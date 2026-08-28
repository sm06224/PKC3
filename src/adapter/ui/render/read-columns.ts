/**
 * 読む面の段組みの保存・適用・送り(#505 段①)。意味論は `features/read-columns.ts`。
 *
 * ⚠ 1 鍵だけ(`pkc3.theme` / `pkc3.page-format` / `pkc3.text-scale` と同じ作法)。
 * ⚠ **container に入れない** ── ノートのデータではなく**この端末の見え方**である
 *   (#505「憶えるのは**ノートごとではなく画面の設定**」)。
 *
 * 🔑 当て方は `text-scale.ts` と**同じ形**にする(属性 1 つ + CSS 変数)──
 *   2 本目の作法を作らない(CLAUDE.md §7)。
 */
import {
  columnsFit,
  DEFAULT_READ_COLUMNS,
  isReadColumns,
  readColumnsSpec,
  wheelToInline,
  type ReadColumns,
} from '@features/read-columns';

const KEY = 'pkc3.read-columns';

/** 🔴 **当たっている段数の印**。CSS が読み、smoke と設定画面が同じ物を見る。 */
export const READ_COLUMNS_ATTR = 'data-pkc-read-columns';
/** `app.css` の `columns: 448px var(--pkc-read-cols, 1)` と 1 対 1。 */
export const READ_COLUMNS_VAR = '--pkc-read-cols';
/**
 * ⚠ かつて最小幅とすき間も変数で渡していたが、**変異試験 M9 / M14 が SURVIVED** で
 *   「渡さなくても何も変わらない」= 同じ数字を 2 か所に置いていただけ、と分かった。
 *   いまは `app.css` のリテラルが実体で、`features/read-columns.ts` の定数との
 *   一致は test が突合する(2026-08-28)。
 */
/**
 * 🔴 **段組みが実際に効いている面の印**(器に付く)。
 * ⚠ 根の `data-pkc-read-columns`(= user の選択)とは**別物**である ──
 *   選んでいても器が狭ければ効かない。CSS が見るのは**こちら**。
 */
export const COLUMNS_ON_ATTR = 'data-pkc-columns-on';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 保存されている段数(起動時の初期値)。⚠ 読めなければ既定(1 段)。 */
export function initialReadColumns(): ReadColumns {
  try {
    const v = readStorage()?.getItem(KEY);
    return v !== null && v !== undefined && isReadColumns(v) ? v : DEFAULT_READ_COLUMNS;
  } catch {
    return DEFAULT_READ_COLUMNS;
  }
}

/**
 * いま当たっている段数(**DOM が正本**)。
 * ⚠ 保存を読み直さない ── 保存できない環境では「この session だけ効いている」値が
 *   正しく、そこで保存を見ると**画面と食い違う**(`text-scale.ts` と同じ)。
 */
export function currentReadColumns(target: HTMLElement): ReadColumns {
  const v = target.getAttribute(READ_COLUMNS_ATTR);
  return v !== null && isReadColumns(v) ? v : DEFAULT_READ_COLUMNS;
}

/**
 * 当てる。⚠ **保存しない**(保存は `chooseReadColumns` だけが持つ)。
 *
 * ⚠ **印は 1 段のときも書く** ── 「属性が無い = 1 段」にすると、CSS 側が
 *   `:not([...])` で書けず、smoke も「消えた」と「そもそも付いていない」を
 *   見分けられない(CLAUDE.md §1「代替物で満たせるガードにしない」)。
 */
export function applyReadColumns(target: HTMLElement, cols: ReadColumns): void {
  const spec = readColumnsSpec(cols);
  target.setAttribute(READ_COLUMNS_ATTR, spec.id);
  target.style.setProperty(READ_COLUMNS_VAR, String(spec.count));
}

/** user が選んだ ── 当てて**保存する**。 */
export function chooseReadColumns(target: HTMLElement, cols: ReadColumns): void {
  applyReadColumns(target, cols);
  try {
    readStorage()?.setItem(KEY, cols);
  } catch {
    // 保存できないだけ ── この session では効いている
  }
}

/** 段組みの本文が入る器(横送りの持ち主)。⚠ 読む面のものだけ。 */
export function columnScroller(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    '[data-pkc-detail-mode="view"] [data-pkc-field="detail-body"]',
  );
}

/**
 * 読む面の器(段組みの親)。⚠ 読む面のものだけ。
 */
function viewPane(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>('[data-pkc-view-pane="detail"][data-pkc-detail-mode="view"]');
}

