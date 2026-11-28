/** @vitest-environment happy-dom */
/**
 * 🔴 GPU グラフの別ウィンドウ(v4.1 PR-9、#2095 後半)── 親(`ChartPopoutHost` + 器の配線)と別ウィンドウ
 * (`bootChartPopoutWindow`)の**実物どうし**を偽の放送路(同じ名前の口へ配る)で繋いで突き合わせる
 * (`pdf-window.test.ts` と同じ規律 ── 片方だけ改名すると機構ごと死ぬので、literal を両側で pin するだけでは足りない)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GPU_CHART_SRC_ATTR, hydrateGpuChart, setGpuChartTestHooks } from '../../src/adapter/ui/render/gpu-chart';
import type { GpuSurface } from '../../src/adapter/platform/render/gpu-lease';
import {
  CHART_POPOUT_BLOCKED,
  ChartPopoutHost,
  SOURCE_CLOSED_NOTE,
  setChartPopoutHostForTest,
  type ChartBroadcaster,
} from '../../src/adapter/platform/chart-popout';
import {
  bootChartPopoutWindow,
  POPOUT_FIXED_TEXT,
  POPOUT_NO_SOURCE_TEXT,
  type ChartPopoutWindowHandle,
} from '../../src/adapter/ui/render/chart-popout-window';
import {
  GPU_CHART_POPOUT_FAILED_EVENT,
  REATTACH_GRACE_MS,
  resetChartPopoutLinksForTest,
} from '../../src/adapter/ui/render/gpu-chart-popout-link';
import {
  CHART_POPOUT_FEATURES,
  CHART_POPOUT_HELLO_MS,
  CHART_SYNC_CHANNEL,
  makeChartSyncMessage,
  parseChartPopoutToken,
} from '../../src/features/chart/gpu-chart-sync';
import { CHART_CONTEXT_ROOT_MARGIN } from '../../src/adapter/ui/render/chart-context-watch';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

// ───────────────────────────── 偽の放送路(同じ名前の口へ、自分以外に配る ── BroadcastChannel と同じ)

class Hub {
  ends: End[] = [];
  /** 送られた便り(名前つき)。 */
  log: Array<{ name: string; data: unknown }> = [];
  make = (name: string): ChartBroadcaster => {
    const e = new End(this, name);
    this.ends.push(e);
    return e;
  };
  /** 開いている口の数。 */
  open(name = CHART_SYNC_CHANNEL): number {
    return this.ends.filter((e) => !e.closed && e.name === name).length;
  }
}
class End implements ChartBroadcaster {
  closed = false;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(
    private readonly hub: Hub,
    readonly name: string,
  ) {}
  postMessage(data: unknown): void {
    if (this.closed) throw new Error('closed channel');
    const copy = structuredClone(data);
    this.hub.log.push({ name: this.name, data: copy });
    for (const e of this.hub.ends) {
      if (e === this || e.closed || e.name !== this.name) continue;
      e.onmessage?.({ data: structuredClone(copy) } as MessageEvent);
    }
  }
  close(): void {
    this.closed = true;
  }
}

// ───────────────────────────── 偽の描画面(GPU は使わない ── 描き直しを数える)

function fakeFactory(): GpuSurface {
  const s: GpuSurface = {
    state: 'idle',
    invalidate() {},
    setPinned() {},
    dispose() {},
  } as unknown as GpuSurface;
  return s;
}

/** 器の「見えた」はすぐ・本文の目印は手で報告(`gpu-chart.test.ts` と同じ形)。 */
let ctxIos: CtxIo[] = [];
class CtxIo {
  targets = new Set<Element>();
  constructor(
    readonly cb: (e: unknown[]) => void,
    readonly opts: { rootMargin?: string } = {},
  ) {
    ctxIos.push(this);
  }
  get forContext(): boolean {
    return this.opts.rootMargin === CHART_CONTEXT_ROOT_MARGIN;
  }
  observe(el: Element): void {
    this.targets.add(el);
    if (!this.forContext) this.cb([{ target: el, isIntersecting: true, boundingClientRect: { top: 0, bottom: 1 }, rootBounds: { top: 0 } }]);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
  }
  readTo(els: Element[], at: number): void {
    this.cb(
      els.map((target, i) => ({
        target,
        isIntersecting: i === at,
        boundingClientRect: i < at ? { top: -200, bottom: -100 } : { top: 600, bottom: 620 },
        rootBounds: { top: 0 },
      })),
    );
  }
}

