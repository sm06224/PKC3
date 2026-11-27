/**
 * 🔴 **大量データ向けの GPU 直接描画グラフ**(v4.1 Phase 3 / PR-7、#2095 前半)── ` ```chart live ` / `heatmap` /
 * `"source": "asset:鍵"` / 2,000 点を超える ` ```chart ` を、`gpu-lease.ts` から借りた描画面へ直接描く。
 *
 * ## 守ること(定常コスト 0・使い捨て GPU ── `gpu-lease.ts` / `viewer-3d.ts` と同じ作法)
 *
 * 1. **描くのは `createGpuSurface` だけ**。renderer を自分で作らない・rAF を自分で回さない。
 *    描き直しは「初回・データの差し替え・操作(拡大 / 縮小 / 移動)・大きさの変化・テーマの変化」のときだけ
 *    `invalidate()` を 1 回頼む(**静止時の rAF = 0**)。ホバーの十字線は上に重ねた 2D の層へその場で描く(GPU を回さない)。
 * 2. **GPU のグラフが無いノートでは 0 バイト**: Three.js は型だけを読む(`import type`)。器(`[data-pkc-gpu-chart-src]`)が
 *    無ければ `hydrateGpuChart` は何もしない。
 * 3. **座標・目盛り・当たり判定・間引きは features 層の純関数を 1 組だけ**(`gpu-chart-viewport` / `gpu-chart-frame` / `lttb`)。
 *    GPU と 2D の簡易表示は同じ「1 コマの描く物」(`buildChartFrame`)を描く ── 判定を 2 か所に書かない(CLAUDE.md §7)。
 * 4. **畳んでも空白にしない**: `capturePoster()` で 1 コマ描き、軸の層と重ねた PNG を返す(ObjectURL の revoke は gpu-lease)。
 * 5. **GPU が無い・1 枚にまとめた版**: 同じ座標・同じ操作の 2D canvas へ落ち、理由を 1 行出す(例外を外へ漏らさない)。
 * 6. **スクロールの取り合い 0**: ただのホイールは本文の縦スクロールへ流す。拡大・縮小は `Ctrl`(⌘)+ ホイールかボタン。
 * 7. **後段(PR-8 / PR-9)の口**: `updateData(nextSpec)` で仕様を差し替え、`invalidate()` 1 回で描き直す。
 */
import type * as ThreeModule from 'three';
import {
  createGpuSurface,
  type GpuContext,
  type GpuFrameSize,
  type GpuSession,
  type GpuSurface,
  type GpuSurfaceOptions,
} from '@adapter/platform/render/gpu-lease';
import { downloadBlob } from '@adapter/platform/download';
import { safeName } from '@features/export/file-name';
import { dayStamp } from '@features/datetime/date-math';
import {
  gpuChartAltText,
  gpuChartPointCount,
  parseGpuChartCsv,
  parseGpuChartSpec,
  type GpuChartSpec,
} from '@features/chart/gpu-chart-spec';
import {
  CHART_ZOOM_STEP,
  categoryTicks,
  clampChartRange,
  dataToPxX,
  dataToPxY,
  groupDigits,
  homeRangeOf,
  niceTicks,
  panChartViewport,
  pickChartPoint,
  pickHeatmapCell,
  pxToNorm,
  zoomChartViewport,
  type ChartRange,
  type ChartTicks,
  type PlotRect,
} from '@features/chart/gpu-chart-viewport';
import { buildChartFrame, heatColor, parseCssRgb, rgbCss, type ChartFrame, type Rgb } from '@features/chart/gpu-chart-frame';
import { wheelDeltaPx } from '@features/viewer3d/orbit-math';
import { seriesColors } from './chart-raster';
import { readPalette, type DiagramPalette } from './mermaid-raster';
import { cssColorToHex } from './css-color';
import { typingQuietIn } from './typing-gate';
import type { MermaidScope } from './mermaid-hydrate';
import type { GetAssetBlob } from './viewer-3d';

type Three = typeof ThreeModule;

let surfaceFactory: (opts: GpuSurfaceOptions) => GpuSurface = createGpuSurface;
let saveBlob: (name: string, blob: Blob) => void = downloadBlob;

/** test 用: 描画面の作り方・保存の口を差し替える(`null` で実物へ戻す)。 */
export function setGpuChartTestHooks(
  hooks: { createSurface?: (opts: GpuSurfaceOptions) => GpuSurface; saveBlob?: (name: string, blob: Blob) => void } | null,
): void {
  surfaceFactory = hooks?.createSurface ?? createGpuSurface;
  saveBlob = hooks?.saveBlob ?? downloadBlob;
}

// ───────────────────────────── テーマ

export interface ChartTheme {
  readonly bg: string;
  readonly fg: string;
  readonly muted: string;
  readonly grid: string;
  readonly accent: string;
  readonly series: readonly string[];
}

/** 配色を CSS 変数から読む(本文に色を書かせない ── テーマを変えれば図も変わる)。 */
export function readChartTheme(el: HTMLElement): ChartTheme {
  let p: DiagramPalette;
  try {
    p = readPalette(el);
  } catch {
    p = { bg: '#ffffff', alt: '#f4f4f4', fg: '#222222', line: '#777777', border: '#cccccc', accent: '#2f6fde', dark: false };
  }
  const doc = el.ownerDocument;
  const cs = doc.defaultView?.getComputedStyle(el);
  const hairline = cs?.getPropertyValue('--hairline').trim() ?? '';
  const toHex = (v: string, fb: string): string => cssColorToHex(doc, v) ?? fb;
  return {
    bg: toHex(p.bg, '#ffffff'),
    fg: toHex(p.fg, '#222222'),
    muted: toHex(p.line, '#777777'),
    grid: toHex(hairline !== '' ? hairline : p.border, '#d8d8d8'),
    accent: toHex(p.accent, '#2f6fde'),
    series: seriesColors(p),
  };
}

/** 印刷・書き出し用の明るい配色(`renderGpuChartPng` の既定)。 */
export const PAPER_CHART_THEME: ChartTheme = {
  bg: '#ffffff',
  fg: '#222222',
  muted: '#666666',
  grid: '#dddddd',
  accent: '#2f6fde',
  series: seriesColors({ bg: '#ffffff', alt: '#f4f4f4', fg: '#222222', line: '#666666', border: '#dddddd', accent: '#2f6fde', dark: false }),
};

function rgbOf(c: string, fb: Rgb): Rgb {
  return parseCssRgb(c) ?? fb;
}

