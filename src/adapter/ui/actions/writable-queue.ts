/**
 * 🔴 **本文へ書ける状態になるまで預かる**(#413 で作り、#279 で共有にした)。
 *
 * ## なぜ要るか
 *
 * 本文を触る action(`CREATE_ENTRY` / `APPEND_TO_ENTRY`)は、
 * **`phase !== 'ready'` を黙って捨てる**(`app-state.ts`)。つまり
 * **編集している最中は 1 文字も書けない**。
 *
 * ⚠ そこで捨てると、**録った物・計った時間が丸ごと消えて、しかも何も言わない**。
 * 🔑 だから「書けないから失敗」ではなく「**書けるようになるまで預かる**」。
 *
 * ## ⚠ 1 段ずらす理由(`queueMicrotask`)
 *
 * `Dispatcher` は **listener の中から撃った dispatch をキューに積む**
 * (`draining` の間は `pending` へ回る)。見張りの中でそのまま書くと、
 * その書込は**まだ state に入っていない** ── 書けているのに
 * 「書けなかった」と読む(#413 の変異試験 Q3 が pin している)。
 *
 * ## ⚠ 常駐を作らない
 *
 * 見張りは**預かりが在る間だけ 1 本**張る。張りっぱなしにすると以後の全 dispatch が
 * ここを通る。⚠ **2 本張らない** ── 同じ預かりを 2 回流すことになる。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';

export interface WritableQueue {
  /**
   * 書ける状態なら**その場で**、そうでなければ**書けるようになってから**走らせる。
   * ⚠ 戻り値は「預かったか」── 呼び側は預かった旨を user に言う。
   */
  push(run: () => void | Promise<void>): boolean;
  /** いま預かっている件数(test の観測点)。 */
  size(): number;
}

/** いま本文を書けるか。⚠ **判定はここ 1 か所**(呼び側で `phase` を数えない)。 */
export function canWriteBody(dispatcher: Dispatcher): boolean {
  const s = dispatcher.getState();
  return s.phase === 'ready' && s.writeLock === null;
}

export function createWritableQueue(dispatcher: Dispatcher): WritableQueue {
  const pending: Array<() => void | Promise<void>> = [];
  let unwatch: (() => void) | null = null;

  const drain = (): void => {
    // ⚠ **取り出してから走らせる** ── 走らせている間に 2 本目が積まれても、
    //    同じ 1 本を 2 回流さない
    const taken = pending.splice(0, pending.length);
    queueMicrotask(async () => {
      for (const run of taken) await run();
    });
  };

  return {
    push(run) {
      if (canWriteBody(dispatcher)) {
        void run();
        return false;
      }
      // ⚠ **積む**(1 枠にしない)── 編集の最中に 2 本目が終わることがあり、
      //    1 枠だと**先に預かったほうが黙って消える**
      pending.push(run);
      if (unwatch !== null) return true;
      unwatch = dispatcher.onState(() => {
        if (!canWriteBody(dispatcher)) return;
        unwatch?.();
        unwatch = null;
        drain();
      });
      return true;
    },
    size: () => pending.length,
  };
}
