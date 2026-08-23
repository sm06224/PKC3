import { describe, expect, it } from 'vitest';
import {
  DATE_SHORTCUTS,
  isDateShortcut,
  shortcutDate,
  type DateShortcut,
} from '../../src/features/schedule/date-shortcuts';
import { isScheduleDate } from '../../src/features/schedule/schedule-date';

/** 2026-08-17(月)から 1 週間。⚠ 曜日を字で持って、読み手が検算できる形にする。 */
const WEEK: ReadonlyArray<[string, string]> = [
  ['2026-08-17', '月'],
  ['2026-08-18', '火'],
  ['2026-08-19', '水'],
  ['2026-08-20', '木'],
  ['2026-08-21', '金'],
  ['2026-08-22', '土'],
  ['2026-08-23', '日'],
];

const at = (key: string): Date => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 13, 45, 30);
};

describe('日付の近道(user 指示 2026-08-23)', () => {
  it('⚠ 前提の検算: 表の曜日が本当にその曜日である', () => {
    // 🔑 この表が狂っていると、下の全部が「別の曜日の主張」になる
    const names = ['日', '月', '火', '水', '木', '金', '土'];
    for (const [key, dow] of WEEK) expect(names[at(key).getDay()], key).toBe(dow);
  });

  it('今日 / 明日 は曜日によらない', () => {
    for (const [key] of WEEK) {
      expect(shortcutDate('today', at(key)), key).toBe(key);
    }
    expect(shortcutDate('tomorrow', at('2026-08-17'))).toBe('2026-08-18');
    // ⚠ 月をまたぐ(桁の詰め方と繰り上がり)
    expect(shortcutDate('tomorrow', at('2026-08-31'))).toBe('2026-09-01');
    // ⚠ 年をまたぐ
    expect(shortcutDate('tomorrow', at('2026-12-31'))).toBe('2027-01-01');
  });

  /**
   * 🔴 **今週末 = 次に来る土曜(土曜なら当日)。**
   * ⚠ 日曜に押したら **6 日後** ── 過去(昨日の土曜)は返さない。
   */
  it('🔴 今週末は、次に来る土曜(全 7 曜日)', () => {
    expect(WEEK.map(([key]) => shortcutDate('weekend', at(key)))).toEqual([
      '2026-08-22', // 月 → 5 日後
      '2026-08-22', // 火
      '2026-08-22', // 水
      '2026-08-22', // 木
      '2026-08-22', // 金
      '2026-08-22', // 🔑 土 → **当日**
      '2026-08-29', // 🔑 日 → **6 日後**(昨日へは戻らない)
    ]);
  });

  /**
   * 🔴 **来週 = 次に来る月曜(月曜なら 7 日後)。**
   * ⚠ 月曜に押して当日を返したら、それは「来週」ではない。
   */
  it('🔴 来週は、次に来る月曜(全 7 曜日)', () => {
    expect(WEEK.map(([key]) => shortcutDate('next-week', at(key)))).toEqual([
      '2026-08-24', // 🔑 月 → **7 日後**(当日ではない)
      '2026-08-24', // 火
      '2026-08-24', // 水
      '2026-08-24', // 木
      '2026-08-24', // 金
      '2026-08-24', // 土
      '2026-08-24', // 日
    ]);
  });

  /**
   * 🔴 **どれも今日より前を返さない。**
   * ⚠ これは上の 2 つの表を**別の観測**で見た不変量である ──
   *   表は「その日である」、こちらは「過去ではない」。片方だけ壊す誤りが在る。
   */
  it('🔴 どの近道も、どの曜日でも、今日より前にならない', () => {
    for (const [key] of WEEK) {
      for (const { id } of DATE_SHORTCUTS) {
        expect(shortcutDate(id, at(key)) >= key, `${id} を ${key} に押したら過去へ行った`).toBe(
          true,
        );
      }
    }
  });

  /**
   * 🔴 **出た字は、そのまま記法として書ける形**であること。
   * ⚠ 近道が `2026-8-5` のような形を返すと、**書けるのに読めない**日付ができる。
   */
  it('🔴 出る字は必ず記法の形(YYYY-MM-DD)', () => {
    for (const [key] of WEEK) {
      for (const { id } of DATE_SHORTCUTS) {
        expect(isScheduleDate(shortcutDate(id, at(key))), `${id} @ ${key}`).toBe(true);
      }
    }
    // ⚠ 1 桁の月・日を必ず通す(桁を詰め忘れる誤りはここでしか出ない)
    expect(shortcutDate('today', at('2026-01-05'))).toBe('2026-01-05');
  });

  it('知らない名前は近道ではない', () => {
    expect(isDateShortcut('today')).toBe(true);
    expect(isDateShortcut('yesterday')).toBe(false);
    // 🔑 表の全項目が通ること(表とガードがずれていないこと)
    for (const { id } of DATE_SHORTCUTS) expect(isDateShortcut(id as DateShortcut)).toBe(true);
  });
});
