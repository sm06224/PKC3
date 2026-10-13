/**
 * 🔴 **ゴミ箱へ移した直後の「元に戻す」**(#1087 流れ 29。Gemini 裁定 = #1163 への依頼 29 の回答 Q3)。
 *
 * 行を消す操作は、確認のダイアログを出さずに実行する。代わりに画面の下の知らせの行へ
 * 「『題名』をゴミ箱へ移しました」/「3 件をゴミ箱へ移しました」と、その隣の **元に戻す** を数秒出す
 * (置き場は予定の「元に戻す」・塊の移動と同じ `status-undo`。新しい器を作らない)。
 *
 * ## 出し入れ
 *
 * | 場面 | 起きること |
 * |---|---|
 * | 移した | 知らせと「元に戻す」を出す |
 * | 数秒経つ(`TRASH_OFFER_MS`) | 知らせごと降ろす |
 * | 次の知らせが来た | 字が変わるので「元に戻す」だけ畳む(`status-open.ts` の作法) |
 * | 次に移した | 置き換わる(戻せるのは直前の 1 回) |
 *
 * ## 戻し方
 *
 * 新しい復元の経路は作らない。ゴミ箱の一覧の「戻す」と同じ `RESTORE_TRASH` を、移した全部に撃つ
 * (`UNDO_TRASH` → 効果層がゴミ箱の一覧から該当の履歴を引く)。⚠ 戻せるのは「ゴミ箱に在る」ものだけ
 * ── 空にされた / もう戻した分は黙って落とす(居ない物を復元しない)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';

/** 「元に戻す」を出しておく長さ(ms)。⚠ 予定の `MOVE_OFFER_MS` と同じ(画面下の知らせの寿命より少し長く)。 */
export const TRASH_OFFER_MS = 7000;

interface Pending {
  readonly lids: readonly string[];
  readonly message: string;
  readonly dispatcher: Dispatcher;
  timer: ReturnType<typeof setTimeout> | null;
}

let pending: Pending | null = null;

/**
 * 画面に出す 1 行。1 件は題名つき、複数は件数。
 * 🔴 **フォルダを移したら、中のノートがどうなったかも言う**(#1087 の見直し 2026-10-13)── 中のノートは
 *   ゴミ箱へは入らず、親を失ってルートに出る。言わないと「中身ごと消えた」と読まれる。
 */
export function trashMessage(titles: readonly string[], toRoot = 0): string {
  const head = titles.length === 1 ? `「${titles[0]}」をゴミ箱へ移しました` : `${String(titles.length)} 件をゴミ箱へ移しました`;
  return toRoot > 0 ? `${head}(中のノート ${String(toRoot)} 件は消えずにルートに出ています)` : head;
}

/** 持っている物を捨て、知らせがまだ載っていれば降ろす。 */
export function clearTrashOffer(): void {
  const p = pending;
  pending = null;
  if (p === null) return;
  if (p.timer !== null) clearTimeout(p.timer);
  if (p.dispatcher.getState().notice === p.message)
    p.dispatcher.dispatch({ type: 'NOTICE_EXPIRED', message: p.message });
}

/** 画面の下の「元に戻す」を出してよいか(いま出ている知らせがこの 1 手の知らせそのものか)。 */
export function trashUndoShown(shownLine: string): boolean {
  return pending !== null && pending.message === shownLine;
}

/** 持っている物(test の観測点)。 */
export function currentTrashOffer(): {
  readonly lids: readonly string[];
  readonly message: string;
} | null {
  return pending === null ? null : { lids: pending.lids, message: pending.message };
}

/**
 * ゴミ箱へ移した直後に呼ぶ。⚠ 移した件が 0 のときは出さない。
 * 知らせは `OP_NOTICE` で出す(メッセージ一覧にも積まれる)。
 */
export function offerTrashUndo(
  dispatcher: Dispatcher,
  moved: readonly { readonly lid: string; readonly title: string }[],
  toRoot = 0,
): void {
  if (moved.length === 0) return;
  clearTrashOffer();
  const p: Pending = {
    lids: moved.map((m) => m.lid),
    message: trashMessage(moved.map((m) => m.title), toRoot),
    dispatcher,
    timer: null,
  };
  pending = p;
  p.timer = setTimeout(() => {
    if (pending === p) clearTrashOffer();
  }, TRASH_OFFER_MS);
  dispatcher.dispatch({ type: 'OP_NOTICE', message: p.message });
}

/** 「元に戻す」の本体。戻す対象を返し、持っている物を忘れる(撃つのは呼び側)。無ければ `null`。 */
export function takeTrashUndo(): readonly string[] | null {
  const p = pending;
  if (p === null) return null;
  pending = null;
  if (p.timer !== null) clearTimeout(p.timer);
  return p.lids;
}
