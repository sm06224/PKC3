/**
 * 🔴 **GPU グラフの別ウィンドウとの通信の正本**(v4.1 Phase 3 / PR-9、#2095 後半)。
 *
 * 親(メインウィンドウ)と別ウィンドウは、**ここの 1 組の封筒・検証・詰め直し**だけを使う(CLAUDE.md §7 ──
 * 片方だけ改名すると機構ごと死ぬので、`tests/adapter/chart-popout.test.ts` が両端の実物どうしを繋いで突き合わせる)。
 *
 * - 放送路は**専用の 1 本**(`pkc3-chart-sync`)── store / view-window / pdf の放送路と混ぜない。
 * - 封筒は全部 `{ pkc3Chart: <種別>, token, payload }`。⚠ 放送は全タブに届く ── **自分が開いた窓の token だけ**受ける。
 * - ⚠ 届いた物は**全部疑う**(fail-closed): 形が外れた便りは `null`(黙って捨てる)。
 * - データ(`Float64Array`)は structured clone でそのまま渡る ── 詰め直しで余計な写しを作らない。
 *
 * 🔑 純関数だけ(DOM・放送路・時計に触らない)。開き方・寿命は `adapter/platform/chart-popout.ts`、
 *   別ウィンドウの画面は `adapter/ui/render/chart-popout-window.ts`。
 */
import {
  CHART_BIND_MODES,
  GPU_CHART_MAX_DATASETS,
  GPU_CHART_MAX_HEATMAP_CELLS,
  GPU_CHART_MAX_HEIGHT,
  GPU_CHART_MAX_POINTS,
  GPU_CHART_MIN_HEIGHT,
  GPU_CHART_TYPES,
  GPU_CHART_MAX_FRAMES,
  type ChartBindMode,
  type GpuChartHeatmap,
  type GpuChartSeries,
  type GpuChartSpec,
} from './gpu-chart-spec';
import type { ChartContextSignal } from './gpu-chart-bind';
import { formatChartPopoutLink, parseChartPopoutLink } from '../link/permalink';

/** 放送路の名前。⚠ 他の放送路(`pkc3-view-window` / `pkc3-pdf` / store)と混ぜない。 */
export const CHART_SYNC_CHANNEL = 'pkc3-chart-sync';
/** 封筒の種別を載せる鍵。 */
export const CHART_SYNC_TAG = 'pkc3Chart';
/**
 * 別ウィンドウの名乗り(`hello`)を待つ時間。⚠ `view-window.ts` の `VIEW_WINDOW_ANNOUNCE_MS` と同じ実測基準
 * (動きの遅い端末では 2.5 秒を過ぎてから窓が出る)。待つのは失敗した回だけ。
 */
export const CHART_POPOUT_HELLO_MS = 4500;
/** 別ウィンドウの大きさ。 */
export const CHART_POPOUT_SIZE = { width: 900, height: 640 } as const;
/**
 * 🔴 **開き方**。`noopener` を外さない ── 閉じた瞬間に別プロセスごとメモリと GPU のメモリが OS へ返る
 * (`view-window.ts` の実測表)。⚠ 値と使う口を 1 か所に置く(落としても test が緑のまま、にしない)。
 */
export const CHART_POPOUT_FEATURES = `popup,noopener,width=${CHART_POPOUT_SIZE.width},height=${CHART_POPOUT_SIZE.height}`;

/** 別ウィンドウ → 親 / 親 → 別ウィンドウ の種別。⚠ 一覧はここに 1 つだけ。 */
export const CHART_SYNC_KINDS = ['hello', 'jump', 'closed', 'init', 'update', 'theme', 'source-closed'] as const;
export type ChartSyncKind = (typeof CHART_SYNC_KINDS)[number];

/** 配色(`<html>` の 3 つの属性 ── `gpu-chart.ts` / `viewer-3d.ts` が見ているのと同じ 3 つ)。 */
export interface ChartThemeAttrs {
  readonly theme: string | null;
  readonly tone: string | null;
  readonly accent: string | null;
}
export const CHART_THEME_ATTRS = ['data-pkc-theme', 'data-pkc-tone', 'data-pkc-accent'] as const;

