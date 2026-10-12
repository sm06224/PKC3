/**
 * 🔴 予定の知らせ(#855 20-C)── `.ics` のアラームと、見逃した予定の数え方。
 *
 * 期待値は実装の関数から組まない(`TRIGGER` の字は手で書く)。
 */
import { describe, expect, it } from 'vitest';
import { buildIcs, type IcsZone } from '@features/schedule/ics';
import { parseIcs } from '@features/schedule/ics-import';
import type { AgendaItem } from '@features/schedule/agenda';
import {
  leadLabel,
  MISSED_LOOKBACK_DAYS,
  missedItems,
  missedLabel,
  normalizeLead,
  SCHEDULE_LEAD_OPTIONS,
} from '@features/schedule/schedule-notify';
import type { TaskCard } from '@features/schedule/task-cards';

const TOKYO: IcsZone = { kind: 'tokyo' };
const STAMP = new Date(Date.UTC(2026, 9, 11, 3, 4, 5));
const unfold = (t: string): string[] => t.replace(/\r\n[ \t]/g, '').split('\r\n');

function item(over: Partial<AgendaItem> = {}): AgendaItem {
  return {
    key: 'k', lid: 'n1', line: 3, text: '打ち合わせ', done: false,
    date: '2026-08-25', time: '14:00', timeEnd: null, until: null, repeat: null, ...over,
  };
}
const lines = (items: AgendaItem[], alarmMinutes?: number, zone: IcsZone = TOKYO): string[] =>
  unfold(buildIcs(items, { stamp: STAMP, zone, ...(alarmMinutes === undefined ? {} : { alarmMinutes }) }).text);

describe('.ics のアラーム(VALARM)', () => {
  it.each([
    [5, '-PT5M'],
    [15, '-PT15M'],
    [30, '-PT30M'],
    [60, '-PT1H'],
  ])('🔴 %i 分前 → TRIGGER:%s(時刻つきの予定の中に 1 つ)', (min, trigger) => {
    const l = lines([item()], min);
    const a = l.indexOf('BEGIN:VALARM');
    expect(a).toBeGreaterThan(l.indexOf('BEGIN:VEVENT'));
    expect(l.slice(a, a + 5)).toEqual(['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:打ち合わせ', `TRIGGER:${trigger}`, 'END:VALARM']);
    expect(l.filter((x) => x === 'BEGIN:VALARM')).toHaveLength(1);
    // VEVENT の内側(END:VEVENT より前)
    expect(l.indexOf('END:VALARM')).toBeLessThan(l.indexOf('END:VEVENT'));
  });

  it('🔴 「なし」(0)と、渡さないときは付けない', () => {
    expect(lines([item()], 0).join('\n')).not.toContain('VALARM');
    expect(lines([item()]).join('\n')).not.toContain('VALARM');
  });

  it('🔴 終日の予定には付けない(時刻つきの隣は付く ── 対照群)', () => {
    const l = lines([item({ line: 1, time: null, text: '終日' }), item({ line: 2, text: '時刻' })], 15);
    expect(l.filter((x) => x === 'BEGIN:VALARM')).toHaveLength(1);
    const allDay = l.slice(l.indexOf('UID:pkc3-n1-L1@pkc3'), l.indexOf('END:VEVENT'));
    expect(allDay.join('\n')).not.toContain('VALARM');
  });

  it('🔑 UTC で書く端末でも付く(繰り返しの予定にも 1 つ)', () => {
    const l = lines([item({ repeat: 'week' })], 30, { kind: 'utc', offsetMinutes: () => 330 });
    expect(l).toContain('TRIGGER:-PT30M');
    expect(l.filter((x) => x === 'BEGIN:VALARM')).toHaveLength(1);
  });

  it('🔴 往復:アラーム付きで書いて読み戻しても、予定は同じ(アラームの字が予定に混ざらない)', () => {
    const items = [item({ text: '会議' }), item({ line: 4, text: '昼', date: '2026-08-26', time: '12:00', timeEnd: '13:00' })];
    const withAlarm = parseIcs(buildIcs(items, { stamp: STAMP, zone: TOKYO, alarmMinutes: 15 }).text);
    const without = parseIcs(buildIcs(items, { stamp: STAMP, zone: TOKYO }).text);
    expect(withAlarm.events.length).toBe(2);
    expect(withAlarm.events).toEqual(without.events);
    expect(withAlarm.events.map((e) => e.summary)).toEqual(['会議', '昼']);
    // 🔴 アラームの DESCRIPTION が予定の説明に混ざらない(混ざると往復のたびに説明が増える)
    expect(withAlarm.events.map((e) => e.description)).toEqual(['', '']);
  });
});

