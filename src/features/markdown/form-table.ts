/**
 * 🔴 **入力欄 ⇄ 本文の表(` ```csv name=… `)の行**(#1456 の「シート(CSV / 表)との双方向データ連携」)。
 *
 * 入力欄の定義(`form-def.ts`)に `table: 日報一覧` と書くと、**押したときだけ**次の 3 つが使える:
 *
 * - **表に追加**: いまの入力を表の末尾に 1 行足す(表が無ければ、項目名を見出しにして作る)
 * - **表の行を更新**: 指定した行をいまの入力で書き換える(入力欄に無い列は元のセルのまま)
 * - **読み込む**: 指定した行を入力欄へ読み込む(`vars.…` に書く)
 *
 * 🔑 **書込は原文の splice で、その行だけ**(`csv-cell` / `csv-shape` と同じ作法)。同じノートの別の表・別の行は
 *   1 バイトも動かない。⚠ 書き換える行は**セルを書き直す**ので、その行だけ引用符の付け方が揃う(他の行は触らない)。
 * ⚠ セルをまたぐ行(引用符の中に改行)がある表では、行の番号が原文の行と対応しないので**更新は断る**(追加は断らない)。
 * ⚠ 見出しは `noheader` の表を**対象にしない**(列と項目を結べない)。理由は画面に出す。
 *
 * pure。呼び側(`body-rewrite.ts` の `form-row` / binder の事前の断り)が同じ関数を通る(§7)。
 */
import { fenceInfo, quoteLead, splitLines, type FenceSpan } from './source-blocks';
import { fencesBelowFrontmatter } from './table-convert';
import { DELIMITER, csvEscapeField, detectCsvLang, isHeaderDisabled, parseCsv, type CsvFenceLang } from './csv-table';
import { csvTableNameRaw } from '../query/csv-tables';
import { detectEol } from './line-eol';

export interface LocatedFormTable {
  readonly span: FenceSpan;
  readonly lang: CsvFenceLang;
  readonly delimiter: string;
  readonly noHeader: boolean;
  /** 中身の最初の行 / 最後の行(原文の行番号、両端含む)。中身が空なら `last < first`。 */
  readonly first: number;
  readonly last: number;
  readonly lines: readonly string[];
  readonly eol: string;
}

function eolOf(body: string): string {
  return detectEol(body);
}

/** 名前が `name` の csv / tsv / psv の囲みを探す(最初の 1 つ)。 */
export function locateFormTable(body: string, name: string): LocatedFormTable | null {
  const lines = splitLines(body);
  for (const span of fencesBelowFrontmatter(body)) {
    const openRaw = lines[span.start] ?? '';
    const lead = quoteLead(openRaw, span.quote);
    const info = fenceInfo(lead === null ? openRaw : openRaw.slice(lead));
    const lang = detectCsvLang(info);
    if (lang === null) continue;
    if (csvTableNameRaw(info) !== name) continue;
    return {
      span,
      lang,
      delimiter: DELIMITER[lang],
      noHeader: isHeaderDisabled(info),
      first: span.start + 1,
      last: span.open ? span.end : span.end - 1,
      lines,
      eol: eolOf(body),
    };
  }
  return null;
}

/** 囲みの中身(引用の前置きを剥がした字)。 */
function contentOf(t: LocatedFormTable): string {
  const out: string[] = [];
  for (let i = t.first; i <= t.last; i += 1) {
    const line = t.lines[i] ?? '';
    const lead = quoteLead(line, t.span.quote);
    if (lead === null) continue;
    out.push(line.slice(lead));
  }
  return out.join('\n');
}

export interface FormTableData {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly located: LocatedFormTable;
}

/** 表を読む。無ければ `null`。 */
export function readFormTable(body: string, name: string): FormTableData | null {
  const located = locateFormTable(body, name);
  if (located === null) return null;
  const grid = parseCsv(contentOf(located), located.delimiter);
  if (grid === null || grid.length === 0) return { header: [], rows: [], located };
  if (located.noHeader) return { header: [], rows: grid, located };
  return { header: (grid[0] ?? []).map((h) => h.trim()), rows: grid.slice(1), located };
}

export type FormRowPlan =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly why: string };

/** 入力欄 1 つ(表の見出しは name か label のどちらで書いてあってもよい)。 */
export interface FormColumn {
  readonly name: string;
  readonly label: string;
}

/**
 * 見出しと入力欄を結ぶ(**列の位置**で持つ)。
 *
 * - 見出しは**項目名でも表示名でも**合う。⚠ **項目名が先**:ある入力欄の表示名が別の入力欄の項目名と同じ字のとき、
 *   その見出しは項目名を持つ入力欄のもの(表示名で横取りしない)。
 * - 同じ字の見出しが複数あるときは、**最初の 1 つだけ**に当てる(残りの列は元の升のまま)。
 * - 見出しに無い入力欄は、見出しの右に足す。
 * @returns 結んだ見出し(足した分を含む)と、項目名 → 列の位置。`changed` = 見出しに足した。
 */
