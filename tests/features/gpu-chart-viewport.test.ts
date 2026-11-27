/**
 * 🔴 グラフの表示範囲・目盛り・当たり判定(v4.1 PR-7、#2095)── GPU と 2D が同じこれを使う。
 */
import { describe, expect, it } from 'vitest';
import {
  CHART_MIN_SPAN_RATIO,
  clampChartRange,
  categoryTicks,
  dataToPxX,
  dataToPxY,
  homeRangeOf,
  niceTicks,
  panChartViewport,
  pickChartPoint,
  pickHeatmapCell,
  visibleIndexRange,
  zoomChartViewport,
  type ChartRange,
  type PlotRect,
} from '../../src/features/chart/gpu-chart-viewport';
import { buildChartFrame, heatColor, parseCssRgb } from '../../src/features/chart/gpu-chart-frame';
import { parseGpuChartSpec, type GpuChartSpec } from '../../src/features/chart/gpu-chart-spec';

const HOME: ChartRange = { xMin: 0, xMax: 100, yMin: -10, yMax: 10 };
const RECT: PlotRect = { x: 40, y: 10, w: 400, h: 200 };

function spec(src: string): GpuChartSpec {
  const r = parseGpuChartSpec(src);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

describe('zoom / pan', () => {
  it('カーソルの下のデータは動かない(不動点)', () => {
    const cur = { xMin: 20, xMax: 60, yMin: -5, yMax: 5 };
    const ax = 0.25;
    const ay = 0.75;
    const before = { x: cur.xMin + ax * 40, y: cur.yMin + ay * 10 };
    const z = zoomChartViewport(cur, HOME, 2, ax, ay);
    expect(z.xMax - z.xMin).toBeCloseTo(20);
    expect(z.xMin + ax * (z.xMax - z.xMin)).toBeCloseTo(before.x);
    expect(z.yMin + ay * (z.yMax - z.yMin)).toBeCloseTo(before.y);
  });
  it('全体より外へは縮小しない・拡大は下限で止める', () => {
    expect(zoomChartViewport(HOME, HOME, 0.1, 0.5, 0.5)).toEqual(HOME);
    let r = HOME;
    for (let i = 0; i < 200; i++) r = zoomChartViewport(r, HOME, 10, 0.5, 0.5);
    expect(r.xMax - r.xMin).toBeGreaterThanOrEqual(100 * CHART_MIN_SPAN_RATIO * 0.999);
    expect(Number.isFinite(r.xMin)).toBe(true);
  });
  it('全体より広い範囲は全体へ戻す(はみ出しを片側へ寄せない)', () => {
    expect(clampChartRange({ xMin: -50, xMax: 200, yMin: -30, yMax: 40 }, HOME)).toEqual(HOME);
  });
  it('パン: 右へ引けば範囲は左へ・全体の外へは出ない', () => {
    const cur = { xMin: 40, xMax: 60, yMin: -2, yMax: 2 };
    const p = panChartViewport(cur, HOME, 0.5, 0);
    expect(p.xMin).toBeCloseTo(30);
    expect(p.xMax).toBeCloseTo(50);
    const far = panChartViewport(cur, HOME, 100, 0);
    expect(far.xMin).toBe(0);
    expect(far.xMax).toBeCloseTo(20);
    // 下へ引くと y は上へ(掴んだ物がついてくる)
    expect(panChartViewport(cur, HOME, 0, 0.5).yMin).toBeCloseTo(0);
  });
});

describe('niceTicks / categoryTicks', () => {
  it('1 / 2 / 5 × 10^n の刻み・浮動小数のゴミが出ない', () => {
    const t = niceTicks(0, 1, 5);
    expect(t.step).toBeCloseTo(0.2);
    expect(t.labels).toEqual(['0', '0.2', '0.4', '0.6', '0.8', '1']);
    expect(niceTicks(0.1, 0.35, 5).values).toEqual([0.1, 0.15, 0.2, 0.25, 0.3, 0.35]);
    expect(niceTicks(-1000, 50_000, 5).labels).toContain('20,000');
    expect(niceTicks(5, 5, 5).values).toEqual([]);
  });
  it('区分の軸は整数の刻みで見出しを使う', () => {
    const t = categoryTicks(-0.5, 2.5, 5, ['a', 'b', 'c']);
    expect(t.values).toEqual([0, 1, 2]);
    expect(t.labels).toEqual(['a', 'b', 'c']);
  });
});

describe('当たり判定', () => {
  const xs = Float64Array.from([0, 25, 50, 75, 100]);
  const ys = Float64Array.from([0, 5, NaN, -5, 0]);
  it('近い点を返す・半径の外は null・欠測は拾わない', () => {
    const px = dataToPxX(25, HOME, RECT);
    const py = dataToPxY(5, HOME, RECT);
    const hit = pickChartPoint([{ xs, ys }], HOME, RECT, px + 3, py - 2, 8, true);
    expect(hit?.index).toBe(1);
    expect(hit?.dist).toBeCloseTo(Math.hypot(3, 2));
    expect(pickChartPoint([{ xs, ys }], HOME, RECT, px + 30, py, 8, true)).toBeNull();
    const mid = pickChartPoint([{ xs, ys }], HOME, RECT, dataToPxX(50, HOME, RECT), dataToPxY(0, HOME, RECT), 8, false);
    expect(mid).toBeNull();
  });
  it('二分探索(sorted)と全走査は同じ答え', () => {
    const n = 5_000;
    const sx = new Float64Array(n);
    const sy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      sx[i] = (i / n) * 100;
      sy[i] = Math.sin(i) * 9;
    }
    for (const [x, y] of [
      [100, 50],
      [250, 120],
      [433, 90],
    ] as const) {
      const a = pickChartPoint([{ xs: sx, ys: sy }], HOME, RECT, x, y, 20, true);
      const b = pickChartPoint([{ xs: sx, ys: sy }], HOME, RECT, x, y, 20, false);
      expect(a?.index).toBe(b?.index);
    }
  });
  it('ヒートマップのセル(行 0 が上)', () => {
    const s = spec('{"type":"heatmap","matrix":[[1,2],[3,4]]}');
    const home = homeRangeOf(s);
    expect(home).toEqual({ xMin: 0, xMax: 2, yMin: 0, yMax: 2 });
    const top = pickHeatmapCell(s.heatmap!, home, RECT, RECT.x + 300, RECT.y + 10);
    expect(top).toEqual({ col: 1, row: 0, value: 2 });
    const bottom = pickHeatmapCell(s.heatmap!, home, RECT, RECT.x + 10, RECT.y + 190);
    expect(bottom).toEqual({ col: 0, row: 1, value: 3 });
    expect(pickHeatmapCell(s.heatmap!, home, RECT, 0, 0)).toBeNull();
  });
  it('visibleIndexRange', () => {
    expect(visibleIndexRange(xs, 20, 80)).toEqual({ start: 1, end: 4 });
    expect(visibleIndexRange(xs, 200, 300)).toEqual({ start: 5, end: 5 });
  });
});

