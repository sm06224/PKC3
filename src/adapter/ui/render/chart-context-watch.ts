/**
 * 🔴 **いまどこを読んでいるかを、スクロールを聞かずに知る**(v4.1 PR-8、#2095 中盤)。
 *
 * - 本文の目印(見出し `h{level}` / 改ページ `hr.pkc-section-break` / ログの日付の見出し)を
 *   **スクロールの器を root にした `IntersectionObserver`** で見る。`scroll` を聞かない・位置を測らない(同期の配置計算 0)。
 * - 画面の上の帯(上 5%〜35%)を越えた目印のうち最後の物を「いま読んでいる所」とし、変わったときだけ `ChartContextSignal` を送る。
 * - 🔑 **定常コスト 0**: 聞く人(連動グラフ・PR-9 の別窓)が 0 になった瞬間に `disconnect()` する。
 *   `"bind"` の無いノートでは 1 つも作らない(作るのは `subscribeChartContext` を呼んだときだけ)。
 * - 本文の目印の並びは features 層の抽出(`gpu-chart-bind.ts`)と同じ数え方 ── 本文に行番号の印
 *   (`data-pkc-source-line`)が付いた物だけを数える(埋め込んだ別ノートの見出しを数えない)。
 */
import {
  logDayOfText,
  pageLabel,
  type ChartBindSpec,
  type ChartContextSignal,
} from '@features/chart/gpu-chart-bind';
import { preferredScrollBehavior } from './scroll-behavior';

export interface ChartAnchor {
  readonly el: Element;
  readonly key: string;
  readonly label: string;
}

/** 本文そのものの塊か(行番号の印があり、引用の中でも連動グラフ自身の中でもない)。 */
function ownBlock(root: Element, el: Element): boolean {
  if (!el.hasAttribute('data-pkc-source-line')) return false;
  const q = el.parentElement?.closest('blockquote, .pkc-gpu-chart');
  return q === null || q === undefined || !root.contains(q);
}

/**
 * 🔑 **目印を集める**(並びは本文の順)。heading / page は番号、log-day は日付が鍵。
 */
export function collectChartAnchors(root: Element, bind: Pick<ChartBindSpec, 'mode' | 'level'>): ChartAnchor[] {
  if (bind.mode === 'heading') {
    const hs = [...root.querySelectorAll(`h${bind.level}`)].filter((h) => ownBlock(root, h));
    return hs.map((el, i) => ({ el, key: String(i), label: (el.textContent ?? '').trim() }));
  }
  if (bind.mode === 'page') {
    const breaks = [...root.querySelectorAll('hr.pkc-section-break')].filter((h) => ownBlock(root, h));
    // 1 ページ目の目印 = 本文の最初の塊(連動グラフ自身は除く ── 上端に固定すると常に見えてしまう)
    const first = [...root.children].find((c) => c.querySelector('.pkc-gpu-chart') === null && !c.classList.contains('pkc-gpu-chart'));
    const els = [first ?? root, ...breaks];
    return els.map((el, i) => ({ el, key: String(i), label: pageLabel(i, els.length) }));
  }
  const out: ChartAnchor[] = [];
  for (const h of root.querySelectorAll('h2')) {
    if (!ownBlock(root, h)) continue;
    const day = logDayOfText(h.textContent ?? '');
    if (day !== null) out.push({ el: h, key: day, label: day });
  }
  return out;
}

export type ChartContextListener = (signal: ChartContextSignal) => void;

type AnchorState = 'above' | 'in' | 'below';

interface IoEntryLike {
  readonly target: Element;
  readonly isIntersecting: boolean;
  readonly boundingClientRect: { readonly top: number; readonly bottom: number };
  readonly rootBounds: { readonly top: number } | null;
}
type IoCtor = new (
  cb: (entries: readonly IoEntryLike[]) => void,
  opts?: { root?: Element | null; rootMargin?: string; threshold?: number | number[] },
) => { observe(el: Element): void; unobserve(el: Element): void; disconnect(): void };

/** 「いま読んでいる所」の帯(画面の上 5%〜35%)。 */
export const CHART_CONTEXT_ROOT_MARGIN = '-5% 0px -65% 0px';

class ContextWatch {
  readonly listeners = new Set<ChartContextListener>();
  private io: InstanceType<IoCtor> | null = null;
  private mo: MutationObserver | null = null;
  private anchors: ChartAnchor[] = [];
  private readonly states = new Map<Element, AnchorState>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  last: ChartContextSignal | null = null;

  constructor(
    readonly root: Element,
    readonly scrollRoot: Element | null,
    readonly lid: string,
    readonly bind: Pick<ChartBindSpec, 'mode' | 'level'>,
    private readonly onEmpty: () => void,
  ) {}

  start(): void {
    const Io = (globalThis as { IntersectionObserver?: IoCtor }).IntersectionObserver;
    if (Io !== undefined) {
      this.io = new Io((entries) => this.onEntries(entries), { root: this.scrollRoot, rootMargin: CHART_CONTEXT_ROOT_MARGIN, threshold: 0 });
    }
    this.collect();
    // 本文の塊が差し替わったら目印を集め直す(⚠ スクロールでは動かない ── DOM が変わったときだけ)
    const MO = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
    if (MO !== undefined) {
      this.mo = new MO(() => this.scheduleRefresh());
      // ⚠ 直下の塊の出入りだけを見る(本文の塊はここで差し替わる)── グラフ自身の字の書き換えでは動かない
      this.mo.observe(this.root, { childList: true });
    }
    // 目印が見えない環境(IntersectionObserver が無い)では、最初の目印を現在地にする
    if (this.io === null) this.emit(0);
  }

