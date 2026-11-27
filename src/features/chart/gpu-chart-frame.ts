/**
 * 🔴 **1 コマぶんの描く物を組む**(v4.1 PR-7、#2095)── GPU の描画と 2D の簡易表示が**同じこれ**を使う(CLAUDE.md §7)。
 *
 * 出すのは表示範囲で**正規化した**座標(左 0〜右 1、下 0〜上 1)。
 * 🔑 データの値(時刻のミリ秒など大きな数)を GPU の 32 bit の浮動小数へそのまま載せると、拡大したときに
 *   点が震える ── 毎コマ「いま見えている範囲」で 0〜1 に揃えてから渡す(描くのは操作したときだけなので、組み直しは安い)。
 *
 * - 折れ線: 見えている範囲(+ 両隣の 1 点)を LTTB で間引き、線分の組(欠測で切る)にする
 * - 散布図: 見えている点(上限を超えたら等間隔に間引く)
 * - 棒: 見えている棒の矩形
 * - ヒートマップ: 見えているセルの矩形と、値の 0〜1(色の段)
 */
import type { GpuChartSpec } from './gpu-chart-spec';
import { downsampleLttb } from './lttb';
import { visibleIndexRange, type ChartRange } from './gpu-chart-viewport';

/** 1 コマで描く印(点・棒・セル)の上限。GPU の 1 回の描画呼び出しに載せる数。 */
export const GPU_CHART_MAX_MARKS = 250_000;

export interface ChartFrameLine {
  readonly series: number;
  /** 線分の端点(x0, y0, x1, y1 の繰り返し、正規化)。 */
  readonly segs: Float32Array;
  readonly segCount: number;
}

export interface ChartFrame {
  readonly lines: readonly ChartFrameLine[];
  /** `rect`: x0, y0, x1, y1, 値(棒は系列の番号、ヒートマップは 0〜1)の 5 つ組 / `point`: x, y, 系列の番号 の 3 つ組。 */
  readonly marks: Float32Array;
  readonly markKind: 'none' | 'rect' | 'point';
  readonly markCount: number;
  /** 表示した点の数(間引いた後)。 */
  readonly shown: number;
}

/** 間引きの目安(描画域の幅 × 2。最低 64 点)。 */
export function lttbThreshold(plotWidthPx: number): number {
  return Math.max(64, Math.round(plotWidthPx * 2));
}

