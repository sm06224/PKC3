/**
 * 🔴 **保存されている中身が壊れたときに、何をするか**(#971)。**pure**。
 *
 * ## user の物語(2026-09-16 の報告)
 *
 * 並び替えを押したら `sqlite result code 11 / database disk image is malformed` と出た。
 * ⚠ 保存領域は 4GB を超えていて、**バックアップの書き出しも通らない**。
 *
 * ## 🔴 直す前に何が起きていたか
 *
 * `src` に **`SQLITE_CORRUPT` を扱う所が 1 件も無かった** ── だから:
 * ① **素の sqlite の字**がそのまま出る(user には読めない)
 * ② **次の一手が画面に出ない**(どこから持ち出せばよいか分からない)
 * ③ 🔴 **書き込みが止まらない** ── 壊れた DB へ書き続けると**壊れ方が広がる**
 *
 * ## 🔑 止めるのは書き込みだけ。読みは残す
 *
 * ⚠ **読みを止めてはいけない** ── 読みこそが**持ち出す道**である。
 *   全部止めると「データは在るのに取り出せない」という、いちばん悪い形になる。
 *
 * ## ⚠ この module は「起きたこと」しか言わない
 *
 * 原因(容量切れ / 多重書き込み / 索引だけの破損)は**まだ切り分けていない**。
 * 🔑 だから**原因を名乗る文言を書かない** ── 書くと、次に読む人が
 *   確かめずに信じる(CLAUDE.md「事故の報告ほど、範囲を実測してから書く」)。
 */
import {
  CONTAINER_REBUILD_LABEL,
  CONTAINER_RESET_LABEL,
  RESCUE_ARCHIVE_LABEL,
} from './rescue-labels';

/**
 * 🔴 **その error が「中身が壊れている」かどうか**。
 *
 * ⚠ **語を広く取りすぎない** ── `error` の字に「壊れ」と入っているだけの別物まで
 *   拾うと、**普通の失敗で書き込みが止まる**(いちばん困る誤検出である)。
 * 🔑 だから sqlite が破損のときだけ出す綴りに絞る:
 *   - `SQLITE_CORRUPT` / `code 11`(result code 11 = SQLITE_CORRUPT)
 *   - `database disk image is malformed`(その既定の文言)
 *   - `file is not a database` / `malformed database schema`
 */
export function looksCorrupt(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('sqlite_corrupt') ||
    m.includes('disk image is malformed') ||
    m.includes('malformed database schema') ||
    m.includes('file is not a database') ||
    /\bcode\s*11\b/.test(m)
  );
}

/**
 * 🔴 **壊れている間、断る op**(= 保存されている中身を書き換えるもの)。
 *
 * ⚠ **読む op は 1 つも入れない** ── 入れると持ち出せなくなる。
 * ⚠ `init` / `openContainer` / `close` も入れない ── これが通らないと
 *   **アプリが起動せず、画面に理由すら出せない**。
 *
 * 🔑 **全数であることは test が守る**(`tests/features/db-corruption.test.ts`)──
 *   protocol の op を 1 つ足した人は、どちらかへ入れるまで落ちる。
 *   ⚠ 手で並べた一覧は、**次に足した人が数え落とす**(CLAUDE.md §7)。
 */
export const CORRUPT_BLOCKED_OPS: readonly string[] = [
  'upsertEntry',
  'bulkUpsertEntries',
  'renameEntry',
  'reorderEntry',
  'deleteEntry',
  'setEntryParent',
  'bulkUpsertRelations',
  'deleteRelation',
  'purgeTrash',
  'putAssetMeta',
  'deleteAssetMeta',
  'replaceAssetRefs',
  'importRevisionChains',
  'restoreRevisionChains',
];