  get observing(): boolean {
    return this.io !== null;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.collect();
    }, 0);
  }

  private collect(): void {
    const next = collectChartAnchors(this.root, this.bind);
    const same = next.length === this.anchors.length && next.every((a, i) => a.el === this.anchors[i]!.el && a.key === this.anchors[i]!.key);
    if (same) return;
    for (const a of this.anchors) this.io?.unobserve(a.el);
    this.states.clear();
    this.anchors = next;
    for (const a of next) this.io?.observe(a.el);
  }

  private onEntries(entries: readonly IoEntryLike[]): void {
    for (const e of entries) {
      let s: AnchorState;
      if (e.isIntersecting) s = 'in';
      else {
        const top = e.rootBounds?.top ?? 0;
        s = e.boundingClientRect.bottom <= top ? 'above' : 'below';
      }
      this.states.set(e.target, s);
    }
    let cur = -1;
    this.anchors.forEach((a, i) => {
      const s = this.states.get(a.el);
      if (s === 'in' || s === 'above') cur = i;
    });
    this.emit(Math.max(0, cur));
  }

  private emit(index: number): void {
    const a = this.anchors[index];
    if (a === undefined) return;
    const signal: ChartContextSignal = {
      lid: this.lid,
      mode: this.bind.mode,
      key: a.key,
      label: a.label,
      index,
      total: this.anchors.length,
    };
    const l = this.last;
    if (l !== null && l.key === signal.key && l.index === signal.index && l.total === signal.total) return;
    this.last = signal;
    for (const fn of [...this.listeners]) fn(signal);
  }

  remove(fn: ChartContextListener): void {
    this.listeners.delete(fn);
    if (this.listeners.size > 0) return;
    this.stop();
    this.onEmpty();
  }

  stop(): void {
    this.io?.disconnect();
    this.io = null;
    this.mo?.disconnect();
    this.mo = null;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.states.clear();
    this.anchors = [];
  }
}

/** 本文の根 → 種類ごとの見張り(同じ本文の連動グラフ・別窓は 1 本を共有する)。 */
const watches = new WeakMap<Element, Map<string, ContextWatch>>();
let liveWatchCount = 0;

/** test 用: 生きている見張り(= 動いている `IntersectionObserver`)の数。 */
export function liveChartContextWatches(): number {
  return liveWatchCount;
}

export interface ChartContextWatchOptions {
  /** 本文の根(`[data-pkc-field="detail-body"]`)。 */
  readonly root: Element;
  /** スクロールの器(`null` なら画面)。 */
  readonly scrollRoot: Element | null;
  readonly lid: string;
  readonly bind: Pick<ChartBindSpec, 'mode' | 'level'>;
}

/**
 * 🔴 **現在地を聞く**。最初の 1 人で見張りを作り、最後の 1 人が抜けたら `disconnect()` する。返り値で抜ける。
 * ⚠ 既に現在地が分かっていれば、聞き始めた人へすぐ 1 通送る(後から来た連動グラフも今の場所に揃う)。
 */
export function subscribeChartContext(opts: ChartContextWatchOptions, fn: ChartContextListener): () => void {
  const key = `${opts.bind.mode}:${opts.bind.mode === 'heading' ? opts.bind.level : 0}`;
  let byKey = watches.get(opts.root);
  if (byKey === undefined) {
    byKey = new Map();
    watches.set(opts.root, byKey);
  }
  let w = byKey.get(key);
  if (w === undefined) {
    const created = new ContextWatch(opts.root, opts.scrollRoot, opts.lid, opts.bind, () => {
      liveWatchCount -= 1;
      const m = watches.get(opts.root);
      m?.delete(key);
      if (m !== undefined && m.size === 0) watches.delete(opts.root);
    });
    byKey.set(key, created);
    liveWatchCount += 1;
    created.listeners.add(fn);
    created.start();
    w = created;
  } else {
    w.listeners.add(fn);
    if (w.last !== null) fn(w.last);
  }
  const watch = w;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    watch.remove(fn);
  };
}

/**
 * 🔑 **目印へ動かす**(連動グラフの「前へ / 次へ」とラベルから本文へ ── 双方向)。
 * 位置を測るのは押したときの 1 回だけ。`prefers-reduced-motion: reduce` では即時に動かす。
 * @param target 番号(heading / page)か鍵(log-day の日付)
 * @param offset 上端に固定したグラフの高さぶん下げる(見出しがグラフの裏に隠れない)
 * @returns 目印が見つかったか
 */
export function scrollToChartContext(
  root: Element,
  bind: Pick<ChartBindSpec, 'mode' | 'level'>,
  target: { readonly index: number } | { readonly key: string },
  opts: { readonly scrollRoot?: Element | null; readonly offset?: number } = {},
): boolean {
  const anchors = collectChartAnchors(root, bind);
  const a = 'key' in target ? anchors.find((x) => x.key === target.key) : anchors[target.index];
  if (a === undefined) return false;
  const behavior = preferredScrollBehavior();
  const sr = opts.scrollRoot ?? null;
  const offset = opts.offset ?? 0;
  if (sr !== null && typeof (sr as HTMLElement).scrollTo === 'function') {
    const top = a.el.getBoundingClientRect().top - sr.getBoundingClientRect().top + sr.scrollTop - offset - 8;
    (sr as HTMLElement).scrollTo({ top: Math.max(0, top), behavior });
    return true;
  }
  if (typeof (a.el as HTMLElement).scrollIntoView === 'function') (a.el as HTMLElement).scrollIntoView({ behavior, block: 'start' });
  return true;
}
