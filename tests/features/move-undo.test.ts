/**
 * 🔴 **予定を動かした直後の「元に戻す」の材料 / 小さな月の「見ている所」**(#855。
 * Gemini 裁定 = #1163 のコメント 6104130726 の 1・5・6)。実体は `features/schedule/move-undo.ts` と
 * `month-grid.ts` の `viewedMarks`。画面に出る道は `tests/adapter/schedule-undo.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import { moveMessage, slotOfCard, undoVerdict, type Slot } from '../../src/features/schedule/move-undo';
import { viewedMarks } from '../../src/features/schedule/month-grid';
import { insertionForLineDate } from '../../src/features/schedule/line-date';

const slot = (
  date: string | null,
  time: string | null = null,
  timeEnd: string | null = null,
  text = '会議',
): Slot => ({
  date,
  time,
  timeEnd,
  until: null,
  text,
});

describe('moveMessage(画面に出る 1 行)', () => {
  it('日 + 時刻の幅 + 動かしました', () => {
    expect(moveMessage(slot('2026-10-05', '16:00', '17:00'))).toBe('10/5(月) 16:00〜17:00 へ動かしました');
  });
  it('時刻 1 点 / 時刻なし', () => {
    expect(moveMessage(slot('2026-10-05', '16:00'))).toBe('10/5(月) 16:00 へ動かしました');
    expect(moveMessage(slot('2026-10-05'))).toBe('10/5(月) へ動かしました');
  });
  it('縁を引いて終わりだけ変えたときは「に変えました」', () => {
    expect(moveMessage(slot('2026-10-05', '16:00', '17:30'), 'changed')).toBe('10/5(月) 16:00〜17:30 に変えました');
  });
  it('日付なしへ外したら「予定から外しました」', () => {
    expect(moveMessage(slot(null))).toBe('予定から外しました');
  });
});

describe('undoVerdict(戻してよいか)', () => {
  const before = slot('2026-10-05', '14:00', '15:00');
  const after = slot('2026-10-07', '14:00', '15:00');
  it('動かした直後の姿 / まだ書き換わっていない姿なら戻す', () => {
    expect(undoVerdict(after, true, before, after)).toBe('revert');
    expect(undoVerdict(before, true, before, after)).toBe('revert');
  });
  it('どちらでもなければ戻さない(動かした後に直された)', () => {
    expect(undoVerdict(slot('2026-10-09', '14:00', '15:00'), true, before, after)).toBe('changed');
    // 時刻だけ・期間の終わりだけ違っても別の姿
    expect(undoVerdict(slot('2026-10-07', '14:30', '15:00'), true, before, after)).toBe('changed');
    expect(undoVerdict({ ...after, until: '2026-10-09' }, true, before, after)).toBe('changed');
  });
  it('🔴 日・時刻が同じでも、中身(指紋)が違えば戻さない(別の予定に化けた行)', () => {
    expect(undoVerdict(slot('2026-10-07', '14:00', '15:00', '別件'), true, before, after)).toBe('changed');
  });
  it('行が見つからない: 走査が済んでいれば戻さない / 済んでいなければ確かめようが無いので戻す', () => {
    expect(undoVerdict(undefined, true, before, after)).toBe('changed');
    expect(undoVerdict(undefined, false, before, after)).toBe('revert');
  });
});

describe('viewedMarks(小さな月で見ている所)', () => {
  const week = ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'];
  it('一覧は印なし / 日は見ている日 1 つ / 週は 7 日', () => {
    expect(viewedMarks('list', '2026-10-06', week)).toEqual({ day: null, week: [] });
    expect(viewedMarks('day', '2026-10-06', week)).toEqual({ day: '2026-10-06', week: [] });
    expect(viewedMarks('week', '2026-10-06', week)).toEqual({ day: null, week });
  });
});

describe('insertionForLineDate の時刻の幅(日付を外した予定を戻すために要る)', () => {
  it('幅を渡すと 14:00..15:00 で書き、渡さなければ従来どおり', () => {
    expect(insertionForLineDate('見積', '2026-08-25', '14:00', null, null, '15:00')).toBe(' @2026-08-25 14:00..15:00');
    expect(insertionForLineDate('見積', '2026-08-25', '14:00')).toBe(' @2026-08-25 14:00');
  });
});

describe('slotOfCard(中身の指紋)', () => {
  const card = (text: string) => ({ date: '2026-10-05', time: null, timeEnd: null, until: null, text });
  it('日付の字を除き、空白を畳む ── 動かしても指紋は変わらない', () => {
    expect(slotOfCard(card('会議  @2026-10-05 14:00 の枠')).text).toBe('会議 の枠');
    expect(slotOfCard(card('会議 @2026-10-07 の枠')).text).toBe('会議 の枠');
  });
  it('別の予定なら指紋が違う', () => {
    expect(slotOfCard(card('別件 @2026-10-05')).text).not.toBe(slotOfCard(card('会議 @2026-10-05')).text);
  });
});
