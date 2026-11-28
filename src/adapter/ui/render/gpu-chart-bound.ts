/**
 * 🔴 **スクロール連動グラフの操作バーと配線**(v4.1 PR-8、#2095 中盤)。
 *
 * - 現在地(`chart-context-watch.ts` の `ChartContextSignal`)が変わったら、本文から作った時点のデータ
 *   (`extractBoundChartFrames`)へ `updateData(…, { animate: true })` で切り替える。
 * - 操作バー(`bind` の付いたグラフだけ): 現在の連動先 / 前へ・次へ / 追従 ON ⇄ 固定中 / 上端に固定 ⇄ 固定を解除。
 *   どれも押し直せば元へ戻る(片道の操作を作らない ── CLAUDE.md §2-9)。
 * - 本文は**読むたびに比べる**: 本文が変わっていれば(保存した)時点のデータを作り直す。変わっていなければ作り直さない。
 */
import {
  BOUND_EMPTY_REASON,
  extractBoundChartFrames,
  frameForSignal,
  type BoundChartDataset,
  type BoundChartFrame,
  type ChartContextSignal,
} from '@features/chart/gpu-chart-bind';
import type { ChartBindSpec, GpuChartSpec } from '@features/chart/gpu-chart-spec';
import { compactLayoutOf, type CompactLayout } from '@features/chart/gpu-chart-floating';
import { scrollToChartContext, subscribeChartContext } from './chart-context-watch';
import type { GpuChartView } from './gpu-chart';

/** 上端に固定したときに付ける印(`app.css`)。 */
export const GPU_CHART_STICKY_CLASS = 'pkc-gpu-chart-sticky';
/** 🔴 縮小表示の印(グラフの枠 `.pkc-gpu-chart` に `"true"` / `"false"`。v4.2 PR-1)。 */
export const GPU_CHART_COMPACT_ATTR = 'data-pkc-gpu-chart-compact';

/**
 * 🔑 **固定するのは本文の根の直下の塊**(器そのものではない)。
 * ⚠ 器は差分描画の塊(`.pkc-md-block` › `.pkc-render-slot`)に包まれている ── `position: sticky` は親の箱の中でしか
 *   留まらないので、器に付けると親の高さ(= グラフの高さ)の中で動けず、そのまま流れる(実ブラウザの smoke で判明)。
 */
export function stickyTargetOf(host: HTMLElement, bodyRoot: HTMLElement): HTMLElement {
  let el: HTMLElement = host;
  while (el.parentElement !== null && el.parentElement !== bodyRoot) el = el.parentElement;
  return el.parentElement === bodyRoot ? el : host;
}

/**
 * 🔑 **本文の今の閲覧位置**(親の追従 ON / 固定中に関係なく)── 別ウィンドウ(PR-9)へ配る中身。
 * ⚠ 親が固定中でも、別ウィンドウには読んでいる場所を配る(追従・固定の判断は別ウィンドウ側が持つ)。
 */
export interface ChartReadingPoint {
  readonly signal: ChartContextSignal | null;
  readonly index: number;
  readonly total: number;
  readonly frame: BoundChartFrame | null;
  readonly mode: ChartBindSpec['mode'];
}

export interface ChartBindingHandle {
  readonly following: boolean;
  readonly sticky: boolean;
  /** 🔴 上端に固定したまま実描画の大きさへ広げているか(v4.2 PR-1)。固定していないときは常に `false`。 */
  readonly expanded: boolean;
  /** 縮小表示の今の倍率と見た目の大きさ(縮小していなければ `null`)。 */
  readonly compact: CompactLayout | null;
  /** 実描画の大きさへ広げる(`true`)/ 縮小に戻す(`false`)。⚠ 固定していないときは何もしない。 */
  setExpanded(on: boolean): void;
  /** いま見せている時点の番号。 */
  readonly index: number;
  setFollowing(on: boolean): void;
  setSticky(on: boolean): void;
  /** 前(-1)・次(+1)の時点へ。 */
  step(dir: 1 | -1): void;
  /** 本文の今の閲覧位置(本文が変わっていれば作り直してから)。 */
  reading(): ChartReadingPoint;
  /** 時点の名前の一覧(別ウィンドウの前へ・次への判定)。 */
  framesMeta(): readonly { key: string; label: string }[];
  /** 番号の時点(別ウィンドウの「前へ / 次へ」への返事に使う)。 */
  frameAt(i: number): BoundChartFrame | null;
  /** 本文をその時点の場所へ動かす(別ウィンドウからの `jump` ── 双方向。⚠ 即時に動かす)。 */
  jump(i: number): void;
  /**
   * 閲覧位置・データの変化を聞く(親の追従 ON / 固定中に関係なく)。返り値で抜ける。
   * @param dataChanged 本文が変わって時点のデータを作り直した
   */
  onReading(fn: (p: ChartReadingPoint, dataChanged: boolean) => void): () => void;
  dispose(): void;
}

