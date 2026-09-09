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

/** 題名。⚠ **いつ調べたか**を入れる(同じ問いを何度も書き出すので、並ぶと区別が要る)。 */
export function sqlNoteTitle(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `SQL の答え ${String(now.getFullYear())}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    ` ${p(now.getHours())}:${p(now.getMinutes())}`
  );
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
    `> ${String(p.rows.length)} 行の答えです。`,
  ];
  if (p.truncated) {
    lines.push('>');
    lines.push('> ⚠ 上限で切っています ── 全部を出すには、LIMIT や条件で絞ってから走らせ直してください。');
  }
  lines.push('>');
  lines.push(
    `> 🔑 この表をまた SQL から引きたいときは、上の囲みの 1 行目を \`csv name=好きな名前\` にしてください。`,
  );
  return `${lines.join('\n')}\n`;
}
