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
