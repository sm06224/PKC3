/**
 * 🔴 **目次で別の章へ飛んだ直後の「元の位置へ戻る」**(台帳 #1852 束 R1、依頼 86-1 B。Gemini の回答「推薦どおり」)。
 *
 * 目次で章を押すと飛ぶが、元の場所へ戻る手段は「↑」(先頭へ)だけで、アドレスも変わらないのでブラウザの「戻る」も効かなかった。
 * 飛んだ直後に、画面の下の知らせの行へ「「章の題」へ移動しました」と、その隣の **元の位置へ戻る** を数秒出す
 * (置き場はゴミ箱へ移した直後・題名を変えた直後と同じ `status-undo`。新しい器を作らない ── 作りは `stack-undo.ts` と同じ)。
 *
 * ## 出し入れ
 *
 * | 場面 | 起きること |
 * |---|---|
 * | 目次の押しで飛んだ | 知らせと「元の位置へ戻る」を出す |
 * | 数秒経つ(`JUMP_BACK_OFFER_MS`) | 知らせごと降ろす |
 * | 次の知らせが来た | 字が変わるので「元の位置へ戻る」だけ畳む(`status-open.ts` の作法) |
 * | 続けて別の章へ飛んだ | **最初に読んでいた位置**を持ち続ける(戻れる先は「読んでいた場所」。飛び先の連鎖ではない) |
 *
 * ## 戻し方
 *
 * 書込は無い(スクロール位置だけ)。飛ぶ前に、飛び先の見出しを包む**スクロールする箱すべて**の位置を控え、戻すときに書き戻す。
 * ⚠ どの箱が動くかは画面の幅・畳みで変わる(中央の列か、ページ全体か)ので、箱を決め打たず、祖先を全部控える。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';

/** 「元の位置へ戻る」を出しておく長さ(ms)。⚠ ゴミ箱の `TRASH_OFFER_MS` と同じ。 */
export const JUMP_BACK_OFFER_MS = 7000;

/** 飛ぶ前のスクロール位置(箱と位置の組)。 */
export type ScrollSnapshot = ReadonlyArray<readonly [Element, number]>;

/** 知らせの中の題の長さの上限(長い題で 1 行が溢れない)。 */
const SHOW_MAX = 24;
const shorten = (s: string): string => (s.length > SHOW_MAX ? `${s.slice(0, SHOW_MAX)}…` : s);

interface Pending {
  /** 飛んだノート。⚠ 別のノートへ移った後は戻さない(別のノートの位置を書き換えない)。 */
  readonly lid: string | null;
  readonly snapshot: ScrollSnapshot;
  readonly message: string;
  readonly dispatcher: Dispatcher;
  timer: ReturnType<typeof setTimeout> | null;
}

let pending: Pending | null = null;

/** `from` を包む箱すべての、いまのスクロール位置を控える(ページ全体の箱も含む)。 */
export function snapshotScroll(from: Element): ScrollSnapshot {
  const out: Array<readonly [Element, number]> = [];
  for (let el: Element | null = from.parentElement; el !== null; el = el.parentElement) out.push([el, el.scrollTop]);
  const root = from.ownerDocument.scrollingElement;
  if (root !== null && root !== undefined && !out.some(([e]) => e === root)) out.push([root, root.scrollTop]);
  return out;
}

/** 控えた位置へ書き戻す。画面から外れた箱は触らない。 */
export function restoreScroll(snapshot: ScrollSnapshot): void {
  for (const [el, top] of snapshot) {
    if (el.isConnected && el.scrollTop !== top) el.scrollTop = top;
  }
}

/** 持っている物を捨て、知らせがまだ載っていれば降ろす。 */
export function clearJumpBackOffer(): void {
  const p = pending;
  pending = null;
  if (p === null) return;
  if (p.timer !== null) clearTimeout(p.timer);
  if (p.dispatcher.getState().notice === p.message)
    p.dispatcher.dispatch({ type: 'NOTICE_EXPIRED', message: p.message });
}

/** 画面の下の「元の位置へ戻る」を出してよいか(いま出ている知らせがこの 1 手の知らせそのものか)。 */
export function jumpBackShown(shownLine: string): boolean {
  return pending !== null && pending.message === shownLine;
}

/** 持っている物(test の観測点)。 */
export function currentJumpBackOffer(): {
  readonly lid: string | null;
  readonly snapshot: ScrollSnapshot;
  readonly message: string;
} | null {
  return pending === null ? null : { lid: pending.lid, snapshot: pending.snapshot, message: pending.message };
}

/**
 * 目次で飛んだ直後に呼ぶ。`snapshot` は**飛ぶ前**の位置、`title` は飛び先の見出しの字。
 * 知らせは `OP_NOTICE` で出す(メッセージ一覧にも積まれる ── 他の「元に戻す」と同じ)。
 * ⚠ すでに戻る先を持っているとき(続けて飛んだ)は、**最初の位置**のまま知らせだけ新しくする。
 */
export function offerJumpBack(dispatcher: Dispatcher, snapshot: ScrollSnapshot, title: string): void {
  const lid = dispatcher.getState().selectedLid;
  // 同じノートの中で続けて飛んだときだけ、最初の位置を持ち続ける
  const keep = pending !== null && pending.lid === lid ? pending.snapshot : snapshot;
  clearJumpBackOffer();
  const message = `「${shorten(title.trim())}」へ移動しました`;
  const p: Pending = { lid, snapshot: keep, message, dispatcher, timer: null };
  pending = p;
  p.timer = setTimeout(() => {
    if (pending === p) clearJumpBackOffer();
  }, JUMP_BACK_OFFER_MS);
  dispatcher.dispatch({ type: 'OP_NOTICE', message });
}

/** 「元の位置へ戻る」の本体。控えとノートを返し、持っている物を忘れる(書き戻すのは呼び側)。無ければ `null`。 */
export function takeJumpBack(): { readonly lid: string | null; readonly snapshot: ScrollSnapshot } | null {
  const p = pending;
  if (p === null) return null;
  pending = null;
  if (p.timer !== null) clearTimeout(p.timer);
  return { lid: p.lid, snapshot: p.snapshot };
}
