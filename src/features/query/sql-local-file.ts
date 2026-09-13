/**
 * 🔴 **SQL の面から「手持ちのファイル」を開く、選び所の印**(#854 段②)。
 *
 * user 裁定 2026-09-12(こちらの解釈):**開いたファイルは憶えない。毎回選び直す。**
 * (憶える形は #215 と一体で作るので、ここでは作らない)。
 *
 * ⚠ **値だけをここへ置く** ── 使う側(`sql.ts` の選び所 / `binder.ts` の受け手 /
 *   `store-effects.ts` の分岐 / `sql-local-file.ts` の控え)が別々の綴りを書くと、
 *   比べる先が食い違って気づけない事故になる(CLAUDE.md §7「同じ値は 1 回だけ
 *   作って両方へ配る」)。
 */

/**
 * 選び所の「手持ちのファイルを開く…」を表す、実体の無い値。
 * ⚠ 本物の lid(`generateLid()` は base36 の時刻+連番だけ)には出てこない字を含む
 *   ── `<select>` に打鍵で似た値を書ける仕組みは無いので、これで衝突は起きない。
 */
export const SQL_PICK_LOCAL_FILE_VALUE = '__pick_local_file__';

/**
 * 手持ちのファイルへ発行する合成 lid の頭。
 * ⚠ **実在するノートの lid とは絶対に被らない** ── `generateLid()` はコロンを
 *   含まないので、頭にコロン付きの印を置けば別物だと機械的に言える。
 */
export const SQL_LOCAL_FILE_LID_PREFIX = 'sql-local-file:';

/**
 * その lid は、手持ちのファイルを表す合成の物か。
 * ⚠ 開くとき(`store-effects.ts`)と、選び所に映すとき(`sql.ts`)で**同じ関数**を
 *   呼ぶ ── 判定を 2 か所に書き写さない。
 */
export function isSqlLocalFileLid(lid: string): boolean {
  return lid.startsWith(SQL_LOCAL_FILE_LID_PREFIX);
}
