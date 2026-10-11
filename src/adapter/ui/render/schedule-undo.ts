/**
 * 🔴 **予定を動かした直後の「元に戻す」**(#855。Gemini 裁定 = #1163 のコメント 6104130726 の 6)。
 *
 * 札を日へドロップした / 目盛りで動かした / 縁を引いた、のあと、**画面の下の知らせの行**に
 * 「10/5(月) 16:00〜17:00 へ動かしました」と、その隣の **元に戻す** を出す
 * (塊を動かした直後の `status-undo` と同じ置き場 ── 予定の面の中に 1 行を足すと、出入りで目盛りが動くか、
 *  札を覆うか、一覧が長いと画面の外になる。下の知らせの行は動かず・覆わず・いつも見える)。
 *
 * ## 出し入れ
 *
 * | 場面 | 起きること |
 * |---|---|
 * | 動かした | 🔴 **本文への書込が届いてから**出す(書込が断られた回に「動かしました」を出さない)。届く前に失敗が出たら出さない |
 * | 数秒経つ | 知らせごと降ろす(画面の下の知らせの寿命と揃える) |
 * | どこかを**クリック**した | 降ろす。⚠ スクロール・つまみのドラッグ・指でなぞる動きでは降ろさない(`click` は動かしたら出ない / 8px を超えたら数えない) |
 * | 次に動かした | 置き換わる(1 手だけ持つ) |
 *
 * ## 戻し方
 *
 * 新しい書込経路は作らない。**動かす前の姿へ向けた `SET_TASK_DATE` / `SET_ENTRY_DATE` を 1 手撃つ**
 * (`binder.ts` の `schedule-undo-move`)。⚠ 動かした後に本文が変わっていたら戻さず、理由を言う
 * (`undoVerdict` ── 行番号の違う別の行 / 別の予定を書き換えない)。
 *
 * ⚠ 繰り返しの回の移動(1 回だけ / 全部)は出さない: 「この回だけ」は行を 1 本増やすので、
 *   逆向きが日付の書き換え 1 手では書けない(別の戻し方が要る)。
 */
import {
  MOVE_OFFER_MS,
  moveMessage,
  sameSlot,
  slotOfCard,
  undoVerdict,
  type Slot,
} from '@features/schedule/move-undo';
import type { AppState, UserAction } from '@adapter/state/app-state';
import type { Dispatcher } from '@adapter/state/dispatcher';

export type MoveTarget =
  | { readonly kind: 'task'; readonly lid: string; readonly line: number }
  | { readonly kind: 'entry'; readonly lid: string };

export interface MoveOffer {
  readonly target: MoveTarget;
  readonly before: Slot;
  readonly after: Slot;
  readonly verb: 'moved' | 'changed';
}

/** 書込が届くのを待つ長さ(ms)。⚠ これを過ぎたら出さずに諦める(古い「動かしました」を後から出さない)。 */
export const MOVE_ACK_WAIT_MS = 5000;
/** クリックと数える動きの大きさ(px)。これを超えて動かした押し方は降ろす理由にしない。 */
export const DISMISS_SLOP_PX = 8;

interface Pending {
  readonly offer: MoveOffer;
  readonly message: string;
  readonly dispatcher: Dispatcher;
  readonly doc: Document;
  /** 本文への書込が届いて、知らせを出したか。 */
  armed: boolean;
  readonly errorAtStart: string | null;
  unsub: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  stop: (() => void) | null;
}

let pending: Pending | null = null;

/** いま走査(または一覧)に見えている、動かした行の姿。見つからなければ `undefined`。 */
function slotNow(
  state: Pick<AppState, 'taskScan' | 'entryMetas'>,
  target: MoveTarget,
): Slot | undefined {
  if (target.kind === 'entry') {
    const m = state.entryMetas.get(target.lid);
    return m === undefined ? undefined : { date: m.date ?? null, time: null, timeEnd: null, until: null, text: '' };
  }
  const c = state.taskScan?.cards.find((x) => x.lid === target.lid && x.line === target.line);
  return c === undefined ? undefined : slotOfCard(c);
}

/** 知らせを降ろして、持っている物を捨てる。 */
export function clearMoveOffer(): void {
  const p = pending;
  pending = null;
  if (p === null) return;
  p.unsub?.();
  if (p.timer !== null) clearTimeout(p.timer);
  p.stop?.();
  // 自分の知らせがまだ載っているときだけ降ろす(後から来た別の知らせを消さない)
  if (p.armed && p.dispatcher.getState().notice === p.message)
    p.dispatcher.dispatch({ type: 'NOTICE_EXPIRED', message: p.message });
}

