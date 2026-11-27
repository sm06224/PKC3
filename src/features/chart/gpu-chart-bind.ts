/**
 * 🔴 **スクロール連動グラフの契約とデータ抽出**(v4.1 Phase 3 / PR-8、#2095 中盤)── 純関数だけ(DOM も Three.js も持たない)。
 *
 * ## 物語
 * ノートの本文(見出しの節・改ページ `+++` で区切ったページ・ログの日付)を読み進めると、` ```chart ` の `"bind"` で
 * 連動させたグラフが**その場所のデータへ切り替わる**。データの正本は本文の Markdown(表・` ```csv `・ログの見出し)で、
 * 新しい形式は作らない(CLAUDE.md §2-2)。見出しごとに明示したいときだけ `"frames"` に書く。
 *
 * ## 契約(PR-9 の別窓連動でもそのまま使う)
 * - `ChartContextSignal` ── 「いまどこを読んでいるか」の 1 通(`BroadcastChannel` にもこの形で載せる)
 * - `extractBoundChartFrames(本文, 全体の仕様)` ── 本文 → 時点ごとのデータ(`BoundChartFrame`)
 * - `interpolateChartSpec(前, 次, t)` ── 切り替えの途中の 1 コマ(形が合わなければ `null` ── 呼び側が即時に切り替える)
 */
import { logDayOfHeading } from '@features/textlog/log-days';
import { isRealCalendarDate } from '@features/schedule/schedule-date';
import {
  GPU_CHART_MAX_POINTS,
  parseGpuChartObject,
  splitCsvLine,
  toNum,
  type ChartBindMode,
  type ChartFrameDefs,
  type GpuChartSpec,
} from './gpu-chart-spec';

export type { ChartBindMode, ChartBindSpec } from './gpu-chart-spec';

/** 🔑 **いまどこを読んでいるか**(PR-9 の `BroadcastChannel` の中身もこの形)。 */
export interface ChartContextSignal {
  readonly lid: string;
  readonly mode: ChartBindMode;
  /** heading: 見出しの番号(0 始まりの字)/ page: 0 始まりのページ番号の字 / log-day: `YYYY-MM-DD` */
  readonly key: string;
  /** 画面に出す名前(例: `Q2` / `ページ 2 / 4` / `2026-11-20`)。 */
  readonly label: string;
  readonly index: number;
  readonly total: number;
}

/** 1 つの時点のデータ。⚠ `spec === null` は「その時点に描くデータが無い」(古いグラフを残さない)。 */
export interface BoundChartFrame {
  readonly key: string;
  readonly label: string;
  readonly spec: GpuChartSpec | null;
  /** データが無い・読めない理由(画面に 1 行で出す)。 */
  readonly reason?: string;
}

export interface BoundChartDataset {
  readonly mode: ChartBindMode;
  readonly frames: readonly BoundChartFrame[];
}

/** データが無い時点の文(種類ごと)。 */
export const BOUND_EMPTY_REASON: Readonly<Record<ChartBindMode, string>> = {
  heading: 'この節には対象データがありません',
  page: 'このページには対象データがありません',
  'log-day': 'この日には記録がありません',
};

// ───────────────────────────── 本文を行で読む(コードの囲みの中は見ない)

interface Line {
  readonly text: string;
  /** コードの囲み(` ``` ` / `~~~`)の中か(開き・閉じの行も含む)。 */
  readonly inFence: boolean;
  /** 囲みの開きの行なら、その見出しの残り(` ```csv ` の `csv`)。 */
  readonly fenceOpen: string | null;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

/** 本文を行に分け、囲みの中かを印す。⚠ 先頭の frontmatter(`---` 〜 `---`)は外す。 */
export function scanLines(body: string): Line[] {
  const raw = body.replace(/\r\n?/g, '\n').split('\n');
  let start = 0;
  if (raw[0]?.trim() === '---') {
    for (let i = 1; i < raw.length; i++) {
      const t = raw[i]!.trim();
      if (t === '---' || t === '...') {
        start = i + 1;
        break;
      }
    }
  }
  const out: Line[] = [];
  let open: { ch: string; len: number } | null = null;
  for (let i = start; i < raw.length; i++) {
    const text = raw[i]!;
    const m = FENCE_RE.exec(text);
    if (open === null) {
      if (m !== null && !(m[1]![0] === '`' && m[2]!.includes('`'))) {
        open = { ch: m[1]![0]!, len: m[1]!.length };
        out.push({ text, inFence: true, fenceOpen: m[2]!.trim() });
        continue;
      }
      out.push({ text, inFence: false, fenceOpen: null });
    } else {
      out.push({ text, inFence: true, fenceOpen: null });
      if (m !== null && m[1]![0] === open.ch && m[1]!.length >= open.len && m[2]!.trim() === '') open = null;
    }
  }
  return out;
}

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
/** 改ページ(`markdown-render.ts` の `+++` と同じ形)。 */
const PAGE_BREAK_RE = /^\s*\+\+\+\s*(?:\{[^}]*\}\s*)?$/;

