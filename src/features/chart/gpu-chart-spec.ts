/**
 * 🔴 **大量データ向けの GPU 直接描画グラフ**(v4.1 Phase 3 / PR-7、#2095 前半)── ` ```chart ` の中身を**検める**純関数。
 *
 * ## 記法を増やさない(CLAUDE.md §2-9)
 * 新しい囲みは作らない。今までの ` ```chart ` の自然な拡張として、次のどれかに当たるときだけ GPU の描画へ振り分ける
 * (`shouldUseGpuChart`)。⚠ どれにも当たらない ` ```chart ` は今までどおり Chart.js → PNG(`chart-raster.ts`)のまま 1 バイトも変えない。
 *
 * 1. 囲みの見出しに `live` か `gpu` がある(` ```chart live `)
 * 2. JSON に `"interactive": true` / `"engine": "gpu"` / `"type": "heatmap"` / `"source": "asset:鍵"` がある
 * 3. `line` / `scatter` / `bar` で、どれかの系列の点の数が Chart.js の上限(`MAX_POINTS` = 2,000)を超える
 *
 * ## chart-fence.ts と同じ規律
 * - **知っている key だけを写し取る**(allowlist)── 関数・未知の key は黙って落とす
 * - 上限は数で持つ(`GPU_CHART_MAX_*`)── 超えた分は切って、理由を 1 行の注記(`notes`)に出す
 * - 読めないときは具体的な理由を返す(黙って空にしない)
 *
 * ⚠ ここは features 層 ── DOM も Three.js も持たない。数は TypedArray(`Float64Array`)で持ち、欠測は `NaN`。
 */
import { MAX_DATASETS, MAX_LABEL_CHARS, MAX_POINTS } from '@features/markdown/chart-fence';
import { parseCompactHeight, parseCompactScale } from './gpu-chart-floating';
import { parseFenceWidth, type FenceSize, type FenceWidth } from '@features/markdown/fence-size';

/** GPU で描ける形。⚠ 一覧はここに 1 つだけ(adapter 側に 2 つ目を作らない)。 */
export const GPU_CHART_TYPES = ['line', 'scatter', 'bar', 'heatmap'] as const;
export type GpuChartType = (typeof GPU_CHART_TYPES)[number];

/** 系列の上限(Chart.js の段と同じ 12 ── 色の見分けがつく数)。 */
export const GPU_CHART_MAX_DATASETS = MAX_DATASETS;
/** 1 系列あたりの点の上限。 */
export const GPU_CHART_MAX_POINTS = 200_000;
/** ヒートマップのセルの上限(例: 500 × 500)。 */
export const GPU_CHART_MAX_HEATMAP_CELLS = 250_000;
/** グラフの高さ(CSS px)の既定と上下限。 */
export const GPU_CHART_DEFAULT_HEIGHT = 320;
export const GPU_CHART_MIN_HEIGHT = 160;
export const GPU_CHART_MAX_HEIGHT = 900;
/**
 * 🔴 **囲みの情報行で縦幅を固定したとき**(` ```chart live height=120 `。v4.2 PR-1)の範囲。
 * ⚠ JSON の `"height"` は今までどおり {@link GPU_CHART_MIN_HEIGHT}〜{@link GPU_CHART_MAX_HEIGHT}(既存の見え方を変えない)。
 */
export const GPU_CHART_FIXED_MIN_HEIGHT = 80;
export const GPU_CHART_FIXED_MAX_HEIGHT = 2000;

export interface GpuChartSeries {
  readonly label: string;
  /** x の値。`line` / `bar` は昇順に並べ直してある(`sorted`)。 */
  readonly xs: Float64Array;
  /** y の値。⚠ 欠測は `NaN`(0 と区別する ── 0 で埋めると折れ線が谷になる)。 */
  readonly ys: Float64Array;
  /** 本文で指定した色(無ければテーマから割り当てる)。 */
  readonly color?: string;
}

export interface GpuChartHeatmap {
  readonly cols: number;
  readonly rows: number;
  /** 行優先(`r * cols + c`)。欠測は `NaN`。 */
  readonly values: Float64Array;
  readonly xLabels: readonly string[];
  readonly yLabels: readonly string[];
  readonly min: number;
  readonly max: number;
}

/** CSV の添付を参照する指定(`"source": "asset:鍵"`)。 */
export interface GpuChartAssetSource {
  readonly key: string;
  readonly xColumn?: string | number;
  readonly yColumns?: readonly (string | number)[];
  readonly seriesColumn?: string | number;
}

