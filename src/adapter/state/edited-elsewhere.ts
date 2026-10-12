/**
 * 🔴 **そのノートを、別のタブ・窓が編集中か**(#529 W5-a〜d。Gemini 裁定 2026-10-11 依頼 18 Q5 = A)。
 *
 * ⚠ 通すと、編集中のタブが保存したとき**そちらの内容で上書きされ**、足した字は履歴にだけ残る
 *   (設計 `board-edit-in-place-design-2026-10.md` §3.2 の 5)。だから**断って理由を出し、打った字は欄に残す**。
 * 🔑 問い合わせは**編集に入るときと同じ口**(`acquireEditLock`)── 判定を 2 本にしない(§7)。
 *   取れたら**すぐ返す**(追記・改名は錠を握り続けない。握ると付箋 10 枚で 10 枚ぶん握る)。
 * ⚠ **このタブが自分で編集中のノートは問い合わせない** ── 取り直して返すと自分の錠を手放す。
 *   このタブの編集は reducer の門(`bodyWriteBlockReason`)が断る。
 * ⚠ `unreachable`(メインのタブと通信できない)は**断らない** ── 「別のタブが編集中」とは別の事実で、
 *   新しい断りを足さない。
 *
 * 呼び手(追記の口の全数。W5-d で数えた): 板の付箋の追記・題名(`binder.ts`)/ 本文の下の追記欄(`append-entry`)/
 * PDF の「ノートへ引く」(`quote-into-note.ts`)/ ブラウザの AI の `pkc_append_note`(`main.ts`)。
 * 通さない口(理由は設計 doc §6 W5-d): 計時の記録・文字起こし・添付のドロップ・予定の面の「足す」。
 */
import { EDIT_ELSEWHERE_ERROR } from '@features/message/caution-events';
import type { Dispatcher } from './dispatcher';
import { appendAndSettle, REAL_APPEND_TIMERS, type AppendOutcome, type AppendTimers } from './append-settle';

/** 編集の錠の口(`BinderServices` の同名の 2 つと同じ形)。 */
export interface EditLockPort {
  acquireEditLock?(lid: string): Promise<'granted' | 'denied' | 'unreachable'>;
  releaseEditLock?(lid: string): void;
}

/**
 * 問い合わせが**要らない**か(同期)。口が無い / このタブが自分で編集中(章の下書き含む)。
 * ⚠ 要らないときは**同期のまま**書く ── 口の無い環境(unit)の追記を非同期に変えない。
 */
export function elsewhereCheckNotNeeded(dispatcher: Dispatcher, port: EditLockPort, lid: string): boolean {
  if (!port.acquireEditLock) return true;
  const st = dispatcher.getState();
  return (st.phase === 'editing' && st.openBody?.lid === lid) || st.sectionDraft?.lid === lid;
}

/** 断る理由(別のタブが編集中)。通すなら `null`。 */
export async function editedElsewhereReason(
  dispatcher: Dispatcher,
  port: EditLockPort,
  lid: string,
): Promise<string | null> {
  if (elsewhereCheckNotNeeded(dispatcher, port, lid)) return null;
  const grant = await port.acquireEditLock!(lid);
  if (grant === 'granted') {
    port.releaseEditLock?.(lid);
    return null;
  }
  return grant === 'denied' ? EDIT_ELSEWHERE_ERROR : null;
}

/**
 * 別のタブの編集を確かめてから {@link appendAndSettle} へ渡す(PDF の引用・ブラウザの AI の書き足し)。
 * 断った回は何も書かず `refused` + 理由で返す(呼び手が自分の字で言う)。
 */
export function appendUnlessEditedElsewhere(
  dispatcher: Dispatcher,
  port: EditLockPort,
  lid: string,
  text: string,
  heading: string | null,
  timeoutMs: number,
  timers: AppendTimers = REAL_APPEND_TIMERS,
): Promise<AppendOutcome> {
  // 問い合わせが要らない回は**同期のまま**撃つ(口の無い環境の追記を 1 手遅らせない)
  if (elsewhereCheckNotNeeded(dispatcher, port, lid)) {
    return appendAndSettle(dispatcher, lid, text, heading, timeoutMs, timers);
  }
  return editedElsewhereReason(dispatcher, port, lid).then((why) =>
    why !== null
      ? ({ ok: false, reason: 'refused', error: why } as const)
      : appendAndSettle(dispatcher, lid, text, heading, timeoutMs, timers),
  );
}
