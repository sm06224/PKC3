/** @vitest-environment happy-dom */
/**
 * 🔴 グラフの縦横の固定(v4.2 Phase 0 / PR-1)── 静的 ` ```chart ` / GPU の仕様 / 焼きの鍵 / 書き出しの焼き。
 * 優先は **JSON の明示 > 囲みの属性(`width=` / `height=`)> 既定**。無指定の出力は今までどおり。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseChartFence } from '../../src/features/markdown/chart-fence';
import { parseGpuChartSpec, GPU_CHART_DEFAULT_HEIGHT } from '../../src/features/chart/gpu-chart-spec';
import { deserializeGpuChartSpec, serializeGpuChartSpec } from '../../src/features/chart/gpu-chart-sync';
import { CHART_KIND, chartHeightFor, chartRasterSize, rasterSizeOf } from '../../src/adapter/ui/render/chart-raster';
import { cacheKey, type RasterKey } from '../../src/adapter/ui/render/mermaid-raster';
import { hydrateDiagrams, type DiagramKind } from '../../src/adapter/ui/render/mermaid-hydrate';
import { bakeFigures, type FigureBakers } from '../../src/features/export/figure-bake';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const BAR = '{"type":"bar","labels":["a","b"],"datasets":[{"data":[1,2]}]}';

describe('静的 chart の JSON(allowlist に width / height)', () => {
  it('無指定では項目ごと持たない(今までの仕様の形)', () => {
    const { spec } = parseChartFence(BAR);
    expect(spec).not.toHaveProperty('width');
    expect(spec).not.toHaveProperty('height');
  });

  it('数(px)・"480px"・"60%" を読み、壊れた値は無視する', () => {
    expect(parseChartFence('{"type":"bar","width":480,"height":300,"datasets":[{"data":[1]}]}').spec).toMatchObject({
      width: { value: 480, unit: 'px' },
      height: 300,
    });
    expect(parseChartFence('{"type":"bar","width":"60%","datasets":[{"data":[1]}]}').spec?.width).toEqual({ value: 60, unit: '%' });
    const bad = parseChartFence('{"type":"bar","width":"1px;x","height":"50%","datasets":[{"data":[1]}]}').spec;
    expect(bad).not.toHaveProperty('width');
    expect(bad).not.toHaveProperty('height');
  });
});

describe('焼く大きさ(chartRasterSize / rasterSizeOf)', () => {
  it('無指定は器の幅のまま・高さは産出器が幅から決める(鍵に高さを入れない)', () => {
    expect(chartRasterSize(BAR, {}, 640)).toEqual({ width: 640 });
  });

  it('囲みの属性 → px はその幅、% は基準の幅の割合(16 単位)', () => {
    expect(chartRasterSize(BAR, { width: { value: 480, unit: 'px' }, height: 200 }, 640)).toEqual({ width: 480, height: 200 });
    expect(rasterSizeOf({ width: { value: 50, unit: '%' } }, 640)).toEqual({ width: 320 });
  });

  it('🔴 JSON の明示が囲みの属性より優先', () => {
    const src = '{"type":"bar","width":300,"height":180,"datasets":[{"data":[1]}]}';
    expect(chartRasterSize(src, { width: { value: 900, unit: 'px' }, height: 500 }, 640)).toEqual({ width: 300, height: 180 });
  });

  it('鍵: 高さを固定したときだけ鍵に入る(無指定の鍵は今までと同じ字)', () => {
    const base: RasterKey = { source: 's', theme: 't', palette: { bg: '#fff', alt: '#eee', fg: '#000', line: '#111', border: '#222', accent: '#00f' } as RasterKey['palette'], width: 640, dpr: 1, kind: 'chart' };
    expect(cacheKey(base)).not.toContain('h300');
    expect(cacheKey({ ...base, height: 300 })).toContain('h300');
    expect(cacheKey({ ...base, height: 300 })).not.toBe(cacheKey(base));
    expect(chartHeightFor(640)).toBe(358);
  });

  it('CHART_KIND は大きさの口を持つ(画面の焼きと書き出しが同じ 1 本を通す)', () => {
    expect(CHART_KIND.rasterSize).toBe(chartRasterSize);
  });
});

describe('🔴 画面の焼き(hydrateDiagrams)が器の属性から鍵へ大きさを渡す', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function keysFor(md: string, withHook: boolean): Promise<RasterKey[]> {
    const keys: RasterKey[] = [];
    const kind: DiagramKind = {
      attr: 'data-pkc-chart-src',
      name: 'chart',
      imgField: 'chart-image',
      alt: () => 'g',
      render: async (key) => {
        keys.push(key);
        return { png: new Blob([new Uint8Array(3)]), cssWidth: key.width };
      },
      ...(withHook ? { rasterSize: chartRasterSize } : {}),
      savable: false,
    };
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(md);
    document.body.append(root);
    const scope = hydrateDiagrams([root], kind);
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
    scope.dispose();
    return keys;
  }

  it('```chart width=480 height=260 → 鍵の幅 480・高さ 260', async () => {
    const keys = await keysFor(`\`\`\`chart width=480 height=260\n${BAR}\n\`\`\``, true);
    expect(keys[0]!.width).toBe(480);
    expect(keys[0]!.height).toBe(260);
  });

  it('対照群: 無指定は高さを持たない / 口の無い種類(mermaid)は器の属性を見ない', async () => {
    const plain = await keysFor(`\`\`\`chart\n${BAR}\n\`\`\``, true);
    expect(plain[0]!.height).toBeUndefined();
    const noHook = await keysFor(`\`\`\`chart width=480 height=260\n${BAR}\n\`\`\``, false);
    expect(noHook[0]!.height).toBeUndefined();
    expect(noHook[0]!.width).not.toBe(480);
  });
});

describe('GPU の仕様の縦横', () => {
  const LINE = '{"type":"line","datasets":[{"data":[1,2]}]}';
  it('無指定は今までどおり(高さ 320・width を持たない)', () => {
    const r = parseGpuChartSpec(LINE);
    expect(r.ok && r.spec.height).toBe(GPU_CHART_DEFAULT_HEIGHT);
    expect(r.ok && r.spec).not.toHaveProperty('width');
  });
  it('囲みの高さは 80〜2000 で丸める・JSON の高さは今までどおり 160〜900', () => {
    const a = parseGpuChartSpec(LINE, { height: 5000 });
    expect(a.ok && a.spec.height).toBe(2000);
    const b = parseGpuChartSpec(LINE, { height: 80 });
    expect(b.ok && b.spec.height).toBe(80);
    const c = parseGpuChartSpec('{"type":"line","height":80,"datasets":[{"data":[1]}]}', { height: 500 });
    expect(c.ok && c.spec.height).toBe(160);
  });
  it('JSON の "width" > 囲みの width=', () => {
    const r = parseGpuChartSpec('{"type":"line","width":"480px","datasets":[{"data":[1]}]}', { width: { value: 60, unit: '%' } });
    expect(r.ok && r.spec.width).toEqual({ value: 480, unit: 'px' });
    const f = parseGpuChartSpec(LINE, { width: { value: 60, unit: '%' } });
    expect(f.ok && f.spec.width).toEqual({ value: 60, unit: '%' });
  });
  it('🔴 別ウィンドウへ渡すときは受け手の範囲(160〜900)に丸める ── 固定した 80px でも受け手が捨てない', () => {
    const r = parseGpuChartSpec(LINE, { height: 80 });
    if (!r.ok) throw new Error('parse');
    const back = deserializeGpuChartSpec(serializeGpuChartSpec(r.spec));
    expect(back).not.toBeNull();
    expect(back!.height).toBe(160);
  });
});

describe('🔴 書き出しの焼き(figure-bake)', () => {
  it('器の縦横の属性を焼く口へ渡し、焼いた幅で見せる・無指定は今までの字', async () => {
    const calls: { kind: string; size: unknown }[] = [];
    const bakers: FigureBakers = {
      vector: async () => null,
      raster: async (kind, _source, _paper, size) => {
        calls.push({ kind, size });
        return { blob: new Blob([new Uint8Array([1, 2, 3])]), cssWidth: size?.width?.value ?? 720 };
      },
    };
    const sized = renderMarkdown(`\`\`\`chart width=480 height=260\n${BAR}\n\`\`\``);
    const out = await bakeFigures(sized, bakers, new Map());
    expect(calls).toEqual([{ kind: 'chart', size: { width: { value: 480, unit: 'px' }, height: 260 } }]);
    expect(out).toContain('data-pkc-figure-baked="chart"');
    expect(out).toContain('style="width:480px;max-width:100%;height:auto"');
    calls.length = 0;
    const plain = await bakeFigures(renderMarkdown(`\`\`\`chart\n${BAR}\n\`\`\``), bakers, new Map());
    expect(calls).toEqual([{ kind: 'chart', size: undefined }]);
    expect(plain).toContain('data-pkc-figure-baked="chart"');
    expect(plain).not.toContain('max-width:100%');
  });

  it('同じ原文でも大きさが違えば別の絵(使い回しの鍵に大きさが入る)', async () => {
    const seen: unknown[] = [];
    const bakers: FigureBakers = {
      vector: async () => null,
      raster: async (_k, _s, _p, size) => {
        seen.push(size);
        return { blob: new Blob([new Uint8Array([1])]), cssWidth: 100 };
      },
    };
    const html =
      renderMarkdown(`\`\`\`chart height=200\n${BAR}\n\`\`\``) + renderMarkdown(`\`\`\`chart height=300\n${BAR}\n\`\`\``);
    await bakeFigures(html, bakers, new Map());
    expect(seen).toEqual([{ height: 200 }, { height: 300 }]);
  });
});