export interface ChartBindingArgs {
  readonly view: GpuChartView;
  /** グラフの器。 */
  readonly host: HTMLElement;
  readonly base: GpuChartSpec & { readonly bind: ChartBindSpec };
  /** 本文の根(目印を探す所)。 */
  readonly bodyRoot: HTMLElement;
  readonly scrollRoot: Element | null;
  readonly lid: string;
  readonly getNoteBody: () => string | null;
  /** 器を置いたときに作った時点のデータ(作り直さないで済むように渡す)。 */
  readonly initial: { readonly body: string; readonly data: BoundChartDataset };
}

/** 連動先の表示(`連動: Q2 (2 / 4)` / `連動: ページ 2 / 4` / `連動: 2026-11-20 (3 / 10)`)。 */
export function bindLabelText(mode: ChartBindSpec['mode'], frame: BoundChartFrame | null, index: number, total: number): string {
  if (frame === null) return '連動: (なし)';
  if (mode === 'page' || index < 0) return `連動: ${frame.label}`;
  return `連動: ${frame.label} (${index + 1} / ${total})`;
}

/** 目印の数と本文の区切りの数が合わないときの文(どの節のデータかを取り違えて描かない)。 */
export const BIND_MISMATCH_REASON = '本文の見出しの数とグラフの区切りの数が合わないため、この場所のデータを特定できません';

/**
 * 🔑 **現在地 → 時点**。heading / page は番号で引くが、⚠ 本文の目印の数(`signal.total`)と時点の数が違うときは
 * 番号の対応が崩れている(setext 見出し・リストの中の見出しなど)── heading は見出しの字で引き直し、
 * それでも引けなければ「特定できない」を返す(隣の節のデータを描かない)。
 */
export function resolveFrame(
  data: BoundChartDataset,
  s: ChartContextSignal,
): { index: number; frame: BoundChartFrame | null; mismatch?: true } {
  if (data.mode === 'log-day') {
    const f = frameForSignal(data, s);
    return { index: f === null ? -1 : data.frames.indexOf(f), frame: f };
  }
  if (s.total === data.frames.length) return { index: s.index, frame: data.frames[s.index] ?? null };
  if (data.mode === 'heading') {
    const k = data.frames.findIndex((f) => f.label === s.label);
    if (k >= 0) return { index: k, frame: data.frames[k]! };
  }
  return { index: -1, frame: { key: '', label: s.label, spec: null, reason: BIND_MISMATCH_REASON }, mismatch: true };
}

/**
 * 🔴 **連動を付ける**。返り値の `dispose()` で現在地の購読を抜ける(最後の 1 人なら見張りごと止まる)。
 */
