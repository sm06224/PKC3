/**
 * 🔴 **SQL の答えを、そのままノートにする**(#681 段③ の 3 つ目)。
 *
 * user の言葉(2026-09-03)の「クエリアプリ」の出口である ── 調べた結果を
 * **持ち歩ける形**(ノート)にしないと、窓を閉じた時点で消える。
 *
 * ## 何を書くか
 *
 * 1. **打った SQL**(`sql` の囲み)── 後から「何を調べた答えか」が読める
 * 2. **答えの表**(`csv` の囲み)── 画面でも表として出るし、
 *    名前を付ければ **また SQL から引ける**(段③ の 1 つ目)
 *
 * ⚠ **名前は付けない**(`name=` を書かない)── こちらが勝手に名付けると、
 *   同じ名前の表が知らないうちに増える(積まれる)。名付けるのは user である。
 *   🔑 代わりに**そう書けることを本文に 1 行**書く(道が在ることを知らせる)。
 *
 * ## ⚠ 囲みを、中身に壊させない
 *
 * 🔴 升の中に ``` が入っていると、**囲みがそこで閉じる** ── 以降の行が
 *   本文として描かれ、user から見ると**答えが途中で化ける**。
 * 🔑 だから柵の長さを**中身から決める**(いちばん長い連なりより 1 本多くする)。
 *   これは markdown の作法そのもので、読み手も同じ規則で閉じる。
 */
import { csvEscapeField } from '@features/markdown/csv-table';
import { sqlCellText } from '@features/markdown/sql-embed';
import { tableToTsv } from '@features/markdown/table-copy';
import { cappedCellsNote } from './sql-cell';

/** 表に書き出す値(worker から来る形)。 */
export type SqlCell = string | number | null;

/**
 * 🔴 **柵の長さを中身から決める**。
 * @returns 囲みに使う ` の並び(最低 3 本)。
 */
export function fenceMarkFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * 題名。⚠ **いつ調べたか**を入れる(同じ問いを何度も書き出すので、並ぶと区別が要る)。
 *
 * 🔴 **何を調べたかも入れる**(#837 K3、2026-09-09)。⚠ 日時は**分まで**なので、
 *   続けて書き出した 2 件は**同じ題名**で並ぶ ── 一覧で見分けられない。
 * ⚠ `where` は取り込んだ `.sqlite` の file 名(この PKC のノートなら `null`)。
 *   ⚠ ノート側で括弧を足さない ── 「(この PKC のノート)」は**ほとんどの回**に
 *   付くので、題名が毎回長くなるだけで見分けの役に立たない。
 */
export function sqlNoteTitle(now: Date, where: string | null = null): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${String(now.getFullYear())}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    ` ${p(now.getHours())}:${p(now.getMinutes())}`;
  return where === null || where === ''
    ? `SQL の結果 ${stamp}`
    : `SQL の結果 ${stamp}(${where})`;
}

/** 升 1 つを csv の字へ。⚠ `null` は**空の升**にする(`null` という字にしない)。 */
function cell(v: SqlCell): string {
  return csvEscapeField(v === null ? '' : String(v), ',');
}

/**
 * 本文を組む。
 *
 * @param truncated 上限で切った回は、**切ったと書く**(黙って途中までを渡さない)
 */
export function sqlNoteBody(p: {
  readonly sql: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly SqlCell[])[];
  readonly truncated: boolean;
  /**
   * 🔴 **どこを調べた答えか**(#837 K3、2026-09-09)。取り込んだ `.sqlite` の
   * file 名。この PKC のノートなら省略(または `null`)。
   *
   * ⚠ 書かないと、1 週間後にそのノートを開いた人は**同じ SQL をノート側で
   *   走らせて `no such table` と断られる** ── この面は画面では
   *   「どちらを調べているか」に気を配っているのに、**いちばん長く残る成果物
   *   (ノート)からその情報だけが落ちて**いた。
   */
  readonly where?: string | null;
  /** 🔴 先頭 2000 字に切ってある升の数(#1087 の見直し)。0 / 省略なら何も言わない。 */
  readonly capped?: number;
}): string {
  const table = [p.columns.map((c) => csvEscapeField(c, ',')).join(','), ...p.rows.map((r) => r.map(cell).join(','))].join(
    '\n',
  );
  const sqlMark = fenceMarkFor(p.sql);
  const csvMark = fenceMarkFor(table);
  const lines = [
    `${sqlMark}sql`,
    p.sql,
    sqlMark,
    '',
    `${csvMark}csv`,
    table,
    csvMark,
    '',
    // 🔴 **どこを調べたかを、いちばん先に言う**(#837 K3)
    `> ${String(p.rows.length)} 行の結果です(${
      p.where === undefined || p.where === null || p.where === ''
        ? 'この PKC3 のノート'
        : p.where
    } を調べました)。`,
  ];
  if (p.truncated) {
    lines.push('>');
    lines.push('> ⚠ 上限で切っています。全部を出すには、LIMIT や条件で絞ってから実行し直してください。');
  }
  if ((p.capped ?? 0) > 0) {
    lines.push('>');
    lines.push(`> ${cappedCellsNote(p.capped ?? 0)}。全文が要るときは、その列だけを SQL で選んで実行し直してください。`);
  }
  lines.push('>');
  lines.push(
    `> この表をまた SQL から実行したいときは、上のブロックの 1 行目を \`csv name=好きな名前\` にしてください。`,
  );
  /**
   * 🔴 **開くたびに最新を出す書き方があることも言う**(#1087 の見直し 2026-10-13)── `sql embed` は画面のどこにも出ておらず、
   *   「結果を本文に貼りたい」人は、書き出しで止まった表しか作れないと思っていた。
   */
  lines.push(
    `> 開くたびに最新の結果を出したいときは、SQL を書いたブロックの 1 行目を \`sql embed\` にしてください(→ マニュアル「本文に SQL の結果を埋め込む」)。`,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * 🔴 **本文に貼る形**(依頼 63-1。Gemini 裁定 2026-10-13 = 推薦どおり)。
 *
 * ````
 * ```sql embed
 * <いま出ている結果を引いた SQL>
 * ```
 * ````
 *
 * を返す。⚠ 綴りは `sql-embed.ts` が読む形(1 行目 = `sql embed`)と同じ ── 柵の長さは
 * `sqlNoteBody` と同じ `fenceMarkFor` で決める(SQL の中に ``` があっても囲みが閉じない)。
 */
export function sqlEmbedFence(sql: string): string {
  const mark = fenceMarkFor(sql);
  return `${mark}sql embed\n${sql}\n${mark}\n`;
}

/**
 * 🔴 **答えの表を表計算に貼る形(TSV)**。⚠ 本文の表の ⧉ と**同じ組み立て**(`tableToTsv`)で、
 * 値が無い升は `(なし)`(画面の表と同じ字)。
 */
export function sqlAnswerTsv(
  columns: readonly string[],
  rows: readonly (readonly SqlCell[])[],
): string {
  return tableToTsv([
    { cells: columns, head: true },
    ...rows.map((r) => ({ cells: r.map(sqlCellText), head: false })),
  ]);
}
