/**
 * plotly フェンス(#528 ①)── ```plotly の中身を**検める**。
 *
 * 書き方は plotly.js の figure そのもの(`{ "data": [...], "layout": {...} }`)── user が既に知っている
 * 書き方を使える(記法を減らさない)。`data` の配列だけを書いてもよい。
 *
 * ## ここでやること / やらないこと
 * - features 層の純関数 ── 描かない。受け取った文字列を検めて形にするだけ
 * - 描くのは adapter 側(sandbox の箱の中の plotly.js → PNG。`plotly-raster.ts`)。「描いたら焼く」
 *
 * ## 🔴 通さないもの
 * - JSON に関数は書けないので、関数を受け付ける設定(コールバック)の入る余地は無い。
 * - `config` / `frames`(操作の設定・アニメーション)は PNG に焼く絵に効かないので**読み捨てる**。
 * - 外へ出る要求(地図のタイル・外部画像・CDN の地形データ)は箱の CSP が止める ── 理由は絵の上に 1 行出る。
 * - `__proto__` / `constructor` / `prototype` の鍵は読むときに落とす(JSON.parse の reviver)。
 *
 * ⚠ 上限を数で持つ(散文の規律にしない)── 事故った本文が画面を潰さない。
 */

/** 原文の上限(文字)。 */
export const MAX_PLOTLY_SOURCE = 1_000_000;
/** 系列(trace)の上限。 */
export const MAX_PLOTLY_TRACES = 40;

export interface PlotlySpec {
  readonly data: readonly Record<string, unknown>[];
  readonly layout: Record<string, unknown>;
}

export interface PlotlyParseResult {
  readonly spec: PlotlySpec | null;
  /** 読めなかった理由(user に見せる ── 黙って空にしない)。 */
  readonly error: string | null;
  /** 描けたが取りこぼしたもの(絵の上に 1 行で見せる)。 */
  readonly notes: readonly string[];
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function parsePlotlyFence(source: string): PlotlyParseResult {
  const fail = (error: string): PlotlyParseResult => ({ spec: null, error, notes: [] });
  const text = source.trim();
  if (text === '') return fail('中身が空です');
  if (text.length > MAX_PLOTLY_SOURCE) return fail(`中身が大きすぎます(${MAX_PLOTLY_SOURCE.toLocaleString('ja-JP')} 文字まで)`);
  let raw: unknown;
  try {
    raw = JSON.parse(text, (k, v: unknown) => (FORBIDDEN_KEYS.has(k) ? undefined : v));
  } catch {
    return fail('JSON として読めません(括弧やカンマを確かめてください)');
  }
  let data: unknown;
  let layout: unknown;
  const notes: string[] = [];
  if (Array.isArray(raw)) {
    data = raw;
  } else if (isPlainObject(raw)) {
    data = raw.data;
    layout = raw.layout;
    if (raw.frames !== undefined || raw.config !== undefined)
      notes.push('config と frames は絵に効かないため読んでいません');
  } else {
    return fail('中身は { "data": [...] } の形にしてください');
  }
  if (!Array.isArray(data) || data.length === 0) return fail('data(系列の配列)が空です');
  if (layout !== undefined && !isPlainObject(layout)) return fail('layout は { } で囲んだ設定にしてください');
  const traces: Record<string, unknown>[] = [];
  let bad = 0;
  for (const t of data) {
    if (isPlainObject(t)) traces.push(t);
    else bad += 1;
  }
  if (traces.length === 0) return fail('data の中身は { } で囲んだ系列にしてください');
  if (bad > 0) notes.push(`読めない系列が ${bad} 本あったため、描いていません`);
  if (traces.length > MAX_PLOTLY_TRACES) {
    notes.push(`系列は ${MAX_PLOTLY_TRACES} 本までです(${traces.length - MAX_PLOTLY_TRACES} 本は描いていません)`);
    traces.length = MAX_PLOTLY_TRACES;
  }
  return { spec: { data: traces, layout: (layout as Record<string, unknown> | undefined) ?? {} }, error: null, notes };
}

/** 系列の種類の呼び名(読み上げ用)。知らない種類はそのまま出す。 */
const TRACE_NAME: Record<string, string> = {
  scatter: '散布図・折れ線',
  scattergl: '散布図・折れ線',
  bar: '棒グラフ',
  pie: '円グラフ',
  histogram: 'ヒストグラム',
  box: 'ボックスプロット',
  violin: 'バイオリン図',
  heatmap: 'ヒートマップ',
  contour: '等高線',
  surface: 'サーフェス',
  scatter3d: '3 次元散布図',
  mesh3d: '3 次元メッシュ',
  candlestick: 'ローソク足',
  ohlc: 'OHLC',
  waterfall: 'ウォーターフォール',
  funnel: 'ファネル',
  sankey: 'サンキー図',
  treemap: 'ツリーマップ',
  sunburst: 'サンバースト',
  indicator: '指標',
  table: '表',
  scatterpolar: '極座標',
  barpolar: '極座標の棒',
  radar: 'レーダーチャート',
  choropleth: '地図の塗り分け',
  densitymapbox: '密度地図',
};

/**
 * 🔴 **絵の代わりに読む文**(`<img alt>`)。⚠ 画像 1 枚で出す以上、これが無いと読み上げ利用者には何も無いのと同じ。
 */
export function plotlyAltText(spec: PlotlySpec): string {
  const kinds: string[] = [];
  for (const t of spec.data) {
    const k = typeof t.type === 'string' ? t.type : 'scatter';
    const name = TRACE_NAME[k] ?? k;
    if (!kinds.includes(name)) kinds.push(name);
  }
  const title = titleOf(spec.layout);
  return `${title === '' ? '' : `${title}の`}グラフ(${spec.data.length} 系列: ${kinds.join('、')})`;
}

function titleOf(layout: Record<string, unknown>): string {
  const t = layout.title;
  if (typeof t === 'string') return t.slice(0, 120);
  if (isPlainObject(t) && typeof t.text === 'string') return t.text.slice(0, 120);
  return '';
}
