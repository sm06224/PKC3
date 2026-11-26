/**
 * 🔴 **ウィジェットが読める「同じノートのデータ」**(v4.0 Phase 2 / PR-08、ビジョン 5-B)。
 *
 * `window.pkcWidget.readNoteContext()` / `readTables()` / `readFrontmatter()` の答えを、ノートの本文 1 件から組む純関数。
 *
 * ## 🔴 読ませてよい範囲(ここで決めて、親はそれに従う)
 *
 * - **そのウィジェットが置かれたノート 1 件の本文だけ**。他のノート・システム領域・設定・他のウィジェットの保存は
 *   ここへ来ない(引数が本文 1 つだけなので、構造上読めない)。どのノートの本文を渡すかは親(`widget-bridge.ts`)が
 *   **登録した `(lid, widgetId)`** から決める。
 * - 渡すのは 2 つ ── ①前書き(frontmatter)の値(文字列・数・真偽・null・その配列だけ) ②表
 *   (GFM の Markdown 表と、` ```csv ` / ` ```tsv ` / ` ```psv ` の囲み。文書順)。
 * - 大きすぎる表は切り詰めて `truncated: true` を付ける(箱へ送る量に上限を置く)。
 *
 * ⚠ 読むだけ。本文は変えない。表の升は**原文のままの字**(式も Markdown の飾りもそのまま)。
 * 🔑 表の読み方は既存の 1 本を使う(重複したパーサーを作らない):Markdown 表は `table-convert.ts` の門
 *   (`mdCellGate` / `mdTableAtGate` ── 囲みの中・前書きの中を外す)、CSV は `allFences` + `detectCsvLang` + `parseCsv`。
 */
import { parseFrontmatter } from './frontmatter';
import { DELIMITER, detectCsvLang, isHeaderDisabled, parseCsv, type CsvFenceLang } from './csv-table';
import { mdCellGate, mdTableAtGate, fencesBelowFrontmatter } from './table-convert';
import { fenceInfo, quoteLead, splitLines } from './source-blocks';

/** 表の数の上限。 */
export const WIDGET_CONTEXT_MAX_TABLES = 50;
/** 1 つの表の行(見出しを除く)の上限。 */
export const WIDGET_CONTEXT_MAX_ROWS = 2000;
/** 1 行の列の上限(極端に横長な表で箱を詰まらせない)。 */
export const WIDGET_CONTEXT_MAX_COLS = 200;
/** 1 つの升の字数の上限(超えた分は切り詰める)。 */
export const WIDGET_CONTEXT_MAX_CELL = 4096;

export type WidgetTableKind = 'markdown' | 'csv' | 'tsv' | 'psv';

export interface WidgetNoteTable {
  /** 文書の中で何番目の表か(0 始まり)。 */
  readonly index: number;
  readonly kind: WidgetTableKind;
  /** 見出しの行(`noheader` の囲み・見出しの空の表は空配列)。 */
  readonly headers: string[];
  /** 見出しを除いた行。 */
  readonly rows: string[][];
  /** 行・列を上限で切り詰めたか。 */
  readonly truncated?: true;
}

export interface WidgetNoteContext {
  readonly frontmatter: Record<string, unknown>;
  readonly tables: WidgetNoteTable[];
  /** 表の数を上限で切り詰めたか。 */
  readonly truncated?: true;
}

/** 空の答え(登録の無い箱・本文の読めないとき)。⚠ 呼ぶたびに新しい物を返す(受け手が書き換えても漏れない)。 */
export function emptyWidgetNoteContext(): WidgetNoteContext {
  return { frontmatter: {}, tables: [] };
}

/** 前書きの値の安全な写し(文字列・数・真偽・null と、その配列だけ)。 */
function copyFrontmatter(meta: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    // ⚠ `__proto__` 等の鍵で写し先の形を変えさせない
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number') out[k] = Number.isFinite(v) ? v : null;
    else if (Array.isArray(v)) {
      out[k] = v.filter(
        (x): x is string | number | boolean | null =>
          x === null || typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)),
      );
    }
  }
  return out;
}