const BOUND_BODY = [
  '```chart live',
  '{"type":"bar","title":"四半期","bind":"heading"}',
  '```',
  '## Q1',
  '| 月 | 売上 |',
  '|---|---|',
  '| 1月 | 10 |',
  '| 2月 | 20 |',
  '## Q2',
  '| 月 | 件数 |',
  '|---|---|',
  '| 4月 | 3 |',
  '| 5月 | 4 |',
  '## Q3',
  '表はありません',
].join('\n');

const STATIC_BODY = '```chart live\n{"type":"line","title":"センサー","datasets":[{"label":"温度","data":[1,2,3,4]}]}\n```\n';

// ───────────────────────────── 1 回の試験の舞台

interface Popout {
  token: string;
  url: string;
  features: string;
  doc: Document;
  root: HTMLElement;
  handle: ChartPopoutWindowHandle;
  win: EventTarget;
}

let hub: Hub;
let host: ChartPopoutHost;
let page: HTMLElement;
let popouts: Popout[];
/** 窓を開いても名乗らない(ポップアップが止められた)。 */
let blockPopups = false;
let timers: Array<{ fn: () => void; ms: number; done: boolean }>;
let themeFns: Array<() => void>;
let themeWatchers = 0;
let pageHideWatchers = 0;
let pageHideFns: Array<() => void>;

function runTimers(ms: number): void {
  for (const t of [...timers]) {
    if (t.done || t.ms > ms) continue;
    t.done = true;
    t.fn();
  }
}

function openPopoutWindow(url: string, features: string): void {
  if (blockPopups) return;
  const token = parseChartPopoutToken(url)!;
  // 🔑 別の document(別ウィンドウ)── 配色の属性が親と混ざらない
  const doc = document.implementation.createHTMLDocument('popout');
  const root = doc.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  doc.body.append(root);
  const win = new EventTarget();
  const handle = bootChartPopoutWindow(root, token, {
    makeChannel: hub.make,
    win: win as unknown as Window,
    setTimer: (fn, ms) => {
      const t = { fn, ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { done: boolean }).done = true;
    },
  });
  popouts.push({ token, url, features, doc, root, handle, win });
}

beforeEach(() => {
  hub = new Hub();
  popouts = [];
  blockPopups = false;
  timers = [];
  themeFns = [];
  themeWatchers = 0;
  pageHideWatchers = 0;
  pageHideFns = [];
  ctxIos = [];
  vi.stubGlobal('IntersectionObserver', CtxIo);
  setGpuChartTestHooks({ createSurface: fakeFactory, reducedMotion: () => true });
  let seq = 0;
  host = new ChartPopoutHost({
    makeChannel: hub.make,
    openWindow: openPopoutWindow,
    baseUrl: () => 'https://pkc.test/app/',
    newToken: () => `tok${String(++seq).padStart(6, '0')}`,
    setTimer: (fn, ms) => {
      const t = { fn, ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { done: boolean }).done = true;
    },
    readTheme: () => ({
      theme: document.documentElement.getAttribute('data-pkc-theme'),
      tone: document.documentElement.getAttribute('data-pkc-tone'),
      accent: document.documentElement.getAttribute('data-pkc-accent'),
    }),
    watchTheme: (fn) => {
      themeWatchers += 1;
      themeFns.push(fn);
      return () => {
        themeWatchers -= 1;
        themeFns = themeFns.filter((f) => f !== fn);
      };
    },
    watchPageHide: (fn) => {
      pageHideWatchers += 1;
      pageHideFns.push(fn);
      return () => {
        pageHideWatchers -= 1;
        pageHideFns = pageHideFns.filter((f) => f !== fn);
      };
    },
  });
  setChartPopoutHostForTest(host);
  page = document.createElement('div');
  document.body.append(page);
  document.documentElement.setAttribute('data-pkc-theme', 'light');
  document.documentElement.setAttribute('data-pkc-tone', 'light');
});

