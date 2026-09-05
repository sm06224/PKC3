/**
 * 🔴 **表を「どの形で」持ち出すか**(#708 段①)。
 *
 * > user の物語(#708): 表の右上の ⧉ を押すと Excel には貼れる。**でも
 * > markdown の表として貼りたい / CSV の file が欲しい**ときに、その道が無い。
 *
 * 🔑 **組み立ての規則はここ 1 本**(CLAUDE.md §7)── csv の囲みが出す表も、
 *   markdown の `| a | b |` が出す表も、**同じ升の並び**にしてからここへ渡す。
 *   別々に書くと「csv の表だけ `|` を逃がさない」型の食い違いが必ず出る。
 * ⚠ ここは **DOM を読まない** ── 升を読むのは adapter(`copy-md-block.ts`)の
 *   仕事で、こちらは升の並びを字にするだけ(features 層は browser API を持たない)。
 *
 * 🔑 **逃げの規則は借りてくる**:
 *   - CSV の囲み方 → `csv-table.ts` の `csvEscapeField`(#418 で 1 本化済み)
 *   - markdown の表 → `html-to-markdown.ts` の `gfmTable` / `gfmCellText`
 *     (HTML 貼付・RTF 貼付が既に使っている 1 本)
 *   ⚠ ここで書き直すと、**同じ問いに答える口が 3 つ**になる。
 */
import { csvEscapeField } from './csv-table';
import { gfmCellText, gfmTable } from './html-to-markdown';

/** 表の 1 行。⚠ `head` は「その行が見出しか」(`<th>` だけで出来ているか)。 */
export interface TableCopyRow {
  readonly cells: readonly string[];
  readonly head: boolean;
}

/**
 * 持ち出す形。⚠ `csv-file` だけは**コピーではなく保存**である ──
 * それでも同じ一覧に並べる(user から見れば「この表を持ち出す」1 つの用事で、
 * 器を 2 つに割ると「保存はどこ?」を探させることになる)。
 */
export type TableCopyFormat = 'tsv' | 'markdown' | 'html' | 'csv' | 'csv-file';

/**
 * 🔴 **並べる字の正本**(#708 段①)。
 *
 * ⚠ **画面に出る字はここだけ**にする ── 器(`app-dialog.ts`)は並べるだけ、
 *   binder は id で分岐するだけ。字を 2 か所に置くと、片方だけ直る。
 * 🔑 字は「**何が起きるか**」で書く(CLAUDE.md「内部の言葉で聞かない」)──
 *   `TSV` とだけ書いても、それが表計算に貼れる物だとは読めない。
 */
export const TABLE_COPY_CHOICES: readonly {
  readonly id: TableCopyFormat;
  readonly label: string;
}[] = [
  { id: 'tsv', label: '表計算に貼る(TSV)' },
  { id: 'markdown', label: 'Markdown の表' },
  { id: 'html', label: 'HTML' },
  { id: 'csv', label: 'CSV' },
  { id: 'csv-file', label: '.csv で保存' },
];

/**
 * TSV(表計算に貼る形)。
 *
 * ⚠ 升の中の tab / 改行は**読む側(`copy-md-block.ts`)が既に空白へ潰している** ──
 *   ここで潰し直さない(潰す規則が 2 つに割れる)。
 */
export function tableToTsv(rows: readonly TableCopyRow[]): string {
  return rows.map((r) => r.cells.join('\t')).join('\n');
}

/**
 * CSV。⚠ 囲むのは `csvEscapeField` に任せる ── 区切り字・引用符を含む升だけが
 * 包まれる(余分に包むと、開き直すたびに字面が太っていく)。
 */
export function tableToCsv(rows: readonly TableCopyRow[]): string {
  return rows.map((r) => r.cells.map((c) => csvEscapeField(c, ',')).join(',')).join('\n');
}

/**
 * markdown の表(GFM)。升が 1 つも無ければ `null`。
 *
 * 🔴 **`|` を逃がす**(`gfmCellText`)── 逃がさないと、升の中の `|` が
 *   **列の区切りとして読まれ、貼った先で表がずれる**(静かに壊れる向き)。
 * ⚠ 見出しの無い表には `gfmTable` が**空の見出し**を足す ── 先頭行を格上げすると
 *   **データが 1 行消える**(`html-to-markdown.ts` の註記と同じ理由)。
 */
export function tableToMarkdown(rows: readonly TableCopyRow[]): string | null {
  return gfmTable(rows.map((r) => ({ cells: r.cells.map(gfmCellText), head: r.head })));
}