/**
 * 🔴 **段の高さを px で決める**(#505。**これが無いと本文が黙って消える**)。
 *
 * ⚠ 実測(2026-08-28、2560×900・40 段落・2 段):
 *
 * | 高さの決め方 | `scrollWidth` | 下へのはみ出し |
 * |---|---|---|
 * | `flex: 1 1 auto` | 1679(= 器と同じ = **送れない**) | 🔴 **87px 見えない** |
 * | `flex: 1 1 0` | 1679(**送れない**) | 🔴 **87px 見えない** |
 * | `height: 0` + `flex-grow: 1` | 36431 = 🔴 **段が 42 本に爆発** | ─ |
 * | **明示 px**(これ) | 2527 ✅ | ✅ 無し |
 *
 * 🔑 理由は「**確定した高さ**でないと、ブラウザは段を増やさず縦へ溢れさせる」こと。
 *   溢れた分は `overflow-y: hidden` が刈るので、**画面から本文が消えて誰も気づかない**
 *   (CLAUDE.md が繰り返し踏んでいる「静かに壊れる」向き)。
 *
 * @returns 実際に当てた高さ(px)。段組みでないときは `null`(inline の高さを外す)
 */
export function fitColumnHeight(root: ParentNode, doc: Document = document): number | null {
  /**
   * ⚠ **面は「読む面かどうか」に関わらず引く** ── 編集へ入ったときに印を
   *   外せないと、DOM が「段組み中」と嘘をつく(変異試験 M10 が教えた)。
   */
  const anyPane = root.querySelector<HTMLElement>('[data-pkc-view-pane="detail"]');
  const host = columnScroller(root);
  const pane = viewPane(root);
  const off = (): null => {
    // ⚠ 読む面が居なくても、印は**居る面から**外す
    (pane ?? anyPane)?.removeAttribute(COLUMNS_ON_ATTR);
    host?.style.removeProperty('height');
    return null;
  };
  // ⚠ 切るときは**印も高さも外す** ── どちらかが残ると、縦送りの面が刈られる
  if (host === null || pane === null) return off();
  const count = readColumnsSpec(currentReadColumns(doc.documentElement)).count;
  const before = pane.getBoundingClientRect();
  // ⚠ 採寸できない環境(happy-dom / 畳んだ面)では触らない ── 0px にすると本文が消える
  if (before.height === 0 || before.width === 0) return null;
  /**
   * 🔴 **2 段置けないなら段組みごと止める**(#505「狭い画面で壊れない」)。
   * ⚠ CSS の `columns` に任せると段数だけ 1 へ落ちて**横送りが残る** ──
   *   ノート PC で「横スクロールで 1 段ずつめくる」画面になっていた(実測)。
   * 🔑 幅は印を付けても変わらない(印が変えるのは**高さ**)ので、ここで決めてよい。
   */
  if (!columnsFit(host.clientWidth || before.width, count)) return off();
  pane.setAttribute(COLUMNS_ON_ATTR, '');
  /**
   * 🔴 **印を付けた「後で」採り直す**(#505。ここで 1 度外した)。
   *
   * ⚠ 印は面を `flex: 1 0 auto`(中身の高さまで伸びる)から `flex: 1 1 0`
   *   (器の高さで止まる)へ変える ── つまり**印を付けた瞬間に面の高さが変わる**。
   *   印より前に採った値を使うと、**伸びていた頃の高さ**(実測 1330px。正しくは
   *   568px)を入れることになり、本文が 2 段に収まって**横へ送れない**。
   * ⚠ この誤りは**見張りが後から採り直して直す**ので、症状は
   *   「たまに段にならない」という間欠の顔で出た(4 走中 2 走)──
   *   直すまで 2 度、待ちの側を疑って外した。
   */
  const paneRect = pane.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const cs = getComputedStyle(pane);
  const inset =
    (Number.parseFloat(cs.paddingBottom) || 0) + (Number.parseFloat(cs.borderBottomWidth) || 0);
  const avail = Math.floor(paneRect.bottom - inset - hostRect.top);
  if (!Number.isFinite(avail) || avail <= 0) return off();
  const next = `${avail}px`;
  // ⚠ 同じ値なら書かない ── 書くと ResizeObserver がまた鳴って回り続ける
  if (host.style.height !== next) host.style.height = next;
  return avail;
}

/**
 * 🔴 **段の高さを、器の変化に追随させる**(#505)。
 *
 * ⚠ 見張るものが **2 つ**要る。片方だけでは足りない:
 *   ① **器の大きさ**(窓のリサイズ・ペインの畳み)── `ResizeObserver`
 *   ② 🔴 **本文の器の入れ替え**(ノートを開き直すと `detail.ts` が骨組みごと
 *      作り直す)── 新しい器には inline の高さが無いので、**そのままだと刈られる**。
 *      `MutationObserver` の `childList` で捕まえる
 *
 * ⚠ **面 1 枚と、その親の直下だけ**を見る(document 全体を見張らない ── 常駐を
 *   作らない)。⚠ 1 稿目は `root` を `subtree: true` で見ており、**画面のどこが
 *   変わっても鳴る**状態だった(自分の docstring を自分で破っていた)。
 *
 * @returns 外す関数
 */
