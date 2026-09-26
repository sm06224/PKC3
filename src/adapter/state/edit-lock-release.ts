/**
 * 編集ロックの解放を phase の遷移 1 か所で束ねる(#177 多重タブ)。
 *
 * editing を離れる経路は 7 つある(app-state.ts:145 の明記 ── COMMIT / CANCEL /
 * FORCE_RELEASE / SYS_BOOTED ほか)。経路ごとに releaseEdit を書くと必ず 1 つ漏れ、
 * 漏れた経路だけ**別タブから永久に編集できないノート**が生まれる ── だから
 * 「editing に居る間は対象を控え、離れた瞬間に返す」の 1 か所で守る。
 *
 * 🔴 **章の欄も同じ 1 か所で守る**(#1044 段2、F-B)。⚠ 章の欄は `phase` を
 *   `ready` のまま保つので(#1044 段2 設計)、`phase === 'editing'` だけを見ていると
 *   **章の欄が閉じてもロックが返らない** ── `sectionDraft` が system command で
 *   閉じる経路(F-A の `guardSectionDraftTransition`)は握っている `services` を
 *   知らないので、そこで返さないと**そのノートが誰からも編集できなくなる**。
 *
 * 🔴 main.ts の closure に書かない(CLAUDE.md 2026-08-08 ── どの test からも
 * 実行されない file に判断を書くと、全 tests 緑のまま取り違える)。
 */
import { unsavedTypingLidOf } from './app-state';
import type { Dispatcher } from './dispatcher';

export interface EditLockSync {
  releaseEdit(cid: string, lid: string): void;
}

/**
 * @param sync 呼ぶたびに読む(#177 の昇格で実体が host に替わるため、
 *             instance を閉じ込めると**古い方へ返し続ける**)
 * @returns 購読解除
 */
export function bindEditLockRelease(
  dispatcher: Dispatcher,
  sync: () => EditLockSync,
  cid: string,
): () => void {
  let locked: string | null = null;
  return dispatcher.onState((state) => {
    // 🔴 **いま握っているべき lid**(#1044 段2、F-B/F-C)。全文編集と章の欄の
    //   **どちらか**が握る(`app-state.ts` の `unsavedTypingLidOf` 1 本 ──
    //   2 つ目の実装をここに作らない。§7)。
    const held = unsavedTypingLidOf(state);
    if (held !== null) {
      locked = held;
      return;
    }
    // ⚠ `phase === 'editing'` で `openBody` が一瞬 null の遷移でも控えを消さない
    //   (直す前と同じ作法 ── 章の欄には該当する窓が無い:`sectionDraft` は
    //   `OPEN_SECTION_DRAFT` が原子的に立て、閉じるときも原子的に `null` にする)
    if (state.phase === 'editing') return;
    if (locked !== null) {
      sync().releaseEdit(cid, locked);
      locked = null;
    }
  });
}
