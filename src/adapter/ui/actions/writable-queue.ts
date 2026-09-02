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

  /** 書けるようになるまで待つ(見張りは 1 本だけ)。 */
  const watch = (): void => {
    if (unwatch !== null) return;
    unwatch = dispatcher.onState(() => {
      if (!canWriteBody(dispatcher)) return;
      unwatch?.();
      unwatch = null;
      pump();
    });
  };

  /**
   * 🔴 **1 本ずつ流す**(#666 の着地前レビュー D2。`writable-queue.test.ts` が pin)。
   *
   * ⚠ 直す前は預かりを**まとめて**流していた(`splice` して `for` で回す)が、
   *   `APPEND_TO_ENTRY` は **`writeLock` が立っている間の要求を黙って捨てる**
   *   (`app-state.ts`「書込中の二重要求も断る」)。1 本目が立てた錠が解けるのは
   *   **worker の ack が返ったとき**なので、**microtask 1 つでは絶対に解けない** ──
   *   つまり **2 本目以降は必ず捨てられ**、しかも呼び側は「本文に入れました」と言う。
   * ⚠ 実際に起きる形:写真を **3 枚**まとめて落とすと **3 枚目が消える**
   *   (1 枚目は即時、2・3 枚目が預かりへ積まれ、解けた瞬間に 2 本流れる)。
   */
  const pump = (): void => {
    const run = pending[0];
    if (run === undefined) return;
    // ⚠ **1 段ずらす**(下の docstring)── 見張りの中で撃つと、その書込は
    //    まだ state に入っていない
    queueMicrotask(async () => {
      // ⚠ **走らせる直前にもう一度見る** ── ずらした 1 段の間に錠が立つことがある
      //    (別の経路の追記・保存)。そこで撃つと reducer に捨てられる
      if (!canWriteBody(dispatcher)) {
        watch();
        return;
      }
      pending.shift();
      await run();
      // ⚠ 残りは**また書けるようになってから** ── ここで続けて流すと元の穴に戻る
      if (pending.length > 0) {
        if (canWriteBody(dispatcher)) pump();
        else watch();
      }
    });
  };

  return {
    push(run) {
      // ⚠ **預かりが在る間は割り込ませない** ── 割り込むと、落とした順と
      //    本文の並びが食い違う(3 枚落として 2 枚目が末尾に着く)
      if (pending.length === 0 && canWriteBody(dispatcher)) {
        void run();
        return false;
      }
      // ⚠ **積む**(1 枠にしない)── 編集の最中に 2 本目が終わることがあり、
      //    1 枠だと**先に預かったほうが黙って消える**
      pending.push(run);
      watch();
      return true;
    },
    size: () => pending.length,
  };
}
