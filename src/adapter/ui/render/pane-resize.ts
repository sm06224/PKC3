/**
 * 🔴 **掴んで大きさを変える**(#497)。判定は `features/pane-size.ts`、
 * 覚えるのは `render/pane-size.ts` ── ここは**入力の配線だけ**である。
 *
 * > user 指示 2026-08-27:「**この枠のサイズは可変にし、ユーザーが変更できるように
 * > して欲しい**」「**リサイズニーズは、両サイドペインも一緒だと思う**」
 *
 * ## 🔑 帯 1 本が 2 つの仕事をする
 *
 * | user の手 | 起きること |
 * |---|---|
 * | **押す**(動かさない) | 畳む・戻す(#197 の既存の動き ── **変えない**) |
 * | **掴んで動かす** | 大きさが変わる |
 * | **矢印キー** | 同じだけ大きさが変わる(掴めない人の口) |
 * | 下限より小さくした | **畳む**(0 の面を残さない ── 帯は残るので戻せる) |
 *
 * ## ⚠ 押すと掴むを取り違えない
 *
 * 🔴 動かした後の `click` は**捨てる** ── 捨てないと、広げた直後に
 * **その面が畳まれる**(掴んだ指を離すとブラウザが `click` も撃つため)。
 * ⚠ ただし「1 回だけ捨てる」を `once` で書かない ── `pointercancel` で
 * `click` が来なかった回に**次の正当な押しを食う**。旗を立てて、
 * 常駐の 1 本が旗を見て判断する。
 *
 * ## ⚠ 図のラスタは掴んでいる最中に焼き直さない
 *
 * 🔑 **既に守られている** ── `mermaid-hydrate.ts` の `ResizeObserver` は
 * 150ms 間引いてから焼き直す(「ペインをドラッグで広げると毎フレーム」と
 * その場に書いてある)。ここで 2 本目の間引きを作らない(§7)。
 */
import {
  isSizedPaneId,
  nudgeOutcome,
  PANE_SIZE_SPECS,
  resizeOutcome,
  type SizedPaneId,
} from '@features/pane-size';
import { appPaneSizes, measuredPaneSize, setPaneSizeVar } from './pane-size';
import { appPanes, applyPaneVisibility } from './pane-visibility';

/** 押すと掴むの境目(px)。⚠ 小さすぎると、押しただけで幅が動く。 */
const DRAG_SLOP = 4;

interface Drag {
  readonly id: SizedPaneId;
  readonly grip: HTMLElement;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  /**
   * 掴んだ時点の大きさ。🔴 **`null` = 測れなかった** ── 大きさは変えないが、
   * ⚠ **掴んだ事実は残す**(下の `moved`)。残さないと、動かしたのに
   * 続く `click` が通って**面が畳まれる**(user から見れば「掴んだら消えた」)。
   */
  readonly startPx: number | null;
  /** `DRAG_SLOP` を越えたか ── 越えていなければ「押した」として扱う。 */
  moved: boolean;
}

/**
 * 🔴 **掴んだ時点の大きさ。`null` は「測れなかった」**(#497)。
 *
 * ⚠ 測れないときに `0` を返してはいけない ── `resizeOutcome` は下限割れを
 *   「畳む」と読むので、**ちょっと掴んだだけで面が消える**。
 * 🔑 ただし**畳んである面の 0 は本物** ── そこから引き出せる(戻す口の 2 本目)。
 */
function paneStartSize(root: HTMLElement, id: SizedPaneId): number | null {
  const px = measuredPaneSize(root, id);
  if (px > 0) return px;
  return appPanes.getHidden().includes(id) ? 0 : null;
}

function paneOf(el: Element | null): SizedPaneId | null {
  const grip = el?.closest<HTMLElement>('[data-pkc-region="pane-grip"]') ?? null;
  const id = grip?.getAttribute('data-pkc-pane') ?? null;
  return id !== null && isSizedPaneId(id) ? id : null;
}

/**
 * 決まった姿を画面と保存へ反映する。⚠ **掴みも鍵もここを通す** ──
 * 通さないと「鍵でだけ畳めない」のような食い違いが静かに生まれる(§7)。
 */
function commit(root: HTMLElement, id: SizedPaneId, outcome: ReturnType<typeof resizeOutcome>): void {
  if (outcome.kind === 'collapse') {
    // ⚠ **大きさは覚えたまま**にする ── 戻したときに元の幅で開く
    if (!appPanes.getHidden().includes(id)) applyPaneVisibility(root, appPanes.toggle(id));
    return;
  }
  // 畳んだ面を掴んで引き出した ── 先に戻す(戻さないと幅だけ変わって見えない)
  if (appPanes.getHidden().includes(id)) applyPaneVisibility(root, appPanes.toggle(id));
  applyPaneSize(root, id, outcome.px);
}

function applyPaneSize(root: HTMLElement, id: SizedPaneId, px: number): void {
  setPaneSizeVar(root, id, px);
  appPaneSizes.set(id, px);
}

/**
 * root へ 1 度だけ配線する(`installColumnFit` と同じ作法)。
 * @returns 外す関数。⚠ アプリ本体では外さない(同寿命)が、test は外せる必要がある。
 */