export interface GpuChartSpec {
  readonly type: GpuChartType;
  readonly title?: string;
  /** 描画面の高さ(CSS px)。 */
  readonly height: number;
  /**
   * 🔴 **横幅の固定**(JSON の `"width"` か囲みの `width=`。v4.2 PR-1)── 指定時は `.pkc-gpu-chart` を
   *   `width: <値>; max-width: 100%` にする。⚠ 無指定では項目ごと持たない(今までの仕様の形を変えない)。
   */
  readonly width?: FenceWidth;
  /** x を区分(0, 1, 2 …)で持つときの見出し(`labels`)。空なら数の目盛り。 */
  readonly labels: readonly string[];
  /** x が区分の番号か(棒・`labels` のある折れ線)。目盛りを整数に揃える。 */
  readonly xIsIndex: boolean;
  readonly series: readonly GpuChartSeries[];
  readonly heatmap: GpuChartHeatmap | null;
  /** 添付の CSV を待っている指定(読み込むと `series` / `heatmap` が埋まる)。 */
  readonly source: GpuChartAssetSource | null;
  /** 棒の幅(x の単位)。⚠ 系列をまとめた 1 区分の幅 ── 系列ごとの幅はこれを系列数で割る。 */
  readonly barSlot: number;
  /** 取りこぼした物(グラフの下に 1 行で見せる)。 */
  readonly notes: readonly string[];
  /**
   * 🔑 **スクロール連動の指定**(`"bind"`。v4.1 PR-8、#2095 中盤)── 見出し・改ページ(`+++`)・ログの日付に合わせてデータを切り替える。
   * ⚠ 無い ` ```chart ` では項目ごと持たない(今までの仕様の形を 1 つも変えない)。
   */
  readonly bind?: ChartBindSpec;
  /** 強調する x(区分の番号。ログの日付連動で「その日」を示す ── 軸の層がアクセント色の帯を引く)。 */
  readonly highlightX?: number;
  /** 連動の明示データ(`"frames"`)── 見出し名 / ページ番号 / 日付 → その時点のデータ(知っている key だけ写した素の設定)。 */
  readonly frameDefs?: ChartFrameDefs;
}

/** 連動の種類(見出しの節 / 改ページ / ログの日付)。⚠ 一覧はここに 1 つだけ。 */
export const CHART_BIND_MODES = ['heading', 'page', 'log-day'] as const;
export type ChartBindMode = (typeof CHART_BIND_MODES)[number];

export interface ChartBindSpec {
  readonly mode: ChartBindMode;
  /** `mode === 'heading'` の対象見出しレベル(1〜6、既定 2)。 */
  readonly level: number;
  /** スクロール中も画面上端へ固定表示するか(既定 true。操作バーからいつでも解除できる)。 */
  readonly sticky: boolean;
  /** `mode === 'log-day'` で表示する日付の幅(日数、1〜90、既定 7)。 */
  readonly windowDays: number;
  /**
   * 🔴 **上端に固定したときの縮小の見た目の高さ**(px、80〜280、既定 140。v4.2 PR-1)── `gpu-chart-floating.ts`。
   * ⚠ 書いたときだけ持つ(今までの仕様の形を変えない)。
   */
  readonly compactHeight?: number;
  /** 🔴 縮小の倍率(0.25〜0.85)。在れば `compactHeight` より優先。書いたときだけ持つ。 */
  readonly compactScale?: number;
}

/** 明示データ(`"frames"`)── 辞書(鍵 → 設定)か配列(添字 → 設定)。中身は知っている key だけを写した素の設定。 */
export type ChartFrameDefs =
  | { readonly kind: 'map'; readonly items: ReadonlyMap<string, Readonly<Record<string, unknown>>> }
  | { readonly kind: 'list'; readonly items: readonly (Readonly<Record<string, unknown>> | null)[] };

/** 明示データの数の上限(見出し・ページ・日付の数)。 */
export const GPU_CHART_MAX_FRAMES = 500;
export const CHART_BIND_DEFAULT_LEVEL = 2;
export const CHART_BIND_DEFAULT_WINDOW_DAYS = 7;
export const CHART_BIND_MAX_WINDOW_DAYS = 90;

export type GpuChartParseResult = { readonly ok: true; readonly spec: GpuChartSpec } | { readonly ok: false; readonly error: string };

// ───────────────────────────── 振り分け(静的 chart か GPU か)

/** 囲みの見出しの残り(`live` / `gpu`)。 */
export function fenceAsksGpu(rest: string): boolean {
  return rest
    .toLowerCase()
    .split(/\s+/)
    .some((t) => t === 'live' || t === 'gpu');
}

/** 系列の点の数(`data` / `points` / `xs` の長いほう)。 */
function rawPointCount(d: unknown): number {
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return 0;
  const o = d as Record<string, unknown>;
  let n = 0;
  for (const k of ['data', 'points', 'xs'] as const) {
    const v = o[k];
    if (Array.isArray(v)) n = Math.max(n, v.length);
  }
  return n;
}

/**
 * 🔴 **この ` ```chart ` を GPU で描くか**(markdown の描画が呼ぶ。1 か所で答える)。
 * ⚠ 偽のときは今までの静的 chart(Chart.js → PNG)のまま ── 1 バイトも変えない。
 * 🔑 2,000 点を超える JSON は最低でも 4,000 字ある(`1,` が 2 字)── それより短い原文は数えずに偽を返す(安い)。
 */
