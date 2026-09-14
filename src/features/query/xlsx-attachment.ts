/**
 * 🔴 **添付した `.xlsx` を、SQL で調べられるようにする**(#854 段③)。
 *
 * ## `.csv` の側(`csv-attachment.ts`)と、同じ形・同じ理由で揃える
 *
 * 🔑 見分けは**拡張子だけ**(中身で見分けるには全部読むしかなく、選ぶ前に
 *   何十 MB も heap へ載せることになる ── 不可侵指示 2026-07-27 の逆)。
 * 🔑 値は全部 TEXT / 列は 1 行目の見出し / **どこから来たか分かる列**を足す。
 * ⚠ 表を 2 つ目の読み手で組まない ── 格子にするのは `xlsx-sheet.ts` 1 本である。
 *
 * ## ⚠ ここだけ csv と違う ── **1 file が表 1 つとは限らない**
 *
 * 🔴 本には枚(シート)が何枚でも在る。**1 枚目だけ読むと残りが黙って消える**ので、
 *   **枚ごとに 1 つの表**にする(枚ごとに見出しが違うので、混ぜられない)。
 * ⚠ 表の名前に**枚の名前は使わない** ── `csv-attachment.ts` が同じ理由で固定名に
 *   している(全角の字や記号を含む題名から作ると**打てない名前**ができる)。
 *   **`sheet1` / `sheet2` …** と数え、🔑 **本当の名前は `_sheet` の列で引ける**
 *   ようにする(`WHERE _sheet = '売上'` が書ける ── 名前を捨てない)。
 */
import { CSV_SOURCE_COLUMNS, CSV_TABLE_CELLS_MAX, csvColumnNames } from './csv-tables';
import type { SqlSource } from './sqlite-attachment';
import type { XlsxCell } from './xlsx-sheet';

/**
 * 🔴 **こちらが先に使う列**。⚠ `csv` の 2 つに **`_sheet` を足す**。
 * ⚠ この並びのまま行の頭に置く(列名と値の順番がずれると、**別の列の値が入る**)。
 */
export const XLSX_SOURCE_COLUMNS = [...CSV_SOURCE_COLUMNS, '_sheet'] as const;

/**
 * その題名は `.xlsx` の添付か。
 * ⚠ 大文字で書く人も居るので、比べる前に小文字へ落とす(`looksLikeCsvAttachmentName` と同じ作法)。
 * ⚠ **`.xls`(古い形式)は受けない** ── 中身が zip ではないので、この読み手では開けない。
 *   受けてしまうと「選べるのに必ず断られる口」になる。
 */
export function looksLikeXlsxAttachmentName(name: string): boolean {
  return name.trim().toLowerCase().endsWith('.xlsx');
}

/**
 * 添付のノートから、xlsx として選べる相手を拾う。
 * ⚠ **`sqlSourcesOf` / `csvAttachmentSourcesOf` と同じ形**で返す(選び所は 1 つの
 *   `<select>` に並べるので、器を分けない)。⚠ 並びは題名順。
 */
export function xlsxAttachmentSourcesOf(
  metas: Iterable<{ readonly lid: string; readonly title: string; readonly archetype: string }>,
): SqlSource[] {
  const out: SqlSource[] = [];
  for (const m of metas) {
    if (m.archetype !== 'attachment') continue;
    if (!looksLikeXlsxAttachmentName(m.title)) continue;
    out.push({ lid: m.lid, name: m.title });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 枚 1 つから組み立てた表。⚠ `CsvAttachmentTable` と同じ形(選び所も出口も共通)。 */
export interface XlsxAttachmentTable {
  readonly name: string;
  /** `_note` / `_lid` / `_sheet` を先頭に含む。 */
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
  /** 上限で切ったか。⚠ 黙って切らない ── 呼び側が画面へ出す。 */
  readonly truncated: boolean;
}

/** 何枚目かを表の名前にする(1 始まり)。 */
export function xlsxTableName(index: number): string {
  return `sheet${String(index + 1)}`;
}

/**
 * 🔴 **枚 1 つを表にする**。
 *
 * ⚠ **1 行目は必ず見出し**として読む(添付は生の file なので、`noheader` を
 *   書ける場所が無い ── `csv-attachment.ts` と同じ)。
 * ⚠ **升の総数**(行 × 列)で切る ── 列が多い本ほど 1 行の組み立てが重いので、
 *   行数だけの上限だと**広い表で固まる**。
 * ⚠ **予算は本 1 冊ぶんを枚で分けない** ── 呼び側が枚ごとに渡す
 *   (ここで割ると、枚が増えるほど 1 枚が痩せて「なぜか途中までしか出ない」になる)。
 *
 * @param grid `xlsx-sheet.ts` の `xlsxSheetGrid` が返した格子
 * @returns 空の枚は `null`(呼び側が飛ばす ── 空の表を作らない)
 */
export function buildXlsxAttachmentTable(
  grid: readonly (readonly XlsxCell[])[],
  sheet: { readonly index: number; readonly name: string },
  note: { readonly lid: string; readonly title: string },
  cellBudget: number = CSV_TABLE_CELLS_MAX,
): XlsxAttachmentTable | null {
  const header = grid[0];
  // ⚠ 見出しの行すら無い枚は表にしない(列が 0 の表は engine が作れない)
  if (header === undefined || header.length === 0) return null;
  const columns = [
    ...XLSX_SOURCE_COLUMNS,
    // 🔑 先取りする列は**全部**渡す ── 見出しが `_sheet` でもぶつからない
    ...csvColumnNames(
      header.map((c) => c ?? ''),
      XLSX_SOURCE_COLUMNS,
    ),
  ];
  const body = grid.slice(1);
  const perRowBudget = Math.max(1, Math.floor(cellBudget / Math.max(1, columns.length)));
  const truncated = body.length > perRowBudget;
  const kept = truncated ? body.slice(0, perRowBudget) : body;
  const rows = kept.map((r) => [
    note.title,
    note.lid,
    sheet.name,
    // ⚠ **見出しの数だけ**並べる ── 行のほうが長くても、名前の無い列は作れない
    ...header.map((_, i) => r[i] ?? null),
  ]);
  return { name: xlsxTableName(sheet.index), columns, rows, truncated };
}