interface Found {
  readonly start: number;
  readonly kind: WidgetTableKind;
  readonly headers: string[];
  readonly rows: string[][];
}

/** 区切りの行(`|---|:--:|`)らしいか ── 表の候補の行だけ門に掛ける(全行を掛けない)。 */
const DELIM_ROW = /^[\s>]*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function markdownTables(body: string, lines: readonly string[]): Found[] {
  const out: Found[] = [];
  const gate = mdCellGate(lines);
  gate.body = body;
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const l = lines[i] ?? '';
    if (!l.includes('|') || !DELIM_ROW.test(lines[i + 1] ?? '')) continue;
    const at = mdTableAtGate(gate, i);
    if (at === null || at.start !== i || at.format !== 'markdown') continue;
    const head = at.rows.find((r) => r.head);
    out.push({
      start: at.start,
      kind: 'markdown',
      headers: head === undefined ? [] : [...head.cells],
      rows: at.rows.filter((r) => !r.head).map((r) => [...r.cells]),
    });
    i = at.end;
  }
  return out;
}

function csvTables(body: string, lines: readonly string[]): Found[] {
  const out: Found[] = [];
  for (const span of fencesBelowFrontmatter(body)) {
    if (span.open) continue;
    const open = lines[span.start] ?? '';
    const lead = quoteLead(open, span.quote);
    if (lead === null) continue;
    const info = fenceInfo(open.slice(lead));
    const lang: CsvFenceLang | null = detectCsvLang(info);
    if (lang === null || info === null) continue;
    const indent = /^[ \t]*/.exec(open.slice(lead))![0]!.length;
    const content: string[] = [];
    let ok = true;
    for (const raw of lines.slice(span.start + 1, span.end)) {
      const q = quoteLead(raw, span.quote);
      if (q === null) {
        ok = false;
        break;
      }
      let l = raw.slice(q);
      let n = 0;
      while (n < indent && (l[n] === ' ' || l[n] === '\t')) n += 1;
      l = l.slice(n);
      content.push(l);
    }
    if (!ok) continue;
    const rows = parseCsv(content.join('\n'), DELIMITER[lang]);
    if (rows === null) continue;
    const withHead = !isHeaderDisabled(info);
    out.push({
      start: span.start,
      kind: lang,
      headers: withHead && rows.length > 0 ? [...(rows[0] ?? [])] : [],
      rows: (withHead ? rows.slice(1) : rows).map((r) => [...r]),
    });
  }
  return out;
}

function clip(t: Found, index: number): WidgetNoteTable {
  let truncated = false;
  const cell = (c: string): string => {
    if (c.length <= WIDGET_CONTEXT_MAX_CELL) return c;
    truncated = true;
    return c.slice(0, WIDGET_CONTEXT_MAX_CELL);
  };
  const cut = (r: readonly string[]): string[] => {
    if (r.length > WIDGET_CONTEXT_MAX_COLS) truncated = true;
    return r.slice(0, WIDGET_CONTEXT_MAX_COLS).map(cell);
  };
  let rows = t.rows;
  if (rows.length > WIDGET_CONTEXT_MAX_ROWS) {
    truncated = true;
    rows = rows.slice(0, WIDGET_CONTEXT_MAX_ROWS);
  }
  const out = { index, kind: t.kind, headers: cut(t.headers), rows: rows.map(cut) };
  return truncated ? { ...out, truncated: true } : out;
}

/**
 * 🔴 **ノート 1 件の本文から、ウィジェットが読めるデータを組む**。
 * ⚠ 本文の外は何も読まない(引数がこれだけ)。
 */
export function extractWidgetNoteContext(body: string): WidgetNoteContext {
  const frontmatter = copyFrontmatter(parseFrontmatter(body).meta);
  const lines = splitLines(body);
  const found = [...markdownTables(body, lines), ...csvTables(body, lines)].sort((a, b) => a.start - b.start);
  const truncated = found.length > WIDGET_CONTEXT_MAX_TABLES;
  const tables = found.slice(0, WIDGET_CONTEXT_MAX_TABLES).map((t, i) => clip(t, i));
  return truncated ? { frontmatter, tables, truncated: true } : { frontmatter, tables };
}
