/**
 * 🔴 **予定の「週」── 7 日の決め方と見出し**(#855 段 A-2)。純関数。
 * 繋がり(描画・押す・窓)は `tests/adapter/schedule-week.test.ts`。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { weekColumnLabel, weekHeading, weekOf } from '../../src/features/schedule/day-layout';
import {
  dropViewScheduleFromHash,
  formatViewDeepLink,
  parseViewDeepLinkSchedule,
} from '../../src/features/link/permalink';

describe('weekOf ── 日曜始まりの 7 日', () => {
  it('🔴 日曜はその日が先頭 / 土曜は 6 日前が先頭(月曜始まりなら日曜は前の週になる)', () => {
    // 2026-08-23 は日曜
    expect(weekOf('2026-08-23')).toEqual([
      '2026-08-23', '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29',
    ]);
    expect(weekOf('2026-08-29')![0]).toBe('2026-08-23');
    expect(weekOf('2026-08-26')![0]).toBe('2026-08-23');
    // 月曜(8/24)も同じ週(日曜 8/23 始まり)
    expect(weekOf('2026-08-24')![0]).toBe('2026-08-23');
  });

  it('月・年をまたぐ週 / 閏日', () => {
    expect(weekOf('2026-01-01')).toEqual([
      '2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03',
    ]);
    expect(weekOf('2028-03-01')![0]).toBe('2028-02-27');
    expect(weekOf('2028-03-01')).toContain('2028-02-29');
  });

  it('実在しない日・読めない字は null(別の週へ寄せない)', () => {
    expect(weekOf('2026-02-30')).toBeNull();
    expect(weekOf('あした')).toBeNull();
    expect(weekOf('')).toBeNull();
  });
});

describe('weekHeading / weekColumnLabel', () => {
  it('今年なら年を付けない', () => {
    expect(weekHeading(weekOf('2026-10-07')!, '2026-10-10')).toBe('10月4日〜10月10日');
  });
  it('🔴 どちらかの端が今年でなければ、両端に年を付ける', () => {
    expect(weekHeading(weekOf('2026-01-01')!, '2026-10-10')).toBe('2025年12月28日〜2026年1月3日');
    expect(weekHeading(weekOf('2025-10-07')!, '2026-10-10')).toBe('2025年10月5日〜2025年10月11日');
  });
  it('列の見出しは曜日と月/日', () => {
    expect(weekColumnLabel('2026-10-04')).toEqual({ weekday: '日', date: '10/4' });
    expect(weekColumnLabel('2026-10-10')).toEqual({ weekday: '土', date: '10/10' });
  });
});

describe('「週」の札の規則 ── 「日」と同じ最低の高さ・位置の式を共有する', () => {
  it('🔴 週の列の札の規則が、「日」の規則と宣言まで同じ(片方だけ動くと重なりの判定と見た目が食い違う)', () => {
    const css = readFileSync('src/styles/app.css', 'utf-8');
    const ruleOf = (field: string): string => {
      const m = new RegExp(`\\[data-pkc-field='${field}'\\] > \\[data-pkc-entry\\] \\{([^}]*)\\}`).exec(css);
      expect(m, `${field} の札の規則が無い`).not.toBeNull();
      return m![1]!.replace(/\/\*.*?\*\//gs, '').replace(/\s+/g, ' ').trim();
    };
    expect(ruleOf('schedule-weekview-lane')).toBe(ruleOf('schedule-day-lane'));
  });
});

describe('ディープリンクの合図(sched / day)', () => {
  const BASE = 'https://pkc.test/app/';
  it('🔴 往復する(週 + 日)/ 日が無ければ週だけ', () => {
    const url = formatViewDeepLink(BASE, 'schedule', {
      token: 'tok',
      schedule: { mode: 'week', day: '2026-10-07' },
    })!;
    expect(url).toBe(`${BASE}#pkc?view=schedule&w=tok&sched=week&day=2026-10-07`);
    expect(parseViewDeepLinkSchedule(url.slice(url.indexOf('#')))).toEqual({
      mode: 'week',
      day: '2026-10-07',
    });
    const bare = formatViewDeepLink(BASE, 'schedule', { schedule: { mode: 'week', day: null } })!;
    expect(bare).toBe(`${BASE}#pkc?view=schedule&sched=week`);
    expect(parseViewDeepLinkSchedule(bare.slice(bare.indexOf('#')))).toEqual({
      mode: 'week',
      day: null,
    });
  });

  it('🔴 実在しない日は載せない / 読むときも捨てる(週だけ受ける)', () => {
    const url = formatViewDeepLink(BASE, 'schedule', {
      schedule: { mode: 'week', day: '2026-02-30' },
    })!;
    expect(url).not.toContain('day=');
    expect(parseViewDeepLinkSchedule('#pkc?view=schedule&sched=week&day=2026-02-30')).toEqual({
      mode: 'week',
      day: null,
    });
  });

  it('🔴 1000 年より前の年は捨てる(`new Date(50, …)` が 1950 年へ寄せる ── 別の日を見せない)', () => {
    expect(parseViewDeepLinkSchedule('#pkc?view=schedule&sched=week&day=0050-01-01')).toEqual({
      mode: 'week',
      day: null,
    });
    expect(parseViewDeepLinkSchedule('#pkc?view=schedule&sched=week&day=1000-01-01')!.day).toBe(
      '1000-01-01',
    );
    expect(
      formatViewDeepLink(BASE, 'schedule', { schedule: { mode: 'week', day: '0050-01-01' } }),
    ).not.toContain('day=');
  });

  it('🔴 読めない値は無視する(week 以外・空・合図なし)', () => {
    expect(parseViewDeepLinkSchedule('#pkc?view=schedule&sched=month')).toBeNull();
    expect(parseViewDeepLinkSchedule('#pkc?view=schedule&sched=')).toBeNull();
    expect(parseViewDeepLinkSchedule('#pkc?view=schedule&day=2026-10-07')).toBeNull();
    expect(parseViewDeepLinkSchedule('')).toBeNull();
    expect(parseViewDeepLinkSchedule('#other')).toBeNull();
  });

  it('面が schedule でなければ運ばない(他の面には意味が無い)', () => {
    const url = formatViewDeepLink(BASE, 'calendar', { schedule: { mode: 'week', day: null } })!;
    expect(url).not.toContain('sched');
  });

  it('落とすのは sched と day だけ(view / w / container / entry は残す)', () => {
    expect(
      dropViewScheduleFromHash('#pkc?container=c1&entry=e1&view=schedule&w=t&sched=week&day=2026-10-07'),
    ).toBe('#pkc?container=c1&entry=e1&view=schedule&w=t');
  });
});
