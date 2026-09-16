/**
 * 🔴 **手持ちのファイルを、SQL の面で開くための控え**(#854 段②)。
 *
 * ## なぜ控えが要るか
 *
 * `SET_SQL_SOURCE { lid, name }` → `REQUEST_SQL_GUEST_OPEN` は**この lid の
 * bytes をどこかから取ってくる**前提の配線である(添付なら `getBody` → 添付の
 * asset key → IDB)。手持ちのファイルには**ノートも添付も無い**ので、
 * `<input type=file>` で選んだ `File` を、合成の lid をキーに控え、
 * `store-effects.ts` がそれを読む。
 *
 * ## ⚠ 憶えない(user 裁定 2026-09-12)
 *
 * ここに置くのは「その file を選んでいる間」だけの控えであって、永続化ではない。
 * 「毎回選び直す」を機械的に守るため、ここは**never persist**(localStorage も
 * IDB も触らない)── 控えは JS heap 上の `Map` のみで、リロードすれば消える。
 *
 * ## 🔴 **読んでも消さない**(#682 段④c で直した)
 *
 * ⚠ 直す前は `takeSqlLocalFileBytes` が**読んだ瞬間に控えを捨てて**いた。
 *   その形で成り立っていたのは「**読むのは 1 回きり**」という前提だが、
 *   🔴 **#682 段② で DuckDB が 2 人目の読み手になった時点で崩れていた**:
 *
 *   | いつ | 誰が読むか | 直す前の結果 |
 *   |---|---|---|
 *   | 相手を選んだ直後 | `REQUEST_SQL_GUEST_OPEN` | 🟢 読める(そして控えが消える) |
 *   | 「走らせる」を押した | `DuckDbRunner.load` | 🔴 **`null`** =「…の中身を読めませんでした」 |
 *
 *   ⚠ つまり **手持ちの `.csv` を DuckDB で引く道は、配った日から 1 度も
 *   通っていなかった**(実測 2026-09-16。`registerSqlLocalFile` → 2 回読んで
 *   2 回目が `null` になることを unit で確かめた)。
 *   ⚠ DuckDB は器を畳んだ後に起こし直すと**また読む**ので、
 *   「1 回だけなら合っている」でもない ── **読む回数は決まっていない**。
 *
 * 🔑 だから終端を「**読んだとき**」から「**その file を選ぶのをやめたとき**」へ
 *   移した(`releaseSqlLocalFile`)。⚠ 不可侵指示 2026-07-27(生成物の
 *   ライフサイクル終端での即破棄)と矛盾しない ── **heap に載るのは
 *   `Uint8Array` のほうで、それはどの読み手も控えない**。ここが握るのは
 *   `File`(= disk 上の file への手)だけである。
 */
import { SQL_LOCAL_FILE_LID_PREFIX } from '@features/query/sql-local-file';

let counter = 0;
const pending = new Map<string, File>();

/**
 * 選んだ file を控え、`SET_SQL_SOURCE` へ渡す合成 lid を返す。
 * ⚠ **本物の lid と衝突しない**(`generateLid()` はコロンを含まない ── 頭に
 *   `SQL_LOCAL_FILE_LID_PREFIX` を付ければ機械的に別物になる)。
 */
export function registerSqlLocalFile(file: File): string {
  /**
   * 🔴 **控えは常に 1 つだけ**(着地前の検算で見つけた穴)。
   *
   * 🔑 選び所は**一度に 1 つしか選べない**ので、控える前に**前の物を捨てる**だけで
   *   上限が 1 に閉じる ── 断られた回も、次に選んだ瞬間に返る。
   * ⚠ 上の「読んでも消さない」に変えた後は、**ここと `releaseSqlLocalFile` が
   *   唯一の終端**である(だから両方を test で pin する)。
   */
  pending.clear();
  counter += 1;
  const lid = `${SQL_LOCAL_FILE_LID_PREFIX}${Date.now().toString(36)}-${counter.toString(36)}`;
  pending.set(lid, file);
  return lid;
}

/**
 * 控えた file を bytes にして返す。⚠ **控えは消さない**(この file の上の節)。
 *
 * ⚠ 別の file を選び直した / 面を閉じた後は `null`(呼び側は「読めなかった」として断る)。
 * ⚠ **重い読み込みはここで終わる** ── `File.arrayBuffer()` はブラウザが main
 *   スレッドを塞がずに読む(IDB の blob を読む `readAssetBytes` と同じ形)。
 *   sqlite の中身の解析・CSV の組み立てはこの先(worker)で行う ──
 *   不可侵指示「重い処理はワーカーへ」はそちらで満たす。
 */
export async function readSqlLocalFileBytes(lid: string): Promise<Uint8Array | null> {
  const file = pending.get(lid);
  if (file === undefined) return null;
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * 🔴 **中身を読まずに大きさだけ返す**(#682 段④c)。
 *
 * 🔑 DuckDB でしか読めない相手(`.parquet` / `.json`)は、開く時点では
 *   **1 バイトも読まない** ── それでも画面には「◯◯ を調べています(… / 1.2 MB)」と
 *   出したいので、大きさだけを別に採る。
 * ⚠ 添付の側は本文の `attachment.size`(`store-effects.ts`)── どちらも
 *   **bytes を heap へ載せない**という同じ規律である。
 */
export function sqlLocalFileSize(lid: string): number | null {
  return pending.get(lid)?.size ?? null;
}

/**
 * 控えを捨てる。⚠ **終端はここ 1 か所**(と、選び直したときの `registerSqlLocalFile`)。
 * 🔑 呼ぶのは「相手を選ぶのをやめたとき」= `REQUEST_SQL_GUEST_CLOSE`。
 *
 * 🔴 **lid を取る。** ⚠ 引数を取らずに全部消す形にすると、手持ちのファイルを
 *   選び直した瞬間に**いま控えたばかりの file が消える** ── `SET_SQL_SOURCE` は
 *   `CLOSE`(前の相手)→ `OPEN`(新しい相手)の順に出すので、
 *   「全部消す」は**未来の相手まで巻き込む**。
 * @param lid 手放す控えの lid。⚠ いま控えている物と違えば**何もしない**。
 */
export function releaseSqlLocalFile(lid: string): void {
  pending.delete(lid);
}
