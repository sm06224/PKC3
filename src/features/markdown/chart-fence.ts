/**
 * chart フェンス(#188 / 台帳 #180 の B-1)── ```chart の中身を**検める**。
 *
 * 🔴 **user は PKC2 で「chart.js は keep・むしろ強化対象」と裁定済み**(2026-07-01)。
 * PKC3 に無いのは移植漏れである。
 *
 * ## ここでやること / やらないこと
 * - ここは **features 層の純関数** ── 描かない。**受け取った文字列を検めて形にする**だけ
 * - 描くのは adapter 側(worker で canvas → PNG)。不可侵指示「描いたら焼く」に従う
 *
 * ## 🔴 chart.js の設定をそのまま通さない
 * chart.js の `options` は**関数を受け付ける**(`callbacks` / `formatter` 等)。
 * 本文は user が書くものなので、**関数の入る余地を作らない** ── ここで
 * **知っている key だけを写し取る**(allowlist)。知らない key は黙って落とす。
 * ⚠ 「危ないものを消す」(denylist)ではなく「知っているものだけ通す」── 前者は
 * 新しい危険が増えるたびに漏れる。
 *
 * ⚠ 上限を数で持つ(散文の規律にしない)── 事故った本文が画面と worker を潰さない。
 */

/** 描ける形。⚠ **一覧をここに 1 つだけ持つ**(adapter 側に 2 つ目を作らない)。 */
export const CHART_TYPES = ['bar', 'line', 'pie', 'doughnut', 'radar', 'scatter'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** 系列の上限。 */
export const MAX_DATASETS = 12;
/** 1 系列あたりの点の上限。 */
export const MAX_POINTS = 2000;
/** 文字列(題名・凡例)の上限。 */
export const MAX_LABEL_CHARS = 120;

export interface ChartDataset {
  readonly label: string;
  /** ⚠ 欠測は `null`(0 と区別する ── 0 で埋めると折れ線が谷になる)。 */
  readonly data: readonly (number | null)[];
  /** 色。⚠ 指定が無ければ adapter がテーマから割り当てる(本文に色を書かせない)。 */
  readonly color?: string;
}

export interface ChartSpec {
  readonly type: ChartType;
  readonly labels: readonly string[];
  readonly datasets: readonly ChartDataset[];
  readonly title?: string;
  readonly stacked?: boolean;
  readonly legend?: boolean;
}

export interface ChartParseResult {
  readonly spec: ChartSpec | null;
  /** 読めなかった理由(user に見せる ── 黙って空にしない)。 */
  readonly error: string | null;
}

const clampText = (v: unknown): string => {
  const s = typeof v === 'string' ? v : String(v ?? '');
  return [...s].slice(0, MAX_LABEL_CHARS).join('');
};

/** 数か欠測か。⚠ `NaN` / `Infinity` は欠測に倒す(描画側で軸が壊れる)。 */
function toPoint(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function isChartType(v: unknown): v is ChartType {
  return typeof v === 'string' && (CHART_TYPES as readonly string[]).includes(v);
}

/**
 * ```chart の中身を検める。
 *
 * 受ける形は **JSON**。⚠ chart.js の設定に**寄せた形**にする ── user が既に
 * 知っている書き方を使えるほうが動線が広い(記法を減らさない)。ただし通すのは
 * 下の allowlist だけである。
 *
 * ```chart
 * { "type": "bar",
 *   "labels": ["1月", "2月"],
 *   "datasets": [{ "label": "売上", "data": [10, 20] }],
 *   "title": "月別" }
 * ```
 */
export function parseChartFence(source: string): ChartParseResult {
  const text = source.trim();
  if (text === '') return { spec: null, error: '中身が空です' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { spec: null, error: 'JSON として読めません(括弧やカンマを確かめてください)' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return { spec: null, error: '中身は { } で囲んだ設定にしてください' };
  const o = raw as Record<string, unknown>;

  const type = o.type;
  if (!isChartType(type))
    return {
      spec: null,
      error: `type は ${CHART_TYPES.join(' / ')} のどれかにしてください`,
    };

  const labels = Array.isArray(o.labels) ? o.labels.map(clampText) : [];

  const rawSets = Array.isArray(o.datasets) ? o.datasets : [];
  if (rawSets.length === 0) return { spec: null, error: 'datasets が空です' };
  const datasets: ChartDataset[] = [];
  for (const s of rawSets.slice(0, MAX_DATASETS)) {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) continue;
    const d = s as Record<string, unknown>;
    const data = Array.isArray(d.data) ? d.data.slice(0, MAX_POINTS).map(toPoint) : [];
    if (data.length === 0) continue;
    const color = typeof d.color === 'string' ? clampText(d.color) : undefined;
    datasets.push({
      label: clampText(d.label ?? `系列 ${datasets.length + 1}`),
      data,
      ...(color === undefined ? {} : { color }),
    });
  }
  if (datasets.length === 0) return { spec: null, error: 'datasets に数値の data がありません' };

  return {
    spec: {
      type,
      labels,
      datasets,
      ...(o.title === undefined ? {} : { title: clampText(o.title) }),
      ...(typeof o.stacked === 'boolean' ? { stacked: o.stacked } : {}),
      ...(typeof o.legend === 'boolean' ? { legend: o.legend } : {}),
    },
    error: null,
  };
}

/**
 * 🔴 **絵の代わりに読む文**(`<img alt>`)。⚠ 画像 1 枚で出す以上、
 * これが無いと読み上げ利用者には**何も無いのと同じ**になる。
 * ⚠ 数字を全部読ませない(長すぎる)── 何の図で、何系列で、範囲がどこか。
 */
export function chartAltText(spec: ChartSpec): string {
  const kind: Record<ChartType, string> = {
    bar: '棒グラフ',
    line: '折れ線グラフ',
    pie: '円グラフ',
    doughnut: 'ドーナツグラフ',
    radar: 'レーダーチャート',
    scatter: '散布図',
  };
  const nums = spec.datasets.flatMap((d) => d.data).filter((v): v is number => v !== null);
  const range =
    nums.length === 0
      ? ''
      : `、値は ${Math.min(...nums)} から ${Math.max(...nums)}`;
  const names = spec.datasets.map((d) => d.label).join('、');
  return `${spec.title ? spec.title + 'の' : ''}${kind[spec.type]}(${spec.datasets.length} 系列: ${names}${range})`;
}
