/**
 * 🔴 **手持ちのファイルを、SQL の面で開くための使い捨ての控え**(#854 段②)。
 *
 * ## なぜ控えが要るか
 *
 * `SET_SQL_SOURCE { lid, name }` → `REQUEST_SQL_GUEST_OPEN` は**この lid の
 * bytes をどこかから取ってくる**前提の配線である(添付なら `getBody` → 添付の
 * asset key → IDB)。手持ちのファイルには**ノートも添付も無い**ので、
 * `<input type=file>` で選んだ `File` を、合成の lid をキーに一時だけ控え、
 * `store-effects.ts` がそれを読んで消費する。
 *
 * ## ⚠ 憶えない(user 裁定 2026-09-12)
 *
 * ここに置くのは「選んでから読まれるまでの一瞬」だけの控えであって、
 * 永続化ではない。**読んだら(成功でも失敗でも)即座に消す**
 * (不可侵指示 2026-07-27「生成とライフサイクル後の速やかな破棄」)。
 * ⚠ 「毎回選び直す」を機械的に守るため、ここは**never persist**(localStorage も
 * IDB も触らない)── 控えは JS heap 上の `Map` のみで、リロードすれば消える。
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
   * ⚠ 下の `takeSqlLocalFileBytes` は「読んだら消す」が、**読まれない道が在る** ──
   *   古い worker(`openSqlGuest` を持たない)では上流の門が先に断るので、
   *   控えた `File` が**誰にも読まれないまま残る**。⚠ 選び直すたびに 1 つずつ
   *   積み上がるので、これは「ライフサイクル終端での即破棄」(不可侵指示
   *   2026-07-27)を静かに破る形である。
   * 🔑 選び所は**一度に 1 つしか選べない**ので、控える前に**前の物を捨てる**だけで
   *   上限が 1 に閉じる ── 断られた回も、次に選んだ瞬間に返る。
   */
  pending.clear();
  counter += 1;
  const lid = `${SQL_LOCAL_FILE_LID_PREFIX}${Date.now().toString(36)}-${counter.toString(36)}`;
  pending.set(lid, file);
  return lid;
}

/**
 * 控えた file を bytes にして返す。
 *
 * ⚠ **読んだら控えを消す**(即破棄)── 2 度読まれる・別の lid で選び直された等で
 *   無ければ `null`(呼び側は「読めなかった」として断る)。
 * ⚠ **重い読み込みはここで終わる** ── `File.arrayBuffer()` はブラウザが main
 *   スレッドを塞がずに読む(IDB の blob を読む `readAssetBytes` と同じ形)。
 *   sqlite の中身の解析・CSV の組み立てはこの先(worker)で行う ──
 *   不可侵指示「重い処理はワーカーへ」はそちらで満たす。
 */
export async function takeSqlLocalFileBytes(lid: string): Promise<Uint8Array | null> {
  const file = pending.get(lid);
  if (file === undefined) return null;
  pending.delete(lid);
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}