export function shouldUseGpuChart(rest: string, source: string): boolean {
  if (fenceAsksGpu(rest)) return true;
  const text = source.trim();
  if (text === '' || text[0] !== '{') return false;
  // 🔑 鍵の印が 1 つも無く、点の上限を超えうる長さも無い原文は JSON を読まない
  const marked = /"(?:interactive|engine|type|source|bind)"/.test(text);
  if (!marked && text.length <= MAX_POINTS * 2) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return false; // 読めない原文は今までの chart の経路が理由を出す
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  if (o.interactive === true || o.engine === 'gpu' || o.type === 'heatmap') return true;
  // 🔑 スクロール連動(PR-8)は GPU の描画の口(`updateData`)で切り替える ── 指定があれば必ず GPU へ
  if (o.bind !== undefined) return true;
  if (typeof o.source === 'string' && o.source.startsWith('asset:')) return true;
  if (o.type !== 'line' && o.type !== 'scatter' && o.type !== 'bar') return false;
  if (!Array.isArray(o.datasets)) return false;
  return o.datasets.some((d) => rawPointCount(d) > MAX_POINTS);
}

// ───────────────────────────── 仕様を検める

const clampText = (v: unknown): string => {
  const s = typeof v === 'string' ? v : String(v ?? '');
  return [...s].slice(0, MAX_LABEL_CHARS).join('');
};

/** 数か欠測か。⚠ `NaN` / `Infinity` は欠測に倒す(軸が壊れる)。 */
export function toNum(v: unknown): number {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return NaN;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function isType(v: unknown): v is GpuChartType {
  return typeof v === 'string' && (GPU_CHART_TYPES as readonly string[]).includes(v);
}

/**
 * 🔴 **縦横を決める 1 か所**(v4.2 PR-1)── 優先は JSON の明示 > 囲みの属性(`width=` / `height=`)> 既定。
 * - 高さ: JSON の数(`160〜900`)。無ければ囲みの `height=`(`80〜2000`)。どちらも無ければ既定 320
 * - 横幅: JSON の `"width"`(数 = px、`"480px"` / `"60%"`。範囲は囲みと同じ門 `parseFenceWidth`)。無ければ囲みの `width=`
 */
export function gpuChartSizeOf(o: Record<string, unknown>, fence: FenceSize = {}): { height: number; width?: FenceWidth } {
  const jsonH = toNum(o.height);
  let height: number;
  if (!Number.isNaN(jsonH)) height = clampHeight(jsonH);
  else if (fence.height !== undefined)
    height = Math.round(Math.max(GPU_CHART_FIXED_MIN_HEIGHT, Math.min(GPU_CHART_FIXED_MAX_HEIGHT, fence.height)));
  else height = GPU_CHART_DEFAULT_HEIGHT;
  const jsonW = typeof o.width === 'number' || typeof o.width === 'string' ? parseFenceWidth(o.width) : undefined;
  const width = jsonW ?? fence.width;
  return width === undefined ? { height } : { height, width };
}

function clampHeight(v: unknown): number {
  const n = toNum(v);
  if (Number.isNaN(n)) return GPU_CHART_DEFAULT_HEIGHT;
  return Math.round(Math.max(GPU_CHART_MIN_HEIGHT, Math.min(GPU_CHART_MAX_HEIGHT, n)));
}

function isAscending(xs: Float64Array): boolean {
  for (let i = 1; i < xs.length; i++) if (!(xs[i]! >= xs[i - 1]!)) return false;
  return true;
}

/**
 * x の昇順に並べ直す(`line` / `bar` の可視範囲を二分探索で引くため)。⚠ x が欠測の点は落とす。
 * 🔑 既に昇順ならそのまま返す(写しを作らない)。
 */
export function sortSeriesByX(xs: Float64Array, ys: Float64Array): { xs: Float64Array; ys: Float64Array } {
  let finiteX = true;
  for (let i = 0; i < xs.length; i++) if (Number.isNaN(xs[i]!)) finiteX = false;
  if (finiteX && isAscending(xs)) return { xs, ys };
  const idx: number[] = [];
  for (let i = 0; i < xs.length; i++) if (!Number.isNaN(xs[i]!)) idx.push(i);
  idx.sort((a, b) => xs[a]! - xs[b]! || a - b);
  const nx = new Float64Array(idx.length);
  const ny = new Float64Array(idx.length);
  idx.forEach((k, i) => {
    nx[i] = xs[k]!;
    ny[i] = ys[k]!;
  });
  return { xs: nx, ys: ny };
}

/** 棒の 1 区分の幅(x の最小の間隔 × 0.8。区分の番号なら 0.8)。 */
export function barSlotOf(series: readonly GpuChartSeries[]): number {
  let gap = Infinity;
  for (const s of series) {
    for (let i = 1; i < s.xs.length; i++) {
      const d = s.xs[i]! - s.xs[i - 1]!;
      if (d > 0 && d < gap) gap = d;
    }
  }
  return (Number.isFinite(gap) ? gap : 1) * 0.8;
}

function columnRef(v: unknown): string | number | undefined {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && v !== '') return clampText(v);
  return undefined;
}

/**
 * ` ```chart ` の中身を GPU の描画用に検める。
 *
 * ```chart live
 * { "type": "line", "title": "センサー",
 *   "datasets": [{ "label": "温度", "data": [21.5, 21.7, null, 22.0] }] }
 * ```
 */
