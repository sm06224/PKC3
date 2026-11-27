/**
 * 🔴 **グラフの表示範囲・目盛り・当たり判定**(v4.1 PR-7、#2095)── GPU の描画と 2D の簡易表示が**同じこれ**を呼ぶ
 * (判定を 2 か所に書かない ── CLAUDE.md §7)。純関数のみ。
 *
 * 座標の約束:
 * - `ChartRange` はデータの単位の表示範囲。
 * - 「正規化」は表示範囲を 0〜1 にした値(x は左 0、y は**下 0**)。
 * - 画面の位置(px)は描画面の左上が原点(y は下向き)。`plotRect` は軸を除いた描画域。
 */
import type { GpuChartHeatmap, GpuChartSpec } from './gpu-chart-spec';

export interface ChartRange {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

/** 最初の範囲(`home`)と今の範囲(`cur`)。 */
export interface ChartViewport {
  readonly home: ChartRange;
  readonly cur: ChartRange;
}

export interface PlotRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 拡大の上限(最初の範囲の 10 万分の 1 まで)── 浮動小数の精度が崩れる手前で止める。 */
export const CHART_MIN_SPAN_RATIO = 1e-5;
/** ボタン 1 回の拡大率。 */
export const CHART_ZOOM_STEP = 1.5;

const spanOf = (min: number, max: number): number => max - min;

/** 1 軸ぶんの範囲を、幅を [最小, home の幅] に収め、home の中に置く。 */
function clampAxis(min: number, max: number, hMin: number, hMax: number): [number, number] {
  const hSpan = hMax - hMin;
  let span = max - min;
  const minSpan = Math.max(hSpan * CHART_MIN_SPAN_RATIO, Number.MIN_VALUE * 1e10);
  if (!(span >= minSpan)) {
    const c = Number.isFinite((min + max) / 2) ? (min + max) / 2 : (hMin + hMax) / 2;
    span = minSpan;
    min = c - span / 2;
    max = c + span / 2;
  }
  if (span >= hSpan) return [hMin, hMax];
  if (min < hMin) return [hMin, hMin + span];
  if (max > hMax) return [hMax - span, hMax];
  return [min, max];
}

export function clampChartRange(r: ChartRange, home: ChartRange): ChartRange {
  const [xMin, xMax] = clampAxis(r.xMin, r.xMax, home.xMin, home.xMax);
  const [yMin, yMax] = clampAxis(r.yMin, r.yMax, home.yMin, home.yMax);
  return { xMin, xMax, yMin, yMax };
}

/**
 * カーソルの位置を中心に拡大・縮小する(`factor` > 1 で寄る)。
 * @param anchorNormX 描画域の中のカーソルの位置(左 0〜右 1)
 * @param anchorNormY 同(下 0〜上 1)
 * 🔑 範囲の端に当たらない限り、カーソルの下のデータの位置は動かない(不動点)。
 */
export function zoomChartViewport(
  cur: ChartRange,
  home: ChartRange,
  factor: number,
  anchorNormX: number,
  anchorNormY: number,
): ChartRange {
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const ax = Math.min(1, Math.max(0, Number.isFinite(anchorNormX) ? anchorNormX : 0.5));
  const ay = Math.min(1, Math.max(0, Number.isFinite(anchorNormY) ? anchorNormY : 0.5));
  const sx = spanOf(cur.xMin, cur.xMax);
  const sy = spanOf(cur.yMin, cur.yMax);
  const vx = cur.xMin + ax * sx;
  const vy = cur.yMin + ay * sy;
  const nsx = Math.min(sx / f, spanOf(home.xMin, home.xMax));
  const nsy = Math.min(sy / f, spanOf(home.yMin, home.yMax));
  return clampChartRange({ xMin: vx - ax * nsx, xMax: vx + (1 - ax) * nsx, yMin: vy - ay * nsy, yMax: vy + (1 - ay) * nsy }, home);
}

/**
 * ドラッグで動かす。
 * @param deltaNormX ポインタの動き ÷ 描画域の幅(右へ動かすと正)
 * @param deltaNormY ポインタの動き ÷ 描画域の高さ(**下へ**動かすと正 ── 画面の向き)
 * 🔑 掴んだデータがポインタについてくる(右へ引けば、表示範囲は左へずれる)。
 */
export function panChartViewport(cur: ChartRange, home: ChartRange, deltaNormX: number, deltaNormY: number): ChartRange {
  const dx = (Number.isFinite(deltaNormX) ? deltaNormX : 0) * spanOf(cur.xMin, cur.xMax);
  const dy = (Number.isFinite(deltaNormY) ? deltaNormY : 0) * spanOf(cur.yMin, cur.yMax);
  return clampChartRange({ xMin: cur.xMin - dx, xMax: cur.xMax - dx, yMin: cur.yMin + dy, yMax: cur.yMax + dy }, home);
}

// ───────────────────────────── 最初の範囲

function seriesExtent(spec: GpuChartSpec): { xMin: number; xMax: number; yMin: number; yMax: number } {
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const s of spec.series) {
    for (let i = 0; i < s.xs.length; i++) {
      const x = s.xs[i]!;
      const y = s.ys[i]!;
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  return { xMin, xMax, yMin, yMax };
}

function padAxis(min: number, max: number, ratio: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const d = Math.abs(min) * 0.1 || 1;
    return [min - d, max + d];
  }
  const p = (max - min) * ratio;
  return [min - p, max + p];
}

/** データ全体が収まる最初の範囲(上下に 5% の余白。棒は 0 を含む)。 */
export function homeRangeOf(spec: GpuChartSpec): ChartRange {
  if (spec.heatmap !== null) return { xMin: 0, xMax: spec.heatmap.cols, yMin: 0, yMax: spec.heatmap.rows };
  const e = seriesExtent(spec);
  if (spec.type === 'bar') {
    const half = spec.barSlot / 2 / 0.8;
    const [yMin, yMax] = padAxis(Math.min(0, e.yMin), Math.max(0, e.yMax), 0.05);
    const xMin = Number.isFinite(e.xMin) ? e.xMin - half : -0.5;
    const xMax = Number.isFinite(e.xMax) ? e.xMax + half : 0.5;
    return { xMin, xMax, yMin: e.yMin >= 0 ? 0 : yMin, yMax: e.yMax <= 0 ? 0 : yMax };
  }
  const [xMin, xMax] = spec.type === 'scatter' ? padAxis(e.xMin, e.xMax, 0.03) : padAxis(e.xMin, e.xMax, 0);
  const [yMin, yMax] = padAxis(e.yMin, e.yMax, 0.05);
  return { xMin, xMax, yMin, yMax };
}

// ───────────────────────────── 位置の変換

export function dataToPxX(x: number, r: ChartRange, rect: PlotRect): number {
  return rect.x + ((x - r.xMin) / (r.xMax - r.xMin)) * rect.w;
}

export function dataToPxY(y: number, r: ChartRange, rect: PlotRect): number {
  return rect.y + rect.h - ((y - r.yMin) / (r.yMax - r.yMin)) * rect.h;
}

/** 画面の位置 → 描画域の中の正規化(左 0〜右 1、下 0〜上 1)。 */
export function pxToNorm(px: number, py: number, rect: PlotRect): { nx: number; ny: number } {
  return { nx: (px - rect.x) / Math.max(1, rect.w), ny: 1 - (py - rect.y) / Math.max(1, rect.h) };
}

/** 昇順の `xs` で [xMin, xMax] に入る添字の範囲 [start, end)。 */
export function visibleIndexRange(xs: Float64Array, xMin: number, xMax: number): { start: number; end: number } {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m]! < xMin) lo = m + 1;
    else hi = m;
  }
  const start = lo;
  hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m]! <= xMax) lo = m + 1;
    else hi = m;
  }
  return { start, end: lo };
}

