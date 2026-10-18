/**
 * 🔴 **スタックを全部降ろした直後の「元に戻す」**(依頼 98-2。Gemini の回答「推薦どおり」= A)。
 *
 * 「スタックを全部降ろす」(Alt+Shift+D)は、確かめも「元に戻す」も無く、最大 20 件の並びが消えていた。
 * 並びを残すには先に「スタックを保存…」を押しておく必要があるが、その案内も無かった。
 * 降ろした直後に、画面の下の知らせの行へ「スタックから N 件を降ろしました」と、その隣の **元に戻す** を数秒出す
 * (置き場はゴミ箱へ移した直後・2 ペインで移した直後と同じ `status-undo`。新しい器を作らない ── 作りは `rename-undo.ts` と同じ)。
 *
 * ## 出し入れ
 *
 * | 場面 | 起きること |
 * |---|---|
 * | 1 件以上降ろした | 知らせと「元に戻す」を出す(知らせに「保存するときは『スタックを保存…』」も添える) |
 * | 数秒経つ(`STACK_OFFER_MS`) | 知らせごと降ろす |
 * | 次の知らせが来た | 字が変わるので「元に戻す」だけ畳む(`status-open.ts` の作法) |
 * | 次に降ろした | 置き換わる(戻せるのは直前の 1 回) |
 *
 * ## 戻し方
 *
 * 新しい書込経路は作らない(スタックは画面の状態で、ノートは書かない)。降ろす前の並びを、下から順に `PIN_SPLIT_ENTRY` で載せ直す
 * (載せたものが一番上に来る規則なので、元の順に戻る)。⚠ 降ろした後に載せ直していた分は、元の並びの上に積まれる。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';

/** 「元に戻す」を出しておく長さ(ms)。⚠ ゴミ箱の `TRASH_OFFER_MS` と同じ。 */
export const STACK_OFFER_MS = 7000;

interface Pending {
  readonly lids: readonly string[];
  readonly message: string;
  readonly dispatcher: Dispatcher;
  timer: ReturnType<typeof setTimeout> | null;
}

let pending: Pending | null = null;

/** 持っている物を捨て、知らせがまだ載っていれば降ろす。 */
export function clearStackOffer(): void {
  const p = pending;
  pending = null;
  if (p === null) return;
  if (p.timer !== null) clearTimeout(p.timer);
  if (p.dispatcher.getState().notice === p.message)
    p.dispatcher.dispatch({ type: 'NOTICE_EXPIRED', message: p.message });
}

/** 画面の下の「元に戻す」を出してよいか(いま出ている知らせがこの 1 手の知らせそのものか)。 */
export function stackUndoShown(shownLine: string): boolean {
  return pending !== null && pending.message === shownLine;
}

/** 持っている物(test の観測点)。 */
export function currentStackOffer(): { readonly lids: readonly string[]; readonly message: string } | null {
  return pending === null ? null : { lids: pending.lids, message: pending.message };
}

/**
 * 全部降ろした直後に呼ぶ。`lids` は降ろす前の並び(上から)。⚠ 0 件のときは出さない。
 * 知らせは `OP_NOTICE` で出す(メッセージ一覧にも積まれる)。
 */
export function offerStackClearUndo(dispatcher: Dispatcher, lids: readonly string[]): void {
  if (lids.length === 0) return;
  clearStackOffer();
  const message = `スタックから ${String(lids.length)} 件を降ろしました(ノートは消えていません。並びを残すときは先に「スタックを保存…」を押します)`;
  const p: Pending = { lids: [...lids], message, dispatcher, timer: null };
  pending = p;
  p.timer = setTimeout(() => {
    if (pending === p) clearStackOffer();
  }, STACK_OFFER_MS);
  dispatcher.dispatch({ type: 'OP_NOTICE', message });
}

/** 「元に戻す」の本体。降ろす前の並びを返し、持っている物を忘れる(載せ直すのは呼び側)。無ければ `null`。 */
export function takeStackUndo(): readonly string[] | null {
  const p = pending;
  if (p === null) return null;
  pending = null;
  if (p.timer !== null) clearTimeout(p.timer);
  return p.lids;
}
