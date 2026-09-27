/**
 * 🔴 **本文へ書ける状態になるまで預かる**(#413 で作り、#279 で共有にした)。
 *
 * ## なぜ要るか
 *
 * 本文を触る action(`CREATE_ENTRY` / `APPEND_TO_ENTRY`)は、編集中・書込中に
 * **断る**(`app-state.ts`。`CREATE_ENTRY` は黙って、`APPEND_TO_ENTRY` は #1051 から
 * 理由を出して)。
 *
 * ⚠ そこで断られると、**録った物・計った時間が丸ごと消える**(理由が出ても、
 *   録り直せない物は戻らない)。
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
import { bodyWriteBlockReason } from '@adapter/state/app-state';
import type { Dispatcher } from '@adapter/state/dispatcher';

export interface WritableQueue {
  /**
   * 書ける状態なら**その場で**、そうでなければ**書けるようになってから**走らせる。
   * ⚠ 戻り値は「預かったか」── 呼び側は預かった旨を user に言う。
   *
   * @param lid 書き先のノート(#1081)。渡すと「**そのノートに**書けるか」で見る ──
   *   編集中でも、書き先が編集中のノートと別なら待たせない。⚠ 渡さない依頼(ノートを
   *   作る物など)は、これまでどおり読む画面に戻るまで待つ。
   */
  push(run: () => void | Promise<void>, lid?: string): boolean;
  /** いま預かっている件数(test の観測点)。 */
  size(): number;
}

/**
 * いま本文を書けるか。⚠ **判定はここ 1 か所**(呼び側で `phase` を数えない)。
 *
 * 🔴 **書き先が分かっているなら、そのノートで見る**(#1081。user 裁定 2026-09-27「推奨で」)。
 * ⚠ 直す前は書き先を見ずに `phase === 'ready'` を求めていた ── ノート A の編集中は、
 *   **A と無関係なノート B への書込まで**編集を終えるまで待たされていた(タイマーの記録)。
 *   reducer の側(`APPEND_TO_ENTRY` の `bodyWriteBlockReason`)は #1051 から別のノートを
 *   通すので、ここだけが揃っていなかった。
 * ⚠ 書込中(`writeLock`)は書き先に関わらず待つ ── reducer が 2 通目を断るので(同時に 1 本)。
 * ⚠ 書き先の無い判定(`lid` を渡さない)は**これまでどおり** ── ノートを作る物
 *   (`CREATE_ENTRY`)は編集中に通らないので、読む画面に戻るまで待つしかない。
 */
export function canWriteBody(dispatcher: Dispatcher, lid?: string): boolean {
  const s = dispatcher.getState();
  if (s.writeLock !== null) return false;
  if (lid === undefined) return s.phase === 'ready';
  return bodyWriteBlockReason(s, lid) === null;
}

/**
 * 2 つの預かりの**順番を守る必要があるか**。
 * 🔑 同じノートへ書く物どうしは、預けた順に入らないと本文の並びが食い違う。
 *   ⚠ 書き先の分からない物は、どれとも順番を守る(これまでどおり)。
 */
function mustKeepOrder(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}

/**
 * 🔴 **書けるようになるまでに、この本文が変わってしまうか**(#684 ㋑、着地前レビュー 重大 ②)。
 *
 * ⚠ 「いま書けない」(`canWriteBody`)と「**この本文が変わる**」は別の問いである。
 *   直す前は前者だけを見て**落とした所を捨てて**いたので、
 *   **編集していないノート**(横に留めた枠)へ落としても位置が捨てられ、
 *   線を出した所ではなく**いちばん下**へ入っていた ── 線が守れない約束になる。
 * 🔑 位置を捨てるべきなのは、待っている間に**その本文自身**が書き換わるときだけ:
 *   ①いま編集しているのがそのノート ②その本文への書込が錠を握っている。
 * ⚠ どちらでもなければ、待っても本文は動かない ── しかも書く直前に
 *   **目印(`InsertAnchor`)で突き合わせる**ので、万一動いていれば断る側に倒れる。
 */
export function bodyWillChange(dispatcher: Dispatcher, lid: string): boolean {
  const s = dispatcher.getState();
  if (s.phase === 'editing' && s.openBody?.lid === lid) return true;
  return s.writeLock !== null && s.writeLock.lid === lid;
}

