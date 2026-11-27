/** @vitest-environment happy-dom */
/**
 * 🔴 閲覧位置の検知(v4.1 PR-8)── `IntersectionObserver` を偽物にして、見出し・改ページ・ログの日付の現在地の 1 通と、
 * 聞く人が 0 になったら止まること(定常コスト 0)を見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHART_CONTEXT_ROOT_MARGIN,
  collectChartAnchors,
  liveChartContextWatches,
  scrollToChartContext,
  subscribeChartContext,
} from '../../src/adapter/ui/render/chart-context-watch';
import type { ChartContextSignal } from '../../src/features/chart/gpu-chart-bind';

interface Entry {
  target: Element;
  isIntersecting: boolean;
  boundingClientRect: { top: number; bottom: number };
  rootBounds: { top: number } | null;
}
let ios: FakeIo[] = [];
class FakeIo {
  targets = new Set<Element>();
  disconnected = false;
  constructor(
    readonly cb: (e: Entry[]) => void,
    readonly opts: { root?: Element | null; rootMargin?: string },
  ) {
    ios.push(this);
  }
  observe(el: Element): void {
    this.targets.add(el);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.disconnected = true;
    this.targets.clear();
  }
  /** `states[i]` = i 番目の目印の位置(上へ過ぎた / 帯の中 / まだ下)。 */
  report(els: Element[], states: Array<'above' | 'in' | 'below'>): void {
    this.cb(
      els.map((target, i) => ({
        target,
        isIntersecting: states[i] === 'in',
        boundingClientRect: states[i] === 'above' ? { top: -200, bottom: -100 } : { top: 500, bottom: 520 },
        rootBounds: { top: 0 },
      })),
    );
  }
}

let root: HTMLElement;
const line = (el: Element, n: number): Element => {
  el.setAttribute('data-pkc-source-line', String(n));
  return el;
};

beforeEach(() => {
  ios = [];
  vi.stubGlobal('IntersectionObserver', FakeIo);
  root = document.createElement('div');
  root.setAttribute('data-pkc-field', 'detail-body');
  document.body.append(root);
});
afterEach(() => {
  root.remove();
  vi.unstubAllGlobals();
});

function headingBody(): HTMLElement[] {
  root.innerHTML = '';
  const hs: HTMLElement[] = [];
  ['Q1', 'Q2', 'Q3'].forEach((t, i) => {
    const h = document.createElement('h2');
    h.textContent = t;
    line(h, i * 10);
    root.append(h, document.createElement('p'));
    hs.push(h);
  });
  // 埋め込んだ別ノートの見出し(行番号の印が無い)と引用の中の見出しは数えない
  const embedded = document.createElement('h2');
  embedded.textContent = '埋め込み';
  root.append(embedded);
  const q = document.createElement('blockquote');
  q.append(line(document.createElement('h2'), 99));
  root.append(q);
  return hs;
}

describe('目印を集める', () => {
  it('heading: 本文の h2 だけ(埋め込み・引用の中は数えない)', () => {
    headingBody();
    const a = collectChartAnchors(root, { mode: 'heading', level: 2 });
    expect(a.map((x) => [x.key, x.label])).toEqual([
      ['0', 'Q1'],
      ['1', 'Q2'],
      ['2', 'Q3'],
    ]);
  });

  it('page: 1 ページ目は本文の最初の塊、続きは改ページの hr', () => {
    root.innerHTML = '<div class="pkc-gpu-chart-sticky"><div class="pkc-gpu-chart"></div></div><p>1</p>';
    const hr = line(document.createElement('hr'), 3);
    hr.className = 'pkc-section-break';
    root.append(hr, document.createElement('p'));
    const a = collectChartAnchors(root, { mode: 'page', level: 2 });
    expect(a).toHaveLength(2);
    expect(a[0]!.el.tagName).toBe('P'); // 連動グラフ自身ではない
    expect(a[1]!.el).toBe(hr);
    expect(a[1]!.label).toBe('ページ 2 / 2');
  });

  it('log-day: 日付の見出しの日を鍵にする', () => {
    root.innerHTML = '';
    for (const [t, n] of [
      ['2026-11-18 09:00:00', 1],
      ['メモ', 3],
      ['2026-11-20 10:00', 5],
    ] as const) {
      const h = line(document.createElement('h2'), n);
      h.textContent = t;
      root.append(h);
    }
    expect(collectChartAnchors(root, { mode: 'log-day', level: 2 }).map((a) => a.key)).toEqual(['2026-11-18', '2026-11-20']);
  });
});

