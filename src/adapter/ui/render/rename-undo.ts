/**
 * 🔴 **題名を変えた直後の「元に戻す」**(Gemini 裁定 = #1163 への依頼 45 の 2、#1657。推薦 A)。
 *
 * 変えた直後に、画面の下の知らせの行へ「題名を「旧」から「新」に変えました」と、その隣の **元に戻す** を数秒出す
 * (置き場はゴミ箱へ移した直後・2 ペインで移した直後と同じ `status-undo`。新しい器を作らない ── 作りは `dual-move-undo.ts` と同じ)。
 *
 * ## 出し入れ
 *
 * | 場面 | 起きること |
 * |---|---|
 * | 題名が実際に変わった | 知らせと「元に戻す」を出す |
 * | 数秒経つ(`RENAME_OFFER_MS`) | 知らせごと降ろす |
 * | 次の知らせが来た | 字が変わるので「元に戻す」だけ畳む(`status-open.ts` の作法) |
 * | 次に変えた | 置き換わる(戻せるのは直前の 1 回) |
 *
 * ## 戻し方
 *
 * 新しい書込経路は作らない。変える前の題名へ向けた `RENAME_ENTRY_TITLE` を 1 手撃つ(`binder.ts` の `undo-rename`)。
 * ⚠ 変えた後にさらに題名を変えていたら戻さない(いまの題名が「変えた後」の物だけ戻す)。
 * ⚠ 「変わったか」は撃つ前後の題名で見る ── 空白だけ・同じ題名・取り込み中の断りは reducer が持つので、ここに判定を書かない。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';

/** 「元に戻す」を出しておく長さ(ms)。⚠ ゴミ箱の `TRASH_OFFER_MS` と同じ。 */
export const RENAME_OFFER_MS = 7000;

interface Pending {
  readonly lid: string;
  readonly from: string;
  readonly to: string;
  /** 添付はファイル名も題名に揃えて変えたので、戻すときも揃える。 */
  readonly withFile: boolean;
  readonly message: string;
  readonly dispatcher: Dispatcher;
  timer: ReturnType<typeof setTimeout> | null;
}

let pending: Pending | null = null;

/** 知らせの中の題名の長さの上限(長い題名で 1 行が溢れない)。 */
const SHOW_MAX = 24;
const shorten = (s: string): string => (s.length > SHOW_MAX ? `${s.slice(0, SHOW_MAX)}…` : s);

/** 持っている物を捨て、知らせがまだ載っていれば降ろす。 */
export function clearRenameOffer(): void {
  const p = pending;
  pending = null;
  if (p === null) return;
  if (p.timer !== null) clearTimeout(p.timer);
  if (p.dispatcher.getState().notice === p.message)
    p.dispatcher.dispatch({ type: 'NOTICE_EXPIRED', message: p.message });
}

/** 画面の下の「元に戻す」を出してよいか(いま出ている知らせがこの 1 手の知らせそのものか)。 */
export function renameUndoShown(shownLine: string): boolean {
  return pending !== null && pending.message === shownLine;
}

/** 持っている物(test の観測点)。 */
export function currentRenameOffer(): {
  readonly lid: string;
  readonly from: string;
  readonly to: string;
  readonly message: string;
} | null {
  return pending === null
    ? null
    : { lid: pending.lid, from: pending.from, to: pending.to, message: pending.message };
}

/**
 * 題名を変える 1 手(`run`)を撃ち、**実際に変わった回だけ**「元に戻す」を出す。
 * `run` は `RENAME_ENTRY_TITLE`(添付は続けて `SET_ATTACHMENT_NAME`)を撃つ関数。
 */
export function renameOfferingUndo(
  dispatcher: Dispatcher,
  lid: string,
  run: () => void,
  withFile = false,
): void {
  const from = dispatcher.getState().entryMetas.get(lid)?.title;
  run();
  const to = dispatcher.getState().entryMetas.get(lid)?.title;
  if (from === undefined || to === undefined || from === to) return;
  clearRenameOffer();
  const message = `題名を「${shorten(from)}」から「${shorten(to)}」に変えました`;
  const p: Pending = { lid, from, to, withFile, message, dispatcher, timer: null };
  pending = p;
  p.timer = setTimeout(() => {
    if (pending === p) clearRenameOffer();
  }, RENAME_OFFER_MS);
  dispatcher.dispatch({ type: 'OP_NOTICE', message });
}

/** 「元に戻す」の本体。戻す対象を返し、持っている物を忘れる(撃つのは呼び側)。無ければ `null`。 */
export function takeRenameUndo(): {
  readonly lid: string;
  readonly from: string;
  readonly to: string;
  readonly withFile: boolean;
} | null {
  const p = pending;
  if (p === null) return null;
  pending = null;
  if (p.timer !== null) clearTimeout(p.timer);
  return { lid: p.lid, from: p.from, to: p.to, withFile: p.withFile };
}