function seriesRgb(spec: GpuChartSpec, theme: ChartTheme, i: number): Rgb {
  const own = spec.series[i]?.color;
  const fromOwn = own !== undefined ? parseCssRgb(own) : null;
  return fromOwn ?? rgbOf(theme.series[i % theme.series.length] ?? theme.accent, [0.2, 0.4, 0.8]);
}

// ───────────────────────────── 描画域と目盛り(GPU と 2D で共通)

const AXIS_FONT = '11px system-ui, sans-serif';

export interface ChartLayout {
  readonly rect: PlotRect;
  readonly xTicks: ChartTicks;
  readonly yTicks: ChartTicks;
}

function ticksFor(spec: GpuChartSpec, range: ChartRange, rect: PlotRect): { x: ChartTicks; y: ChartTicks } {
  const tx = Math.max(2, Math.floor(rect.w / 90));
  const ty = Math.max(2, Math.floor(rect.h / 40));
  if (spec.heatmap !== null) {
    const hm = spec.heatmap;
    const x = categoryTicks(Math.max(0, range.xMin - 0.5), Math.min(hm.cols - 1, range.xMax - 0.5), tx, hm.xLabels);
    // y の番号は下から数える ── 字は行(上から)の見出し
    const yRaw = categoryTicks(Math.max(0, range.yMin - 0.5), Math.min(hm.rows - 1, range.yMax - 0.5), ty, []);
    const yLabels = yRaw.values.map((v) => hm.yLabels[hm.rows - 1 - v] ?? String(hm.rows - 1 - v));
    return {
      x: { ...x, values: x.values.map((v) => v + 0.5) },
      y: { values: yRaw.values.map((v) => v + 0.5), step: yRaw.step, labels: yLabels },
    };
  }
  const x = spec.xIsIndex ? categoryTicks(range.xMin, range.xMax, tx, spec.labels) : niceTicks(range.xMin, range.xMax, tx);
  return { x, y: niceTicks(range.yMin, range.yMax, ty) };
}

/** 軸の幅を目盛りの字の幅から決める(字が切れない最小)。 */
export function layoutChart(
  ctx: CanvasRenderingContext2D | null,
  spec: GpuChartSpec,
  range: ChartRange,
  width: number,
  height: number,
): ChartLayout {
  const top = 8;
  const right = 14;
  const bottom = 24;
  // 1 回目は仮の左余白で目盛りを決め、字の幅で左余白を決め直す
  let left = 48;
  let rect: PlotRect = { x: left, y: top, w: Math.max(10, width - left - right), h: Math.max(10, height - top - bottom) };
  let t = ticksFor(spec, range, rect);
  if (ctx !== null) {
    ctx.font = AXIS_FONT;
    let maxW = 0;
    for (const l of t.y.labels) maxW = Math.max(maxW, ctx.measureText(l).width);
    left = Math.round(Math.min(160, Math.max(32, maxW + 12)));
    rect = { x: left, y: top, w: Math.max(10, width - left - right), h: rect.h };
    t = ticksFor(spec, range, rect);
  }
  return { rect, xTicks: t.x, yTicks: t.y };
}

export interface HoverMark {
  readonly px: number;
  readonly py: number;
  readonly color: string;
}

/**
 * 軸・目盛り・グリッド・ホバーを描く(GPU のときは上に重ねる層、2D のときはデータの上)。
 * @param coverMargins 軸の余白を地の色で塗る(GPU の描画がはみ出した分を隠す)
 */