export function attachChartBinding(args: ChartBindingArgs): ChartBindingHandle {
  const { view, host, base, bodyRoot, scrollRoot, lid } = args;
  const bind = base.bind;
  const doc = host.ownerDocument;
  const stickyEl = stickyTargetOf(host, bodyRoot);
  let body = args.initial.body;
  let data = args.initial.data;
  let index = -1;
  let following = true;
  let sticky = bind.sticky;
  /** 🔴 上端に固定したまま実描画の大きさへ広げているか(v4.2 PR-1)。固定し直すたびに縮小から始める。 */
  let expanded = false;
  let compact: CompactLayout | null = null;
  let lastSignal: ChartContextSignal | null = null;
  let disposed = false;

  /** 本文が変わっていれば時点のデータを作り直す。作り直したら真。 */
  const refreshData = (): boolean => {
    const now = args.getNoteBody();
    if (now === null || now === body) return false;
    body = now;
    data = extractBoundChartFrames(now, base);
    return true;
  };
  const freshData = (): BoundChartDataset => {
    refreshData();
    return data;
  };

  // ── 操作バー
  const bar = doc.createElement('div');
  bar.className = 'pkc-gpu-chart-bind';
  bar.setAttribute('data-pkc-field', 'gpu-chart-bind');
  bar.setAttribute('data-pkc-gpu-chart-bind-mode', bind.mode);
  const mkBtn = (op: string, text: string, tip: string): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'pkc-gpu-chart-btn';
    b.setAttribute('data-pkc-variant', 'ghost');
    b.setAttribute('data-pkc-gpu-chart-op', op);
    b.textContent = text;
    b.title = tip;
    return b;
  };
  const label = mkBtn('bind-jump', '連動: ', '本文のこの場所へ移動します');
  label.classList.add('pkc-gpu-chart-bind-label');
  label.setAttribute('data-pkc-field', 'gpu-chart-bind-label');
  const prev = mkBtn('bind-prev', '◀ 前へ', '前の場所のデータを表示します(追従中は本文もその場所へ移動します)');
  const next = mkBtn('bind-next', '次へ ▶', '次の場所のデータを表示します(追従中は本文もその場所へ移動します)');
  const follow = mkBtn('bind-follow', '追従 ON', '');
  follow.setAttribute('data-pkc-field', 'gpu-chart-follow');
  const stick = mkBtn('bind-sticky', '', '');
  stick.setAttribute('data-pkc-field', 'gpu-chart-sticky');
  // 🔴 縮小 ⇄ 実サイズ(v4.2 PR-1)── 上端に固定しているときだけ出す
  const expand = mkBtn('bind-expand', '', '');
  expand.setAttribute('data-pkc-field', 'gpu-chart-expand');
  const spacer = doc.createElement('span');
  spacer.className = 'pkc-gpu-chart-spacer';
  bar.append(label, spacer, prev, next, follow, expand, stick);
  const firstBar = view.element.querySelector('[data-pkc-field="gpu-chart-bar"]');
  if (firstBar !== null) firstBar.after(bar);
  else view.element.prepend(bar);

  /**
   * 🔴 **縮小の枠**(v4.2 PR-1)── 描画面(`.pkc-gpu-chart-stage`)を包む。縮小中は枠の高さを見た目の高さにして
   *   `overflow: hidden`、中の描画面は実描画の大きさのまま `transform: scale()` で縮めて見せる。
   *   ⚠ 描画面の `clientWidth` / `clientHeight`(描く論理解像度)は transform の影響を受けない ── 縮めても描き直さない。
   */
  const stage = view.element.querySelector<HTMLElement>('[data-pkc-gpu-chart-stage]');
  const viewport = doc.createElement('div');
  viewport.className = 'pkc-gpu-chart-viewport';
  viewport.setAttribute('data-pkc-field', 'gpu-chart-viewport');
  const hint = doc.createElement('span');
  hint.className = 'pkc-gpu-chart-compact-hint';
  hint.setAttribute('data-pkc-field', 'gpu-chart-compact-hint');
  hint.setAttribute('aria-hidden', 'true');
  hint.textContent = 'クリックで実サイズ表示';
  if (stage !== null) {
    stage.before(viewport);
    viewport.append(stage, hint);
  }

  /** 縮小の見た目を当てる / 外す(DOM だけ。状態は `sticky && !expanded`)。 */
  const applyCompact = (): void => {
    const on = sticky && !expanded && stage !== null;
    if (on) {
      // 🔑 実描画の大きさは描画面の箱(transform の影響を受けない)から読む。高さは指定どおり(`spec.height`)
      const renderW = stage.clientWidth || stage.offsetWidth || 1;
      const renderH = stage.clientHeight || view.currentSpec().height;
      compact = compactLayoutOf(renderW, renderH, bind);
      viewport.style.height = `${compact.visualH}px`;
      stage.style.transform = `scale(${compact.scale})`;
      stage.style.transformOrigin = 'top left';
      viewport.setAttribute('role', 'button');
      viewport.tabIndex = 0;
      viewport.setAttribute('aria-label', 'グラフを縮小して表示しています。押すと実サイズで表示します');
    } else {
      compact = null;
      viewport.style.removeProperty('height');
      stage?.style.removeProperty('transform');
      stage?.style.removeProperty('transform-origin');
      viewport.removeAttribute('role');
      viewport.removeAttribute('tabindex');
      viewport.removeAttribute('aria-label');
    }
    view.element.setAttribute(GPU_CHART_COMPACT_ATTR, on ? 'true' : 'false');
    viewport.setAttribute('aria-expanded', on ? 'false' : 'true');
    hint.hidden = !on;
  };

  const syncButtons = (): void => {
    follow.setAttribute('aria-pressed', following ? 'false' : 'true');
    follow.textContent = following ? '追従 ON' : '固定中';
    follow.title = following
      ? '本文を読み進めるとグラフが切り替わります。押すと今のグラフに固定します'
      : 'グラフを固定しています(スクロールしても切り替わりません)。押すと今読んでいる場所に戻ります';
    stick.setAttribute('aria-pressed', sticky ? 'true' : 'false');
    stick.textContent = sticky ? '固定を解除' : '上端に固定';
    stick.title = sticky
      ? 'グラフを画面の上端に固定しています。押すと本文と一緒に流れる配置に戻ります'
      : 'スクロールしてもグラフが画面の上端に残るようにします';
    stickyEl.classList.toggle(GPU_CHART_STICKY_CLASS, sticky);
    expand.hidden = !sticky;
    expand.setAttribute('aria-expanded', sticky && !expanded ? 'false' : 'true');
    expand.textContent = expanded ? '縮小に戻す' : '実サイズで表示';
    expand.title = expanded
      ? 'グラフを縮小した表示に戻します(Esc キーでも)'
      : 'グラフを実際の大きさで表示します(縮小したグラフを押しても広がります)';
    applyCompact();
    view.element.setAttribute('data-pkc-gpu-chart-following', following ? 'true' : 'false');
    const total = data.frames.length;
    prev.disabled = index <= 0;
    next.disabled = index < 0 || index >= total - 1;
  };

  /** 時点を見せる(データが無い時点は理由を出し、古い絵を隠す)。 */
  const show = (i: number, frame: BoundChartFrame | null, animate: boolean): void => {
    const total = data.frames.length;
    index = i;
    label.textContent = bindLabelText(bind.mode, frame, i, total);
    view.element.setAttribute('data-pkc-gpu-chart-bind-key', frame?.key ?? '');
    if (frame === null || frame.spec === null) {
      view.setEmpty(frame?.reason ?? BOUND_EMPTY_REASON[bind.mode]);
    } else {
      view.setEmpty(null);
      view.updateData(frame.spec, { animate, resetViewport: true });
    }
    syncButtons();
  };

  const applySignal = (s: ChartContextSignal, animate: boolean, changedBefore = false): void => {
    // 🔴 同じ場所でも、本文が変わった(保存した)なら描き直す(古い数のまま残さない)
    // ⚠ 先に聞き手へ配るために作り直していたら、その事実を引き継ぐ(2 回目の比較は「変わっていない」と答える)
    const changed = refreshData() || changedBefore;
    const d = data;
    const r = resolveFrame(d, s);
    if (!changed && r.index === index && r.frame !== null && r.frame.spec !== null && view.element.getAttribute('data-pkc-gpu-chart-bind-key') === r.frame.key) return;
    show(r.index, r.frame, animate);
  };

  /** 本文の該当場所へ(上端に固定していればそのぶん下げる)。 */
  const jumpTo = (i: number, instant = false): void => {
    const f = data.frames[i];
    if (f === undefined) return;
    const offset = sticky ? stickyEl.getBoundingClientRect().height : 0;
    const target = bind.mode === 'log-day' ? { key: f.key } : { index: i };
    scrollToChartContext(bodyRoot, bind, target, { scrollRoot, offset, instant });
  };

  const step = (dir: 1 | -1): void => {
    const d = freshData();
    const i = Math.max(0, Math.min(d.frames.length - 1, (index < 0 ? 0 : index) + dir));
    if (i === index) return;
    show(i, d.frames[i] ?? null, true);
    // 🔑 追従中は本文もその場所へ動かす(グラフ → 本文の向き)。固定中はグラフだけめくる(読んでいる場所は動かさない)
    if (following) jumpTo(i);
  };

  const setFollowing = (on: boolean): void => {
    following = on;
    syncButtons();
    if (on && lastSignal !== null) applySignal(lastSignal, true);
  };
  const setSticky = (on: boolean): void => {
    sticky = on;
    // 🔑 固定し直したら縮小から始める / 解除したら(広げていても)本文の中の実描画の大きさへ戻る
    expanded = false;
    syncButtons();
  };
  const setExpanded = (on: boolean): void => {
    if (!sticky || expanded === on) return;
    expanded = on;
    syncButtons();
  };

  const onPrev = (): void => step(-1);
  const onNext = (): void => step(1);
  const onFollow = (): void => setFollowing(!following);
  const onStick = (): void => setSticky(!sticky);
  const onJump = (): void => jumpTo(index);
  const onExpand = (): void => setExpanded(!expanded);
  /**
   * 🔴 **縮小中の押す・触るは「実サイズで表示」に専念させる**(v4.2 PR-1)── 先に枠で受けて描画面へ渡さない
   *   (ドラッグでの移動・ホバーの詳細・ホイールの拡大が縮小した絵の上で誤って動かない)。
   */
  const blockWhileCompact = (e: Event): void => {
    if (compact === null) return;
    e.stopPropagation();
  };
  const onViewportPointerDown = (e: Event): void => {
    if (compact === null) return;
    e.stopPropagation();
    e.preventDefault();
  };
  /** 広げたら焦点を描画面へ(キーボードの操作と `Esc` がそのまま効く)。⚠ 見えている位置を動かさない。 */
  const expandByUser = (): void => {
    setExpanded(true);
    stage?.focus({ preventScroll: true });
  };
  const onViewportClick = (e: Event): void => {
    if (compact === null) return;
    e.stopPropagation();
    expandByUser();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (compact !== null && e.target === viewport && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      e.stopPropagation();
      expandByUser();
      return;
    }
    if (sticky && expanded && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setExpanded(false);
      viewport.focus({ preventScroll: true });
    }
  };
  expand.addEventListener('click', onExpand);
  viewport.addEventListener('pointerdown', onViewportPointerDown, true);
  viewport.addEventListener('pointermove', blockWhileCompact, true);
  viewport.addEventListener('wheel', blockWhileCompact, true);
  viewport.addEventListener('dblclick', blockWhileCompact, true);
  viewport.addEventListener('click', onViewportClick, true);
  view.element.addEventListener('keydown', onKey, true);
  prev.addEventListener('click', onPrev);
  next.addEventListener('click', onNext);
  follow.addEventListener('click', onFollow);
  stick.addEventListener('click', onStick);
  label.addEventListener('click', onJump);

  // 最初の時点(現在地が届くまで)── 1 つ目
  show(0, data.frames[0] ?? null, false);

  const readers = new Set<(p: ChartReadingPoint, dataChanged: boolean) => void>();
  const reading = (): ChartReadingPoint => {
    const d = freshData();
    if (lastSignal === null) return { signal: null, index: d.frames.length > 0 ? 0 : -1, total: d.frames.length, frame: d.frames[0] ?? null, mode: bind.mode };
    const r = resolveFrame(d, lastSignal);
    return { signal: lastSignal, index: r.index, total: d.frames.length, frame: r.frame, mode: bind.mode };
  };

  const unsubscribe = subscribeChartContext({ root: bodyRoot, scrollRoot, lid, bind }, (s) => {
    lastSignal = s;
    if (disposed) return;
    let changed = false;
    if (readers.size > 0) {
      // 🔑 別ウィンドウへは親の追従 ON / 固定中に関係なく配る
      changed = refreshData();
      const p = reading();
      for (const fn of [...readers]) fn(p, changed);
    }
    if (!following) return;
    applySignal(s, true, changed);
  });

  return {
    get following() {
      return following;
    },
    get sticky() {
      return sticky;
    },
    get expanded() {
      return expanded;
    },
    get compact() {
      return compact;
    },
    setExpanded,
    get index() {
      return index;
    },
    setFollowing,
    setSticky,
    step,
    reading,
    framesMeta: () => freshData().frames.map((f) => ({ key: f.key, label: f.label })),
    frameAt: (i) => freshData().frames[i] ?? null,
    jump: (i) => {
      refreshData();
      jumpTo(i, true);
    },
    onReading: (fn) => {
      readers.add(fn);
      return () => readers.delete(fn);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      readers.clear();
      unsubscribe();
      prev.removeEventListener('click', onPrev);
      next.removeEventListener('click', onNext);
      follow.removeEventListener('click', onFollow);
      stick.removeEventListener('click', onStick);
      label.removeEventListener('click', onJump);
      expand.removeEventListener('click', onExpand);
      viewport.removeEventListener('pointerdown', onViewportPointerDown, true);
      viewport.removeEventListener('pointermove', blockWhileCompact, true);
      viewport.removeEventListener('wheel', blockWhileCompact, true);
      viewport.removeEventListener('dblclick', blockWhileCompact, true);
      viewport.removeEventListener('click', onViewportClick, true);
      view.element.removeEventListener('keydown', onKey, true);
      bar.remove();
      stickyEl.classList.remove(GPU_CHART_STICKY_CLASS);
      // 🔑 縮小の枠を外して、描画面を元の場所へ戻す(器が使い回されても縮小の見た目を残さない)
      sticky = false;
      applyCompact();
      if (stage !== null && viewport.parentElement !== null) viewport.replaceWith(stage);
      view.element.removeAttribute(GPU_CHART_COMPACT_ATTR);
    },
  };
}