/** 連動の時点の名前(前へ・次への押せる / 押せないを別ウィンドウで決める)。 */
export interface ChartFrameMeta {
  readonly key: string;
  readonly label: string;
}

/** 親 → 別ウィンドウ: 最初に見せる一式。 */
export interface ChartInitPayload {
  readonly noteTitle: string;
  readonly chartTitle: string;
  /** 描くデータ。`null` は「この場所にはデータが無い」(`emptyReason`)。 */
  readonly spec: GpuChartSpec | null;
  readonly emptyReason?: string;
  /** 連動の種類(連動グラフのときだけ)。 */
  readonly bindMode?: ChartBindMode;
  readonly framesMeta?: readonly ChartFrameMeta[];
  readonly currentIndex: number;
  readonly currentLabel: string;
  readonly theme: ChartThemeAttrs;
}

/** 親 → 別ウィンドウ: 現在地・データが変わった。 */
export interface ChartUpdatePayload {
  readonly signal?: ChartContextSignal;
  readonly spec: GpuChartSpec | null;
  readonly emptyReason?: string;
  readonly label: string;
  readonly index: number;
  readonly total: number;
  readonly animate: boolean;
  /** 時点の名前の一覧が変わった(本文を保存して見出しが増えた等)。 */
  readonly framesMeta?: readonly ChartFrameMeta[];
  /**
   * 🔑 **別ウィンドウの「前へ / 次へ」への返事**。固定中でもこの時点を見せる(押した人が見たい物)。
   * ⚠ 本文のスクロールから来た便りには付けない(固定中は控えに置くだけ)。
   */
  readonly requested?: boolean;
}

export interface ChartJumpPayload {
  readonly index: number;
  readonly key: string;
}

export interface ChartSourceClosedPayload {
  readonly reason: string;
}

export type ChartSyncMessage =
  | { readonly kind: 'hello'; readonly token: string }
  | { readonly kind: 'closed'; readonly token: string }
  | { readonly kind: 'jump'; readonly token: string; readonly payload: ChartJumpPayload }
  | { readonly kind: 'init'; readonly token: string; readonly payload: ChartInitPayload }
  | { readonly kind: 'update'; readonly token: string; readonly payload: ChartUpdatePayload }
  | { readonly kind: 'theme'; readonly token: string; readonly payload: ChartThemeAttrs }
  | { readonly kind: 'source-closed'; readonly token: string; readonly payload: ChartSourceClosedPayload };

/** 別ウィンドウの合図の綴り(`permalink.ts` と同じ規則)。 */
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function isChartPopoutToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_RE.test(v);
}

/** 別ウィンドウのアドレス(`<base>#pkc?chart=<token>`)。組めなければ `null`。 */
export function formatChartPopoutUrl(baseUrl: string, token: string): string | null {
  return formatChartPopoutLink(baseUrl, token);
}

/** アドレス(または断片)から別ウィンドウの合図を読む。別ウィンドウでなければ `null`。 */
export function parseChartPopoutToken(raw: string): string | null {
  return parseChartPopoutLink(raw);
}

// ───────────────────────────── グラフの仕様の詰め直し

/** 放送で渡す形(structured clone できる素の物)。⚠ `bind` / `frameDefs`(Map)/ `source` は渡さない ── 別ウィンドウは描くだけ。 */
export interface SerializedGpuChartSpec {
  readonly v: 1;
  readonly type: string;
  readonly title?: string;
  readonly height: number;
  readonly labels: readonly string[];
  readonly xIsIndex: boolean;
  readonly series: readonly { label: string; xs: Float64Array; ys: Float64Array; color?: string }[];
  readonly heatmap: {
    cols: number;
    rows: number;
    values: Float64Array;
    xLabels: readonly string[];
    yLabels: readonly string[];
    min: number;
    max: number;
  } | null;
  readonly barSlot: number;
  readonly notes: readonly string[];
  readonly highlightX?: number;
}

/**
 * 🔑 **放送に載せる形へ**。`Float64Array` はそのまま(写しは放送の structured clone の 1 回だけ)。
 */