export function installPaneResize(root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  let drag: Drag | null = null;
  /** 直後の `click` を捨てるか。⚠ 上の「⚠ 押すと掴むを取り違えない」を参照。 */
  let swallowClick = false;

  const onPointerDown = (e: PointerEvent): void => {
    swallowClick = false;
    if (e.button !== 0) return;
    const grip = (e.target as Element | null)?.closest<HTMLElement>(
      '[data-pkc-region="pane-grip"]',
    );
    const id = paneOf(e.target as Element | null);
    if (!grip || id === null) return;
    drag = {
      id,
      grip,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startPx: paneStartSize(root, id),
      moved: false,
    };
    // ⚠ 掴んだ先が面の外へ出ても追える(捕まえないと、速く動かすと外れる)
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      // 捕まえられない環境でも、下の `pointermove` は document から届く
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (drag === null || e.pointerId !== drag.pointerId) return;
    const spec = PANE_SIZE_SPECS[drag.id];
    const delta = spec.axis === 'x' ? e.clientX - drag.startX : e.clientY - drag.startY;
    if (!drag.moved && Math.abs(delta) < DRAG_SLOP) return;
    drag.moved = true;
    if (drag.startPx === null) return; // 測れない ── 大きさは触らない(畳みもしない)
    const outcome = resizeOutcome(drag.id, drag.startPx, delta);
    // ⚠ **動かしている間は保存しない**(離すまで書かない ── 1 掴みで 1 回)。
    //    畳むかどうかも離すまで決めない ── 通り過ぎただけで消えると驚く。
    if (outcome.kind === 'size') setPaneSizeVar(root, drag.id, outcome.px);
  };

  const finish = (e: PointerEvent): void => {
    if (drag === null || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    try {
      d.grip.releasePointerCapture(d.pointerId);
    } catch {
      // 捕まえていなければ何もしない
    }
    if (!d.moved) return; // 押しただけ ── `toggle-pane` に任せる
    // 🔴 **動かしたなら、続く `click` は捨てる** ── 測れなかった回も捨てる
    //    (捨てないと「掴んだのに畳まれた」になる。測れないのは user のせいではない)
    swallowClick = true;
    if (d.startPx === null) return;
    const spec = PANE_SIZE_SPECS[d.id];
    const delta = spec.axis === 'x' ? e.clientX - d.startX : e.clientY - d.startY;
    commit(root, d.id, resizeOutcome(d.id, d.startPx, delta));
  };

  const onCancel = (e: PointerEvent): void => {
    if (drag === null || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    // ⚠ 途中で取り消されたら**元へ戻す**(中途半端な幅を保存しない)
    if (d.startPx !== null) setPaneSizeVar(root, d.id, appPaneSizes.get()[d.id] ?? null);
    if (d.moved) swallowClick = true;
  };

  const onClick = (e: MouseEvent): void => {
    if (!swallowClick) return;
    swallowClick = false;
    if (paneOf(e.target as Element | null) === null) return;
    e.stopPropagation();
    e.preventDefault();
  };

  /**
   * 🔴 **掴めない人も同じことができる**(user 指示「マウスだけで完結し、
   * キーボードは近道」の逆側 ── 掴むのが唯一の口だと、そこで動線が切れる)。
   * ⚠ 戻す(畳んだ状態から開く)は `Enter` / `Space` = `toggle-pane` である。
   */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const id = paneOf(e.target as Element | null);
    if (id === null) return;
    const spec = PANE_SIZE_SPECS[id];
    // 帯を「右/下へ動かす」= 正。どちらが広がるかは `grow` が決める
    const steps =
      spec.axis === 'x'
        ? e.key === 'ArrowRight'
          ? 1
          : e.key === 'ArrowLeft'
            ? -1
            : 0
        : e.key === 'ArrowDown'
          ? 1
          : e.key === 'ArrowUp'
            ? -1
            : 0;
    if (steps === 0) return;
    const startPx = paneStartSize(root, id);
    if (startPx === null) return; // 測れない ── 掴みと同じ扱い(黙って畳まない)
    e.preventDefault(); // ⚠ 画面が一緒に流れないように
    commit(root, id, nudgeOutcome(id, startPx, steps));
  };

  root.addEventListener('pointerdown', onPointerDown);
  // ⚠ 移動と終了は **document** で受ける ── 捕まえられない環境で面の外へ
  //    出たとき、root だけだと途中で音沙汰が無くなる
  doc.addEventListener('pointermove', onPointerMove);
  doc.addEventListener('pointerup', finish);
  doc.addEventListener('pointercancel', onCancel);
  root.addEventListener('click', onClick, true);
  root.addEventListener('keydown', onKeyDown);

  return () => {
    root.removeEventListener('pointerdown', onPointerDown);
    doc.removeEventListener('pointermove', onPointerMove);
    doc.removeEventListener('pointerup', finish);
    doc.removeEventListener('pointercancel', onCancel);
    root.removeEventListener('click', onClick, true);
    root.removeEventListener('keydown', onKeyDown);
  };
}
