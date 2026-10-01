/**
 * 🔴 **本文の `@日付` の右に添える「あと3日」「5日前」**(#1225)── 字そのもの。
 *
 * 言葉は Gemini 裁定 2026-10-01 ②:今日は「今日」、明日は「明日」、それ以外は「あとN日」「N日前」。
 * 1 年以上先・前もそのまま日数。⚠ 昨日は「昨日」ではなく「1日前」(裁定の言葉どおり)。
 */
import { describe, expect, it } from 'vitest';
import { relativeDayLabel } from '../../src/features/schedule/relative-days';

const TODAY = '2026-10-01';

describe('relativeDayLabel(#1225)', () => {
  it('🔴 今日は「今日」/ 明日は「明日」(「あと0日」「あと1日」と言わない)', () => {
    expect(relativeDayLabel('2026-10-01', TODAY)).toBe('今日');
    expect(relativeDayLabel('2026-10-02', TODAY)).toBe('明日');
  });

  it('🔴 それ以外は先なら「あとN日」・前なら「N日前」(昨日も「1日前」)', () => {
    expect(relativeDayLabel('2026-10-04', TODAY)).toBe('あと3日');
    expect(relativeDayLabel('2026-10-03', TODAY)).toBe('あと2日');
    expect(relativeDayLabel('2026-09-26', TODAY)).toBe('5日前');
    expect(relativeDayLabel('2026-09-30', TODAY)).toBe('1日前');
  });

  it('🔴 1 年以上先・前もそのまま日数(「あと1年」に丸めない)', () => {
    expect(relativeDayLabel('2027-10-01', TODAY)).toBe('あと365日');
    expect(relativeDayLabel('2028-10-01', TODAY)).toBe('あと731日'); // 2028 は閏年
    expect(relativeDayLabel('2025-10-01', TODAY)).toBe('365日前');
  });

  it('月・年の境目も日数で数える(文字列の引き算ではない)', () => {
    expect(relativeDayLabel('2026-11-01', TODAY)).toBe('あと31日');
    expect(relativeDayLabel('2027-01-01', '2026-12-31')).toBe('明日');
    expect(relativeDayLabel('2026-12-31', '2027-01-01')).toBe('1日前');
  });

  it('🔴 読めない日付は null(字を出さない。「あと0日」で隠さない)', () => {
    expect(relativeDayLabel('いつか', TODAY)).toBeNull();
    expect(relativeDayLabel('2026-10-01', '今日')).toBeNull();
  });
});
