/**
 * 🔴 **`.xlsx` の 1 冊を、枚(シート)ごとの表に開く**(#854 段③)。
 *
 * ## 置き場の理由
 *
 * 🔑 zip を解くのも、枚を数えるのも、格子を表にするのも**全部 features 層に在る**
 *   ので、それを 1 本に束ねるここも features 層に置く ── 🔴 **重い処理は worker で
 *   完結させる**(不可侵指示 2026-08-03)ので、`storage-worker.ts` はこの 1 本を
 *   呼ぶだけにする。⚠ bytes を主スレッドへ戻して組み立て直す形にしない。
 *
 * ## ⚠ 上限は「枚ごと」と「1 冊ぶん」の 2 段
 *
 * 🔑 **枚ごとの上限は割らない**(`buildXlsxAttachmentTable` の docstring)──
 *   枚の数で割ると、枚が増えるほど 1 枚が痩せて「**なぜか途中までしか出ない**」に
 *   なる。⚠ その代わり**1 冊ぶんの総量で止める** ── 割らずに止めるので、
 *   1 枚の本は今までどおり満額で、50 枚の本だけが途中で止まる。
 * 🔴 止めたことは必ず `truncated` で言う(黙って切ると user は「これで全部」と読む)。
 */
import { readZipDirectory, readZipText, type ZipEntry } from '@features/import/zip-reader';
import { CSV_TABLE_CELLS_MAX } from './csv-tables';
import { buildXlsxAttachmentTable, type XlsxAttachmentTable } from './xlsx-attachment';
import {
  dateStyleIndexesOf,
  sharedStringsOf,
  sheetsOf,
  xlsxSheetGrid,
} from './xlsx-sheet';

/**
 * 🔴 **1 冊ぶんの升の総数の上限**。
 *
 * ⚠ 枚ごとの上限(`CSV_TABLE_CELLS_MAX` = 20 万)だけだと、枚が 50 枚在る本で
 *   **1000 万升**が `:memory:` の DB に積まれる ── 客の DB は常駐するので、
 *   そのまま常駐メモリになる(不可侵指示 2026-07-27「速やかな破棄」の逆)。
 * 🔑 4 倍にしてあるのは「**1 枚の本は 1 度も当たらない**」ため ── この門が効くのは
 *   枚が 5 つ以上あって、どれも大きい本だけである。
 */
export const XLSX_BOOK_CELLS_MAX = CSV_TABLE_CELLS_MAX * 4;

/**
 * 🔴 **枚の目録の表**(`csv_tables` と同じ作法)。
 *
 * ## なぜ要るか ── `sheet1` だけ見せられても、何の枚か分からない
 *
 * ⚠ 表の名前は `sheet1` / `sheet2` …(打てる名前にするため)なので、
 *   画面の「この file に在る表」もその字で並ぶ ── 🔴 **3 枚在る本を開いた user は、
 *   どれが「売上」なのか画面のどこからも読めない**。
 * 🔑 だから**目録を 1 つ足す** ── `csv_tables` が「どんな名前が在るか」を
 *   答えているのと同じ形である(この repo の既存の言い方に揃える)。
 * ⚠ 目録は**いちばん前**に置く ── 薄字の手本(`sqlPlaceholder`)は
 *   1 つ目の表を使うので、開いた直後の例文が「どの枚が何か」を出す 1 手になる。
 *
 * 🔴 **枚が 1 つの本には作らない** ── 見分けるものが無いので、
 *   目録は「打つ前にもう 1 手」を増やすだけである(csv と同じ手数のままにする)。
 */
export const XLSX_SHEETS_TABLE = 'xlsx_sheets';

/** 1 冊を開いた結果。 */
export interface XlsxBook {
  /** 枚ごとの表(`sheet1` / `sheet2` …)。⚠ 空の枚は**入らない**。 */
  readonly tables: readonly XlsxAttachmentTable[];
  /** どこかで上限に当たったか(枚の中で切った / 枚ごと落とした のどちらでも)。 */
  readonly truncated: boolean;
}

/** zip の目録から 1 件引く。⚠ 名前は**丸ごと一致**で見る(尻だけ留めると別物に当たる)。 */
function entryOf(entries: readonly ZipEntry[], path: string): ZipEntry | null {
  for (const e of entries) {
    if (!e.isDirectory && e.name === path) return e;
  }
  return null;
}