function resolveColumns(
  header: readonly string[],
  fields: readonly FormColumn[],
): { header: string[]; idxOf: Map<string, number>; changed: boolean } {
  const out = header.slice();
  const idxOf = new Map<string, number>();
  const claimed = new Set<number>();
  // 1 周目: 項目名で合うものを先に確保する
  for (const f of fields) {
    const i = out.findIndex((h, k) => h === f.name && !claimed.has(k));
    if (i >= 0) {
      idxOf.set(f.name, i);
      claimed.add(i);
    }
  }
  // 2 周目: 残りの入力欄は表示名で合う列へ(確保済みの列は取らない)
  for (const f of fields) {
    if (idxOf.has(f.name)) continue;
    const i = out.findIndex((h, k) => h === f.label && !claimed.has(k));
    if (i >= 0) {
      idxOf.set(f.name, i);
      claimed.add(i);
    }
  }
  let changed = false;
  for (const f of fields) {
    if (idxOf.has(f.name)) continue;
    out.push(f.name);
    idxOf.set(f.name, out.length - 1);
    changed = true;
  }
  return { header: out, idxOf, changed };
}

export type FormRowRequest =
  | {
      readonly mode: 'add';
      readonly table: string;
      /** 入力欄の並び(表が無い / 空のとき、この順で見出しを作る)。 */
      readonly fields: readonly FormColumn[];
      /** 項目名 → 値。 */
      readonly cells: Readonly<Record<string, string>>;
    }
  | {
      readonly mode: 'update';
      readonly table: string;
      readonly fields: readonly FormColumn[];
      readonly cells: Readonly<Record<string, string>>;
      /** データ行の番号(1 始まり。見出しを数えない)。 */
      readonly row: number;
      /**
       * 🔴 **押した時点のその行の中身**(`SET_CSV_CELL` の `openLine` と同じ型)。⚠ 書く側が disk の行と**一致するか**を確かめ、
       *   食い違えば断る ── 行を足した / 別のタブが書いた後に、番号だけで別の行を書き換えない。省略すると照合しない(test 用)。
       */
      readonly openRow?: readonly string[];
    };

function rowText(
  header: readonly string[],
  existing: readonly string[] | null,
  byIdx: ReadonlyMap<number, string>,
  delimiter: string,
): string {
  // 🔴 見出しより多いセルも落とさない(元の行が長いとき、その分は元のまま残す)
  const n = Math.max(header.length, existing?.length ?? 0);
  const cells: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const v = byIdx.has(i) ? byIdx.get(i)! : (existing?.[i] ?? '');
    cells.push(csvEscapeField(v, delimiter));
  }
  return cells.join(delimiter);
}

/** 項目名 → 値 を、列の位置 → 値 に直す。 */
function byIdxOf(
  cells: Readonly<Record<string, string>>,
  idxOf: ReadonlyMap<string, number>,
): Map<number, string> {
  const out = new Map<number, string>();
  for (const [name, i] of idxOf) if (Object.prototype.hasOwnProperty.call(cells, name)) out.set(i, cells[name]!);
  return out;
}