export function serializeGpuChartSpec(spec: GpuChartSpec): SerializedGpuChartSpec {
  return {
    v: 1,
    type: spec.type,
    ...(spec.title === undefined ? {} : { title: spec.title }),
    // ⚠ 囲みで固定した高さ(80〜2000)は、受け手の検め(160〜900)に合わせて丸める ── 別ウィンドウは自分の大きさで描く(v4.2 PR-1)
    height: Math.max(GPU_CHART_MIN_HEIGHT, Math.min(GPU_CHART_MAX_HEIGHT, spec.height)),
    labels: [...spec.labels],
    xIsIndex: spec.xIsIndex,
    series: spec.series.map((s) => ({ label: s.label, xs: s.xs, ys: s.ys, ...(s.color === undefined ? {} : { color: s.color }) })),
    heatmap:
      spec.heatmap === null
        ? null
        : {
            cols: spec.heatmap.cols,
            rows: spec.heatmap.rows,
            values: spec.heatmap.values,
            xLabels: [...spec.heatmap.xLabels],
            yLabels: [...spec.heatmap.yLabels],
            min: spec.heatmap.min,
            max: spec.heatmap.max,
          },
    barSlot: spec.barSlot,
    notes: [...spec.notes],
    ...(spec.highlightX === undefined ? {} : { highlightX: spec.highlightX }),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown, max: number): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string');
const isFin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** 数の列(欠測の `NaN` は通す ── 線を切る印)。⚠ 素の配列で来ても受ける(古い送り手・別の詰め方)。 */
function toF64(v: unknown, max: number): Float64Array | null {
  if (v instanceof Float64Array) return v.length <= max ? v : null;
  if (Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'number')) return Float64Array.from(v as number[]);
  return null;
}

/**
 * 🔴 **放送から受けた仕様を検める**(fail-closed)。形が 1 つでも外れたら `null`(描かない・例外を投げない)。
 */
export function deserializeGpuChartSpec(raw: unknown): GpuChartSpec | null {
  if (!isRecord(raw) || raw.v !== 1) return null;
  const type = raw.type;
  if (typeof type !== 'string' || !(GPU_CHART_TYPES as readonly string[]).includes(type)) return null;
  const height = raw.height;
  if (!isFin(height) || height < GPU_CHART_MIN_HEIGHT || height > GPU_CHART_MAX_HEIGHT) return null;
  if (raw.title !== undefined && typeof raw.title !== 'string') return null;
  if (!isStrArr(raw.labels, GPU_CHART_MAX_POINTS)) return null;
  if (typeof raw.xIsIndex !== 'boolean') return null;
  if (!isFin(raw.barSlot) || raw.barSlot <= 0) return null;
  if (!isStrArr(raw.notes, 64)) return null;
  if (raw.highlightX !== undefined && !isFin(raw.highlightX)) return null;
  if (!Array.isArray(raw.series) || raw.series.length > GPU_CHART_MAX_DATASETS) return null;
  const series: GpuChartSeries[] = [];
  let points = 0;
  for (const s of raw.series as unknown[]) {
    if (!isRecord(s) || typeof s.label !== 'string') return null;
    if (s.color !== undefined && typeof s.color !== 'string') return null;
    const xs = toF64(s.xs, GPU_CHART_MAX_POINTS);
    const ys = toF64(s.ys, GPU_CHART_MAX_POINTS);
    if (xs === null || ys === null || xs.length !== ys.length) return null;
    points += xs.length;
    if (points > GPU_CHART_MAX_POINTS) return null;
    series.push({ label: s.label, xs, ys, ...(s.color === undefined ? {} : { color: s.color }) });
  }
  let heatmap: GpuChartHeatmap | null = null;
  if (raw.heatmap !== null) {
    const h = raw.heatmap;
    if (!isRecord(h)) return null;
    const { cols, rows } = h;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 1 || (rows as number) < 1) return null;
    const cells = (cols as number) * (rows as number);
    if (cells > GPU_CHART_MAX_HEATMAP_CELLS) return null;
    const values = toF64(h.values, GPU_CHART_MAX_HEATMAP_CELLS);
    if (values === null || values.length !== cells) return null;
    if (!isStrArr(h.xLabels, cols as number) || !isStrArr(h.yLabels, rows as number)) return null;
    if (!isFin(h.min) || !isFin(h.max)) return null;
    heatmap = { cols: cols as number, rows: rows as number, values, xLabels: h.xLabels, yLabels: h.yLabels, min: h.min, max: h.max };
  }
  // ⚠ 種類と中身の対応(heatmap なのにセルが無い / 線なのに系列が無い)── 描けない仕様は通さない
  if (type === 'heatmap' ? heatmap === null : series.length === 0) return null;
  return {
    type: type as GpuChartSpec['type'],
    ...(raw.title === undefined ? {} : { title: raw.title as string }),
    height,
    labels: raw.labels,
    xIsIndex: raw.xIsIndex,
    series,
    heatmap,
    source: null,
    barSlot: raw.barSlot,
    notes: raw.notes,
    ...(raw.highlightX === undefined ? {} : { highlightX: raw.highlightX as number }),
  };
}