describe('buildChartFrame(GPU と 2D が同じ物を描く)', () => {
  it('折れ線: 大量の点を描画域の幅ほどへ間引き、欠測で切る', () => {
    const n = 50_000;
    const data = Array.from({ length: n }, (_, i) => (i === 100 ? null : Math.sin(i / 100)));
    const s = spec(JSON.stringify({ type: 'line', datasets: [{ data }] }));
    const f = buildChartFrame(s, homeRangeOf(s), 500);
    expect(f.lines[0]!.segCount).toBeLessThanOrEqual(1_000);
    expect(f.lines[0]!.segCount).toBeGreaterThan(500);
    expect(f.shown).toBeLessThan(n);
    // 正規化した座標(0〜1 の範囲。両隣の 1 点ぶんだけ外へ出てよい)
    const segs = f.lines[0]!.segs.subarray(0, f.lines[0]!.segCount * 4);
    expect(Math.min(...segs)).toBeGreaterThanOrEqual(-0.01);
    expect(Math.max(...segs)).toBeLessThanOrEqual(1.01);
  });
  it('拡大すると見えている範囲だけを組む', () => {
    const s = spec(JSON.stringify({ type: 'scatter', datasets: [{ points: Array.from({ length: 1000 }, (_, i) => ({ x: i, y: i % 10 })) }] }));
    const f = buildChartFrame(s, { xMin: 0, xMax: 99, yMin: -1, yMax: 11 }, 400);
    expect(f.markKind).toBe('point');
    expect(f.markCount).toBe(100);
    const capped = buildChartFrame(s, homeRangeOf(s), 400, 100);
    expect(capped.markCount).toBeLessThanOrEqual(100);
  });
  it('棒とヒートマップは矩形', () => {
    const b = spec('{"type":"bar","labels":["a","b"],"datasets":[{"data":[1,-2]}]}');
    const fb = buildChartFrame(b, homeRangeOf(b), 300);
    expect(fb.markKind).toBe('rect');
    expect(fb.markCount).toBe(2);
    const h = spec('{"type":"heatmap","matrix":[[1,2],[3,null]]}');
    const fh = buildChartFrame(h, homeRangeOf(h), 300);
    expect(fh.markCount).toBe(3);
    expect(fh.marks[4]).toBe(0); // 最小 = 0
  });
  it('色: hsl の空白区切りも読む・ヒートの段は単調', () => {
    expect(parseCssRgb('hsl(0 100% 50%)')).toEqual([1, 0, 0]);
    expect(parseCssRgb('#0f0')).toEqual([0, 1, 0]);
    expect(parseCssRgb('nope')).toBeNull();
    const a = heatColor(0.2, [1, 1, 1], [0, 0, 1]);
    const b = heatColor(0.8, [1, 1, 1], [0, 0, 1]);
    expect(b[0]).toBeLessThan(a[0]);
  });
});