afterEach(() => {
  for (const p of popouts) p.handle.close();
  setChartPopoutHostForTest(null);
  resetChartPopoutLinksForTest();
  setGpuChartTestHooks(null);
  page.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function note(body: string, lid = 'n1'): { root: HTMLElement; scope: ReturnType<typeof hydrateGpuChart>; chart: HTMLElement; heads: Element[]; io: () => CtxIo } {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-field', 'detail-body');
  root.className = 'pkc-md-rendered';
  root.innerHTML = renderMarkdown(body, { sourceLineAnchors: true });
  page.append(root);
  const scope = hydrateGpuChart(root, { getNoteBody: () => body, noteLid: lid, scrollRoot: null, getNoteTitle: () => '週報' });
  const chart = root.querySelector<HTMLElement>(`[${GPU_CHART_SRC_ATTR}]`)!;
  return { root, scope, chart, heads: [...root.querySelectorAll('h2')], io: () => ctxIos.find((i) => i.forContext)! };
}

const popoutBtn = (chart: HTMLElement): HTMLButtonElement => chart.querySelector<HTMLButtonElement>('[data-pkc-field="gpu-chart-popout"]')!;
const q = <T extends Element = HTMLElement>(p: Popout, sel: string): T => p.root.querySelector<T>(sel)!;
const popAria = (p: Popout): string => q(p, '[data-pkc-gpu-chart-stage]').getAttribute('aria-label') ?? '';
const popLabel = (p: Popout): string => q(p, '[data-pkc-field="chart-popout-bind"]').textContent ?? '';
const kindsSent = (): string[] => hub.log.map((l) => (l.data as Record<string, string>).pkc3Chart!);

describe('🔴 開く(noopener・名乗り・一式)', () => {
  it('非連動のグラフ: 「別ウィンドウで開く」→ noopener の窓 → hello → init → 別ウィンドウにグラフ', () => {
    const { scope, chart } = note(STATIC_BODY);
    const btn = popoutBtn(chart);
    expect(btn.textContent).toBe('別ウィンドウで開く');
    expect(btn.getAttribute('data-pkc-variant')).toBe('ghost');
    // 🔴 押すまで放送路は 0 本
    expect(hub.open()).toBe(0);
    btn.click();
    expect(popouts).toHaveLength(1);
    const p = popouts[0]!;
    expect(p.features).toBe(CHART_POPOUT_FEATURES);
    expect(p.features).toContain('noopener');
    expect(p.url).toBe(`https://pkc.test/app/#pkc?chart=${p.token}`);
    expect(kindsSent()).toEqual(['hello', 'init']);
    expect(host.isReady(p.token)).toBe(true);
    expect(popAria(p)).toContain('温度');
    expect(p.doc.title).toBe('センサー - 週報 | PKC3');
    expect(q(p, '.pkc-chart-popout-bind').hidden).toBe(true); // 連動の操作は出さない
    expect(q(p, '[data-pkc-region="chart-popout-stage"]').querySelector('[data-pkc-gpu-chart]')).not.toBeNull();
    // 🔑 別ウィンドウには「別ウィンドウで開く」を付けない
    expect(p.root.querySelector('[data-pkc-field="gpu-chart-popout"]')).toBeNull();
    scope.dispose();
  });

  it('連動グラフ: 親の閲覧位置で一式を作る・連動の表示と前へ / 次へが出る', () => {
    const { scope, chart, heads, io } = note(BOUND_BODY);
    io().readTo(heads, 1);
    popoutBtn(chart).click();
    const p = popouts[0]!;
    expect(popLabel(p)).toBe('連動: Q2 (2 / 3)');
    expect(popAria(p)).toContain('件数');
    expect(q(p, '.pkc-chart-popout-bind').hidden).toBe(false);
    expect(q<HTMLButtonElement>(p, '[data-pkc-field="chart-popout-prev"]').disabled).toBe(false);
    expect(q<HTMLButtonElement>(p, '[data-pkc-field="chart-popout-follow"]').textContent).toBe('追従 ON');
    expect(p.doc.title).toBe('四半期 - 週報 | PKC3');
    scope.dispose();
  });
});

describe('🔴 連動(追従 ON / 固定中)', () => {
  it('親を読み進めると別ウィンドウが切り替わる ── 固定中は変わらず、解除すると最新へ追従する', () => {
    const { scope, chart, heads, io } = note(BOUND_BODY);
    popoutBtn(chart).click();
    const p = popouts[0]!;
    expect(popLabel(p)).toBe('連動: Q1 (1 / 3)');
    io().readTo(heads, 1);
    expect(popLabel(p)).toBe('連動: Q2 (2 / 3)');
    expect(popAria(p)).toContain('件数');
    // データの無い節は理由を出して古い絵を隠す
    io().readTo(heads, 2);
    expect(q(p, '[data-pkc-gpu-chart]').hasAttribute('data-pkc-gpu-chart-empty')).toBe(true);
    expect(q(p, '[data-pkc-field="gpu-chart-empty"]').textContent).toBe('この節には対象データがありません');
    io().readTo(heads, 0);
    expect(popAria(p)).toContain('売上');
    // 固定
    const follow = q<HTMLButtonElement>(p, '[data-pkc-field="chart-popout-follow"]');
    follow.click();
    expect(follow.textContent).toBe('固定中');
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    expect(q(p, '[data-pkc-field="chart-popout-status"]').textContent).toBe(POPOUT_FIXED_TEXT);
    io().readTo(heads, 1);
    expect(popLabel(p)).toBe('連動: Q1 (1 / 3)');
    expect(popAria(p)).toContain('売上');
    // 解除 → 最新(Q2)へ
    follow.click();
    expect(follow.textContent).toBe('追従 ON');
    expect(popLabel(p)).toBe('連動: Q2 (2 / 3)');
    expect(popAria(p)).toContain('件数');
    scope.dispose();
  });

  it('🔑 親が固定中でも、別ウィンドウには親の閲覧位置を配る(判断は別ウィンドウ側)', () => {
    const { scope, chart, heads, io } = note(BOUND_BODY);
    chart.querySelector<HTMLButtonElement>('[data-pkc-field="gpu-chart-follow"]')!.click(); // 親を固定
    popoutBtn(chart).click();
    const p = popouts[0]!;
    io().readTo(heads, 1);
    expect(chart.querySelector('[data-pkc-gpu-chart]')!.getAttribute('data-pkc-gpu-chart-bind-key')).toBe('0'); // 親は動かない
    expect(popLabel(p)).toBe('連動: Q2 (2 / 3)'); // 別ウィンドウは追従
    scope.dispose();
  });

  it('🔴 別ウィンドウの前へ / 次へ → 親の本文がその見出しへ動く(双方向)・固定中でも押した時点を見せる', () => {
    const { scope, chart, heads } = note(BOUND_BODY);
    const scrolled: Element[] = [];
    for (const h of heads) (h as HTMLElement).scrollIntoView = (() => scrolled.push(h)) as never;
    popoutBtn(chart).click();
    const p = popouts[0]!;
    const prev = q<HTMLButtonElement>(p, '[data-pkc-field="chart-popout-prev"]');
    const next = q<HTMLButtonElement>(p, '[data-pkc-field="chart-popout-next"]');
    expect(prev.disabled).toBe(true);
    next.click();
    expect(scrolled).toEqual([heads[1]]);
    expect(popLabel(p)).toBe('連動: Q2 (2 / 3)');
    expect(kindsSent()).toContain('jump');
    // 固定中でも押した時点は見せる
    q<HTMLButtonElement>(p, '[data-pkc-field="chart-popout-follow"]').click();
    next.click();
    expect(scrolled).toEqual([heads[1], heads[2]]);
    expect(popLabel(p)).toBe('連動: Q3 (3 / 3)');
    expect(next.disabled).toBe(true);
    // 連動の表示を押すと本文をその場所へ
    q<HTMLButtonElement>(p, '[data-pkc-field="chart-popout-bind"]').click();
    expect(scrolled).toEqual([heads[1], heads[2], heads[2]]);
    scope.dispose();
  });
});

describe('🔴 配色の同期', () => {
  it('親の配色が変わると別ウィンドウの <html> の 3 つの属性が揃う(別ウィンドウ 0 枚なら見張り 0)', () => {
    expect(themeWatchers).toBe(0);
    const { scope, chart } = note(STATIC_BODY);
    popoutBtn(chart).click();
    const p = popouts[0]!;
    expect(themeWatchers).toBe(1);
    expect(p.doc.documentElement.getAttribute('data-pkc-theme')).toBe('light');
    document.documentElement.setAttribute('data-pkc-theme', 'solarized-dark');
    document.documentElement.setAttribute('data-pkc-tone', 'dark');
    document.documentElement.setAttribute('data-pkc-accent', 'green');
    for (const f of themeFns) f();
    expect(p.doc.documentElement.getAttribute('data-pkc-theme')).toBe('solarized-dark');
    expect(p.doc.documentElement.getAttribute('data-pkc-tone')).toBe('dark');
    expect(p.doc.documentElement.getAttribute('data-pkc-accent')).toBe('green');
    // 変わっていなければ送らない
    const before = hub.log.length;
    for (const f of themeFns) f();
    expect(hub.log.length).toBe(before);
    scope.dispose();
    document.documentElement.removeAttribute('data-pkc-accent');
  });
});

describe('🔴 混線 0', () => {
  it('別の token(別のタブの別ウィンドウ)宛ての便りは受けない', () => {
    const { scope, chart, heads, io } = note(BOUND_BODY);
    popoutBtn(chart).click();
    const p = popouts[0]!;
    const stranger = hub.make(CHART_SYNC_CHANNEL);
    const other = 'otherTab0001';
    // 親宛て: 他人の jump / closed は無視
    stranger.postMessage(makeChartSyncMessage({ kind: 'closed', token: other }));
    stranger.postMessage(makeChartSyncMessage({ kind: 'jump', token: other, payload: { index: 2, key: '2' } }));
    expect(host.has(p.token)).toBe(true);
    // 別ウィンドウ宛て: 他人の update / source-closed は無視
    stranger.postMessage(
      makeChartSyncMessage({ kind: 'update', token: other, payload: { spec: null, emptyReason: '他人', label: 'X', index: 2, total: 3, animate: false } }),
    );
    stranger.postMessage(makeChartSyncMessage({ kind: 'source-closed', token: other, payload: { reason: '他人' } }));
    expect(popLabel(p)).toBe('連動: Q1 (1 / 3)');
    expect(p.handle.connected).toBe(true);
    // 壊れた便りも無視
    stranger.postMessage({ pkc3Chart: 'update', token: p.token, payload: { spec: { v: 1, type: 'pie' } } });
    expect(popAria(p)).toContain('売上');
    io().readTo(heads, 1);
    expect(popLabel(p)).toBe('連動: Q2 (2 / 3)');
    stranger.close();
    scope.dispose();
  });
});

describe('🔴 開けなかった(ポップアップが止められた)', () => {
  it('名乗りが来なければ理由を出し、上へ伝え、放送路を閉じる(無言の dead click にしない)', () => {
    blockPopups = true;
    const { scope, chart } = note(STATIC_BODY);
    const failed: string[] = [];
    page.addEventListener(GPU_CHART_POPOUT_FAILED_EVENT, (e) => failed.push((e as CustomEvent<{ message: string }>).detail.message));
    popoutBtn(chart).click();
    expect(hub.open()).toBe(1);
    expect(chart.querySelector('[data-pkc-gpu-chart-info="hover"]')!.textContent).toBe('別ウィンドウを開いています…');
    runTimers(CHART_POPOUT_HELLO_MS - 1);
    expect(host.sessionCount).toBe(1);
    runTimers(CHART_POPOUT_HELLO_MS);
    expect(host.sessionCount).toBe(0);
    expect(hub.open()).toBe(0);
    expect(failed).toEqual([CHART_POPOUT_BLOCKED]);
    expect(chart.querySelector('[data-pkc-gpu-chart-info="hover"]')!.textContent).toBe(CHART_POPOUT_BLOCKED);
    expect(themeWatchers).toBe(0);
    expect(pageHideWatchers).toBe(0);
    scope.dispose();
  });

  it('放送路が無い環境では窓を開かずに理由を返す', () => {
    const h2 = new ChartPopoutHost({ makeChannel: () => null, openWindow: openPopoutWindow });
    setChartPopoutHostForTest(h2);
    const { scope, chart } = note(STATIC_BODY);
    const failed: string[] = [];
    page.addEventListener(GPU_CHART_POPOUT_FAILED_EVENT, (e) => failed.push((e as CustomEvent<{ message: string }>).detail.message));
    popoutBtn(chart).click();
    expect(popouts).toHaveLength(0);
    expect(failed).toHaveLength(1);
    scope.dispose();
  });

  it('別ウィンドウ側: 一式が届かなければ案内を出して放送路を閉じる(親が既に閉じた等)', () => {
    blockPopups = false;
    // 親のいない別ウィンドウ(F5 で読み直した・親が閉じた)
    openPopoutWindow('https://pkc.test/app/#pkc?chart=orphan000001', CHART_POPOUT_FEATURES);
    const p = popouts[0]!;
    expect(hub.open()).toBe(1);
    runTimers(CHART_POPOUT_HELLO_MS);
    expect(q(p, '[data-pkc-field="chart-popout-status"]').textContent).toBe(POPOUT_NO_SOURCE_TEXT);
    expect(hub.open()).toBe(0);
  });
});

describe('🔴 定常コスト 0(閉じたら放送路を返す)', () => {
  it('別ウィンドウを閉じる → closed → セッション 0 件 → 放送路を close・見張りも 0', () => {
    const { scope, chart } = note(STATIC_BODY);
    popoutBtn(chart).click();
    const p = popouts[0]!;
    expect(hub.open()).toBe(2); // 親 + 別ウィンドウ
    expect(themeWatchers).toBe(1);
    expect(pageHideWatchers).toBe(1);
    p.win.dispatchEvent(new Event('pagehide'));
    expect(kindsSent().at(-1)).toBe('closed');
    expect(host.sessionCount).toBe(0);
    expect(hub.open()).toBe(0);
    expect(themeWatchers).toBe(0);
    expect(pageHideWatchers).toBe(0);
    expect(p.handle.view).toBeNull();
    // 静止している間は 1 通も送らない
    const n = hub.log.length;
    scope.dispose();
    expect(hub.log.length).toBe(n);
  });

  it('親が閉じる(pagehide)→ 全ての別ウィンドウへ source-closed → 放送路を close', () => {
    const { scope, chart } = note(STATIC_BODY);
    popoutBtn(chart).click();
    popoutBtn(chart).click();
    expect(host.sessionCount).toBe(2);
    for (const f of [...pageHideFns]) f();
    expect(kindsSent().filter((k) => k === 'source-closed')).toHaveLength(2);
    expect(host.sessionCount).toBe(0);
    expect(hub.open()).toBe(0);
    for (const p of popouts) {
      expect(p.root.hasAttribute('data-pkc-chart-popout-detached')).toBe(true);
      expect(q(p, '[data-pkc-field="chart-popout-status"]').textContent).toBe(SOURCE_CLOSED_NOTE);
    }
    scope.dispose();
  });
});

describe('🔴 親のノート切替・描き直し', () => {
  it('別のノートへ移った(器が畳まれ、置き直されない)→ source-closed ── 別ウィンドウのグラフは消えず操作できる', () => {
    vi.useFakeTimers();
    const { scope, chart } = note(BOUND_BODY);
    popoutBtn(chart).click();
    const p = popouts[0]!;
    scope.dispose();
    expect(host.sessionCount).toBe(1); // 置き直しを待つ
    vi.advanceTimersByTime(REATTACH_GRACE_MS + 1);
    expect(host.sessionCount).toBe(0);
    expect(hub.open()).toBe(0);
    expect(p.handle.connected).toBe(false);
    expect(q(p, '[data-pkc-field="chart-popout-status"]').textContent).toBe(SOURCE_CLOSED_NOTE);
    // グラフは残り、操作できる(拡大)
    expect(p.handle.view).not.toBeNull();
    expect(popAria(p)).toContain('売上');
    const before = p.handle.view!.range;
    q<HTMLButtonElement>(p, '[data-pkc-gpu-chart-op="zoom-in"]').click();
    expect(p.handle.view!.range).not.toEqual(before);
    // 前へ / 次へ・追従は押せない
    expect(q<HTMLButtonElement>(p, '[data-pkc-field="chart-popout-next"]').disabled).toBe(true);
    expect(q<HTMLButtonElement>(p, '[data-pkc-field="chart-popout-follow"]').disabled).toBe(true);
  });

  it('🔑 保存で器が作り直された(同じノートの同じ順番のグラフ)→ 切らずに引き継ぎ、新しいデータを送る', () => {
    vi.useFakeTimers();
    const first = note(STATIC_BODY);
    popoutBtn(first.chart).click();
    const p = popouts[0]!;
    expect(popAria(p)).toContain('温度');
    first.scope.dispose();
    first.root.remove();
    const second = note(STATIC_BODY.replace('温度', '湿度'));
    expect(host.sessionCount).toBe(1);
    vi.advanceTimersByTime(REATTACH_GRACE_MS + 1);
    expect(host.sessionCount).toBe(1); // 切れていない
    expect(popAria(p)).toContain('湿度');
    expect(p.handle.connected).toBe(true);
    second.scope.dispose();
  });

  it('🔑 連動グラフも引き継ぐ ── 保存で節が増えた本文の時点と名前の一覧を、次の閲覧位置で送る(1 つ目へ一瞬戻さない)', () => {
    vi.useFakeTimers();
    const first = note(BOUND_BODY);
    first.io().readTo(first.heads, 1);
    popoutBtn(first.chart).click();
    const p = popouts[0]!;
    expect(popLabel(p)).toBe('連動: Q2 (2 / 3)');
    first.scope.dispose();
    first.root.remove();
    ctxIos = [];
    const saved = BOUND_BODY.replace('| 月 | 件数 |', '| 月 | 来客数 |') + '\n## Q4\n| 月 | 返品 |\n|---|---|\n| 10月 | 1 |\n';
    const second = note(saved);
    // 閲覧位置が届く前は、別ウィンドウは前の絵のまま
    expect(popLabel(p)).toBe('連動: Q2 (2 / 3)');
    second.io().readTo(second.heads, 1);
    expect(popLabel(p)).toBe('連動: Q2 (2 / 4)');
    expect(popAria(p)).toContain('来客数');
    vi.advanceTimersByTime(REATTACH_GRACE_MS + 1);
    expect(host.sessionCount).toBe(1);
    // 増えた節へも次へで行ける
    q<HTMLButtonElement>(p, '[data-pkc-field="chart-popout-next"]').click();
    q<HTMLButtonElement>(p, '[data-pkc-field="chart-popout-next"]').click();
    expect(popLabel(p)).toBe('連動: Q4 (4 / 4)');
    expect(popAria(p)).toContain('返品');
    second.scope.dispose();
  });
});
