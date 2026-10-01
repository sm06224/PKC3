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
 * 🔴 **「もう 1 つ足す…」の中の「手持ちのファイルを足す…」**(#918 段⑦)。
 * ⚠ 上の `SQL_PICK_LOCAL_FILE_VALUE` と**別の値**にする ── 同じ file 選択画面を開くが、
 *   選んだ file を**足す**のか**置き換える**のかが違う(binder が値で見分ける)。
 */
export const SQL_ADD_LOCAL_FILE_VALUE = '__add_local_file__';

/**
 * 🔴 **足す相手として選んだ添付の印**(#918 段⑦)。`add:` の後ろが lid。
 * ⚠ 本物の lid は `:` を含まない(`generateLid()`)ので、頭の印と衝突しない。
 */
export const SQL_ADD_SOURCE_PREFIX = 'add:';

/** 選び所の値が「足す」の選択か。足す相手の lid を返す(`null` = 足す選択ではない)。 */
export function addSourceLidOf(value: string): string | null {
  return value.startsWith(SQL_ADD_SOURCE_PREFIX) ? value.slice(SQL_ADD_SOURCE_PREFIX.length) : null;
}

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