/**
 * 🔴 **断るときに画面へ出す字**。
 *
 * ⚠ **記法を書かない**(素のテキストとして出る面がある)。
 * ⚠ **鍵の綴りを書かない**(スマホに `F5` は無い)。
 * 🔑 **次の一手を必ず 1 つ書く** ── 「壊れました」だけでは user は何もできない。
 *
 * 🔴 **2026-09-17(#986 段③)に、案内する先を替えた**(動線レビューが出した)。
 * ⚠ 直す前はここが **生の SQL を書かせる迂回路**だけを案内していた ──
 *   しかも押させる字が「**答えをファイルへ**」で、画面の実物は「**ファイルへ**」
 *   (`sql.ts`)なので、**3 文字だけ多い名前を探させていた**(#996 と同じ型)。
 * 🔴 **2026-09-18(#1006)に、先頭の一手を替えた** ── 直す前は 3 手
 *   (「拾って書き出す」→「中身を捨てる」→「取り込む」)を案内していたが、
 *   ⚠ **壊れているのは入れ物の側なのに、中身を捨てさせる**手順だった(user 裁定)。
 *   🔑 いまは **1 押しで済む「中身を残して、作り直す」**を先に案内し、
 *   3 手の道は**それでも直らないとき**の副えにした ── ⚠ **消していない**。
 * 🔑 いまは **その人のために作った画面**を先に案内し、SQL は
 *   「自分の目で見たいだけなら」の**副え**にした ── ⚠ 消していない
 *   (CLAUDE.md「記法を減らすことは、user の動線を減らすことである」の向き)。
 * ⚠ ここに書く**ボタンの字は、画面から引いて突き合わせる**
 *   (`tests/features/db-corruption.test.ts`)── 手で書くと、改名した日に
 *   **両方そのままで緑**になる。
 */
export const CORRUPT_REFUSAL =
  '保存されている中身の一部が壊れています。これ以上書き込むと壊れ方が広がるので、' +
  '書き込みだけ止めました。読むことはできます ── ' +
  `設定 の 書き出しと片づけ にある「${CONTAINER_REBUILD_LABEL}」を押してください。` +
  '読めるノートをファイルへ書き出してから入れ物を作り直し、そのまま戻します(添付は触りません)。' +
  `それでも直らないときは、「${RESCUE_ARCHIVE_LABEL}」で取り出してから` +
  `「${CONTAINER_RESET_LABEL}」でまっさらにして、左の列の「取り込む」で戻してください。` +
  '中身を自分の目で見たいだけなら、「SQL で調べる」の面からも取り出せます。';

/**
 * 壊れていると分かった回に、**元の字を残したまま**読める形にする。
 * ⚠ 元の字を捨てない ── 切り分けに要る(どの op のどこで出たか)。
 */
export function corruptReport(op: string, raw: string): string {
  return `${CORRUPT_REFUSAL}(${op} で検出: ${raw})`;
}

/**
 * 🔴 **この op の error は「うちの DB」の話ではない**(#971。書いている最中に見つけた穴)。
 *
 * ⚠ `openSqlGuest` は **user が取り込んだ file** を開く口である ── 壊れた `.sqlite` を
 *   1 つ選んだだけで `file is not a database` が出る。
 * 🔴 それを「うちの DB が壊れた」と読むと、**本体への書き込みが全部止まる** ──
 *   user は何も壊していないのに、**ノートを保存できなくなる**。
 * 🔑 だから**客の file を触る口は、判定から外す**。
 */
const GUEST_OPS: readonly string[] = ['openSqlGuest', 'closeSqlGuest'];

/**
 * 🔴 **この error で「うちの DB が壊れた」と決めてよいか**。
 *
 * @param op    いま走らせていた op
 * @param guest その op が**客の DB**へ向いていたか(`runReadOnlySql` は両方へ向く)
 * @param raw   engine が出した字
 *
 * 🔑 判定は 2 段:**①うちの DB の話か ②壊れの綴りか**。
 *   ⚠ ②だけで決めると、客の file の破損を**うちの破損として扱う**(上の穴)。
 */
export function shouldFlagCorrupt(op: string, guest: boolean, raw: string): boolean {
  if (GUEST_OPS.includes(op)) return false;
  if (guest) return false;
  return looksCorrupt(raw);
}