export function parseGpuChartSpec(
  source: string,
  /**
   * 🔴 **囲みの情報行に書いた縦横**(`width=` / `height=`。v4.2 PR-1)。優先は **JSON の明示 > 囲みの属性 > 既定**。
   * ⚠ 無指定(`{}`)なら今までと 1 つも変わらない。
   */
  fence: FenceSize = {},
): GpuChartParseResult {
  const fail = (error: string): GpuChartParseResult => ({ ok: false, error: `グラフを描けません: ${error}` });
  const text = source.trim();
  if (text === '') return fail('中身が空です');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('JSON として読めません(括弧やカンマを確かめてください)');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('中身は { } で囲んだ設定にしてください');
  const o = raw as Record<string, unknown>;
  if (o.bind === undefined) {
    if (o.frames !== undefined) return fail('frames は bind(スクロール連動)と一緒に書いてください');
    return parseGpuChartObject(o, fence);
  }
  // 🔑 スクロール連動(PR-8)── 種類の指定を検め、データは無くてもよい(本文の表・明示データから作る)
  const bind = parseChartBind(o.bind);
  if (typeof bind === 'string') return fail(bind);
  if (o.source !== undefined) return fail('bind(スクロール連動)と source(添付の CSV)は一緒に使えません');
  if (o.type === 'heatmap') return fail('bind(スクロール連動)は line / scatter / bar のグラフで使えます');
  const frameDefs = parseFrameDefs(o.frames);
  if (typeof frameDefs === 'string') return fail(frameDefs);
  const hasData = Array.isArray(o.datasets) && o.datasets.length > 0;
  const r = hasData ? parseGpuChartObject(o, fence) : parseGpuChartObject({ ...o, datasets: [{ data: [0] }] }, fence);
  if (!r.ok) return r;
  const spec: GpuChartSpec = {
    ...r.spec,
    ...(hasData ? {} : { series: [], labels: [], barSlot: 0.8 }),
    bind,
    ...(frameDefs === null ? {} : { frameDefs }),
  };
  return { ok: true, spec };
}

/** `"bind"` を検める(文字列の略記 `"heading"` / `"page"` / `"log-day"` も受ける)。読めなければ理由の文。 */
export function parseChartBind(v: unknown): ChartBindSpec | string {
  const isMode = (m: unknown): m is ChartBindMode => typeof m === 'string' && (CHART_BIND_MODES as readonly string[]).includes(m);
  const allowed = `bind は ${CHART_BIND_MODES.map((m) => `"${m}"`).join(' / ')} のどれかにしてください`;
  if (typeof v === 'string') {
    if (!isMode(v)) return allowed;
    return { mode: v, level: CHART_BIND_DEFAULT_LEVEL, sticky: true, windowDays: CHART_BIND_DEFAULT_WINDOW_DAYS };
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return allowed;
  const b = v as Record<string, unknown>;
  if (!isMode(b.mode)) return allowed;
  const lv = toNum(b.level);
  const level = Number.isInteger(lv) && lv >= 1 && lv <= 6 ? lv : CHART_BIND_DEFAULT_LEVEL;
  const wd = toNum(b.windowDays);
  const windowDays = Number.isNaN(wd)
    ? CHART_BIND_DEFAULT_WINDOW_DAYS
    : Math.max(1, Math.min(CHART_BIND_MAX_WINDOW_DAYS, Math.round(wd)));
  const compactHeight = parseCompactHeight(b.compactHeight);
  const compactScale = parseCompactScale(b.compactScale);
  return {
    mode: b.mode,
    level,
    sticky: b.sticky !== false,
    windowDays,
    ...(compactHeight === undefined ? {} : { compactHeight }),
    ...(compactScale === undefined ? {} : { compactScale }),
  };
}

/** 明示データ 1 件で写す key(⚠ `type` / `bind` / `frames` / `source` は写さない ── 種類は全体の指定に揃える)。 */
const FRAME_KEYS = ['labels', 'datasets', 'xs', 'title'] as const;

function frameDefOf(v: unknown): Readonly<Record<string, unknown>> | null {
  if (v === null || typeof v !== 'object') return null;
  // 配列だけの略記(`[1, 2, 3]`)は 1 系列の data とみなす
  if (Array.isArray(v)) return { datasets: [{ data: v.slice(0, GPU_CHART_MAX_POINTS) }] };
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of FRAME_KEYS) if (o[k] !== undefined) out[k] = o[k];
  return Object.keys(out).length === 0 ? null : out;
}

/** `"frames"` を検める(辞書か配列)。無ければ `null`、読めなければ理由の文。 */
export function parseFrameDefs(v: unknown): ChartFrameDefs | null | string {
  if (v === undefined) return null;
  if (Array.isArray(v)) return { kind: 'list', items: v.slice(0, GPU_CHART_MAX_FRAMES).map(frameDefOf) };
  if (v === null || typeof v !== 'object') return 'frames は { "見出し名": { … } } か [ { … }, … ] の形で書いてください';
  const items = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [k, d] of Object.entries(v as Record<string, unknown>)) {
    if (items.size >= GPU_CHART_MAX_FRAMES) break;
    const def = frameDefOf(d);
    if (def !== null) items.set(clampText(k).trim(), def);
  }
  return { kind: 'map', items };
}

