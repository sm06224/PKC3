/**
 * 🔴 **2 ペインで「移す」を押した直後の「元に戻す」**(Gemini 裁定 = #1163 への依頼 62 の 4)。
 *
 * 移した直後に、画面の下の知らせの行へ「3 件を「会議」へ入れました」と、その隣の **元に戻す** を数秒出す
 * (置き場はゴミ箱へ移した直後・予定を動かした直後と同じ `status-undo`。新しい器を作らない ── 作りは `trash-undo.ts` と同じ)。
 *
 * ## 出し入れ
 *
 * | 場面 | 起きること |
 * |---|---|
 * | 移した(1 件でも動いた回) | 知らせと「元に戻す」を出す |
 * | 数秒経つ(`DUAL_MOVE_OFFER_MS`) | 知らせごと降ろす |
 * | 次の知らせが来た | 字が変わるので「元に戻す」だけ畳む(`status-open.ts` の作法) |
 * | 次に移した | 置き換わる(戻せるのは直前の 1 回) |
 *
 * ## 戻し方
 *
 * 新しい書込経路は作らない。動いた物 1 件ごとに、動かす前の場所へ向けた `SET_ENTRY_PARENT` を撃つ(`binder.ts` の `undo-dual-move`)。
 * ⚠ 移した後に別の場所へ動かした物は戻さない(いまの場所が「移した先」の物だけ)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';

/** 「元に戻す」を出しておく長さ(ms)。⚠ ゴミ箱の `TRASH_OFFER_MS` と同じ。 */
export const DUAL_MOVE_OFFER_MS = 7000;

/** 動いた 1 件。`from` / `to` は親フォルダの ID(`null` = ルート)。 */
export interface DualMove {
  readonly lid: string;
  readonly from: string | null;
  readonly to: string | null;
}

interface Pending {
  readonly moves: readonly DualMove[];
  readonly message: string;
  readonly dispatcher: Dispatcher;
  timer: ReturnType<typeof setTimeout> | null;
}

let pending: Pending | null = null;

/** 持っている物を捨て、知らせがまだ載っていれば降ろす。 */
export function clearDualMoveOffer(): void {
  const p = pending;
  pending = null;
  if (p === null) return;
  if (p.timer !== null) clearTimeout(p.timer);
  if (p.dispatcher.getState().notice === p.message)
    p.dispatcher.dispatch({ type: 'NOTICE_EXPIRED', message: p.message });
}

/** 画面の下の「元に戻す」を出してよいか(いま出ている知らせがこの 1 手の知らせそのものか)。 */
export function dualMoveUndoShown(shownLine: string): boolean {
  return pending !== null && pending.message === shownLine;
}

/** 持っている物(test の観測点)。 */
export function currentDualMoveOffer(): {
  readonly moves: readonly DualMove[];
  readonly message: string;
} | null {
  return pending === null ? null : { moves: pending.moves, message: pending.message };
}

/**
 * 移した直後に呼ぶ。⚠ 動いた件が 0 のときは出さない。
 * 知らせは `OP_NOTICE` で出す(メッセージ一覧にも積まれる)。
 */
export function offerDualMoveUndo(
  dispatcher: Dispatcher,
  moves: readonly DualMove[],
  message: string,
): void {
  if (moves.length === 0) return;
  clearDualMoveOffer();
  const p: Pending = { moves, message, dispatcher, timer: null };
  pending = p;
  p.timer = setTimeout(() => {
    if (pending === p) clearDualMoveOffer();
  }, DUAL_MOVE_OFFER_MS);
  dispatcher.dispatch({ type: 'OP_NOTICE', message });
}

/** 「元に戻す」の本体。戻す対象を返し、持っている物を忘れる(撃つのは呼び側)。無ければ `null`。 */
export function takeDualMoveUndo(): readonly DualMove[] | null {
  const p = pending;
  if (p === null) return null;
  pending = null;
  if (p.timer !== null) clearTimeout(p.timer);
  return p.moves;
}