// ───────────────────────────── 目盛り

export interface ChartTicks {
  readonly values: readonly number[];
  readonly step: number;
  readonly labels: readonly string[];
}

/** 1 / 2 / 5 × 10^n の刻み。 */
export function niceStep(span: number, targetCount: number): number {
  const raw = span / Math.max(1, targetCount);
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return nice * p;
}

/** 3 桁ごとのカンマ(`50,000`)。 */
export function groupDigits(n: number): string {
  const [i, f] = String(n).split('.');
  const s = i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return f === undefined ? s : `${s}.${f}`;
}

/** 目盛りの字(刻みに合わせた桁。大きい・小さい数は指数)。 */
export function formatTick(v: number, step: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e9 || (a < 1e-4 && step < 1e-4)) return v.toExponential(Math.max(0, Math.min(6, -Math.floor(Math.log10(step / a)))));
  const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(step) + 1e-9)));
  const n = Number(v.toFixed(decimals));
  return a >= 1e4 ? groupDigits(n) : String(n);
}

/** 見やすい目盛り(端を含む範囲 [min, max] の中の刻み)。 */
export function niceTicks(min: number, max: number, targetCount: number): ChartTicks {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return { values: [], step: 1, labels: [] };
  const step = niceStep(max - min, targetCount);
  const first = Math.ceil(min / step - 1e-9);
  const last = Math.floor(max / step + 1e-9);
  const values: number[] = [];
  for (let k = first; k <= last && values.length < 200; k++) {
    // ⚠ 刻みの倍数で作る(足し算を重ねると 0.30000000000000004 が出る)
    const v = Number((k * step).toPrecision(12));
    values.push(Object.is(v, -0) ? 0 : v);
  }
  return { values, step, labels: values.map((v) => formatTick(v, step)) };
}