describe('現在地の 1 通', () => {
  it('heading: 帯を越えた最後の見出しが現在地・変わったときだけ送る', () => {
    const hs = headingBody();
    const got: ChartContextSignal[] = [];
    const scroller = document.createElement('div');
    const off = subscribeChartContext({ root, scrollRoot: scroller, lid: 'n1', bind: { mode: 'heading', level: 2 } }, (s) => got.push(s));
    expect(ios).toHaveLength(1);
    expect(ios[0]!.opts.root).toBe(scroller);
    expect(ios[0]!.opts.rootMargin).toBe(CHART_CONTEXT_ROOT_MARGIN);
    expect([...ios[0]!.targets]).toEqual(hs);
    ios[0]!.report(hs, ['in', 'below', 'below']);
    ios[0]!.report(hs, ['in', 'below', 'below']); // 同じ所 ── 送らない
    ios[0]!.report(hs, ['above', 'in', 'below']);
    ios[0]!.report(hs, ['above', 'above', 'in']);
    ios[0]!.report(hs, ['above', 'in', 'below']); // 戻る
    expect(got.map((s) => [s.key, s.index, s.total, s.label])).toEqual([
      ['0', 0, 3, 'Q1'],
      ['1', 1, 3, 'Q2'],
      ['2', 2, 3, 'Q3'],
      ['1', 1, 3, 'Q2'],
    ]);
    expect(got[0]!.lid).toBe('n1');
    expect(got[0]!.mode).toBe('heading');
    off();
  });

  it('page / log-day の 1 通', () => {
    root.innerHTML = '<p>1</p>';
    const hr = line(document.createElement('hr'), 3);
    hr.className = 'pkc-section-break';
    root.append(hr, document.createElement('p'));
    const pages: string[] = [];
    const offP = subscribeChartContext({ root, scrollRoot: null, lid: 'n', bind: { mode: 'page', level: 2 } }, (s) => pages.push(s.label));
    const anchors = collectChartAnchors(root, { mode: 'page', level: 2 }).map((a) => a.el);
    ios[0]!.report(anchors, ['above', 'in']);
    expect(pages).toEqual(['ページ 2 / 2']);
    offP();

    root.innerHTML = '';
    const days: string[] = [];
    for (const t of ['2026-11-18 09:00', '2026-11-18 10:00', '2026-11-20 08:00']) {
      const h = line(document.createElement('h2'), 1);
      h.textContent = t;
      root.append(h);
    }
    const offD = subscribeChartContext({ root, scrollRoot: null, lid: 'n', bind: { mode: 'log-day', level: 2 } }, (s) => days.push(s.key));
    const els = [...root.querySelectorAll('h2')];
    ios[1]!.report(els, ['above', 'in', 'below']);
    ios[1]!.report(els, ['above', 'above', 'in']);
    expect(days).toEqual(['2026-11-18', '2026-11-20']);
    offD();
  });

  it('🔴 聞く人が 0 になったら disconnect する(定常コスト 0)・同じ本文は 1 本を共有する', () => {
    headingBody();
    expect(liveChartContextWatches()).toBe(0);
    const bind = { mode: 'heading', level: 2 } as const;
    const a: string[] = [];
    const b: string[] = [];
    const offA = subscribeChartContext({ root, scrollRoot: null, lid: 'n', bind }, (s) => a.push(s.key));
    ios[0]!.report(collectChartAnchors(root, bind).map((x) => x.el), ['above', 'in', 'below']);
    // 後から来た人には今の現在地をすぐ送る
    const offB = subscribeChartContext({ root, scrollRoot: null, lid: 'n', bind }, (s) => b.push(s.key));
    expect(ios).toHaveLength(1);
    expect(b).toEqual(['1']);
    expect(liveChartContextWatches()).toBe(1);
    offA();
    expect(ios[0]!.disconnected).toBe(false);
    offB();
    offB(); // 2 度抜けても数を壊さない
    expect(ios[0]!.disconnected).toBe(true);
    expect(liveChartContextWatches()).toBe(0);
    // 抜けた後にまた聞けば作り直す
    const offC = subscribeChartContext({ root, scrollRoot: null, lid: 'n', bind }, () => undefined);
    expect(ios).toHaveLength(2);
    offC();
    expect(liveChartContextWatches()).toBe(0);
  });

  it('本文の塊が差し替わったら目印を集め直す', async () => {
    headingBody();
    const off = subscribeChartContext({ root, scrollRoot: null, lid: 'n', bind: { mode: 'heading', level: 2 } }, () => undefined);
    expect(ios[0]!.targets.size).toBe(3);
    const h = line(document.createElement('h2'), 50);
    h.textContent = 'Q4';
    root.append(h);
    await new Promise((r) => setTimeout(r, 5));
    expect(ios[0]!.targets.size).toBe(4);
    expect(ios[0]!.targets.has(h)).toBe(true);
    off();
  });
});

describe('目印へ動かす(双方向)', () => {
  it('スクロールの器を固定したグラフの高さぶん下げて動かす・動きを減らす設定では即時', () => {
    const hs = headingBody();
    const scroller = document.createElement('div');
    const calls: ScrollToOptions[] = [];
    scroller.scrollTo = ((o: ScrollToOptions) => calls.push(o)) as typeof scroller.scrollTo;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 100 });
    scroller.getBoundingClientRect = () => ({ top: 50 }) as DOMRect;
    hs[2]!.getBoundingClientRect = () => ({ top: 650 }) as DOMRect;
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    expect(scrollToChartContext(root, { mode: 'heading', level: 2 }, { index: 2 }, { scrollRoot: scroller, offset: 200 })).toBe(true);
    expect(calls).toEqual([{ top: 650 - 50 + 100 - 200 - 8, behavior: 'auto' }]);
    expect(scrollToChartContext(root, { mode: 'heading', level: 2 }, { index: 9 }, { scrollRoot: scroller })).toBe(false);
  });
});