// ───────────────────────────── 封筒

/** 封筒を作る(載せる仕様は詰め直す)。 */
export function makeChartSyncMessage(msg: ChartSyncMessage): Record<string, unknown> {
  const base = { [CHART_SYNC_TAG]: msg.kind, token: msg.token };
  switch (msg.kind) {
    case 'hello':
    case 'closed':
      return base;
    case 'init':
    case 'update': {
      const p = msg.payload;
      return { ...base, payload: { ...p, spec: p.spec === null ? null : serializeGpuChartSpec(p.spec) } };
    }
    default:
      return { ...base, payload: msg.payload };
  }
}

const str = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length <= max;
const optStr = (v: unknown): boolean => v === undefined || str(v);
const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= -1 && (v as number) <= GPU_CHART_MAX_FRAMES;

function readTheme(v: unknown): ChartThemeAttrs | null {
  if (!isRecord(v)) return null;
  const ok = (x: unknown): boolean => x === null || (typeof x === 'string' && /^[A-Za-z0-9_-]{0,40}$/.test(x));
  if (!ok(v.theme) || !ok(v.tone) || !ok(v.accent)) return null;
  return { theme: v.theme as string | null, tone: v.tone as string | null, accent: v.accent as string | null };
}

function readFramesMeta(v: unknown): ChartFrameMeta[] | null {
  if (!Array.isArray(v) || v.length > GPU_CHART_MAX_FRAMES) return null;
  const out: ChartFrameMeta[] = [];
  for (const f of v as unknown[]) {
    if (!isRecord(f) || !str(f.key, 200) || !str(f.label, 500)) return null;
    out.push({ key: f.key, label: f.label });
  }
  return out;
}

function readSignal(v: unknown): ChartContextSignal | null {
  if (!isRecord(v)) return null;
  if (!str(v.lid, 200) || !str(v.key, 200) || !str(v.label, 500)) return null;
  if (typeof v.mode !== 'string' || !(CHART_BIND_MODES as readonly string[]).includes(v.mode)) return null;
  if (!isIndex(v.index) || !Number.isInteger(v.total) || (v.total as number) < 0) return null;
  return { lid: v.lid, mode: v.mode as ChartBindMode, key: v.key, label: v.label, index: v.index, total: v.total as number };
}

/** 仕様: `null`(データ無し)か検めて通った物。⚠ 形が外れた仕様は封筒ごと捨てる(`undefined`)。 */
function readSpec(v: unknown): GpuChartSpec | null | undefined {
  if (v === null) return null;
  return deserializeGpuChartSpec(v) ?? undefined;
}

/**
 * 🔴 **届いた便りを検める**(fail-closed)。種別・token・中身の形が外れたら `null`。
 */