/** 追記 / 更新を計画する。⚠ 書けない理由は画面の言葉で返す(黙って断らない)。 */
export function planFormRow(body: string, req: FormRowRequest): FormRowPlan {
  const eol = eolOf(body);
  const t = locateFormTable(body, req.table);
  if (t === null) {
    if (req.mode === 'update') {
      return { ok: false, why: `表「${req.table}」が見つかりません(\`csv name=${req.table}\` のブロックがありません)` };
    }
    // 表が無ければ、項目名を見出しにして末尾に作る
    const r = resolveColumns([], req.fields);
    const head = r.header.map((f) => csvEscapeField(f, ',')).join(',');
    const row = rowText(r.header, null, byIdxOf(req.cells, r.idxOf), ',');
    const base = body.endsWith('\n') || body === '' ? body : body + eol;
    const gap = base === '' || base.endsWith(`${eol}${eol}`) ? '' : eol;
    return { ok: true, body: `${base}${gap}\`\`\`csv name=${req.table}${eol}${head}${eol}${row}${eol}\`\`\`${eol}` };
  }
  if (t.noHeader) {
    return { ok: false, why: `表「${req.table}」は noheader なので、列と入力欄を結べません(見出しの行を付けてください)` };
  }
  const data = readFormTable(body, req.table)!;
  const lines = t.lines.slice();
  const prefixOf = (idx: number): string => {
    const raw = lines[idx] ?? '';
    const lead = quoteLead(raw, t.span.quote);
    return lead === null ? '' : raw.slice(0, lead);
  };
  const openPrefix = prefixOf(t.span.start);

  const empty = data.header.length === 0;
  const resolved = resolveColumns(data.header, req.fields);
  const header = resolved.header;
  const headerChanged = resolved.changed;
  const byHeader = byIdxOf(req.cells, resolved.idxOf);
  const headerLine = (prefix: string): string => `${prefix}${header.map((h) => csvEscapeField(h, t.delimiter)).join(t.delimiter)}`;

  const contentLines = splitLines(contentOf(t));
  const oneLinePerRow =
    !empty && contentLines.every((l) => l !== '') && contentLines.length === data.rows.length + 1;
  if (headerChanged && !empty && !oneLinePerRow) {
    const missing = req.fields.filter((f) => !data.header.includes(f.name) && !data.header.includes(f.label)).map((f) => f.name);
    return {
      ok: false,
      why: `表「${req.table}」の見出しに列を足せません(セルの中に改行がある、または空行がある表です)。見出しに ${missing.join('・')} を足してください`,
    };
  }

  if (req.mode === 'add') {
    const newRow = `${(t.last >= t.first ? prefixOf(t.last) : openPrefix) || openPrefix}${rowText(header, null, byHeader, t.delimiter)}`;
    if (empty) {
      lines.splice(t.first, Math.max(0, t.last - t.first + 1), headerLine(openPrefix), newRow);
    } else {
      if (headerChanged) lines[t.first] = headerLine(prefixOf(t.first));
      lines.splice(t.last + 1, 0, newRow);
    }
    return { ok: true, body: lines.join(eol) };
  }

  // update
  if (!Number.isInteger(req.row) || req.row < 1 || req.row > data.rows.length) {
    return {
      ok: false,
      why:
        data.rows.length === 0
          ? `表「${req.table}」にはデータの行がありません`
          : `行 ${String(req.row)} はありません(表「${req.table}」は 1〜${String(data.rows.length)} 行です)`,
    };
  }
  // 🔴 押した時点の行と、いまの行が同じか(違えば別の行を書き換えるので断る)
  if (req.openRow !== undefined) {
    const cur = data.rows[req.row - 1] ?? [];
    if (cur.length !== req.openRow.length || cur.some((c, i) => c !== req.openRow![i])) {
      return {
        ok: false,
        why: `行 ${String(req.row)} は、入力欄を見てから書き換えられています(行が足された / 別のタブが書いた など)。表を見直して、もう一度押してください`,
      };
    }
  }
  if (!oneLinePerRow) {
    return {
      ok: false,
      why: `表「${req.table}」はセルの中に改行がある(または空行がある)ので、行を書き換えられません。表のセルを直接直してください`,
    };
  }
  const at = t.first + req.row; // 見出しの次から数える
  if (headerChanged) lines[t.first] = headerLine(prefixOf(t.first));
  const existing = data.rows[req.row - 1] ?? [];
  lines[at] = `${prefixOf(at)}${rowText(header, existing, byHeader, t.delimiter)}`;
  return { ok: true, body: lines.join(eol) };
}

export type FormRowLoad =
  | { readonly ok: true; readonly cells: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly why: string };

/**
 * 表の `row` 行目(1 始まり)を、**項目名 → 値**にして返す(見出しが項目名でも表示名でも合う)。
 * ⚠ 見出しに無い入力欄は含めない(読み込んでも、その入力欄は元のまま)。
 */
export function loadFormRow(body: string, table: string, row: number, fields: readonly FormColumn[]): FormRowLoad {
  const data = readFormTable(body, table);
  if (data === null) return { ok: false, why: `表「${table}」が見つかりません(\`csv name=${table}\` のブロックがありません)` };
  if (data.located.noHeader) return { ok: false, why: `表「${table}」は noheader なので、列と入力欄を結べません` };
  if (!Number.isInteger(row) || row < 1 || row > data.rows.length) {
    return {
      ok: false,
      why:
        data.rows.length === 0
          ? `表「${table}」にはデータの行がありません`
          : `行 ${String(row)} はありません(表「${table}」は 1〜${String(data.rows.length)} 行です)`,
    };
  }
  const r = data.rows[row - 1] ?? [];
  const cells: Record<string, string> = {};
  const { idxOf } = resolveColumns(data.header, fields);
  for (const f of fields) {
    const at = idxOf.get(f.name);
    // 見出しに無い入力欄(足される列)は読まない
    if (at !== undefined && at < data.header.length) cells[f.name] = r[at] ?? '';
  }
  return { ok: true, cells };
}

/** 表の `row` 行目(1 始まり)の升の並び。無ければ `null`(押した時点の行の照合に使う)。 */
export function formRowCells(body: string, table: string, row: number): readonly string[] | null {
  const data = readFormTable(body, table);
  if (data === null || !Number.isInteger(row) || row < 1) return null;
  return data.rows[row - 1] ?? null;
}