export function drawChartAxes(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  layout: ChartLayout,
  range: ChartRange,
  theme: ChartTheme,
  opts: { coverMargins: boolean; grid: boolean; hover?: HoverMark | null },
): void {
  const { rect, xTicks, yTicks } = layout;
  if (opts.coverMargins) {
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, rect.y);
    ctx.fillRect(0, rect.y + rect.h, width, height - rect.y - rect.h);
    ctx.fillRect(0, rect.y, rect.x, rect.h);
    ctx.fillRect(rect.x + rect.w, rect.y, width - rect.x - rect.w, rect.h);
  }
  ctx.lineWidth = 1;
  if (opts.grid) {
    ctx.strokeStyle = theme.grid;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    for (const v of yTicks.values) {
      const y = Math.round(dataToPxY(v, range, rect)) + 0.5;
      ctx.moveTo(rect.x, y);
      ctx.lineTo(rect.x + rect.w, y);
    }
    for (const v of xTicks.values) {
      const x = Math.round(dataToPxX(v, range, rect)) + 0.5;
      ctx.moveTo(x, rect.y);
      ctx.lineTo(x, rect.y + rect.h);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // 軸の線
  ctx.strokeStyle = theme.muted;
  ctx.beginPath();
  ctx.moveTo(rect.x + 0.5, rect.y);
  ctx.lineTo(rect.x + 0.5, rect.y + rect.h + 0.5);
  ctx.lineTo(rect.x + rect.w, rect.y + rect.h + 0.5);
  ctx.stroke();
  // 目盛りの字
  ctx.fillStyle = theme.muted;
  ctx.font = AXIS_FONT;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  yTicks.values.forEach((v, i) => ctx.fillText(yTicks.labels[i] ?? '', rect.x - 6, dataToPxY(v, range, rect)));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let lastRight = -Infinity;
  xTicks.values.forEach((v, i) => {
    const x = dataToPxX(v, range, rect);
    const label = xTicks.labels[i] ?? '';
    const w = ctx.measureText(label).width;
    // ⚠ 字が重なる目盛りは飛ばす(長い見出し)
    if (x - w / 2 < lastRight + 4) return;
    lastRight = x + w / 2;
    ctx.fillText(label, x, rect.y + rect.h + 5);
  });
  const h = opts.hover;
  if (h !== null && h !== undefined) {
    ctx.save();
    ctx.strokeStyle = theme.muted;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(h.px) + 0.5, rect.y);
    ctx.lineTo(Math.round(h.px) + 0.5, rect.y + rect.h);
    ctx.moveTo(rect.x, Math.round(h.py) + 0.5);
    ctx.lineTo(rect.x + rect.w, Math.round(h.py) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = h.color;
    ctx.strokeStyle = theme.bg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(h.px, h.py, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

/** 散布図の点の半径(px)。点が多いほど小さく。 */
export function pointRadiusPx(markCount: number): number {
  return markCount > 50_000 ? 1.2 : markCount > 5_000 ? 1.8 : 3;
}

/** 1 コマの描く物を 2D canvas へ(GPU と同じ `ChartFrame`)。 */
export function drawFrame2d(ctx: CanvasRenderingContext2D, frame: ChartFrame, rect: PlotRect, spec: GpuChartSpec, theme: ChartTheme): void {
  const X = (n: number): number => rect.x + n * rect.w;
  const Y = (n: number): number => rect.y + rect.h - n * rect.h;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  const m = frame.marks;
  if (frame.markKind === 'rect') {
    const from = rgbOf(theme.bg, [1, 1, 1]);
    const to = rgbOf(theme.accent, [0.2, 0.4, 0.9]);
    for (let k = 0; k < frame.markCount; k++) {
      const o = k * 5;
      ctx.fillStyle = spec.heatmap !== null ? rgbCss(heatColor(m[o + 4]!, from, to)) : rgbCss(seriesRgb(spec, theme, m[o + 4]!));
      const x0 = X(m[o]!);
      const y1 = Y(m[o + 1]!);
      const x1 = X(m[o + 2]!);
      const y0 = Y(m[o + 3]!);
      // ⚠ 細い棒・セルも 1px は塗る(消えない)
      ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    }
  } else if (frame.markKind === 'point') {
    const r = pointRadiusPx(frame.markCount);
    const colors = spec.series.map((_, i) => rgbCss(seriesRgb(spec, theme, i)));
    for (let k = 0; k < frame.markCount; k++) {
      const o = k * 3;
      ctx.fillStyle = colors[m[o + 2]!] ?? theme.accent;
      if (r < 2) ctx.fillRect(X(m[o]!) - r, Y(m[o + 1]!) - r, r * 2, r * 2);
      else {
        ctx.beginPath();
        ctx.arc(X(m[o]!), Y(m[o + 1]!), r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  for (const line of frame.lines) {
    ctx.strokeStyle = rgbCss(seriesRgb(spec, theme, line.series));
    ctx.beginPath();
    const s = line.segs;
    for (let k = 0; k < line.segCount; k++) {
      const o = k * 4;
      ctx.moveTo(X(s[o]!), Y(s[o + 1]!));
      ctx.lineTo(X(s[o + 2]!), Y(s[o + 3]!));
    }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * 🔴 **2D canvas で 1 枚描く**(簡易表示・PNG で保存・書き出しの焼き込みの 3 つで同じ 1 本)。
 */
export function paintChart2d(
  canvas: HTMLCanvasElement,
  spec: GpuChartSpec,
  range: ChartRange,
  width: number,
  height: number,
  dpr: number,
  theme: ChartTheme,
  hover?: HoverMark | null,
): { frame: ChartFrame; layout: ChartLayout } | null {
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  let ctx: CanvasRenderingContext2D | null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (ctx === null) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);
  const layout = layoutChart(ctx, spec, range, width, height);
  // 2D はグリッドを先に(データの下)
  drawChartAxes(ctx, width, height, layout, range, theme, { coverMargins: false, grid: true });
  const frame = buildChartFrame(spec, range, layout.rect.w);
  drawFrame2d(ctx, frame, layout.rect, spec, theme);
  drawChartAxes(ctx, width, height, layout, range, theme, { coverMargins: false, grid: false, hover: hover ?? null });
  return { frame, layout };
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

/**
 * 書き出し(閲覧用 HTML・Word / PowerPoint)へ焼く PNG(本文に直に書いたデータだけ。添付の CSV は呼び側が読めないので断る)。
 * @returns 描けなければ例外(呼び側が「描けませんでした」の器のまま残す)
 */
export async function renderGpuChartPng(
  source: string,
  opts: { width?: number; dpr?: number; theme?: ChartTheme; doc?: Document } = {},
): Promise<{ blob: Blob; cssWidth: number }> {
  const parsed = parseGpuChartSpec(source);
  if (!parsed.ok) throw new Error(parsed.error);
  const spec = parsed.spec;
  if (spec.source !== null) throw new Error('添付の CSV を参照するグラフは、書き出すファイルに画像で入れられません');
  const width = opts.width ?? 720;
  const doc = opts.doc ?? document;
  const canvas = doc.createElement('canvas');
  const drawn = paintChart2d(canvas, spec, homeRangeOf(spec), width, spec.height, opts.dpr ?? 2, opts.theme ?? PAPER_CHART_THEME);
  if (drawn === null) throw new Error('この端末では canvas に描けません');
  const blob = await canvasToPng(canvas);
  if (blob === null) throw new Error('PNG にできませんでした');
  return { blob, cssWidth: width };
}

// ───────────────────────────── ビューア本体

export type GpuChartState = 'loading' | 'ready' | 'fallback' | 'failed' | 'disposed';

const BACKEND_LABEL: Readonly<Record<string, string>> = { webgpu: 'WebGPU', webgl2: 'WebGL2', '2d': '簡易表示(2D)' };

export interface GpuChartView {
  readonly element: HTMLElement;
  readonly state: GpuChartState;
  /** 今の表示範囲。 */
  readonly range: ChartRange;
  /**
   * 🔑 **データを差し替える**(PR-8 のスクロール連動・PR-9 の別窓連動の口)。GPU の buffer を作り直し、`invalidate()` 1 回で描く。
   * @param opts.resetViewport 表示範囲を全体へ戻す(既定は今の範囲を新しいデータの範囲に収めて保つ)
   */
  updateData(nextSpec: GpuChartSpec, opts?: { resetViewport?: boolean }): void;
  /** 拡大(+1)・縮小(-1)。 */
  zoomStep(dir: 1 | -1): void;
  /** 全体表示。 */
  resetView(): void;
  /** 今の表示を PNG で保存する。 */
  savePng(): Promise<void>;
  dispose(): void;
}

class ChartView implements GpuChartView {
  readonly element: HTMLElement;
  readonly stage: HTMLElement;
  readonly overlay: HTMLCanvasElement;
  readonly info: { points: HTMLElement; hover: HTMLElement; backend: HTMLElement };
  readonly note: HTMLElement;
  readonly buttons: { zoomIn: HTMLButtonElement; zoomOut: HTMLButtonElement; reset: HTMLButtonElement; save: HTMLButtonElement };
  state: GpuChartState = 'loading';
  mode: 'gpu' | '2d' = 'gpu';
  spec: GpuChartSpec;
  home: ChartRange;
  cur: ChartRange;
  /** データの世代(差し替えのたびに進める ── GPU 側の buffer を作り直す合図)。 */
  dataGen = 0;
  total = 0;
  surface: GpuSurface | null = null;
  canvas2d: HTMLCanvasElement | null = null;
  hover: HoverMark | null = null;
  /** 最後に描いた描画域(当たり判定の座標系)。 */
  layout: ChartLayout | null = null;
  /** ポスターを出した(軸の層を隠した)。 */
  posterShown = false;
  private readonly cleanups: Array<() => void> = [];
  private drag: { id: number; x: number; y: number } | null = null;
  private noteBase = '';

  constructor(
    readonly host: HTMLElement,
    spec: GpuChartSpec,
  ) {
    this.spec = spec;
    this.home = homeRangeOf(spec);
    this.cur = this.home;
    this.total = gpuChartPointCount(spec);
    const doc = host.ownerDocument;
    this.element = doc.createElement('div');
    this.element.className = 'pkc-gpu-chart';
    this.element.setAttribute('data-pkc-gpu-chart', '');
    this.element.setAttribute('data-pkc-gpu-chart-state', 'loading');

    const bar = doc.createElement('div');
    bar.className = 'pkc-gpu-chart-bar';
    bar.setAttribute('data-pkc-field', 'gpu-chart-bar');
    const title = doc.createElement('span');
    title.className = 'pkc-gpu-chart-title';
    title.textContent = spec.title ?? '';
    const spacer = doc.createElement('span');
    spacer.className = 'pkc-gpu-chart-spacer';
    const mkBtn = (op: string, label: string, tip: string, aria?: string): HTMLButtonElement => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'pkc-gpu-chart-btn';
      b.setAttribute('data-pkc-variant', 'ghost');
      b.setAttribute('data-pkc-gpu-chart-op', op);
      b.textContent = label;
      b.title = tip;
      if (aria !== undefined) b.setAttribute('aria-label', aria);
      return b;
    };
    this.buttons = {
      zoomOut: mkBtn('zoom-out', '−', '縮小します(Ctrl + ホイールでも。キーボードの - でも)', '縮小'),
      zoomIn: mkBtn('zoom-in', '+', '拡大します(Ctrl + ホイールでも。キーボードの + でも)', '拡大'),
      reset: mkBtn('reset', '全体表示', 'データ全体が収まる表示に戻します(キーボードの 0 でも)'),
      save: mkBtn('save', 'PNG で保存', '今の表示を PNG の画像で保存します'),
    };
    bar.append(title, spacer, this.buttons.zoomOut, this.buttons.zoomIn, this.buttons.reset, this.buttons.save);

    this.stage = doc.createElement('div');
    this.stage.className = 'pkc-gpu-chart-stage';
    this.stage.setAttribute('data-pkc-gpu-chart-stage', '');
    this.stage.tabIndex = 0;
    this.stage.setAttribute('role', 'img');
    this.stage.setAttribute(
      'aria-label',
      `${gpuChartAltText(spec)}。ドラッグで移動、Ctrl + ホイールかボタンで拡大・縮小、矢印キーでも移動できます`,
    );
    this.stage.style.height = `${spec.height}px`;
    this.overlay = doc.createElement('canvas');
    this.overlay.className = 'pkc-gpu-chart-overlay';
    this.overlay.setAttribute('data-pkc-gpu-chart-overlay', '');
    this.overlay.setAttribute('aria-hidden', 'true');
    this.stage.append(this.overlay);

    const infoRow = doc.createElement('div');
    infoRow.className = 'pkc-gpu-chart-info';
    infoRow.setAttribute('data-pkc-field', 'gpu-chart-info');
    const mkInfo = (field: string): HTMLElement => {
      const s = doc.createElement('span');
      s.setAttribute('data-pkc-gpu-chart-info', field);
      return s;
    };
    this.info = { points: mkInfo('points'), hover: mkInfo('hover'), backend: mkInfo('backend') };
    this.info.hover.setAttribute('aria-live', 'polite');
    this.info.backend.textContent = '準備中';
    infoRow.append(this.info.points, this.info.hover, this.info.backend);

    this.note = doc.createElement('p');
    this.note.className = 'pkc-gpu-chart-note';
    this.note.setAttribute('data-pkc-gpu-chart-note', '');
    this.setNoteBase(spec.notes.join('。'));

    this.element.append(bar, this.stage, infoRow, this.note);
    host.append(this.element);
    this.updatePointsInfo(0);
    this.bindEvents();
  }

  get range(): ChartRange {
    return this.cur;
  }

  setState(s: GpuChartState): void {
    this.state = s;
    this.element.setAttribute('data-pkc-gpu-chart-state', s);
  }

  private setNoteBase(text: string, reason = ''): void {
    this.noteBase = text;
    const all = [reason, text].filter((t) => t !== '').join('。');
    this.note.textContent = all;
    this.note.hidden = all === '';
  }

  private updatePointsInfo(shown: number): void {
    this.info.points.textContent =
      shown > 0 && shown < this.total
        ? `${groupDigits(this.total)} 点(表示 ${groupDigits(shown)} 点)`
        : `${groupDigits(this.total)} 点`;
  }

  // ── 操作

  private on<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void {
    el.addEventListener(type, fn as EventListener, opts);
    this.cleanups.push(() => el.removeEventListener(type, fn as EventListener, opts));
  }

  private bindEvents(): void {
    const stage = this.stage;
    this.on(this.buttons.zoomIn, 'click', () => this.zoomStep(1));
    this.on(this.buttons.zoomOut, 'click', () => this.zoomStep(-1));
    this.on(this.buttons.reset, 'click', () => this.resetView());
    this.on(this.buttons.save, 'click', () => void this.savePng());
    // ⚠ 描画面の上の 2 回押しで、本文の側(編集を開くなど)を動かさない
    this.on(stage, 'dblclick', (e) => e.stopPropagation());
    this.on(stage, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try {
        stage.setPointerCapture?.(e.pointerId);
      } catch {
        /* 捕まえられなくても続ける */
      }
      this.surface?.setPinned(true);
      // 🔑 ポスターの上で触ったら、静かに GPU へ戻す
      if (this.posterShown) this.requestDraw();
    });
    this.on(stage, 'pointermove', (e) => {
      const d = this.drag;
      if (d !== null && d.id === e.pointerId) {
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (dx === 0 && dy === 0) return;
        this.drag = { id: d.id, x: e.clientX, y: e.clientY };
        const rect = this.layout?.rect;
        if (rect === undefined) return;
        this.setRange(panChartViewport(this.cur, this.home, dx / rect.w, dy / rect.h));
        return;
      }
      this.updateHover(e.clientX, e.clientY);
    });
    const end = (e: PointerEvent): void => {
      if (this.drag?.id !== e.pointerId) return;
      this.drag = null;
      this.surface?.setPinned(false);
    };
    this.on(stage, 'pointerup', end);
    this.on(stage, 'pointercancel', end);
    this.on(stage, 'pointerleave', () => {
      if (this.drag !== null) return;
      this.setHover(null, '');
    });
    this.on(
      stage,
      'wheel',
      (e) => {
        // 🔴 スクロールの取り合いを 0 にする: Ctrl / ⌘ + ホイール(トラックパッドのピンチを含む)のときだけ奪う。
        //   ただのホイールは preventDefault せず、本文のスクロールへ流す。
        //   ⚠ preventDefault を呼ぶ経路があるので非 passive で登録する(Ctrl + ホイールのページ拡大も止める)
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const rect = this.layout?.rect;
        const box = stage.getBoundingClientRect();
        const n = rect === undefined ? { nx: 0.5, ny: 0.5 } : pxToNorm(e.clientX - box.left, e.clientY - box.top, rect);
        const factor = Math.exp(-wheelDeltaPx(e.deltaY, e.deltaMode) * 0.002);
        this.setRange(zoomChartViewport(this.cur, this.home, factor, n.nx, n.ny));
      },
      { passive: false },
    );
    this.on(stage, 'keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const step = 0.1;
      switch (e.key) {
        case '+':
        case '=':
          this.zoomStep(1);
          break;
        case '-':
        case '_':
          this.zoomStep(-1);
          break;
        case '0':
          this.resetView();
          break;
        case 'ArrowLeft':
          this.setRange(panChartViewport(this.cur, this.home, step, 0));
          break;
        case 'ArrowRight':
          this.setRange(panChartViewport(this.cur, this.home, -step, 0));
          break;
        case 'ArrowUp':
          this.setRange(panChartViewport(this.cur, this.home, 0, step));
          break;
        case 'ArrowDown':
          this.setRange(panChartViewport(this.cur, this.home, 0, -step));
          break;
        default:
          return;
      }
      e.preventDefault();
      // ⚠ 拾ったキーは全体のショートカットへ流さない(`+` / `-` / `0` / 矢印)
      e.stopPropagation();
    });
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (RO !== undefined) {
      // ⚠ 大きさが本当に変わったときだけ(観測を始めた直後の報告で、畳んだ GPU を借り直さない)
      let lastW = -1;
      let lastH = -1;
      const ro = new RO((entries) => {
        const r = entries[entries.length - 1]?.contentRect;
        const w = Math.round(r?.width ?? stage.clientWidth);
        const h = Math.round(r?.height ?? stage.clientHeight);
        if (w === lastW && h === lastH) return;
        const first = lastW < 0;
        lastW = w;
        lastH = h;
        if (!first || this.mode === '2d') this.requestDraw();
      });
      ro.observe(stage);
      this.cleanups.push(() => ro.disconnect());
    }
    // テーマが変わったら描き直す(⚠ 配色の属性だけを見る ── `viewer-3d.ts` と同じ 3 つ)
    const html = this.host.ownerDocument.documentElement;
    const MO = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
    if (MO !== undefined && html !== null) {
      const mo = new MO(() => this.requestDraw());
      mo.observe(html, { attributes: true, attributeFilter: ['data-pkc-theme', 'data-pkc-tone', 'data-pkc-accent'] });
      this.cleanups.push(() => mo.disconnect());
    }
  }

  setRange(r: ChartRange): void {
    this.cur = r;
    this.hover = null;
    this.info.hover.textContent = '';
    this.requestDraw();
  }

  zoomStep(dir: 1 | -1): void {
    this.setRange(zoomChartViewport(this.cur, this.home, dir === 1 ? CHART_ZOOM_STEP : 1 / CHART_ZOOM_STEP, 0.5, 0.5));
  }

  resetView(): void {
    this.setRange(this.home);
  }

  updateData(nextSpec: GpuChartSpec, opts: { resetViewport?: boolean } = {}): void {
    if (this.state === 'disposed') return;
    this.spec = nextSpec;
    this.home = homeRangeOf(nextSpec);
    this.cur = opts.resetViewport === true ? this.home : clampChartRange(this.cur, this.home);
    this.total = gpuChartPointCount(nextSpec);
    this.dataGen += 1;
    this.setNoteBase(nextSpec.notes.join('。'), this.mode === '2d' ? this.fallbackReason : '');
    this.stage.setAttribute('aria-label', `${gpuChartAltText(nextSpec)}。ドラッグで移動、Ctrl + ホイールかボタンで拡大・縮小、矢印キーでも移動できます`);
    this.hover = null;
    this.info.hover.textContent = '';
    this.requestDraw();
  }

  /** 描き直しを頼む(GPU なら `invalidate()` を 1 回、2D ならその場で描く)。 */
  requestDraw(): void {
    if (this.state === 'disposed' || this.state === 'failed') return;
    if (this.mode === '2d') {
      this.draw2d();
      return;
    }
    this.surface?.invalidate();
  }

  // ── ホバー(当たり判定は features の純関数)

  private updateHover(clientX: number, clientY: number): void {
    const layout = this.layout;
    if (layout === null) return;
    const box = this.stage.getBoundingClientRect();
    const px = clientX - box.left;
    const py = clientY - box.top;
    const spec = this.spec;
    const theme = readChartTheme(this.stage);
    if (spec.heatmap !== null) {
      const hit = pickHeatmapCell(spec.heatmap, this.cur, layout.rect, px, py);
      if (hit === null) return this.setHover(null, '');
      const hm = spec.heatmap;
      const cx = dataToPxX(hit.col + 0.5, this.cur, layout.rect);
      const cy = dataToPxY(hm.rows - hit.row - 0.5, this.cur, layout.rect);
      const t = hm.max > hm.min ? (hit.value - hm.min) / (hm.max - hm.min) : 0.5;
      const color = rgbCss(heatColor(t, rgbOf(theme.bg, [1, 1, 1]), rgbOf(theme.accent, [0.2, 0.4, 0.9])));
      const xl = hm.xLabels[hit.col] ?? String(hit.col);
      const yl = hm.yLabels[hit.row] ?? String(hit.row);
      return this.setHover({ px: cx, py: cy, color }, `${xl} × ${yl}: ${hit.value}`);
    }
    const sorted = spec.type !== 'scatter';
    // 🔑 棒は系列ごとに横へずらして描いている ── 当たり判定も同じずれで見る(描いた所と当たる所を揃える)
    const n = spec.series.length;
    const offsets = spec.type === 'bar' ? spec.series.map((_, si) => (si - (n - 1) / 2) * (spec.barSlot / Math.max(1, n))) : undefined;
    const hit = pickChartPoint(spec.series, this.cur, layout.rect, px, py, spec.type === 'scatter' ? 10 : 18, sorted, offsets);
    if (hit === null) return this.setHover(null, '');
    const s = spec.series[hit.series]!;
    const xText = spec.xIsIndex ? (spec.labels[hit.x] ?? String(hit.x)) : String(hit.x);
    const color = rgbCss(seriesRgb(spec, theme, hit.series));
    this.setHover(
      { px: dataToPxX(hit.x + (offsets?.[hit.series] ?? 0), this.cur, layout.rect), py: dataToPxY(hit.y, this.cur, layout.rect), color },
      `${s.label}: x ${xText}、y ${hit.y}`,
    );
  }

  private setHover(mark: HoverMark | null, text: string): void {
    const same = this.hover === null && mark === null;
    this.hover = mark;
    this.info.hover.textContent = text;
    if (same) return;
    // 🔑 十字線は軸の層へその場で描く(GPU のコマは回さない)。ポスターのとき・2D のときは描き直しを頼む
    if (this.mode === '2d') this.draw2d();
    else if (this.posterShown) this.requestDraw();
    else this.drawOverlay();
  }

  // ── GPU

  start(): void {
    this.surface = surfaceFactory({
      host: this.stage,
      onAcquire: (ctx) => this.acquire(ctx),
      onFallback2d: (_host, reason) => this.enterFallback2d(reason),
    });
    // 最初の 1 コマ(見えるまでは gpu-lease が待つ)
    this.surface.invalidate();
  }

  private stageSize(): { w: number; h: number } {
    return { w: Math.max(1, this.stage.clientWidth || 1), h: Math.max(1, this.stage.clientHeight || this.spec.height) };
  }

  /** 軸の層を描く(GPU のとき)。 */
  drawOverlay(size?: { w: number; h: number; dpr: number }): void {
    const { w, h } = size ?? this.stageSize();
    const dpr = size?.dpr ?? Math.min(2, globalThis.devicePixelRatio || 1);
    const c = this.overlay;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (c.width !== pw) c.width = pw;
    if (c.height !== ph) c.height = ph;
    let ctx: CanvasRenderingContext2D | null;
    try {
      ctx = c.getContext('2d');
    } catch {
      ctx = null;
    }
    const theme = readChartTheme(this.stage);
    const layout = layoutChart(ctx, this.spec, this.cur, w, h);
    this.layout = layout;
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    drawChartAxes(ctx, w, h, layout, this.cur, theme, { coverMargins: true, grid: true, hover: this.hover });
  }

  private acquire(ctx: GpuContext): GpuSession {
    const T = ctx.three as Three;
    const scene = new T.Scene();
    const camera = new T.OrthographicCamera(0, 1, 1, 0, -10, 10);
    camera.position.set(0, 0, 5);
    const quad = new T.PlaneGeometry(1, 1);
    const circle = new T.CircleGeometry(1, 12);
    const markMat = new T.MeshBasicMaterial({ color: 0xffffff });
    let mesh: ThreeModule.InstancedMesh | null = null;
    let meshCap = 0;
    let meshKind: 'rect' | 'point' | null = null;
    let lines: ThreeModule.LineSegments[] = [];
    const lineMats: ThreeModule.LineBasicMaterial[] = [];
    let builtGen = -1;

    const dropMesh = (): void => {
      if (mesh === null) return;
      scene.remove(mesh);
      mesh.dispose();
      mesh = null;
      meshCap = 0;
      meshKind = null;
    };
    const dropLines = (): void => {
      for (const l of lines) {
        scene.remove(l);
        l.geometry.dispose();
      }
      lines = [];
    };

    const ensureMesh = (kind: 'rect' | 'point', count: number): ThreeModule.InstancedMesh => {
      if (mesh !== null && meshKind === kind && meshCap >= count) return mesh;
      dropMesh();
      // ⚠ 少し余裕を持って作る(拡大・移動で数が少し増えるたびに作り直さない)
      const cap = Math.max(16, Math.ceil(count * 1.25));
      const im = new T.InstancedMesh(kind === 'rect' ? quad : circle, markMat, cap);
      im.instanceColor = new T.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      im.frustumCulled = false;
      scene.add(im);
      mesh = im;
      meshCap = cap;
      meshKind = kind;
      return im;
    };

    /** 🔴 1 コマの描く物を GPU の buffer へ書く(正規化した座標 ── 精度は今の表示範囲で保つ)。 */
    const writeFrame = (frame: ChartFrame, rect: PlotRect, theme: ChartTheme): void => {
      if (builtGen !== this.dataGen) {
        // データを差し替えた ── 古い buffer を返して作り直す
        dropMesh();
        dropLines();
        builtGen = this.dataGen;
      }
      const spec = this.spec;
      // 線(系列ごとに LineSegments 1 つ = 描画呼び出し 1 回)
      dropLines();
      frame.lines.forEach((ln) => {
        if (ln.segCount === 0) return;
        const pos = new Float32Array(ln.segCount * 6);
        for (let k = 0; k < ln.segCount; k++) {
          const s = k * 4;
          const o = k * 6;
          pos[o] = ln.segs[s]!;
          pos[o + 1] = ln.segs[s + 1]!;
          pos[o + 3] = ln.segs[s + 2]!;
          pos[o + 4] = ln.segs[s + 3]!;
        }
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(pos, 3));
        let mat = lineMats[ln.series];
        if (mat === undefined) {
          mat = new T.LineBasicMaterial({ color: 0xffffff });
          lineMats[ln.series] = mat;
        }
        const c = seriesRgb(spec, theme, ln.series);
        mat.color.setRGB(c[0], c[1], c[2]);
        const l = new T.LineSegments(g, mat);
        l.frustumCulled = false;
        scene.add(l);
        lines.push(l);
      });
      // 印(棒・セル・点)── InstancedMesh 1 つ = 描画呼び出し 1 回
      if (frame.markKind === 'none' || frame.markCount === 0) {
        if (mesh !== null) mesh.count = 0;
        return;
      }
      const im = ensureMesh(frame.markKind, frame.markCount);
      const mat = im.instanceMatrix.array as Float32Array;
      const col = im.instanceColor!.array as Float32Array;
      const m = frame.marks;
      const from = rgbOf(theme.bg, [1, 1, 1]);
      const to = rgbOf(theme.accent, [0.2, 0.4, 0.9]);
      const palette = spec.series.map((_, i) => seriesRgb(spec, theme, i));
      if (frame.markKind === 'rect') {
        for (let k = 0; k < frame.markCount; k++) {
          const s = k * 5;
          const x0 = m[s]!;
          const y0 = m[s + 1]!;
          // ⚠ 細い棒・セルも 1px は塗る(消えない)
          const sx = Math.max(m[s + 2]! - x0, 1 / rect.w);
          const sy = Math.max(m[s + 3]! - y0, 1 / rect.h);
          const o = k * 16;
          mat.fill(0, o, o + 16);
          mat[o] = sx;
          mat[o + 5] = sy;
          mat[o + 10] = 1;
          mat[o + 12] = x0 + sx / 2;
          mat[o + 13] = y0 + sy / 2;
          mat[o + 15] = 1;
          const c = spec.heatmap !== null ? heatColor(m[s + 4]!, from, to) : (palette[m[s + 4]!] ?? to);
          col[k * 3] = c[0];
          col[k * 3 + 1] = c[1];
          col[k * 3 + 2] = c[2];
        }
      } else {
        const r = pointRadiusPx(frame.markCount);
        const rx = r / rect.w;
        const ry = r / rect.h;
        for (let k = 0; k < frame.markCount; k++) {
          const s = k * 3;
          const o = k * 16;
          mat.fill(0, o, o + 16);
          mat[o] = rx;
          mat[o + 5] = ry;
          mat[o + 10] = 1;
          mat[o + 12] = m[s]!;
          mat[o + 13] = m[s + 1]!;
          mat[o + 15] = 1;
          const c = palette[m[s + 2]!] ?? to;
          col[k * 3] = c[0];
          col[k * 3 + 1] = c[1];
          col[k * 3 + 2] = c[2];
        }
      }
      im.count = frame.markCount;
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor!.needsUpdate = true;
    };

    let lastSize: GpuFrameSize = { width: 1, height: 1, pixelRatio: 1 };
    const render = (size: GpuFrameSize): void => {
      lastSize = size;
      const w = size.width;
      const h = size.height;
      // 軸の層を先に(描画域が決まる)── ポスターを出していたら層を戻す
      this.posterShown = false;
      this.overlay.hidden = false;
      this.drawOverlay({ w, h, dpr: size.pixelRatio });
      const layout = this.layout!;
      const rect = layout.rect;
      const theme = readChartTheme(this.stage);
      scene.background = new T.Color(theme.bg);
      const frame = buildChartFrame(this.spec, this.cur, rect.w);
      writeFrame(frame, rect, theme);
      this.updatePointsInfo(frame.shown);
      // 描画域が 0〜1 に、余白がその外側になるカメラ
      camera.left = -rect.x / rect.w;
      camera.right = 1 + (w - rect.x - rect.w) / rect.w;
      camera.top = 1 + rect.y / rect.h;
      camera.bottom = -(h - rect.y - rect.h) / rect.h;
      camera.updateProjectionMatrix();
      // ⚠ 描画域の外(軸の余白)へはみ出した分は、軸の層が余白を地の色で塗って隠す
      const r = ctx.renderer as unknown as { render(s: ThreeModule.Scene, c: ThreeModule.Camera): void };
      r.render(scene, camera);
    };

    if (this.state === 'loading') this.setState('ready');
    this.info.backend.textContent = BACKEND_LABEL[ctx.backend] ?? ctx.backend;
    this.info.backend.setAttribute('data-pkc-gpu-chart-backend', ctx.backend);
    this.element.setAttribute('data-pkc-gpu-chart-backend', ctx.backend);
    return {
      render,
      capturePoster: async () => {
        // ⚠ WebGL は描画バッファを残さない ── 1 コマ描いてから同じ処理の中で軸の層と重ねて焼く
        render(lastSize);
        const doc = this.stage.ownerDocument;
        let blob: Blob | null = null;
        try {
          const c = doc.createElement('canvas');
          c.width = ctx.canvas.width || this.overlay.width;
          c.height = ctx.canvas.height || this.overlay.height;
          const g = c.getContext('2d');
          if (g !== null) {
            g.drawImage(ctx.canvas, 0, 0, c.width, c.height);
            // 🔴 空白にしない: 地は不透明に描いている ── 描画域の真ん中が透明なら、GPU の絵を写せていない
            //    (WebGPU の canvas はタスクを抜けると絵が失効しうる)→ 下の 2D で焼く
            const rect = this.layout?.rect;
            const k = c.width / Math.max(1, this.stageSize().w);
            const probe = rect === undefined ? null : g.getImageData(Math.floor((rect.x + rect.w / 2) * k), Math.floor((rect.y + rect.h / 2) * k), 1, 1);
            if (probe !== null && (probe.data[3] ?? 0) > 0) {
              g.drawImage(this.overlay, 0, 0, c.width, c.height);
              blob = await canvasToPng(c);
            }
          }
        } catch {
          blob = null;
        }
        if (blob === null) {
          // 重ねられなかった ── 同じ座標の 2D で焼く(空白にしない)
          const { w, h } = this.stageSize();
          const c = doc.createElement('canvas');
          if (paintChart2d(c, this.spec, this.cur, w, h, lastSize.pixelRatio, readChartTheme(this.stage), null) !== null) {
            blob = await canvasToPng(c);
          }
        }
        if (blob !== null) {
          // ポスターが軸ごと持っている ── 軸の層は隠す(二重に描かない)
          this.posterShown = true;
          this.overlay.hidden = true;
        }
        return blob;
      },
      dispose: () => {
        dropMesh();
        dropLines();
        quad.dispose();
        circle.dispose();
        markMat.dispose();
        for (const m of lineMats) m?.dispose();
        lineMats.length = 0;
        builtGen = -1;
      },
    };
  }

  // ── 2D の簡易表示(GPU と同じ座標・操作・当たり判定)

  fallbackReason = '';

  enterFallback2d(reason: string): void {
    if (this.state === 'disposed') return;
    this.mode = '2d';
    this.fallbackReason = reason;
    this.setState('fallback');
    this.info.backend.textContent = BACKEND_LABEL['2d']!;
    this.info.backend.setAttribute('data-pkc-gpu-chart-backend', '2d');
    this.element.setAttribute('data-pkc-gpu-chart-backend', '2d');
    this.setNoteBase(this.noteBase, reason);
    this.overlay.hidden = true;
    const c = this.stage.ownerDocument.createElement('canvas');
        c.setAttribute('data-pkc-gpu-chart-canvas2d', '');
    this.stage.append(c);
    this.canvas2d = c;
    this.draw2d();
  }

  draw2d(): void {
    const c = this.canvas2d;
    if (c === null) return;
    const { w, h } = this.stageSize();
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const drawn = paintChart2d(c, this.spec, this.cur, w, h, dpr, readChartTheme(this.stage), this.hover);
    if (drawn === null) {
      // canvas も使えない ── 少なくとも点の数と範囲は読める
      this.layout = layoutChart(null, this.spec, this.cur, w, h);
      return;
    }
    this.layout = drawn.layout;
    this.updatePointsInfo(drawn.frame.shown);
  }

  async savePng(): Promise<void> {
    const { w, h } = this.stageSize();
    const c = this.stage.ownerDocument.createElement('canvas');
    // 🔑 保存は同じ座標の 2D で 2 倍に描く(どの段で表示していても同じ絵)
    if (paintChart2d(c, this.spec, this.cur, w, h, 2, readChartTheme(this.stage), null) === null) {
      this.info.hover.textContent = 'この端末では PNG にできませんでした';
      return;
    }
    const blob = await canvasToPng(c);
    if (blob === null) {
      this.info.hover.textContent = 'この端末では PNG にできませんでした';
      return;
    }
    // 🔑 名前の規則は書き出しと同じ 1 か所(`safeName`)+ 日付(他の書き出しと同じ形)
    saveBlob(`${safeName(this.spec.title ?? 'グラフ')}-${dayStamp(new Date(), '')}.png`, blob);
  }

  fail(message: string): void {
    this.setState('failed');
    this.setNoteBase(message);
    const s = this.surface;
    this.surface = null;
    queueMicrotask(() => s?.dispose());
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.setState('disposed');
    for (const c of this.cleanups.splice(0)) c();
    this.drag = null;
    const s = this.surface;
    this.surface = null;
    s?.dispose();
    this.canvas2d = null;
    this.layout = null;
    this.element.remove();
  }
}

/**
 * 🔴 **GPU のグラフを置く**。⚠ ここでは Three.js を読み込まない ── 描画面が見えて最初の 1 コマを描くときに gpu-lease が読む。
 */
export function mountGpuChart(host: HTMLElement, spec: GpuChartSpec): GpuChartView {
  const view = new ChartView(host, spec);
  view.start();
  return view;
}

// ───────────────────────────── 器を埋める(`hydrateFigures` の 1 員)

export interface HydrateGpuChartOptions {
  readonly getAssetBlob?: GetAssetBlob;
}

export const GPU_CHART_SRC_ATTR = 'data-pkc-gpu-chart-src';
const STATE_ATTR = 'data-pkc-gpu-chart-state';
const ERROR_ATTR = 'data-pkc-gpu-chart-error';

/** 添付の CSV を読んで仕様を埋める。読めなければ理由の文。 */
export async function resolveGpuChartSource(spec: GpuChartSpec, getAssetBlob: GetAssetBlob | undefined): Promise<GpuChartSpec | string> {
  const src = spec.source;
  if (src === null) return spec;
  if (getAssetBlob === undefined) return 'この画面では添付の CSV を読み込めません';
  const got = await getAssetBlob(src.key).catch(() => null);
  if (got === null) return `グラフを描けません: 添付(${src.key})が見つかりません`;
  let text: string;
  try {
    text = await got.blob.text();
  } catch {
    return `グラフを描けません: 添付(${src.key})を読めませんでした`;
  }
  const r = parseGpuChartCsv(text, spec);
  return r.ok ? r.spec : r.error;
}

type IoCtor = new (
  cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void,
  opts?: { rootMargin?: string },
) => { observe(el: Element): void; unobserve(el: Element): void; disconnect(): void };

/**
 * 🔴 **GPU のグラフの器を埋める**。器が無ければ何もしない(Three.js も読まない)。
 * - 見えるまで置かない(`IntersectionObserver`。無い環境ではすぐ置く)
 * - 打鍵中は置くのを待つ(`typingQuietIn` ── 長いノートの打鍵の描画を遅らせない)
 * 返す口は図の塊と同じ形(`MermaidScope`)── `prune()` は DOM から外れた器のビューアを畳む。
 */
export function hydrateGpuChart(root: ParentNode | readonly ParentNode[], opts: HydrateGpuChartOptions = {}): MermaidScope {
  const roots: readonly ParentNode[] = Array.isArray(root) ? (root as readonly ParentNode[]) : [root as ParentNode];
  const hosts: HTMLElement[] = [];
  for (const r of roots) {
    if (r instanceof Element && r.matches(`[${GPU_CHART_SRC_ATTR}]`)) hosts.push(r as HTMLElement);
    hosts.push(...r.querySelectorAll<HTMLElement>(`[${GPU_CHART_SRC_ATTR}]`));
  }
  if (hosts.length === 0) return { dispose: () => undefined, prune: () => 0, flush: () => Promise.resolve() };

  const views = new Map<HTMLElement, GpuChartView>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  const failHost = (host: HTMLElement, error: string): void => {
    host.setAttribute(STATE_ATTR, 'failed');
    host.setAttribute(ERROR_ATTR, error);
  };
  const mount = (host: HTMLElement): void => {
    if (disposed || !host.isConnected || views.has(host)) return;
    const wait = typingQuietIn();
    if (wait > 0) {
      const t = setTimeout(() => {
        timers.delete(t);
        mount(host);
      }, wait);
      timers.add(t);
      return;
    }
    const parsed = parseGpuChartSpec(host.getAttribute(GPU_CHART_SRC_ATTR) ?? '');
    if (!parsed.ok) {
      failHost(host, parsed.error);
      return;
    }
    if (parsed.spec.source === null) {
      views.set(host, mountGpuChart(host, parsed.spec));
      host.setAttribute(STATE_ATTR, 'ready');
      return;
    }
    void resolveGpuChartSource(parsed.spec, opts.getAssetBlob).then((spec) => {
      if (disposed || !host.isConnected || views.has(host)) return;
      if (typeof spec === 'string') {
        failHost(host, spec);
        return;
      }
      views.set(host, mountGpuChart(host, spec));
      host.setAttribute(STATE_ATTR, 'ready');
    });
  };

  const Io = (globalThis as { IntersectionObserver?: IoCtor }).IntersectionObserver;
  const io =
    Io === undefined
      ? null
      : new Io(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              io?.unobserve(e.target);
              mount(e.target as HTMLElement);
            }
          },
          { rootMargin: '200px' },
        );
  for (const host of hosts) {
    // ⚠ 同じ器に 2 枚目を置かない(差分反映で同じ器が 2 度渡ってきても)
    if (host.hasAttribute(STATE_ATTR)) continue;
    host.setAttribute(STATE_ATTR, 'loading');
    if (io === null) mount(host);
    else io.observe(host);
  }
  return {
    dispose: () => {
      disposed = true;
      io?.disconnect();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const v of views.values()) v.dispose();
      views.clear();
      // 🔑 器の印を外す ── 同じ器を次の塊が埋め直せる(印が残ると「済み」と見て空のまま飛ばす)
      for (const h of hosts) {
        h.removeAttribute(STATE_ATTR);
        h.removeAttribute(ERROR_ATTR);
      }
    },
    prune: () => {
      for (const [host, v] of views) {
        if (!host.isConnected) {
          v.dispose();
          views.delete(host);
          io?.unobserve(host);
        }
      }
      return hosts.filter((h) => h.isConnected && h.getAttribute(STATE_ATTR) !== 'failed').length;
    },
    flush: () => Promise.resolve(),
  };
}