/** 区分の番号の軸(棒・見出しのある折れ線)── 刻みは 1 以上の整数、字は見出し。 */
export function categoryTicks(min: number, max: number, targetCount: number, labels: readonly string[]): ChartTicks {
  const step = Math.max(1, Math.round(niceStep(max - min, targetCount)));
  const values: number[] = [];
  for (let v = Math.max(0, Math.ceil(min / step) * step); v <= max && values.length < 200; v += step) values.push(v);
  return { values, step, labels: values.map((v) => labels[v] ?? String(v)) };
}

// ───────────────────────────── 当たり判定

export interface PickSeries {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
}

export interface ChartPick {
  readonly series: number;
  readonly index: number;
  readonly x: number;
  readonly y: number;
  /** 画面の距離(px)。 */
  readonly dist: number;
}

/**
 * 可視範囲の中で、カーソルにいちばん近い点(`hitRadiusPx` 以内)。
 * @param sorted x が昇順の系列か(折れ線・棒)── 二分探索で x の近くだけを調べる
 */
export function pickChartPoint(
  series: readonly PickSeries[],
  viewport: ChartRange,
  plotRect: PlotRect,
  px: number,
  py: number,
  hitRadiusPx: number,
  sorted = false,
  /** 系列ごとの描いた位置の x のずれ(棒は系列を横に並べて描く)。 */
  xOffsets?: readonly number[],
): ChartPick | null {
  if (px < plotRect.x - hitRadiusPx || px > plotRect.x + plotRect.w + hitRadiusPx) return null;
  if (py < plotRect.y - hitRadiusPx || py > plotRect.y + plotRect.h + hitRadiusPx) return null;
  const kx = plotRect.w / (viewport.xMax - viewport.xMin);
  const ky = plotRect.h / (viewport.yMax - viewport.yMin);
  const r2 = hitRadiusPx * hitRadiusPx;
  let best: ChartPick | null = null;
  let bestD2 = r2;
  const dx = hitRadiusPx / kx;
  series.forEach((s, si) => {
    const off = xOffsets?.[si] ?? 0;
    let start = 0;
    let end = s.xs.length;
    if (sorted) {
      const cx = viewport.xMin + (px - plotRect.x) / kx - off;
      ({ start, end } = visibleIndexRange(s.xs, Math.max(viewport.xMin, cx - dx), Math.min(viewport.xMax, cx + dx)));
    }
    for (let i = start; i < end; i++) {
      const x = s.xs[i]! + off;
      const y = s.ys[i]!;
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      if (x < viewport.xMin || x > viewport.xMax || y < viewport.yMin || y > viewport.yMax) continue;
      const ddx = plotRect.x + (x - viewport.xMin) * kx - px;
      const ddy = plotRect.y + plotRect.h - (y - viewport.yMin) * ky - py;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = { series: si, index: i, x: s.xs[i]!, y, dist: Math.sqrt(d2) };
      }
    }
  });
  return best;
}

export interface HeatmapPick {
  readonly col: number;
  readonly row: number;
  readonly value: number;
}

/**
 * ヒートマップのセル。セル (c, r) は x ∈ [c, c+1)、y ∈ [rows-r-1, rows-r)(行 0 が上)。
 */
export function pickHeatmapCell(
  hm: GpuChartHeatmap,
  viewport: ChartRange,
  plotRect: PlotRect,
  px: number,
  py: number,
): HeatmapPick | null {
  if (px < plotRect.x || px > plotRect.x + plotRect.w || py < plotRect.y || py > plotRect.y + plotRect.h) return null;
  const x = viewport.xMin + ((px - plotRect.x) / plotRect.w) * (viewport.xMax - viewport.xMin);
  const y = viewport.yMin + (1 - (py - plotRect.y) / plotRect.h) * (viewport.yMax - viewport.yMin);
  const col = Math.floor(x);
  const row = hm.rows - 1 - Math.floor(y);
  if (col < 0 || col >= hm.cols || row < 0 || row >= hm.rows) return null;
  const value = hm.values[row * hm.cols + col]!;
  return Number.isNaN(value) ? null : { col, row, value };
}
