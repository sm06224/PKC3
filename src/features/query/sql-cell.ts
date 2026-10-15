/**
 * 🔴 **1 つの升に運ぶ字数の上限**(#681 段②、2026-09-09 の着地前レビュー。DuckDB 側は #682 段④d の着地後レビュー)。
 *
 * ⚠ **BLOB を畳む理由は、長い字にそのまま当たる** ── 画面に出しても読めず、
 *   heap に載せる理由が無い。⚠ ところが初稿は BLOB だけ畳んで**字は素通り**だった
 *   (CLAUDE.md「片側を直したら、対称の反対側を必ず疑う」)。
 * 🔴 実測(2026-09-09):`SELECT hex(randomblob(2000000))` は **1 行で 400 万字**を返し、
 *   **進み具合の見張りは 1 度も鳴らない**(1 行なので歩数も行数も門にならない)。
 *   ⚠ そして `entries.body` は同じ表に在るので、`SELECT * FROM entries` は
 *   **いちばん自然な最初の 1 打**である。
 * 🔴 **DuckDB の答えにも同じ天井を当てる**(`duckdb-rows.ts`)── 内蔵の sqlite(storage worker)だけ畳んで
 *   DuckDB は素通しだと、同じ `.sqlite` の同じ 1 行が **engine を替えただけで画面を埋める**
 *   (BLOB は base64 で入るので、1 MB の BLOB は 1.3 MB の字になる)。
 * 🔑 **字数も上限も、ここ 1 か所**(§7「同じ問いに答える口を 2 つ作らない」)── 2 つの engine が別々の
 *   数字・別々の書き方を持つと、片方だけが変わる。
 */
export const MAX_CELL_CHARS = 2000;

/**
 * 長い字を畳む。⚠ **全部で何字あったかは残す**(黙って切らない ── user は「これで全部」と読む)。
 */
export function capCellText(s: string): string {
  return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}…(全 ${String(s.length)} 字)` : s;
}

/**
 * 🔴 **畳まれた升か**(#1087 の見直し)── `capCellText` が付けた `…(全 N 字)` の印で見分ける。
 * ⚠ 「ファイルへ」「ノートへ」は worker が運んだ升をそのまま書くので、**畳まれた升は畳まれたまま**出る。
 *   それを言うために数える(印の付け方はここ 1 か所 ── §7。書式を変えたらこの判定も変わる)。
 * ⚠ 先頭が `MAX_CELL_CHARS` 字 + 印 + 印の字数が上限より大きい、までを見る
 *   (たまたま `…(全 3 字)` で終わる字を畳まれた物と数えない)。
 */
const CAPPED_TAIL = /^…\(全 (\d+) 字\)$/;
export function isCappedCellText(v: unknown): boolean {
  if (typeof v !== 'string' || v.length <= MAX_CELL_CHARS) return false;
  const m = CAPPED_TAIL.exec(v.slice(MAX_CELL_CHARS));
  return m !== null && Number(m[1]) > MAX_CELL_CHARS;
}

/** 行の並びの中で、畳まれた升の数。 */
export function countCappedCells(rows: readonly (readonly unknown[])[]): number {
  let n = 0;
  for (const r of rows) for (const v of r) if (isCappedCellText(v)) n += 1;
  return n;
}

/** 畳んだ升の数を user に言う 1 文(0 のときは空)。⚠ 画面の字なので `ui-terms` の門を通る。 */
export function cappedCellsNote(n: number): string {
  return n > 0 ? `長い値 ${String(n)} 個は先頭 ${String(MAX_CELL_CHARS)} 字で切ってあります` : '';
}
