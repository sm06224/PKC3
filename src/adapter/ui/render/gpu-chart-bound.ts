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
import { scrollToChartContext, subscribeChartContext } from './chart-context-watch';
import type { GpuChartView } from './gpu-chart';

/** 上端に固定したときに付ける印(`app.css`)。 */
export const GPU_CHART_STICKY_CLASS = 'pkc-gpu-chart-sticky';

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

export interface ChartBindingHandle {
  readonly following: boolean;
  readonly sticky: boolean;
  /** いま見せている時点の番号。 */
  readonly index: number;
  setFollowing(on: boolean): void;
  setSticky(on: boolean): void;
  /** 前(-1)・次(+1)の時点へ。 */
  step(dir: 1 | -1): void;
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
  const spacer = doc.createElement('span');
  spacer.className = 'pkc-gpu-chart-spacer';
  bar.append(label, spacer, prev, next, follow, stick);
  const firstBar = view.element.querySelector('[data-pkc-field="gpu-chart-bar"]');
  if (firstBar !== null) firstBar.after(bar);
  else view.element.prepend(bar);

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

  const applySignal = (s: ChartContextSignal, animate: boolean): void => {
    // 🔴 同じ場所でも、本文が変わった(保存した)なら描き直す(古い数のまま残さない)
    const changed = refreshData();
    const d = data;
    const r = resolveFrame(d, s);
    if (!changed && r.index === index && r.frame !== null && r.frame.spec !== null && view.element.getAttribute('data-pkc-gpu-chart-bind-key') === r.frame.key) return;
    show(r.index, r.frame, animate);
  };

  /** 本文の該当場所へ(上端に固定していればそのぶん下げる)。 */
  const jumpTo = (i: number): void => {
    const f = data.frames[i];
    if (f === undefined) return;
    const offset = sticky ? stickyEl.getBoundingClientRect().height : 0;
    const target = bind.mode === 'log-day' ? { key: f.key } : { index: i };
    scrollToChartContext(bodyRoot, bind, target, { scrollRoot, offset });
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
    syncButtons();
  };

  const onPrev = (): void => step(-1);
  const onNext = (): void => step(1);
  const onFollow = (): void => setFollowing(!following);
  const onStick = (): void => setSticky(!sticky);
  const onJump = (): void => jumpTo(index);
  prev.addEventListener('click', onPrev);
  next.addEventListener('click', onNext);
  follow.addEventListener('click', onFollow);
  stick.addEventListener('click', onStick);
  label.addEventListener('click', onJump);

  // 最初の時点(現在地が届くまで)── 1 つ目
  show(0, data.frames[0] ?? null, false);

  const unsubscribe = subscribeChartContext({ root: bodyRoot, scrollRoot, lid, bind }, (s) => {
    lastSignal = s;
    if (!following || disposed) return;
    applySignal(s, true);
  });

  return {
    get following() {
      return following;
    },
    get sticky() {
      return sticky;
    },
    get index() {
      return index;
    },
    setFollowing,
    setSticky,
    step,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      prev.removeEventListener('click', onPrev);
      next.removeEventListener('click', onNext);
      follow.removeEventListener('click', onFollow);
      stick.removeEventListener('click', onStick);
      label.removeEventListener('click', onJump);
      bar.remove();
      stickyEl.classList.remove(GPU_CHART_STICKY_CLASS);
    },
  };
}