export function createWritableQueue(dispatcher: Dispatcher): WritableQueue {
  const pending: Array<{ readonly run: () => void | Promise<void>; readonly lid: string | undefined }> = [];
  let unwatch: (() => void) | null = null;

  /**
   * いま走らせてよい預かりの位置(無ければ `-1`)。
   * 🔑 **書けて、かつ前に順番を守るべき預かりが居ない**物のうち、いちばん前(#1081)。
   *   ⚠ 書き先を渡さない物だけのときは、先頭が書けるかだけを見る形になる(これまでどおり)。
   */
  const runnableIndex = (): number => {
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i]!;
      if (pending.slice(0, i).some((p) => mustKeepOrder(p.lid, item.lid))) continue;
      if (canWriteBody(dispatcher, item.lid)) return i;
    }
    return -1;
  };

  /** 書けるようになるまで待つ(見張りは 1 本だけ)。 */
  const watch = (): void => {
    if (unwatch !== null) return;
    unwatch = dispatcher.onState(() => {
      if (runnableIndex() < 0) return;
      unwatch?.();
      unwatch = null;
      pump();
    });
  };

  /**
   * 🔴 **1 本ずつ流す**(#666 の着地前レビュー D2。`writable-queue.test.ts` が pin)。
   *
   * ⚠ 直す前は預かりを**まとめて**流していた(`splice` して `for` で回す)が、
   *   `APPEND_TO_ENTRY` は **`writeLock` が立っている間の要求を断る**
   *   (`app-state.ts`「書込中の二重要求も断る」。当時は黙って捨てていた)。1 本目が立てた錠が解けるのは
   *   **worker の ack が返ったとき**なので、**microtask 1 つでは絶対に解けない** ──
   *   つまり **2 本目以降は必ず捨てられ**、しかも呼び側は「本文に入れました」と言う。
   * ⚠ 実際に起きる形:写真を **3 枚**まとめて落とすと **3 枚目が消える**
   *   (1 枚目は即時、2・3 枚目が預かりへ積まれ、解けた瞬間に 2 本流れる)。
   */
  const pump = (): void => {
    if (pending.length === 0) return;
    // ⚠ **1 段ずらす**(下の docstring)── 見張りの中で撃つと、その書込は
    //    まだ state に入っていない
    queueMicrotask(async () => {
      // ⚠ **走らせる直前にもう一度見る** ── ずらした 1 段の間に錠が立つことがある
      //    (別の経路の追記・保存)。そこで撃つと reducer に捨てられる
      const at = runnableIndex();
      if (at < 0) {
        watch();
        return;
      }
      /**
       * 🔴 **掴むのは門を通ってから**(#666 の着地前レビュー 7)。
       * ⚠ 1 稿目は `pending[0]` を **microtask の外**で読み、`shift()` を中でして
       *   いた ── `pump()` が 2 本飛ぶと**両方が同じ 1 本を掴んで両方 `shift()` する**
       *   ので、同じ預かりが 2 回走り、次の 1 本が**黙って落ちる**
       *   (実物の module に当てて再現:走った順が `A,B,B`)。
       * 🔑 掴みと取り出しを**1 手**にすれば、2 本飛んでも取り合いにならない。
       */
      const [item] = pending.splice(at, 1);
      if (item === undefined) return;
      await item.run();
      // ⚠ 残りは**また書けるようになってから** ── ここで続けて流すと元の穴に戻る
      if (pending.length === 0) return;
      if (runnableIndex() < 0) {
        watch();
        return;
      }
      // ⚠ **見張りを畳んでから次を撃つ** ── 畳まないと、`await` の最中に
      //    `push` が張った見張りが生き残り、`pump()` が 2 本飛ぶ
      unwatch?.();
      unwatch = null;
      pump();
    });
  };

  return {
    push(run, lid) {
      // ⚠ **順番を守るべき預かりが在る間は割り込ませない** ── 割り込むと、落とした順と
      //    本文の並びが食い違う(3 枚落として 2 枚目が末尾に着く)。🔑 書き先が**別の
      //    ノート**の預かりは追い越してよい(#1081 ── 並びが食い違う相手が居ない)
      if (!pending.some((p) => mustKeepOrder(p.lid, lid)) && canWriteBody(dispatcher, lid)) {
        void run();
        return false;
      }
      // ⚠ **積む**(1 枠にしない)── 編集の最中に 2 本目が終わることがあり、
      //    1 枠だと**先に預かったほうが黙って消える**
      pending.push({ run, lid });
      watch();
      return true;
    },
    size: () => pending.length,
  };
}