export function parseChartSyncMessage(data: unknown): ChartSyncMessage | null {
  if (!isRecord(data)) return null;
  const kind = data[CHART_SYNC_TAG];
  if (typeof kind !== 'string' || !(CHART_SYNC_KINDS as readonly string[]).includes(kind)) return null;
  const token = data.token;
  if (!isChartPopoutToken(token)) return null;
  const p = data.payload;
  switch (kind as ChartSyncKind) {
    case 'hello':
      return { kind: 'hello', token };
    case 'closed':
      return { kind: 'closed', token };
    case 'jump': {
      if (!isRecord(p) || !Number.isInteger(p.index) || (p.index as number) < 0 || (p.index as number) >= GPU_CHART_MAX_FRAMES) return null;
      if (!str(p.key, 200)) return null;
      return { kind: 'jump', token, payload: { index: p.index as number, key: p.key } };
    }
    case 'theme': {
      const t = readTheme(p);
      return t === null ? null : { kind: 'theme', token, payload: t };
    }
    case 'source-closed': {
      if (!isRecord(p) || !str(p.reason)) return null;
      return { kind: 'source-closed', token, payload: { reason: p.reason } };
    }
    case 'init': {
      if (!isRecord(p) || !str(p.noteTitle) || !str(p.chartTitle) || !str(p.currentLabel) || !isIndex(p.currentIndex)) return null;
      if (!optStr(p.emptyReason)) return null;
      const spec = readSpec(p.spec);
      if (spec === undefined) return null;
      const theme = readTheme(p.theme);
      if (theme === null) return null;
      let bindMode: ChartBindMode | undefined;
      if (p.bindMode !== undefined) {
        if (typeof p.bindMode !== 'string' || !(CHART_BIND_MODES as readonly string[]).includes(p.bindMode)) return null;
        bindMode = p.bindMode as ChartBindMode;
      }
      let framesMeta: ChartFrameMeta[] | undefined;
      if (p.framesMeta !== undefined) {
        const f = readFramesMeta(p.framesMeta);
        if (f === null) return null;
        framesMeta = f;
      }
      return {
        kind: 'init',
        token,
        payload: {
          noteTitle: p.noteTitle,
          chartTitle: p.chartTitle,
          spec,
          ...(p.emptyReason === undefined ? {} : { emptyReason: p.emptyReason as string }),
          ...(bindMode === undefined ? {} : { bindMode }),
          ...(framesMeta === undefined ? {} : { framesMeta }),
          currentIndex: p.currentIndex,
          currentLabel: p.currentLabel,
          theme,
        },
      };
    }
    case 'update': {
      if (!isRecord(p) || !str(p.label) || !isIndex(p.index) || !Number.isInteger(p.total) || (p.total as number) < 0) return null;
      if (typeof p.animate !== 'boolean' || !optStr(p.emptyReason)) return null;
      if (p.requested !== undefined && typeof p.requested !== 'boolean') return null;
      const spec = readSpec(p.spec);
      if (spec === undefined) return null;
      let signal: ChartContextSignal | undefined;
      if (p.signal !== undefined) {
        const s = readSignal(p.signal);
        if (s === null) return null;
        signal = s;
      }
      let framesMeta: ChartFrameMeta[] | undefined;
      if (p.framesMeta !== undefined) {
        const f = readFramesMeta(p.framesMeta);
        if (f === null) return null;
        framesMeta = f;
      }
      return {
        kind: 'update',
        token,
        payload: {
          ...(signal === undefined ? {} : { signal }),
          spec,
          ...(p.emptyReason === undefined ? {} : { emptyReason: p.emptyReason as string }),
          label: p.label,
          index: p.index,
          total: p.total as number,
          animate: p.animate,
          ...(framesMeta === undefined ? {} : { framesMeta }),
          ...(p.requested === true ? { requested: true } : {}),
        },
      };
    }
  }
  return null;
}

/** 別ウィンドウの題名(`<グラフ題名> - <ノート題名> | PKC3`)。 */
export function chartPopoutTitle(chartTitle: string, noteTitle: string): string {
  const c = chartTitle.trim() === '' ? 'グラフ' : chartTitle.trim();
  const n = noteTitle.trim();
  return n === '' ? `${c} | PKC3` : `${c} - ${n} | PKC3`;
}

/** 別ウィンドウの連動の表示(`連動: Q2 (2 / 4)`)。 */
export function popoutBindLabel(mode: ChartBindMode | undefined, label: string, index: number, total: number): string {
  if (mode === undefined) return '';
  if (label === '') return '連動: (なし)';
  if (mode === 'page' || index < 0 || total <= 0) return `連動: ${label}`;
  return `連動: ${label} (${index + 1} / ${total})`;
}