/** 在れば読む、無ければ空文字(`sharedStrings.xml` / `styles.xml` は**無い本が在る**)。 */
async function textOr(
  zip: Blob,
  entries: readonly ZipEntry[],
  path: string,
): Promise<string> {
  const e = entryOf(entries, path);
  if (e === null) return '';
  return readZipText(zip, e);
}

/**
 * 🔴 **1 冊を開く**。
 *
 * @param bytes `.xlsx` そのもの(zip)
 * @param note どのノートから来たか(表の `_note` / `_lid` 列に入る)
 * @throws 読めない本(zip でない / `workbook.xml` が無い / 枚が 1 つも読めない)。
 *   ⚠ **黙って空を返さない** ── 呼び側が「開けました」と言ってしまう。
 */
export async function readXlsxBook(
  bytes: Uint8Array,
  note: { readonly lid: string; readonly title: string },
  budget: { readonly perSheet?: number; readonly book?: number } = {},
): Promise<XlsxBook> {
  const perSheet = budget.perSheet ?? CSV_TABLE_CELLS_MAX;
  const bookBudget = budget.book ?? XLSX_BOOK_CELLS_MAX;
  // ⚠ `Blob` は view の範囲(byteOffset / byteLength)をそのまま尊重する ──
  //    `.buffer` を渡すと**切り出す前の全体**を包んでしまう(ここでは渡さない)
  const zip = new Blob([bytes as BlobPart]);
  const entries = await readZipDirectory(zip);
  const workbook = entryOf(entries, 'xl/workbook.xml');
  if (workbook === null) {
    throw new Error('xl/workbook.xml が入っていません(xlsx ではないかもしれません)');
  }
  const rels = entryOf(entries, 'xl/_rels/workbook.xml.rels');
  if (rels === null) {
    throw new Error('xl/_rels/workbook.xml.rels が入っていません(枚の並びを読めません)');
  }
  const sheets = sheetsOf(await readZipText(zip, workbook), await readZipText(zip, rels));
  if (sheets.length === 0) throw new Error('枚(シート)が 1 つも見つかりません');

  const shared = sharedStringsOf(await textOr(zip, entries, 'xl/sharedStrings.xml'));
  const dateStyles = dateStyleIndexesOf(await textOr(zip, entries, 'xl/styles.xml'));

  // ⚠ 枚の名前は**この場で持つ** ── 表の `_sheet` 列から採り直すと、
  //    **行が 0 件の枚**(見出しだけ)で空になる(目録に名前の無い行ができる)
  const kept: { readonly table: XlsxAttachmentTable; readonly sheet: string }[] = [];
  let truncated = false;
  let used = 0;
  for (const [index, sheet] of sheets.entries()) {
    const e = entryOf(entries, sheet.path);
    // ⚠ 目録に在る枚の中身が無い本は壊れているが、**残りは読める** ── 1 枚で諦めない
    if (e === null) {
      truncated = true;
      continue;
    }
    if (used >= bookBudget) {
      // 🔴 1 冊ぶんの上限に当たった ── ここから先の枚は**載せない**(黙らない)
      truncated = true;
      break;
    }
    // ⚠ **ここで割らない** ── 載せると決めた枚には満額を渡し、次の回の頭で止める
    //    (割ると枚が増えるほど 1 枚が痩せて「なぜか途中までしか出ない」になる)
    const grid = xlsxSheetGrid(await readZipText(zip, e), shared, dateStyles);
    const built = buildXlsxAttachmentTable(
      grid,
      { index, name: sheet.name },
      note,
      perSheet,
    );
    // ⚠ 空の枚は表にしない(列 0 の表は engine が作れない)── これは打ち切りではない
    if (built === null) continue;
    used += built.rows.length * built.columns.length;
    if (built.truncated) truncated = true;
    kept.push({ table: built, sheet: sheet.name });
  }
  if (kept.length === 0) throw new Error('中身のある枚(シート)が 1 つもありません');
  const tables = kept.map((k) => k.table);
  // 🔴 見分けるものが 2 つ以上あるときだけ目録を足す(上の docstring)
  if (tables.length < 2) return { tables, truncated };
  return {
    tables: [
      {
        name: XLSX_SHEETS_TABLE,
        // ⚠ 値は**全部字**である(表の中身と同じ規則 ── 数で比べたいなら CAST する)
        columns: ['name', 'sheet', 'rows'],
        rows: kept.map((k) => [k.table.name, k.sheet, String(k.table.rows.length)]),
        // ⚠ 目録そのものは切っていない(切ったかどうかは冊の `truncated` が言う)
        truncated: false,
      },
      ...tables,
    ],
    truncated,
  };
}