export function buildChartFrame(
  spec: GpuChartSpec,
  range: ChartRange,
  plotWidthPx: number,
  maxMarks: number = GPU_CHART_MAX_MARKS,
): ChartFrame {
  const sx = range.xMax - range.xMin;
  const sy = range.yMax - range.yMin;
  const nx = (x: number): number => (x - range.xMin) / sx;
  const ny = (y: number): number => (y - range.yMin) / sy;
  const empty: ChartFrame = { lines: [], marks: new Float32Array(0), markKind: 'none', markCount: 0, shown: 0 };
  if (!(sx > 0) || !(sy > 0)) return empty;

  if (spec.heatmap !== null) {
    const hm = spec.heatmap;
    const c0 = Math.max(0, Math.floor(range.xMin));
    const c1 = Math.min(hm.cols, Math.ceil(range.xMax));
    // y ∈ [rows-r-1, rows-r) ── 行 0 が上
    const r0 = Math.max(0, Math.floor(hm.rows - range.yMax));
    const r1 = Math.min(hm.rows, Math.ceil(hm.rows - range.yMin));
    const cap = Math.max(0, Math.min(maxMarks, (c1 - c0) * (r1 - r0)));
    const marks = new Float32Array(cap * 5);
    const vSpan = hm.max - hm.min;
    let k = 0;
    for (let r = r0; r < r1 && k < cap; r++) {
      const yTop = hm.rows - r;
      for (let c = c0; c < c1 && k < cap; c++) {
        const v = hm.values[r * hm.cols + c]!;
        if (Number.isNaN(v)) continue;
        const o = k * 5;
        marks[o] = nx(c);
        marks[o + 1] = ny(yTop - 1);
        marks[o + 2] = nx(c + 1);
        marks[o + 3] = ny(yTop);
        marks[o + 4] = vSpan > 0 ? (v - hm.min) / vSpan : 0.5;
        k++;
      }
    }
    return { lines: [], marks, markKind: 'rect', markCount: k, shown: k };
  }

  if (spec.type === 'line') {
    const th = lttbThreshold(plotWidthPx);
    let shown = 0;
    const lines: ChartFrameLine[] = spec.series.map((s, si) => {
      const vis = visibleIndexRange(s.xs, range.xMin, range.xMax);
      // ⚠ 両隣の 1 点も入れる(端で線が途切れない)
      const start = Math.max(0, vis.start - 1);
      const end = Math.min(s.xs.length, vis.end + 1);
      const d = downsampleLttb(s.xs, s.ys, start, end, th);
      const segs = new Float32Array(Math.max(0, d.xs.length - 1) * 4);
      let n = 0;
      for (let i = 0; i < d.xs.length; i++) {
        const y = d.ys[i]!;
        // ⚠ x か y が欠測なら線の切れ目(どちらの欠測も線分にしない)
        if (Number.isNaN(y) || Number.isNaN(d.xs[i]!)) continue;
        shown++;
        if (i === 0) continue;
        const py = d.ys[i - 1]!;
        if (Number.isNaN(py) || Number.isNaN(d.xs[i - 1]!)) continue;
        const o = n * 4;
        segs[o] = nx(d.xs[i - 1]!);
        segs[o + 1] = ny(py);
        segs[o + 2] = nx(d.xs[i]!);
        segs[o + 3] = ny(y);
        n++;
      }
      return { series: si, segs, segCount: n };
    });
    return { lines, marks: new Float32Array(0), markKind: 'none', markCount: 0, shown };
  }

  if (spec.type === 'scatter') {
    // 見えている点を数えてから、上限を超えるなら等間隔に間引く
    let visible = 0;
    for (const s of spec.series) {
      for (let i = 0; i < s.xs.length; i++) {
        const x = s.xs[i]!;
        const y = s.ys[i]!;
        if (x >= range.xMin && x <= range.xMax && y >= range.yMin && y <= range.yMax) visible++;
      }
    }
    const stride = Math.max(1, Math.ceil(visible / Math.max(1, maxMarks)));
    const cap = Math.min(maxMarks, Math.ceil(visible / stride));
    const marks = new Float32Array(cap * 3);
    let k = 0;
    let seen = 0;
    spec.series.forEach((s, si) => {
      for (let i = 0; i < s.xs.length && k < cap; i++) {
        const x = s.xs[i]!;
        const y = s.ys[i]!;
        if (!(x >= range.xMin && x <= range.xMax && y >= range.yMin && y <= range.yMax)) continue;
        if (seen++ % stride !== 0) continue;
        const o = k * 3;
        marks[o] = nx(x);
        marks[o + 1] = ny(y);
        marks[o + 2] = si;
        k++;
      }
    });
    return { lines: [], marks, markKind: 'point', markCount: k, shown: k };
  }

  // 棒 ── 区分の幅を系列で分け合う
  const n = Math.max(1, spec.series.length);
  const w = spec.barSlot / n;
  const base = Math.min(Math.max(0, range.yMin), range.yMax);
  let visible = 0;
  const ranges = spec.series.map((s, si) => {
    const off = (si - (n - 1) / 2) * w;
    const vis = visibleIndexRange(s.xs, range.xMin - off - w, range.xMax - off + w);
    visible += vis.end - vis.start;
    return { ...vis, off };
  });
  const stride = Math.max(1, Math.ceil(visible / Math.max(1, maxMarks)));
  const cap = Math.min(maxMarks, Math.ceil(visible / stride) + n);
  const marks = new Float32Array(cap * 5);
  let k = 0;
  let seen = 0;
  spec.series.forEach((s, si) => {
    const r = ranges[si]!;
    for (let i = r.start; i < r.end && k < cap; i++) {
      const y = s.ys[i]!;
      if (Number.isNaN(y)) continue;
      if (seen++ % stride !== 0) continue;
      const cx = s.xs[i]! + r.off;
      const o = k * 5;
      marks[o] = nx(cx - w / 2);
      marks[o + 1] = ny(Math.min(base, y));
      marks[o + 2] = nx(cx + w / 2);
      marks[o + 3] = ny(Math.max(base, y));
      marks[o + 4] = si;
      k++;
    }
  });
  return { lines: [], marks, markKind: 'rect', markCount: k, shown: k };
}

// ───────────────────────────── 色

export type Rgb = readonly [number, number, number];

/**
 * 色の字 → 0〜1 の RGB。`#rgb` / `#rrggbb` / `rgb()` / `hsl()`(カンマ区切りも空白区切りも)。読めなければ `null`。
 * ⚠ three の `Color.setStyle` は空白区切りの `hsl(210 62% 42%)` を読めない ── だからここで読む。
 */
export function parseCssRgb(color: string): Rgb | null {
  const c = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((ch) => ch + ch).join('') : hex[1]!;
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }
  const rgb = /^rgba?\(\s*([\d.]+)%?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?/.exec(c);
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255].map((v) => Math.min(1, Math.max(0, v))) as unknown as Rgb;
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(c);
  if (hsl) {
    const h = (((Number(hsl[1]) % 360) + 360) % 360) / 360;
    const s = Math.min(1, Number(hsl[2]) / 100);
    const l = Math.min(1, Number(hsl[3]) / 100);
    if (s === 0) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t: number): number => {
      let u = t;
      if (u < 0) u += 1;
      if (u > 1) u -= 1;
      if (u < 1 / 6) return p + (q - p) * 6 * u;
      if (u < 1 / 2) return q;
      if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
      return p;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
  }
  return null;
}

/** 0〜1 の RGB → `rgb(…)`(2D canvas 用)。 */
export function rgbCss(c: Rgb): string {
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}

/** ヒートマップの色の段(地 → アクセントへ単調。`t` は 0〜1)。 */
export function heatColor(t: number, from: Rgb, to: Rgb): Rgb {
  const u = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  // ⚠ 低い値も地と見分けがつくよう、地から 12% 離した所から始める
  const k = 0.12 + 0.88 * u;
  return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k];
}
