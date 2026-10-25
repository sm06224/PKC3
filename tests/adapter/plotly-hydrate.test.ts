/** @vitest-environment happy-dom */
/**
 * plotly の器を PNG で埋める(#528 ①)── chart と同じ型に乗っているか。
 *
 * 守る主張:
 * 1. 埋めるのは `<img>` 1 枚(SVG / canvas を本文に置かない)/ 保存(SVG)の導線は出さない
 * 2. 焼くのは**箱(`WorkerLease` 越しの worker 役)**へ 1 件だけ。読めない本文では**起こさない**
 * 3. 鍵: 種類 `plotly` + 産出器 + 原文 + 幅 + dpr + 配色(他の絵と取り違えない)
 * 4. 箱へ渡す設定: 配色が既定として敷かれ、**本文の指定が勝つ**。大きさは呼び側(幅)が決める
 * 5. 読めない理由は日本語で出て原文が残る / 箱の起動の失敗は日本語 / 取りこぼしは note
 * 6. 畳むと貸した URL を返す
 * 7. 書き出し・押して拡大でも chart と同じ産出器の経路に乗る(`PLOTLY_KIND.render`)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagramPalette, RasterKey } from '../../src/adapter/ui/render/mermaid-raster';

const seenKeys: RasterKey[] = [];
vi.mock('../../src/adapter/ui/render/mermaid-raster', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/adapter/ui/render/mermaid-raster')>();
  return {
    ...real,
    readPalette: () => ({ bg: '#fff', alt: '#eee', fg: '#000', line: '#666', border: '#ccc', accent: '#080', dark: false }),
    renderCachedPng: vi.fn(async (key: RasterKey, produce: () => Promise<{ png: Blob; cssWidth: number }>) => {
      seenKeys.push(key);
      return produce();
    }),
  };
});

import { cacheKey } from '../../src/adapter/ui/render/mermaid-raster';
import {
  PLOTLY_ENGINE,
  PLOTLY_KIND,
  mergeLayout,
  paletteLayout,
  plotlyHeightFor,
  setPlotlyFrameSpawn,
} from '../../src/adapter/ui/render/plotly-raster';
import { hydrateFigures } from '../../src/adapter/ui/render/detail';

const FIG = '{"data":[{"type":"bar","x":["a"],"y":[1]}],"layout":{"title":"T"}}';
const PALETTE: DiagramPalette = { bg: '#fff', alt: '#eee', fg: '#000', line: '#666', border: '#ccc', accent: '#080', dark: false };

describe('plotly の器を埋める', () => {
  let scope: { dispose(): void; prune(): number } | null = null;
  const urls: string[] = [];
  const revoked: string[] = [];

  beforeEach(() => {
    document.body.innerHTML = '';
    urls.length = 0;
    revoked.length = 0;
    seenKeys.length = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const u = `blob:plotly-${String(urls.length)}`;
      urls.push(u);
      return u;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.push(u));
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private readonly cb: (e: unknown[]) => void) {}
        observe(el: Element): void {
          this.cb([{ isIntersecting: true, target: el }]);
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });
  afterEach(() => {
    scope?.dispose();
    scope = null;
    setPlotlyFrameSpawn(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function fakeWorker(onJob: (payload: unknown) => void, reply: 'ok' | 'dead' = 'ok') {
    class FakeWorker {
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: ErrorEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      postMessage(msg: { id: number; payload: unknown }): void {
        onJob(msg.payload);
        if (reply === 'dead') {
          queueMicrotask(() => this.onerror?.({ message: '' } as ErrorEvent));
          return;
        }
        queueMicrotask(() =>
          this.onmessage?.({
            data: { id: msg.id, ok: true, result: { png: new Uint8Array([1, 2, 3]).buffer, cssWidth: 320 } },
          } as MessageEvent),
        );
      }
      terminate(): void {}
    }
    return () => new FakeWorker() as unknown as Worker;
  }

  async function mount(source: string, reply: 'ok' | 'dead' = 'ok') {
    const jobs: Array<Record<string, unknown>> = [];
    setPlotlyFrameSpawn(fakeWorker((j) => jobs.push(j as Record<string, unknown>), reply));
    const host = document.createElement('div');
    host.className = 'pkc-plotly-placeholder';
    host.setAttribute('data-pkc-plotly-src', source);
    const pre = document.createElement('pre');
    pre.className = 'pkc-plotly-source';
    pre.textContent = source;
    host.append(pre);
    document.body.append(host);
    // 🔑 読む面と同じ口(`hydrateFigures`)から呼ぶ ── 束ねの口に plotly が入っていることも見る
    const scopes = hydrateFigures([host]);
    scope = { dispose: () => scopes.forEach((s) => s.dispose()), prune: () => 0 };
    for (let i = 0; i < 30; i += 1) await new Promise((r) => setTimeout(r, 0));
    return { host, jobs };
  }

  it('🔴 img 1 枚で埋まり、箱へ 1 件だけ投げる。SVG / canvas / 保存の導線は無い', async () => {
    const { host, jobs } = await mount(FIG);
    const img = host.querySelector('img');
    expect(img, 'img が入っていない').not.toBeNull();
    expect(img!.getAttribute('data-pkc-field')).toBe('plotly-image');
    expect(host.querySelector('canvas, svg')).toBeNull();
    expect(host.querySelector('[data-pkc-action="export-diagram"]'), '押せない保存の導線').toBeNull();
    expect(host.getAttribute('data-pkc-plotly-state')).toBe('ready');
    expect(jobs).toHaveLength(1);
    // 🔑 押すと大きく見られる(図・グラフと同じ口)
    expect(img!.getAttribute('data-pkc-action')).toBe('view-big');
  });

  it('🔴 鍵: 種類・産出器・原文・幅・dpr・配色が入る(1 つでも変われば別の絵)', async () => {
    await mount(FIG);
    const k = seenKeys[0]!;
    expect(k).toMatchObject({ kind: 'plotly', engine: PLOTLY_ENGINE, source: FIG });
    const base = cacheKey(k);
    for (const changed of [
      { ...k, source: `${FIG} ` },
      { ...k, width: k.width + 16 },
      { ...k, dpr: k.dpr + 1 },
      { ...k, engine: 'plotly.js-next' },
      { ...k, kind: 'chart' },
      { ...k, palette: { ...k.palette, bg: '#000' } },
    ])
      expect(cacheKey(changed), JSON.stringify(Object.keys(changed))).not.toBe(base);
  });

  it('🔴 箱へ渡す設定: 配色が既定で敷かれ、本文の指定が勝ち、大きさは呼び側が決める', async () => {
    const { jobs } = await mount(
      '{"data":[{"y":[1]}],"layout":{"paper_bgcolor":"#123456","width":9999,"height":300,"xaxis":{"title":"X"}}}',
    );
    const p = jobs[0] as { fig: { data: unknown[]; layout: Record<string, unknown> }; width: number; height: number; scale: number };
    expect(p.fig.layout.paper_bgcolor, '本文の指定が配色に負けた').toBe('#123456');
    expect(p.fig.layout.plot_bgcolor, '配色の既定が敷かれていない').toBe('#fff');
    expect((p.fig.layout.font as { color: string }).color).toBe('#000');
    expect(Array.isArray(p.fig.layout.colorway)).toBe(true);
    // 入れ子は混ぜる(本文の x 軸の題を足しても、配色の既定の格子の色は残る)
    const xaxis = p.fig.layout.xaxis as Record<string, unknown>;
    expect(xaxis.title).toBe('X');
    expect(xaxis.gridcolor).toBe('#ccc');
    // 大きさ: 幅は呼び側(器の幅)、高さは本文の layout.height(上下限つき)
    expect(p.fig.layout.width).toBe(p.width);
    expect(p.fig.layout.width).not.toBe(9999);
    expect(p.height).toBe(300);
    expect(p.fig.layout.autosize).toBe(false);
    expect(p.scale).toBeGreaterThan(0);
  });

  it('🔴 読めない本文では理由が出て原文が残り、箱は起こさない', async () => {
    const { host, jobs } = await mount('{ これは JSON ではない');
    expect(host.getAttribute('data-pkc-plotly-state')).toBe('failed');
    const msg = host.getAttribute('data-pkc-plotly-error') ?? '';
    expect(msg).toMatch(/^グラフを描けません: /);
    expect(msg).toContain('JSON');
    expect(msg).not.toMatch(/^\w*Error:/);
    expect(host.querySelector('.pkc-plotly-source'), '原文まで消した').not.toBeNull();
    expect(jobs, '読めないのに箱を起こした').toHaveLength(0);
  });

  it('🔴 箱が起動できなかった理由は日本語(英語の生の字を出さない)', async () => {
    const { host } = await mount(FIG, 'dead');
    expect(host.getAttribute('data-pkc-plotly-state')).toBe('failed');
    const msg = host.getAttribute('data-pkc-plotly-error') ?? '';
    expect(msg).toContain('裏で動く処理を起動できませんでした');
    expect(msg).not.toMatch(/^plotly: /);
  });

  it('🔴 取りこぼしがあれば note が付き、無ければ付かない', async () => {
    const many = JSON.stringify({ data: Array.from({ length: 43 }, () => ({ y: [1] })) });
    const a = await mount(many);
    expect(a.host.getAttribute('data-pkc-plotly-note') ?? '').toContain('40 本まで');
    scope?.dispose();
    document.body.innerHTML = '';
    const b = await mount(FIG);
    expect(b.host.hasAttribute('data-pkc-plotly-note')).toBe(false);
  });

  it('🔴 畳むと貸した URL を返す(生成物を残さない)', async () => {
    await mount(FIG);
    expect(urls).toHaveLength(1);
    scope?.dispose();
    scope = null;
    expect(revoked).toEqual(urls);
  });

  it('🔴 書き出し・拡大の経路(PLOTLY_KIND.render)も同じ産出器を通り、箱から PNG を受ける', async () => {
    const jobs: unknown[] = [];
    setPlotlyFrameSpawn(fakeWorker((j) => jobs.push(j)));
    const r = await PLOTLY_KIND.render({ source: FIG, kind: 'plotly', theme: 'light', palette: PALETTE, width: 720, dpr: 2 });
    expect(r.png.size).toBe(3);
    expect(jobs).toHaveLength(1);
    await expect(
      PLOTLY_KIND.render({ source: 'x', kind: 'plotly', theme: 'light', palette: PALETTE, width: 720, dpr: 2 }),
    ).rejects.toThrow('グラフを描けません');
  });
});

describe('設定の組み立て(純関数)', () => {
  it('mergeLayout: 入れ子は混ぜ、本文が勝ち、元の物を壊さない', () => {
    const base = { a: { x: 1, y: 2 }, b: 1 };
    const out = mergeLayout(base, { a: { y: 9 }, c: 3 });
    expect(out).toEqual({ a: { x: 1, y: 9 }, b: 1, c: 3 });
    expect(base).toEqual({ a: { x: 1, y: 2 }, b: 1 });
    // 配列は混ぜず置き換える
    expect(mergeLayout({ k: [1, 2] }, { k: [3] })).toEqual({ k: [3] });
  });

  it('plotlyHeightFor: 指定は上下限つき、無ければ幅から(chart と同じ比)', () => {
    expect(plotlyHeightFor(400, { height: 5 })).toBe(160);
    expect(plotlyHeightFor(400, { height: 99999 })).toBe(1200);
    expect(plotlyHeightFor(400, { height: 333.4 })).toBe(333);
    expect(plotlyHeightFor(400, {})).toBe(224);
    expect(plotlyHeightFor(400, { height: 'x' })).toBe(224);
  });

  it('paletteLayout: 地・文字・格子が配色から引かれ、系列色は系列の上限ぶんある', () => {
    const l = paletteLayout(PALETTE) as Record<string, unknown>;
    expect(l.paper_bgcolor).toBe('#fff');
    expect((l.colorway as string[]).length).toBeGreaterThanOrEqual(12);
    expect(paletteLayout({ ...PALETTE, bg: '#000', dark: true }).paper_bgcolor).toBe('#000');
  });
});