export function installColumnFit(root: HTMLElement, doc: Document = document): () => void {
  const fit = (): void => void fitColumnHeight(root, doc);
  const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  const MO = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  const ro = RO === undefined ? null : new RO(fit);
  /** 面の中の見張り(骨組みの入れ替え・面の切替)。 */
  const inner = MO === undefined ? null : new MO(fit);
  /** 面そのものの出入り。 */
  const outer = MO === undefined ? null : new MO(() => rewatch());
  let watched: HTMLElement | null = null;

  function rewatch(): void {
    const pane = root.querySelector<HTMLElement>('[data-pkc-view-pane="detail"]');
    if (pane !== null && pane !== watched) {
      if (watched !== null) ro?.unobserve(watched);
      ro?.observe(pane);
      inner?.disconnect();
      /**
       * ⚠ 直下の子だけ(骨組みの組み直し)+ 面の切替 ── 本文の中の書き換えは見ない。
       *
       * ⚠ **この 2 行は変異試験 N / O が SURVIVED である。承知のうえで残している** ──
       *   いまの test では上の `ResizeObserver` が先に鳴って救う(ノートを開き直すのも
       *   編集へ入るのも、結果として**面の高さが変わる**ため)。
       * 🔑 だが救っているのは**高さが変わったという副作用**であって、
       *   「骨組みが変わった」「面が切り替わった」という**当の出来事ではない** ──
       *   高さが偶然同じ遷移が 1 つ出た日に、静かに外れる側である。
       *   ⚠ 消すなら「面の高さが変わらない切替」を作る test と対で消すこと。
       */
      inner?.observe(pane, { childList: true });
      inner?.observe(pane, { attributes: true, attributeFilter: ['data-pkc-detail-mode'] });
      watched = pane;
    }
    fit();
  }

  /**
   * ⚠ **`root` を `subtree: true` で見張らない**(1 稿目はそう書いていた)──
   *   それでは**画面のどこが変わっても**ここが鳴る = 常駐の重さを足すことになり、
   *   このモジュール自身の「面 1 枚だけを見る」という約束を破っていた。
   * 🔑 面(pane)は**中央の器の直下の子**なので、器を `childList` で見れば
   *   入れ替わりは捕まる(`subtree` は要らない)。
   */
  const center = root.querySelector<HTMLElement>('[data-pkc-region="detail"]') ?? root;
  outer?.observe(center, { childList: true });

  /**
   * ⚠ かつて `resize` も聞いていたが、**変異試験 P が KILLED / Q が SURVIVED** で
   *   「窓を狭めたら `ResizeObserver` が先に鳴る」= 聞く必要が無いと分かった
   *   (2026-08-28)。⚠ 同じ物を 2 か所で見張らない(CLAUDE.md §7)。
   */
  rewatch();
  return () => {
    ro?.disconnect();
    inner?.disconnect();
    outer?.disconnect();
  };
}

/**
 * 🔴 **縦のホイールで横へ送れるようにする**(#505。実測で必須と分かった)。
 *
 * ⚠ これが無いと、段組みは**マウスだけでは読めない** ── 縦のホイールでは
 *   1px も動かず(実測 1727 → 1727)、横ホイールを持つマウスは少数である。
 *   不可侵指示 2026-08-03「マウスだけで完結し、キーボードは近道」に当たる。
 *
 * 🔑 **器ごとに張らない。shell に 1 本**だけ張って、その都度いまの器を引く ──
 *   本文の器はノートを変えるたびに作り直されるので、器に張ると
 *   **張り直しを忘れた面だけ送れない**(§7 の「同じ判定が複数の場所にある」)。
 *
 * @returns 外す関数(呼ばなければ張りっぱなし ── shell と同じ寿命)
 */
export function installColumnWheel(root: HTMLElement, doc: Document = document): () => void {
  const onWheel = (ev: WheelEvent): void => {
    // ⚠ 1 段のときは**何もしない**(ふつうの縦送りを奪わない)
    if (currentReadColumns(doc.documentElement) === '1') return;
    const host = columnScroller(root);
    if (host === null) return;
    // ⚠ その器の中で起きたホイールだけ(右の情報ペインの送りを奪わない)
    const t = ev.target;
    if (!(t instanceof Node) || !host.contains(t)) return;
    // ⚠ **送り切っていたら既定に返す** ── 端で止めると、外側の面が送れなくなる
    const dx = wheelToInline(ev.deltaX, ev.deltaY);
    if (dx === 0) return;
    const max = host.scrollWidth - host.clientWidth;
    if (max <= 0) return;
    const next = host.scrollLeft + dx;
    if ((dx < 0 && host.scrollLeft <= 0) || (dx > 0 && host.scrollLeft >= max)) return;
    ev.preventDefault();
    host.scrollLeft = Math.max(0, Math.min(max, next));
  };
  // ⚠ `passive: false` ── 既定を止めるので、明示しないと `preventDefault` が効かない
  root.addEventListener('wheel', onWheel, { passive: false });
  return () => root.removeEventListener('wheel', onWheel);
}