/**
 * 設定の中身(JSON を読んだ後の素の値)を検める ── 本文の表・明示データから作るフレーム(`gpu-chart-bind.ts`)も同じ 1 本を通す。
 * ⚠ `bind` / `frames` は見ない(連動の指定は `parseGpuChartSpec` が検める)。
 */
export function parseGpuChartObject(o: Record<string, unknown>, fence: FenceSize = {}): GpuChartParseResult {
  const fail = (error: string): GpuChartParseResult => ({ ok: false, error: `グラフを描けません: ${error}` });
  if (!isType(o.type)) return fail(`type は ${GPU_CHART_TYPES.join(' / ')} のどれかにしてください`);
  const type = o.type;
  const notes: string[] = [];
  const title = o.title === undefined ? undefined : clampText(o.title);
  const { height, width } = gpuChartSizeOf(o, fence);

  // 添付の CSV(大量データ)── 読むのは adapter(`parseGpuChartCsv`)
  let assetSource: GpuChartAssetSource | null = null;
  if (o.source !== undefined) {
    if (typeof o.source !== 'string' || !o.source.startsWith('asset:') || o.source.length <= 'asset:'.length) {
      return fail('source は "asset:添付の ID" の形で書いてください');
    }
    const xColumn = columnRef(o.xColumn);
    const seriesColumn = columnRef(o.seriesColumn);
    const yColumns = Array.isArray(o.yColumns)
      ? o.yColumns.map(columnRef).filter((v): v is string | number => v !== undefined).slice(0, GPU_CHART_MAX_DATASETS)
      : undefined;
    assetSource = {
      key: o.source.slice('asset:'.length).trim(),
      ...(xColumn === undefined ? {} : { xColumn }),
      ...(yColumns === undefined || yColumns.length === 0 ? {} : { yColumns }),
      ...(seriesColumn === undefined ? {} : { seriesColumn }),
    };
  }

  const base = { type, ...(title === undefined ? {} : { title }), height, ...(width === undefined ? {} : { width }) };

  if (type === 'heatmap') {
    if (assetSource !== null) {
      return {
        ok: true,
        spec: { ...base, labels: [], xIsIndex: false, series: [], heatmap: null, source: assetSource, barSlot: 1, notes },
      };
    }
    const hm = parseHeatmapJson(o, notes);
    if (typeof hm === 'string') return fail(hm);
    return { ok: true, spec: { ...base, labels: [], xIsIndex: false, series: [], heatmap: hm, source: null, barSlot: 1, notes } };
  }

  const labels = Array.isArray(o.labels) ? o.labels.slice(0, GPU_CHART_MAX_POINTS).map(clampText) : [];
  if (assetSource !== null) {
    return {
      ok: true,
      spec: { ...base, labels, xIsIndex: type === 'bar', series: [], heatmap: null, source: assetSource, barSlot: 0.8, notes },
    };
  }
  const topXs = Array.isArray(o.xs) ? o.xs : null;
  const rawSets = Array.isArray(o.datasets) ? o.datasets : [];
  if (rawSets.length === 0) return fail('datasets が空です');
  if (rawSets.length > GPU_CHART_MAX_DATASETS) {
    notes.push(`系列は ${GPU_CHART_MAX_DATASETS} 本までです(${rawSets.length - GPU_CHART_MAX_DATASETS} 本は描いていません)`);
  }
  const series: GpuChartSeries[] = [];
  const unreadable: number[] = [];
  let pointsCut = false;
  let anyExplicitX = false;
  rawSets.slice(0, GPU_CHART_MAX_DATASETS).forEach((s, i) => {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      unreadable.push(i + 1);
      return;
    }
    const d = s as Record<string, unknown>;
    const entries: unknown[] = Array.isArray(d.points) ? d.points : Array.isArray(d.data) ? d.data : [];
    if (entries.length > GPU_CHART_MAX_POINTS) pointsCut = true;
    const n = Math.min(entries.length, GPU_CHART_MAX_POINTS);
    const ownXs = Array.isArray(d.xs) ? d.xs : topXs;
    let xs = new Float64Array(n);
    let ys = new Float64Array(n);
    let k = 0;
    let finite = 0;
    for (let j = 0; j < n; j++) {
      const e = entries[j];
      let x: number;
      let y: number;
      if (e !== null && typeof e === 'object' && !Array.isArray(e)) {
        x = toNum((e as Record<string, unknown>).x);
        y = toNum((e as Record<string, unknown>).y);
        anyExplicitX = true;
        // 散布図の点は x / y の両方が要る(読めない点は飛ばす)
        if (Number.isNaN(x) || (type === 'scatter' && Number.isNaN(y))) continue;
      } else {
        y = toNum(e);
        if (ownXs !== null) {
          x = toNum(ownXs[j]);
          anyExplicitX = true;
          if (Number.isNaN(x)) continue;
        } else {
          x = j;
        }
        if (type === 'scatter' && Number.isNaN(y)) continue;
      }
      xs[k] = x;
      ys[k] = y;
      k++;
      if (!Number.isNaN(y)) finite++;
    }
    // ⚠ 数が 1 つも読めない系列は描かない(描いても空のグラフになるだけ ── 黙って空にしない)
    if (finite === 0) {
      unreadable.push(i + 1);
      return;
    }
    if (k < n) {
      xs = xs.slice(0, k);
      ys = ys.slice(0, k);
    }
    const sorted = type === 'scatter' ? { xs, ys } : sortSeriesByX(xs, ys);
    const color = typeof d.color === 'string' ? clampText(d.color) : undefined;
    series.push({
      label: clampText(d.label ?? `系列 ${series.length + 1}`),
      xs: sorted.xs,
      ys: sorted.ys,
      ...(color === undefined ? {} : { color }),
    });
  });
  if (series.length === 0) {
    return fail(
      type === 'scatter'
        ? 'datasets に数値の data がありません(散布図は { "x": 1, "y": 2 } の形で書きます)'
        : 'datasets に数値の data がありません',
    );
  }
  if (unreadable.length > 0) notes.push(`${unreadable.join('・')} 番目の系列は、数が読めないため描いていません`);
  if (pointsCut) notes.push(`点は 1 系列 ${GPU_CHART_MAX_POINTS.toLocaleString('en-US')} までです(超えた分は描いていません)`);
  const xIsIndex = type === 'bar' ? !anyExplicitX : labels.length > 0 && !anyExplicitX;
  return {
    ok: true,
    spec: { ...base, labels, xIsIndex, series, heatmap: null, source: null, barSlot: barSlotOf(series), notes },
  };
}

