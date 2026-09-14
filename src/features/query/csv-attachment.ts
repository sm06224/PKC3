/**
 * 🔴 **添付した CSV / TSV を、SQL で調べられるようにする**(#854 段①)。
 *
 * user の言葉(2026-09-03)の「**csv や sqliteDB のクエリアプリ**」の csv の側 ──
 * 段①② は本文に書いた csv の囲みだけを引けた(`csv-tables.ts`)。ここでは
 * **添付として取り込んだ `.csv` / `.tsv` そのもの**を、`.sqlite` の添付と
 * 同じ選び所から選べるようにする。
 *
 * ## どこから選ぶか / 何を「それらしい」と見るか
 *
 * 🔑 `sqlite-attachment.ts` と**同じ理由・同じ形**である ── 添付として取り込んだ
 *   ノートから、**拡張子だけ**で見分ける(中身で見分けるには全部読むしかなく、
 *   選ぶ前に何十 MB も heap へ載せることになる。不可侵指示 2026-07-27 の逆)。
 *   外したものは開いたときに断られる。
 *
 * ## 表の作り方は「本文の囲み」と揃える
 *
 * ⚠ **2 つ目の CSV 読み手を書かない**(§7「同じ問いに答える口を 2 つ作らない」)。
 *   `parseCsv`(区切りで割る)と `csvColumnNames`(見出しの升を列名にする)は
 *   `csv-table.ts` / `csv-tables.ts` に既に在る ── ここはその 2 つを**そのまま使い**、
 *   ①値は全部 TEXT ②列は 1 行目の見出し ③どこから来たか分かる列
 *   (`CSV_SOURCE_COLUMNS` = `_note` / `_lid`)を足す、を揃える。
 *
 * ⚠ 添付は **1 file = 1 表**なので、`csv-tables.ts` の「同じ名前の囲みを積む」規則は
 *   要らない。名前は**固定で `csv`** にする ── file 名(題名)から作ると、
 *   全角の字や記号を含む題名で「打てない名前」ができる(`csv-tables.ts` の
 *   `validCsvTableName` が守っている規律と同じ理由)。固定名なら誰でも同じ字を打てる。
 */
import { DELIMITER, parseCsv } from '@features/markdown/csv-table';
import { CSV_SOURCE_COLUMNS, CSV_TABLE_CELLS_MAX, csvColumnNames } from './csv-tables';
import type { SqlSource } from './sqlite-attachment';

/** 添付として選べる CSV 系の言語。 */
export type CsvAttachmentLang = 'csv' | 'tsv';

/**
 * その題名は `.csv` / `.tsv` の添付か。
 * ⚠ 大文字で書く人も居るので、比べる前に小文字へ落とす(`looksLikeSqliteName` と同じ作法)。
 */
export function looksLikeCsvAttachmentName(name: string): CsvAttachmentLang | null {
  const lower = name.trim().toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.tsv')) return 'tsv';
  return null;
}

/**
 * 添付のノートから、csv / tsv として選べる相手を拾う。
 *
 * ⚠ **`sqlSourcesOf`(`.sqlite` 側)と同じ形**で返す ── 選び所は 1 つの `<select>` に
 *   両方を並べるので、器を分けない(呼び側が 2 つの一覧を連結する)。
 * ⚠ **並びは題名順**(`sqlSourcesOf` と同じ理由 ── 入れ直すたびに場所が変わらない)。
 */
export function csvAttachmentSourcesOf(
  metas: Iterable<{ readonly lid: string; readonly title: string; readonly archetype: string }>,
): SqlSource[] {
  const out: SqlSource[] = [];
  for (const m of metas) {
    if (m.archetype !== 'attachment') continue;
    if (looksLikeCsvAttachmentName(m.title) === null) continue;
    out.push({ lid: m.lid, name: m.title });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 固定の表の名前(理由は上の docstring)。 */
export const CSV_ATTACHMENT_TABLE_NAME = 'csv';

/** 添付から組み立てた表。 */
export interface CsvAttachmentTable {
  readonly name: string;
  /** `_note` / `_lid` を先頭に含む(`CSV_SOURCE_COLUMNS`)。 */
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
  /** 上限で切ったか。⚠ 黙って切らない ── 呼び側が画面へ出す。 */
  readonly truncated: boolean;
}

/**
 * 🔴 **file 全体を 1 つの表にする**(#854 段①)。
 *
 * ⚠ **1 行目は必ず見出し**として読む ── 本文の囲みと違って `noheader` を
 *   書ける場所が無い(添付は 1 つの生の file であって、書式を添える info 文字列を
 *   持たない)。
 * ⚠ **大きすぎる file で固まらせない**(不可侵指示「重い処理はワーカーへ」の
 *   worker 内での見張り)。行数ではなく**升の総数**(行 × 列)で切る ──
 *   列が多い file ほど 1 行の組み立てが重いので、行数だけの上限だと
 *   広い表で固まる(`docs`: #854 の報告に実測を書く)。
 *
 * @returns 空、または区切りが 1 つも見つからない file は `null`(呼び側が断る)。
 */
export function buildCsvAttachmentTable(
  text: string,
  lang: CsvAttachmentLang,
  note: { readonly lid: string; readonly title: string },
  cellBudget: number = CSV_TABLE_CELLS_MAX,
): CsvAttachmentTable | null {
  const grid = parseCsv(text, DELIMITER[lang]);
  // ⚠ `parseCsv` は空 / 白紙だけの入力に `null` を返す(`csv-tables.ts` と同じ前提)
  if (grid === null) return null;
  const header = grid[0] ?? [];
  const columns = [...CSV_SOURCE_COLUMNS, ...csvColumnNames(header, CSV_SOURCE_COLUMNS)];
  const body = grid.slice(1);
  // ⚠ 列数は必ず 1 以上(`csvColumnNames` は見出しが 1 升でも 1 列返す) ──
  //   それでも割り算の分母を 1 で床にして、将来の変更に備える。
  const perRowBudget = Math.max(1, Math.floor(cellBudget / Math.max(1, columns.length)));
  const truncated = body.length > perRowBudget;
  const kept = truncated ? body.slice(0, perRowBudget) : body;
  const rows = kept.map((r) => [note.title, note.lid, ...header.map((_, i) => r[i] ?? null)]);
  return { name: CSV_ATTACHMENT_TABLE_NAME, columns, rows, truncated };
}