/** 画面の下の「元に戻す」を出してよいか(いま出ている知らせがこの 1 手の知らせそのものか)。 */
export function scheduleUndoShown(shownLine: string): boolean {
  return pending !== null && pending.armed && pending.message === shownLine;
}

/** 持っている物(test の観測点)。 */
export function currentMoveOffer(): MoveOffer | null {
  return pending === null ? null : pending.offer;
}

/** 書込が届いたのを見て、知らせを出す。 */
function arm(p: Pending): void {
  p.armed = true;
  p.unsub?.();
  p.unsub = null;
  if (p.timer !== null) clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    if (pending === p) clearMoveOffer();
  }, MOVE_OFFER_MS);
  p.dispatcher.dispatch({ type: 'OP_NOTICE', message: p.message });
  // クリックで降ろす。⚠ スクロール / つまみ / 指でなぞる動きは `click` にならない。押した位置から動かした
  // 押し方(`DISMISS_SLOP_PX` 超)も数えない。「元に戻す」自身は降ろす前に binder が使う。
  const doc = p.doc;
  let down: { x: number; y: number } | null = null;
  const onDown = (e: Event): void => {
    const pe = e as PointerEvent;
    down = { x: pe.clientX, y: pe.clientY };
  };
  const onClick = (e: Event): void => {
    const t = e.target as Element | null;
    // 「元に戻す」自身は降ろさない(binder が押された後に使う)。⚠ 字ではなく押し先で見る
    if (t?.closest('[data-pkc-action="schedule-undo-move"]') != null) return;
    const me = e as MouseEvent;
    if (down !== null && Math.hypot(me.clientX - down.x, me.clientY - down.y) > DISMISS_SLOP_PX) return;
    if (pending === p) clearMoveOffer();
  };
  // 次の tick から聞く(動かした操作自身の pointerup / click で降ろさない)
  const armTimer = setTimeout(() => {
    doc.addEventListener('pointerdown', onDown, true);
    doc.addEventListener('click', onClick, true);
  }, 0);
  p.stop = () => {
    clearTimeout(armTimer);
    doc.removeEventListener('pointerdown', onDown, true);
    doc.removeEventListener('click', onClick, true);
  };
}

/**
 * 動かした直後に呼ぶ。⚠ 動かしても何も変わらなかった(前後が同じ)ときは出さない。
 * 🔴 出すのは**書込が届いてから**(走査がこの行の「動かした後の姿」を映したとき)。届く前に失敗が出たら捨てる。
 */
export function offerMoveUndo(root: HTMLElement, dispatcher: Dispatcher, offer: MoveOffer): void {
  if (sameSlot(offer.before, offer.after)) return;
  clearMoveOffer();
  const p: Pending = {
    offer,
    message: moveMessage(offer.after, offer.verb),
    dispatcher,
    doc: root.ownerDocument,
    armed: false,
    errorAtStart: dispatcher.getState().error,
    unsub: null,
    timer: null,
    stop: null,
  };
  pending = p;
  const evaluate = (): void => {
    if (pending !== p || p.armed) return;
    const st = dispatcher.getState();
    // 書込が断られた / 失敗した(新しい失敗が出た)── 動いていないので出さない
    if (st.error !== null && st.error !== p.errorAtStart) {
      clearMoveOffer();
      return;
    }
    const now = slotNow(st, offer.target);
    if (now !== undefined && sameSlot(now, offer.after)) arm(p);
  };
  p.timer = setTimeout(() => {
    if (pending === p && !p.armed) clearMoveOffer();
  }, MOVE_ACK_WAIT_MS);
  p.unsub = dispatcher.onState(evaluate);
  evaluate();
}

/** `schedule-undo-move` の本体。戻す 1 手を返す(撃つのは呼び側)。戻さないなら理由を返す。 */
export function undoScheduleMove(
  state: Pick<AppState, 'taskScan' | 'entryMetas'>,
): { readonly action: UserAction } | { readonly refusal: string } | null {
  const p = pending;
  if (p === null || !p.armed) return null;
  const offer = p.offer;
  const scanned = offer.target.kind === 'entry' || state.taskScan !== null;
  const current = slotNow(state, offer.target);
  clearMoveOffer();
  if (undoVerdict(current, scanned, offer.before, offer.after) === 'changed')
    return { refusal: '動かした後に予定が変わったので、元に戻せませんでした' };
  const b = offer.before;
  if (offer.target.kind === 'entry')
    return { action: { type: 'SET_ENTRY_DATE', lid: offer.target.lid, date: b.date } };
  return {
    action: {
      type: 'SET_TASK_DATE',
      lid: offer.target.lid,
      line: offer.target.line,
      date: b.date,
      time: b.time,
      timeEnd: b.timeEnd,
      until: b.until,
    },
  };
}