function finiteRange(values: Float64Array): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? { min, max } : { min: 0, max: 0 };
}

/** `matrix` / `values` からヒートマップを作る。読めなければ理由の文。 */
function parseHeatmapJson(o: Record<string, unknown>, notes: string[]): GpuChartHeatmap | string {
  const xLabels = Array.isArray(o.xLabels) ? o.xLabels.map(clampText) : [];
  const yLabels = Array.isArray(o.yLabels) ? o.yLabels.map(clampText) : [];
  if (Array.isArray(o.matrix)) {
    const rowsRaw = o.matrix.filter((r): r is unknown[] => Array.isArray(r));
    if (rowsRaw.length === 0) return 'matrix に行がありません(数の配列の配列で書きます)';
    let cols = rowsRaw.reduce((m, r) => Math.max(m, r.length), 0);
    let rows = rowsRaw.length;
    if (cols === 0) return 'matrix の行が空です';
    if (rows * cols > GPU_CHART_MAX_HEATMAP_CELLS) {
      rows = Math.max(1, Math.floor(GPU_CHART_MAX_HEATMAP_CELLS / cols));
      if (rows * cols > GPU_CHART_MAX_HEATMAP_CELLS) cols = GPU_CHART_MAX_HEATMAP_CELLS;
      notes.push(`セルは ${GPU_CHART_MAX_HEATMAP_CELLS.toLocaleString('en-US')} 個までです(超えた行は描いていません)`);
    }
    const values = new Float64Array(rows * cols).fill(NaN);
    for (let r = 0; r < rows; r++) {
      const row = rowsRaw[r]!;
      for (let c = 0; c < cols && c < row.length; c++) values[r * cols + c] = toNum(row[c]);
    }
    if (values.every((v) => Number.isNaN(v))) return 'matrix に数値がありません';
    const { min, max } = finiteRange(values);
    return { cols, rows, values, xLabels: xLabels.slice(0, cols), yLabels: yLabels.slice(0, rows), min, max };
  }
  if (Array.isArray(o.values)) {
    const triples: Array<[number, number, number]> = [];
    let cols = xLabels.length;
    let rows = yLabels.length;
    for (const t of o.values) {
      if (!Array.isArray(t) || t.length < 3) continue;
      const cx = toNum(t[0]);
      const ry = toNum(t[1]);
      if (!Number.isInteger(cx) || !Number.isInteger(ry) || cx < 0 || ry < 0) continue;
      triples.push([cx, ry, toNum(t[2])]);
      cols = Math.max(cols, cx + 1);
      rows = Math.max(rows, ry + 1);
    }
    if (triples.length === 0) return 'values に [x の番号, y の番号, 値] の組がありません';
    if (rows * cols > GPU_CHART_MAX_HEATMAP_CELLS) return `セルは ${GPU_CHART_MAX_HEATMAP_CELLS.toLocaleString('en-US')} 個までです(行と列を減らしてください)`;
    const values = new Float64Array(rows * cols).fill(NaN);
    for (const [c, r, v] of triples) values[r * cols + c] = v;
    if (values.every((v) => Number.isNaN(v))) return 'values に数値がありません';
    const { min, max } = finiteRange(values);
    return { cols, rows, values, xLabels: xLabels.slice(0, cols), yLabels: yLabels.slice(0, rows), min, max };
  }
  return 'ヒートマップは matrix(数の配列の配列)か values([x, y, 値] の組)で書いてください';
}

// ───────────────────────────── 添付の CSV

