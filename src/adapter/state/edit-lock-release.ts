/**
 * 編集ロックの解放を phase の遷移 1 か所で束ねる(#177 多重タブ)。
 *
 * editing を離れる経路は 7 つある(app-state.ts:145 の明記 ── COMMIT / CANCEL /
 * FORCE_RELEASE / SYS_BOOTED ほか)。経路ごとに releaseEdit を書くと必ず 1 つ漏れ、
 * 漏れた経路だけ**別タブから永久に編集できないノート**が生まれる ── だから
 * 「editing に居る間は対象を控え、離れた瞬間に返す」の 1 か所で守る。
 *
 * 🔴 main.ts の closure に書かない(CLAUDE.md 2026-08-08 ── どの test からも
 * 実行されない file に判断を書くと、全 tests 緑のまま取り違える)。
 */
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
    if (state.phase === 'editing') {
      // ⚠ openBody が一瞬 null の遷移でも控えを消さない(?? で保つ)
      locked = state.openBody?.lid ?? locked;
      return;
    }
    if (locked !== null) {
      sync().releaseEdit(cid, locked);
      locked = null;
    }
  });
}