/** 見出しの行なら [レベル, 字]。 */
function headingOf(line: Line): [number, string] | null {
  if (line.inFence) return null;
  const m = HEADING_RE.exec(line.text);
  return m === null ? null : [m[1]!.length, m[2]!.trim()];
}

// ───────────────────────────── 表と CSV → 数の列

interface Grid {
  readonly head: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** 表の 1 行を欄に分ける(端の `|` を外し、`\|` は字として残す)。 */
export function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === '\\' && t[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const DELIM_ROW_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * 表の欄の数(`1,200` / `35%` / `¥1,000` / `-3.5` / 強調の `**12**` も数として読む)。読めなければ `NaN`。
 */
export function cellNum(s: string): number {
  const t = s
    .trim()
    .replace(/^\*{1,2}|\*{1,2}$/g, '')
    .replace(/^[¥$€£]/, '')
    .replace(/,/g, '')
    .replace(/%$/, '')
    .trim();
  if (t === '') return NaN;
  return toNum(t);
}

/** 区間の行から、最初の表か ` ```csv ` を読む。 */
function firstGrid(lines: readonly Line[], from: number, to: number): Grid | null {
  for (let i = from; i < to; i++) {
    const l = lines[i]!;
    if (l.fenceOpen !== null) {
      if (/^csv\b/i.test(l.fenceOpen)) {
        const body: string[] = [];
        for (let k = i + 1; k < to && lines[k]!.inFence && lines[k]!.fenceOpen === null; k++) body.push(lines[k]!.text);
        // 閉じの行を外す
        if (body.length > 0 && FENCE_RE.test(body[body.length - 1]!)) body.pop();
        const g = csvGrid(body);
        if (g !== null) return g;
      }
      continue;
    }
    if (l.inFence) continue;
    const next = lines[i + 1];
    if (i + 1 < to && next !== undefined && !next.inFence && l.text.includes('|') && DELIM_ROW_RE.test(next.text) && next.text.includes('-')) {
      const head = splitTableRow(l.text);
      const rows: string[][] = [];
      for (let k = i + 2; k < to; k++) {
        const r = lines[k]!;
        if (r.inFence || r.text.trim() === '' || !r.text.includes('|')) break;
        rows.push(splitTableRow(r.text));
      }
      if (rows.length > 0) return { head, rows };
    }
  }
  return null;
}

function csvGrid(body: readonly string[]): Grid | null {
  const lines = body.filter((l) => l.trim() !== '');
  if (lines.length === 0) return null;
  const first = lines[0]!;
  const delim = first.includes('\t') && !first.includes(',') ? '\t' : ',';
  const cells = lines.map((l) => splitCsvLine(l, delim).map((c) => c.trim()));
  const hasHeader = cells[0]!.some((c) => c !== '' && Number.isNaN(cellNum(c)));
  return hasHeader ? { head: cells[0]!, rows: cells.slice(1) } : { head: cells[0]!.map((_, i) => `列 ${i + 1}`), rows: cells };
}

/** 列が数の列か(空でない欄が 1 つ以上あり、空でない欄がすべて数)。 */
function numericColumn(rows: readonly (readonly string[])[], c: number): boolean {
  let any = false;
  for (const r of rows) {
    const v = (r[c] ?? '').trim();
    if (v === '' || v === '-' || v === '—') continue;
    if (Number.isNaN(cellNum(v))) return false;
    any = true;
  }
  return any;
}

/**
 * 表(見出し行 + 行)→ グラフの仕様。1 列目は x(数でなければ区分の見出し)、数の列が系列。
 * @returns 数の列が無ければ `null`(「数値表」ではない)
 */
export function gridToSpec(grid: Grid, base: GpuChartSpec): GpuChartSpec | null {
  const rows = grid.rows.slice(0, GPU_CHART_MAX_POINTS);
  const width = Math.max(grid.head.length, ...rows.map((r) => r.length));
  const yCols: number[] = [];
  for (let c = 1; c < width; c++) if (numericColumn(rows, c)) yCols.push(c);
  let xCol = 0;
  if (yCols.length === 0) {
    // 1 列だけの数の表は、行の番号を x にする
    if (!numericColumn(rows, 0)) return null;
    xCol = -1;
    yCols.push(0);
  }
  const xNumeric = xCol === 0 && base.type !== 'bar' && numericColumn(rows, 0);
  const o: Record<string, unknown> = {
    type: base.type,
    height: base.height,
    ...(base.title === undefined ? {} : { title: base.title }),
    datasets: yCols.map((c) => ({
      label: grid.head[c] !== undefined && grid.head[c] !== '' ? grid.head[c] : `列 ${c + 1}`,
      data: rows.map((r) => {
        const v = cellNum(r[c] ?? '');
        return Number.isNaN(v) ? null : v;
      }),
    })),
  };
  if (xCol === 0) {
    if (xNumeric) o.xs = rows.map((r) => cellNum(r[0] ?? ''));
    else o.labels = rows.map((r) => (r[0] ?? '').trim());
  }
  if (base.type === 'scatter') {
    // 散布図は {x, y} の点で渡す(x が数でなければ行の番号)
    o.datasets = (o.datasets as Array<{ label: string; data: (number | null)[] }>).map((d) => ({
      label: d.label,
      data: d.data.map((y, i) => ({ x: xNumeric ? cellNum(rows[i]![0] ?? '') : i, y })),
    }));
    delete o.xs;
  }
  const r = parseGpuChartObject(o);
  return r.ok ? r.spec : null;
}

/** 明示データ 1 件 → 仕様。読めなければ理由の文。 */
function specOfDef(def: Readonly<Record<string, unknown>>, base: GpuChartSpec): GpuChartSpec | string {
  const r = parseGpuChartObject({
    type: base.type,
    height: base.height,
    ...(base.title === undefined ? {} : { title: base.title }),
    ...def,
  });
  return r.ok ? r.spec : r.error;
}

function defFor(defs: ChartFrameDefs | undefined, key: string, index: number): Readonly<Record<string, unknown>> | null {
  if (defs === undefined) return null;
  if (defs.kind === 'list') return defs.items[index] ?? null;
  return defs.items.get(key) ?? null;
}

/** 明示データ → 本文の表 の順で 1 つの時点を作る。 */
function makeFrame(
  key: string,
  label: string,
  base: GpuChartSpec,
  defKey: string,
  index: number,
  lines: readonly Line[],
  from: number,
  to: number,
): BoundChartFrame {
  const def = defFor(base.frameDefs, defKey, index);
  if (def !== null) {
    const s = specOfDef(def, base);
    return typeof s === 'string' ? { key, label, spec: null, reason: s } : { key, label, spec: s };
  }
  const grid = firstGrid(lines, from, to);
  const spec = grid === null ? null : gridToSpec(grid, base);
  return spec === null ? { key, label, spec: null } : { key, label, spec };
}

// ───────────────────────────── 3 つの種類

/** 見出しの節(既定 `##`)ごと。節 = その見出しから、同じか浅い見出しの手前まで。 */
function headingFrames(lines: readonly Line[], base: GpuChartSpec, level: number): BoundChartFrame[] {
  const heads: Array<{ at: number; text: string }> = [];
  const ends: number[] = [];
  lines.forEach((l, i) => {
    const h = headingOf(l);
    if (h === null) return;
    if (h[0] <= level && heads.length > ends.length) ends.push(i);
    if (h[0] === level) heads.push({ at: i, text: h[1] });
  });
  while (ends.length < heads.length) ends.push(lines.length);
  return heads.map((h, i) => makeFrame(String(i), h.text, base, h.text, i, lines, h.at + 1, ends[i]!));
}

/** 改ページ(`+++`)で区切ったページごと。 */
function pageFrames(lines: readonly Line[], base: GpuChartSpec): BoundChartFrame[] {
  const cuts: number[] = [];
  lines.forEach((l, i) => {
    if (!l.inFence && PAGE_BREAK_RE.test(l.text)) cuts.push(i);
  });
  const bounds: Array<[number, number]> = [];
  let from = 0;
  for (const c of cuts) {
    bounds.push([from, c]);
    from = c + 1;
  }
  bounds.push([from, lines.length]);
  const total = bounds.length;
  return bounds.map(([a, b], i) => makeFrame(String(i), pageLabel(i, total), base, String(i + 1), i, lines, a, b));
}

/** ページの名前(`ページ 2 / 4`)。⚠ 番号は 1 始まりで見せる。 */
export function pageLabel(index: number, total: number): string {
  return `ページ ${index + 1} / ${total}`;
}

const DATE_ONLY_HEAD = /^(\d{4}-\d{2}-\d{2})(?:\s|$|\()/;

/**
 * 🔑 **ログの見出しの日付**(`2026-11-20 09:15:00` / `2026-11-20`)── 本文の抽出と画面の現在地の両方がこの 1 本を使う。
 */
export function logDayOfText(text: string): string | null {
  const t = text.trim();
  const withTime = logDayOfHeading(t);
  if (withTime !== null) return withTime;
  const m = DATE_ONLY_HEAD.exec(t);
  return m !== null && isRealCalendarDate(m[1]!) ? m[1]! : null;
}

/** `YYYY-MM-DD` を n 日ずらす(暦の日付だけを数える ── 時差に依らない)。 */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** ログの日ごと ── その日を終端とする `windowDays` 日の記録の件数(その日を強調)。 */
function logDayFrames(lines: readonly Line[], base: GpuChartSpec, windowDays: number): BoundChartFrame[] {
  const counts = new Map<string, number>();
  for (const l of lines) {
    const h = headingOf(l);
    if (h === null || h[0] !== 2) continue;
    const day = logDayOfText(h[1]);
    if (day !== null) counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const days = [...counts.keys()].sort();
  return days.map((d, index) => {
    const def = defFor(base.frameDefs, d, index);
    if (def !== null) {
      const s = specOfDef(def, base);
      return typeof s === 'string' ? { key: d, label: d, spec: null, reason: s } : { key: d, label: d, spec: s };
    }
    const window: string[] = [];
    for (let k = windowDays - 1; k >= 0; k--) window.push(shiftDay(d, -k));
    const r = parseGpuChartObject({
      type: base.type,
      height: base.height,
      ...(base.title === undefined ? {} : { title: base.title }),
      labels: window.map((w) => w.slice(5)),
      datasets: [{ label: '記録の件数', data: window.map((w) => counts.get(w) ?? 0) }],
    });
    if (!r.ok) return { key: d, label: d, spec: null, reason: r.error };
    return { key: d, label: d, spec: { ...r.spec, highlightX: windowDays - 1 } };
  });
}

/**
 * 🔴 **本文 → 時点ごとのデータ**(連動の種類は `base.bind`)。`bind` が無ければ空。
 */
export function extractBoundChartFrames(markdownBody: string, base: GpuChartSpec): BoundChartDataset {
  const bind = base.bind;
  if (bind === undefined) return { mode: 'heading', frames: [] };
  const lines = scanLines(markdownBody);
  switch (bind.mode) {
    case 'heading':
      return { mode: 'heading', frames: headingFrames(lines, base, bind.level) };
    case 'page':
      return { mode: 'page', frames: pageFrames(lines, base) };
    case 'log-day':
      return { mode: 'log-day', frames: logDayFrames(lines, base, bind.windowDays) };
  }
}

/** 現在地の 1 通に当たる時点(heading / page は番号、log-day は日付で引く)。 */
export function frameForSignal(data: BoundChartDataset, signal: Pick<ChartContextSignal, 'key' | 'index'>): BoundChartFrame | null {
  if (data.mode === 'log-day') return data.frames.find((f) => f.key === signal.key) ?? null;
  return data.frames[signal.index] ?? null;
}

// ───────────────────────────── 切り替えの補間

/** 減速の曲線(切り替えの補間に使う)。 */
export function easeOutCubic(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return 1 - (1 - c) ** 3;
}

function lerpArray(a: Float64Array, b: Float64Array, t: number): Float64Array {
  const out = new Float64Array(b.length);
  for (let i = 0; i < b.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    // ⚠ 欠測は補間しない(行き先の値へ切り替える ── 0 から伸びる嘘の線を描かない)
    out[i] = Number.isNaN(x) || Number.isNaN(y) ? y : x + (y - x) * t;
  }
  return out;
}

/**
 * 🔑 **切り替えの途中の 1 コマ**。種類・系列の数・各系列の点の数(ヒートマップは行と列)が同じときだけ数を線形に補間する。
 * 形が合わなければ `null`(呼び側は即時に切り替える ── 壊れた途中の絵を描かない)。
 */
export function interpolateChartSpec(from: GpuChartSpec, to: GpuChartSpec, t: number): GpuChartSpec | null {
  if (from.type !== to.type) return null;
  const k = Math.max(0, Math.min(1, t));
  if (to.heatmap !== null || from.heatmap !== null) {
    const a = from.heatmap;
    const b = to.heatmap;
    if (a === null || b === null || a.cols !== b.cols || a.rows !== b.rows) return null;
    return {
      ...to,
      heatmap: { ...b, values: lerpArray(a.values, b.values, k), min: a.min + (b.min - a.min) * k, max: a.max + (b.max - a.max) * k },
    };
  }
  if (from.series.length !== to.series.length || to.series.length === 0) return null;
  for (let i = 0; i < to.series.length; i++) if (from.series[i]!.ys.length !== to.series[i]!.ys.length) return null;
  return {
    ...to,
    series: to.series.map((s, i) => {
      const f = from.series[i]!;
      return { ...s, xs: lerpArray(f.xs, s.xs, k), ys: lerpArray(f.ys, s.ys, k) };
    }),
  };
}