/** CSV の 1 行を区切る(`"…"` の中の区切りと `""` に対応)。 */
export function splitCsvLine(line: string, delim: string): string[] {
  if (!line.includes('"')) return line.split(delim);
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const isNumericCell = (s: string): boolean => s.trim() !== '' && !Number.isNaN(toNum(s.trim()));

/**
 * 🔴 **添付の CSV を数の列(TypedArray)へ**(`"source": "asset:鍵"`)。
 * - 区切りはカンマ(1 行目にタブがあってカンマが無ければタブ)
 * - 1 行目に数でない欄があれば見出し行とみなす
 * - `xColumn`(既定: 0 列目。列が 1 つなら行の番号)/ `yColumns`(既定: x 以外の全列)/ `seriesColumn`(その列の値ごとに系列を分ける)
 * - x の列が数でなければ、行の番号を x にしてその字を見出し(`labels`)にする(日付の字など)
 * - y が数でない行はその系列から外す / 1 系列 `GPU_CHART_MAX_POINTS` 点まで
 */
export function parseGpuChartCsv(csvText: string, spec: GpuChartSpec): GpuChartParseResult {
  const fail = (error: string): GpuChartParseResult => ({ ok: false, error: `グラフを描けません: ${error}` });
  const src = spec.source;
  const label = src === null ? '' : `添付(${src.key})`;
  const lines = csvText.replace(/^\uFEFF/, '').split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  if (lines.length === 0) return fail(`${label}の CSV が空です`);
  const first = lines[0]!;
  const delim = first.includes('\t') && !first.includes(',') ? '\t' : ',';
  const head = splitCsvLine(first, delim).map((s) => s.trim());
  const hasHeader = head.some((c) => c !== '' && !isNumericCell(c));
  const dataStart = hasHeader ? 1 : 0;
  const width = head.length;
  const notes = [...spec.notes];

  if (spec.type === 'heatmap') return csvHeatmap(lines, delim, hasHeader, head, spec, notes, fail);

  const resolve = (ref: string | number | undefined, what: string): number | string | undefined => {
    if (ref === undefined) return undefined;
    if (typeof ref === 'number') return ref < width ? ref : `${what}の列 ${ref} がありません(0 から数えます)`;
    const i = hasHeader ? head.indexOf(ref) : -1;
    if (i >= 0) return i;
    const n = Number(ref);
    if (Number.isInteger(n) && n >= 0 && n < width) return n;
    return `${what}の列「${ref}」が見つかりません`;
  };
  const xr = resolve(src?.xColumn, 'x ');
  if (typeof xr === 'string') return fail(xr);
  const sr = resolve(src?.seriesColumn, '系列');
  if (typeof sr === 'string') return fail(sr);
  const xCol = xr ?? (width >= 2 ? 0 : -1);
  let yCols: number[] = [];
  if (src?.yColumns !== undefined) {
    for (const ref of src.yColumns) {
      const r = resolve(ref, 'y ');
      if (typeof r === 'string') return fail(r);
      if (r !== undefined) yCols.push(r);
    }
  } else {
    for (let c = 0; c < width; c++) if (c !== xCol && c !== sr) yCols.push(c);
  }
  if (sr !== undefined) yCols = yCols.slice(0, 1);
  if (yCols.length === 0) return fail(`${label}に y にする列がありません`);
  if (yCols.length > GPU_CHART_MAX_DATASETS) {
    notes.push(`系列は ${GPU_CHART_MAX_DATASETS} 本までです(${yCols.length - GPU_CHART_MAX_DATASETS} 列は描いていません)`);
    yCols = yCols.slice(0, GPU_CHART_MAX_DATASETS);
  }

  // x が数か(見出しを除いて最初の数行で決める)
  let xNumeric = xCol >= 0;
  if (xCol >= 0) {
    for (let i = dataStart; i < Math.min(lines.length, dataStart + 50); i++) {
      const cell = splitCsvLine(lines[i]!, delim)[xCol] ?? '';
      if (cell.trim() !== '' && !isNumericCell(cell)) {
        xNumeric = false;
        break;
      }
    }
  }
  const labels: string[] = [];
  const bucket = new Map<string, { xs: number[]; ys: number[] }>();
  const order: string[] = [];
  const nameOf = (c: number): string => (hasHeader && head[c] !== '' ? clampText(head[c]) : `列 ${c}`);
  if (sr === undefined) for (const c of yCols) {
    order.push(String(c));
    bucket.set(String(c), { xs: [], ys: [] });
  }
  let cut = false;
  let droppedGroups = 0;
  let row = 0;
  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const cells = splitCsvLine(line, delim);
    let x: number;
    if (xCol < 0) x = row;
    else if (xNumeric) {
      x = toNum(cells[xCol]?.trim());
      if (Number.isNaN(x)) continue;
    } else {
      x = row;
      if (labels.length < GPU_CHART_MAX_POINTS) labels.push(clampText((cells[xCol] ?? '').trim()));
    }
    row++;
    if (sr !== undefined) {
      const g = clampText((cells[sr] ?? '').trim());
      let b = bucket.get(g);
      if (b === undefined) {
        if (order.length >= GPU_CHART_MAX_DATASETS) {
          droppedGroups++;
          continue;
        }
        b = { xs: [], ys: [] };
        bucket.set(g, b);
        order.push(g);
      }
      const y = toNum(cells[yCols[0]!]?.trim());
      if (Number.isNaN(y)) continue;
      if (b.xs.length >= GPU_CHART_MAX_POINTS) {
        cut = true;
        continue;
      }
      b.xs.push(x);
      b.ys.push(y);
    } else {
      for (const c of yCols) {
        const y = toNum(cells[c]?.trim());
        if (Number.isNaN(y)) continue;
        const b = bucket.get(String(c))!;
        if (b.xs.length >= GPU_CHART_MAX_POINTS) {
          cut = true;
          continue;
        }
        b.xs.push(x);
        b.ys.push(y);
      }
    }
  }
  const series: GpuChartSeries[] = [];
  for (const key of order) {
    const b = bucket.get(key)!;
    if (b.xs.length === 0) continue;
    const raw = { xs: Float64Array.from(b.xs), ys: Float64Array.from(b.ys) };
    const sorted = spec.type === 'scatter' ? raw : sortSeriesByX(raw.xs, raw.ys);
    series.push({ label: sr === undefined ? nameOf(Number(key)) : key || '(空)', xs: sorted.xs, ys: sorted.ys });
  }
  if (series.length === 0) return fail(`${label}の CSV に数値の行がありません`);
  if (droppedGroups > 0) notes.push(`系列は ${GPU_CHART_MAX_DATASETS} 本までです(残りの ${droppedGroups} 行は描いていません)`);
  if (cut) notes.push(`点は 1 系列 ${GPU_CHART_MAX_POINTS.toLocaleString('en-US')} までです(超えた分は描いていません)`);
  const useLabels = !xNumeric && xCol >= 0;
  return {
    ok: true,
    spec: {
      ...spec,
      labels: useLabels ? labels : spec.labels,
      xIsIndex: spec.type === 'bar' ? !xNumeric || xCol < 0 : useLabels,
      series,
      barSlot: barSlotOf(series),
      notes,
    },
  };
}