describe('選べる時間', () => {
  it('なし / 5分前 / 15分前 / 30分前 / 1時間前 の 5 つで、既定の丸めは 15', () => {
    expect(SCHEDULE_LEAD_OPTIONS.map(leadLabel)).toEqual(['なし', '5分前', '15分前', '30分前', '1時間前']);
    expect(normalizeLead(7)).toBe(15);
    expect(normalizeLead(Number.NaN)).toBe(15);
    expect(normalizeLead(0)).toBe(0);
  });
});

const card = (over: Partial<TaskCard> = {}): TaskCard =>
  ({ lid: 'a', line: 3, text: '打ち合わせ', done: false, date: '2026-08-27', time: '14:00', until: null, repeat: null, ...over }) as TaskCard;
const ms = (d: number, h: number, m = 0): number => new Date(2026, 7, d, h, m, 0, 0).getTime();

describe('見逃した予定の数え方', () => {
  it('🔴 境界:前に開いた時刻ちょうどは数えない / いまちょうどは数える', () => {
    const from = ms(27, 14, 0);
    expect(missedItems([card()], from, ms(27, 15))).toHaveLength(0); // 14:00 ちょうど = 開いていた間
    expect(missedItems([card({ time: '14:01' })], from, ms(27, 15))).toHaveLength(1);
    expect(missedItems([card({ time: '15:00' })], from, ms(27, 15))).toHaveLength(1);
    expect(missedItems([card({ time: '15:01' })], from, ms(27, 15))).toHaveLength(0); // まだ来ていない
  });

  it('🔴 済んだ項目は数えない(対照群:済んでいなければ数える)', () => {
    const from = ms(27, 9);
    expect(missedItems([card({ done: true })], from, ms(27, 20))).toHaveLength(0);
    expect(missedItems([card()], from, ms(27, 20))).toHaveLength(1);
  });

  it('🔴 終日(時刻なし)・日付なしは数えない', () => {
    const from = ms(26, 9);
    expect(missedItems([card({ time: null })], from, ms(28, 9))).toHaveLength(0);
    expect(missedItems([card({ date: null, time: null })], from, ms(28, 9))).toHaveLength(0);
  });

  it('🔴 この端末で初めて(前の時刻が無い)なら何も出さない', () => {
    expect(missedItems([card()], null, ms(28, 9))).toHaveLength(0);
    expect(missedItems([card()], ms(28, 9), ms(28, 9))).toHaveLength(0); // 区間が空
  });

  it('繰り返しは回ごとに数える(済んだ回の実体は除く)', () => {
    const rule = card({ date: '2026-08-20', repeat: 'day' as TaskCard['repeat'] });
    // 8/25 10:00 に閉じて 8/27 15:00 に開く → 8/26・8/27 の 14:00 の 2 回(8/25 14:00 も入る = 3 回)
    expect(missedItems([rule], ms(25, 10), ms(27, 15))).toHaveLength(3);
    const done = card({ date: '2026-08-26', repeat: null, done: true, substitutes: '2026-08-26' } as Partial<TaskCard>);
    expect(missedItems([rule, done], ms(25, 10), ms(27, 15))).toHaveLength(2);
  });

  it(`🔑 遡るのは ${MISSED_LOOKBACK_DAYS} 日まで`, () => {
    const to = ms(27, 15);
    const old = card({ date: '2026-06-01' }); // 約 87 日前
    expect(missedItems([old], new Date(2026, 4, 1).getTime(), to)).toHaveLength(0);
    const edge = card({ date: '2026-07-28', time: '16:00' }); // 30 日前 16:00(上限の内側)
    expect(missedItems([edge], new Date(2026, 4, 1).getTime(), to)).toHaveLength(1);
  });

  it('1 行の字', () => {
    expect(missedLabel(3)).toBe('見逃した予定が 3 件あります');
  });
});
