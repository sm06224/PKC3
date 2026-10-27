import { describe, expect, it } from 'vitest';
import {
  formatLogMonth,
  logDayRuns,
  logMonthOfDay,
  logMonthRuns,
} from '../../src/features/textlog/log-days';

describe('ログの月別(pure) #1441', () => {
  it('日 → 月 / 月の字', () => {
    expect(logMonthOfDay('2026-10-09')).toBe('2026-10');
    expect(formatLogMonth('2026-09')).toBe('2026年9月');
    expect(formatLogMonth('2026-12')).toBe('2026年12月');
  });

  it('途切れず続く同じ月の日を 1 つに束ね、月が変われば分ける', () => {
    const levels = [2, 0, 2, 0, 2, 0, 2, 0];
    const days = ['2026-09-30', null, '2026-10-01', null, '2026-10-02', null, '2026-10-02', null];
    const runs = logDayRuns(levels, days);
    expect(runs).toHaveLength(3);
    const months = logMonthRuns(runs);
    expect(months).toEqual([
      { month: '2026-09', start: 0, end: 2, days: 1 },
      { month: '2026-10', start: 2, end: 8, days: 2 },
    ]);
  });

  it('間に時刻でない `##` が挟まったら、同じ月でも別の連なり', () => {
    const levels = [2, 0, 2, 0, 2, 0];
    const days = ['2026-10-01', null, null, null, '2026-10-02', null];
    const months = logMonthRuns(logDayRuns(levels, days));
    expect(months.map((m) => [m.month, m.start, m.end])).toEqual([
      ['2026-10', 0, 2],
      ['2026-10', 4, 6],
    ]);
  });

  it('日が無ければ月も無い', () => {
    expect(logMonthRuns([])).toEqual([]);
  });
});