function csvHeatmap(
  lines: readonly string[],
  delim: string,
  hasHeader: boolean,
  head: readonly string[],
  spec: GpuChartSpec,
  notes: string[],
  fail: (e: string) => GpuChartParseResult,
): GpuChartParseResult {
  const body = lines.slice(hasHeader ? 1 : 0).filter((l) => l.trim() !== '');
  const rowsCells = body.map((l) => splitCsvLine(l, delim).map((s) => s.trim()));
  // 1 列目が数でない行があれば、1 列目は行の見出し
  const rowHead = rowsCells.some((r) => r.length > 1 && r[0] !== '' && !isNumericCell(r[0]!));
  const c0 = rowHead ? 1 : 0;
  let cols = rowsCells.reduce((m, r) => Math.max(m, r.length - c0), 0);
  let rows = rowsCells.length;
  if (cols <= 0 || rows === 0) return fail('CSV に数値のセルがありません');
  if (rows * cols > GPU_CHART_MAX_HEATMAP_CELLS) {
    rows = Math.max(1, Math.floor(GPU_CHART_MAX_HEATMAP_CELLS / cols));
    if (rows * cols > GPU_CHART_MAX_HEATMAP_CELLS) cols = GPU_CHART_MAX_HEATMAP_CELLS;
    notes.push(`セルは ${GPU_CHART_MAX_HEATMAP_CELLS.toLocaleString('en-US')} 個までです(超えた行は描いていません)`);
  }
  const values = new Float64Array(rows * cols).fill(NaN);
  for (let r = 0; r < rows; r++) {
    const cells = rowsCells[r]!;
    for (let c = 0; c < cols; c++) values[r * cols + c] = toNum(cells[c + c0]);
  }
  if (values.every((v) => Number.isNaN(v))) return fail('CSV に数値のセルがありません');
  const { min, max } = finiteRange(values);
  return {
    ok: true,
    spec: {
      ...spec,
      heatmap: {
        cols,
        rows,
        values,
        xLabels: hasHeader ? head.slice(c0, c0 + cols).map(clampText) : [],
        yLabels: rowHead ? rowsCells.slice(0, rows).map((r) => clampText(r[0])) : [],
        min,
        max,
      },
      notes,
    },
  };
}

/** 全体の点の数(欠測を除く)。 */
export function gpuChartPointCount(spec: GpuChartSpec): number {
  if (spec.heatmap !== null) {
    let n = 0;
    for (let i = 0; i < spec.heatmap.values.length; i++) if (!Number.isNaN(spec.heatmap.values[i]!)) n++;
    return n;
  }
  let n = 0;
  for (const s of spec.series) for (let i = 0; i < s.ys.length; i++) if (!Number.isNaN(s.ys[i]!)) n++;
  return n;
}

/** 絵の代わりに読む文(`aria-label`)。 */
export function gpuChartAltText(spec: GpuChartSpec): string {
  const kind: Record<GpuChartType, string> = { line: '折れ線グラフ', scatter: '散布図', bar: '棒グラフ', heatmap: 'ヒートマップ' };
  const head = `${spec.title ? spec.title + 'の' : ''}${kind[spec.type]}`;
  if (spec.heatmap !== null) return `${head}(${spec.heatmap.cols} × ${spec.heatmap.rows} セル、値は ${spec.heatmap.min} から ${spec.heatmap.max})`;
  return `${head}(${spec.series.length} 系列: ${spec.series.map((s) => s.label).join('、')})`;
}
