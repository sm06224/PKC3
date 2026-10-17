/** @vitest-environment node */
/**
 * 🔴 **予定表の日付の読み方**(台帳 #1852 束 E1。Gemini 裁定 = #1163 の依頼 186 / 187 / 188 / 189 / 192 / 283 の B / 284 / 130 / 57 の 1)。
 *
 * 守る主張:
 * 1. 全角の数字・コロン・`/` 区切り・曜日の括弧・1 桁の時を読む ── ⚠ **記法の範囲(`start`/`end`)は原文の字数**で数える
 *    (写しの長さで数えると、書き換え・札の字が別の字を壊す)。入力の日本語形は総当たりで当てる
 * 2. いま読めている形を 1 つも読めなくしない(`@2026-10-20/21`・括弧だけで時刻が無い・離れた `3:00`)
 * 3. 読めない `@…` は「日付として読めません」と出す。読めた物には出さない
 * 4. 前書きの `date:` は時刻・全角・`/` つきでも日付の部分を読む
 * 5. 外したノート(「出すもの」で外した / 片付けた)の予定は鳴らさず、見逃しにも数えない
 * 6. 日付だけの予定にも、起動したとき「今日の予定 N 件」と言う
 */
import { describe, expect, it } from 'vitest';
import {
  allDateTokens,
  readLineDate,
  stripLineDate,
  unreadableDateTokens,
} from '../../src/features/schedule/line-date';
import { dateOfFrontmatterText, foldWideDateChars, padClockHour } from '../../src/features/schedule/schedule-date';
import { readScheduleDate } from '../../src/features/schedule/schedule-keys';
import { DATE_UNREADABLE_TEXT, renderMarkdown } from '../../src/features/markdown/markdown-render';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { dueAlarms, silencedLidsOf } from '../../src/features/alarm/alarm-due';
import {
  missedItems,
  upcomingCounts,
  upcomingLabel,
} from '../../src/features/schedule/schedule-notify';
import { taskCardsOf, type TaskCard } from '../../src/features/schedule/task-cards';

describe('全角・スラッシュ・曜日の括弧・1 桁の時 ── 入力の形の総当たり(依頼 188 / 189)', () => {
  const DATES: readonly [string, string][] = [
    ['2026-10-20', '2026-10-20'],
    ['２０２６-１０-２０', '2026-10-20'],
    ['2026/10/20', '2026-10-20'],
    ['２０２６／１０／２０', '2026-10-20'],
  ];
  const TIMES: readonly [string, string | null][] = [
    ['', null],
    ['14:00', '14:00'],
    ['14：00', '14:00'],
    ['１４：００', '14:00'],
    ['9:00', '09:00'],
    ['９：００', '09:00'],
  ];
  const PARENS = ['', '(火)', '（火）', '(火曜)', '（火曜日）'] as const;

  it('日付 × 時刻 × 曜日の括弧の全組み合わせで、値が揃い、記法の範囲が原文どおり', () => {
    let n = 0;
    for (const [rawDate, date] of DATES) {
      for (const [rawTime, time] of TIMES) {
        for (const paren of PARENS) {
          const notation = `@${rawDate}${paren}${rawTime === '' ? '' : ' ' + rawTime}`;
          const line = `- [ ] 会議 ${notation} です`;
          const d = readLineDate(line);
          expect(d, line).not.toBeNull();
          expect(d!.date, line).toBe(date);
          expect(d!.time, line).toBe(time);
          // 括弧は時刻が続くときだけ記法の一部。時刻が無ければ題名に残る(今までと同じ)
          const eaten = rawTime === '' ? `@${rawDate}` : notation;
          expect(line.slice(d!.start, d!.end), line).toBe(eaten);
          const stripped = rawTime !== '' || paren === '' ? '- [ ] 会議 です' : `- [ ] 会議 ${paren} です`;
          expect(stripLineDate(line), line).toBe(stripped);
          n += 1;
        }
      }
    }
    // 空振り防止 ── 4 × 6 × 5 の全部を実際に通った
    expect(n).toBe(120);
  });

  it('書き換えると半角の整った形になり、前後の字は動かない(全角・括弧・1 桁の時の原文を差し替える)', () => {
    const body = '- [ ] 会議 @２０２６／１０／２０(火) ９：００ です\n';
    const out = applyBodyRewrite(body, {
      kind: 'line-date',
      line: 0,
      openLine: '- [ ] 会議 @２０２６／１０／２０(火) ９：００ です',
      date: '2026-10-21',
      time: '09:00',
    });
    expect(out).toBe('- [ ] 会議 @2026-10-21 09:00 です\n');
  });

  it('🔴 いま読めている形は変わらない', () => {
    // 日付の直後の `/` は今までどおり日付の外(`-` に倒さない)
    expect(readLineDate('x @2026-10-20/21')).toMatchObject({ date: '2026-10-20' });
    expect(readLineDate('x @2026-10-20/21')!.end).toBe('x @2026-10-20'.length);
    // 括弧だけで時刻が無ければ、括弧は題名に残る
    expect(stripLineDate('x @2026-10-20(火) 打合せ')).toBe('x (火) 打合せ');
    // 離れた 3:00 は拾わない / 期間・繰り返し・時刻の幅
    expect(readLineDate('@2026-10-20 の 3:00 の予算')).toMatchObject({ time: null });
    expect(readLineDate('@2026/10/20..2026/10/22')).toMatchObject({ date: '2026-10-20', until: '2026-10-22' });
    expect(readLineDate('@2026-10-20 9:00..10:30 毎週')).toMatchObject({
      time: '09:00',
      timeEnd: '10:30',
      repeat: 'week',
    });
    expect(readLineDate('@2026-10-20 9:00 - 10:30')).toMatchObject({ time: '09:00', timeEnd: '10:30' });
  });

  it('値の正規化の 2 つの小道具', () => {
    expect(foldWideDateChars('２０２６／１０／２０ １４：００ABC')).toBe('2026/10/20 14:00ABC');
    expect(foldWideDateChars('2026-10-20')).toBe('2026-10-20');
    expect(padClockHour('9:00')).toBe('09:00');
    expect(padClockHour('09:00')).toBe('09:00');
    expect(padClockHour('9:0')).toBe('9:0');
  });

  it('押せる字(allDateTokens)も、全角・スラッシュの日付を押せる字として数える', () => {
    const line = '- [ ] a @２０２６／１０／２０ b @2026-10-21';
    expect(allDateTokens(line).map((t) => t.date)).toEqual(['2026-10-20', '2026-10-21']);
  });
});

describe('読めない @… は「日付として読めません」と言う(依頼 283 の B)', () => {
  const bad = (line: string): string[] => unreadableDateTokens(line).map((t) => line.slice(t.start, t.end));

  it('日付に見えて読めない形を拾う', () => {
    expect(bad('- [ ] a @2026年10月17日')).toEqual(['@2026年10月17日']);
    expect(bad('- [ ] a @2026/10/5')).toEqual(['@2026/10/5']);
    expect(bad('- [ ] a @2026-10-171')).toEqual(['@2026-10-171']);
    expect(bad('- [ ] a @2026-10-5')).toEqual(['@2026-10-5']);
    expect(bad('- [ ] a @2026-10-20..2026-10-18')).toEqual(['@2026-10-20']);
  });

  it('🔴 読めた物・日付に見えない物・メール・コードの中には出さない(対照群)', () => {
    expect(bad('- [ ] a @2026-10-17')).toEqual([]);
    expect(bad('- [ ] a @２０２６／１０／１７')).toEqual([]);
    expect(bad('- [ ] a @2026-02-31')).toEqual([]); // 形が通れば読まれた側(実在しない日は予定の並びに出て見て直せる)
    expect(bad('単価 @1,500 個数 @3')).toEqual([]);
    expect(bad('連絡は foo@2026-10.example.com へ')).toEqual([]);
    expect(bad('`@2026年10月17日` と書く')).toEqual([]);
    expect(bad('')).toEqual([]);
  });

  it('描画: 入れた面では読めない日付の横に字が出て、読める日付には出ない', () => {
    const on = (md: string): string => renderMarkdown(md, { interactiveDates: true });
    const html = on('- [ ] 会議 @2026年10月17日\n');
    expect(html).toContain(`<span class="pkc-date-warn">${DATE_UNREADABLE_TEXT}</span>`);
    expect(html, '元の字が消えた').toContain('@2026年10月17日');
    // 読める日付と読めない日付が並んでも、両方を正しく扱う(順序・字が崩れない)
    const both = on('@2026/10/5 と @2026-10-17\n');
    expect(both.match(/pkc-date-warn/g), '読めない 1 つにだけ出る').toHaveLength(1);
    expect(both).toContain('data-pkc-date="2026-10-17"');
    expect(on('- [ ] 会議 @2026-10-17\n')).not.toContain('pkc-date-warn');
    // 既定の面(書き出し・印刷)は 1 バイトも変わらない
    expect(renderMarkdown('- [ ] 会議 @2026年10月17日\n', {})).not.toContain('pkc-date-warn');
  });

  it('字は日本語の字だけで、用語集の使わない語を含まない', () => {
    expect(DATE_UNREADABLE_TEXT).toBe('日付として読めません(2026-10-17 の形で書きます)');
  });
});

describe('前書きの date: は時刻・全角・/ つきでも日付を読む(依頼 192 / 284)', () => {
  it('日付の部分だけ取り出す(時刻は捨てる)', () => {
    for (const raw of [
      '2026-10-20',
      '2026-10-20 14:00',
      '2026-10-20T10:00',
      '2026-10-20T10:00:00',
      '2026-10-20T10:00:00Z',
      '２０２６-１０-２０ １４：００',
      '2026/10/20',
      '２０２６／１０／２０',
    ]) {
      expect(dateOfFrontmatterText(raw), raw).toBe('2026-10-20');
    }
  });

  it('🔴 日付でない値・時刻の後ろに字が付く値は読まない(今までどおり)', () => {
    for (const raw of ['', '2026-10-2', '来週', '2026-10-20 午後', '2026-10-20 14:00 頃', '2026年10月20日', 'x2026-10-20']) {
      expect(dateOfFrontmatterText(raw), raw).toBeNull();
    }
  });

  it('前書きの本文から読むと、そのノートは予定表の日付を持つ', () => {
    expect(readScheduleDate({ date: '2026-10-20 14:00' })).toBe('2026-10-20');
    expect(readScheduleDate({ date: '2026-10-20' })).toBe('2026-10-20');
    expect(readScheduleDate({ date: 5 as unknown as string })).toBeNull();
    expect(readScheduleDate({})).toBeNull();
  });
});

describe('外したノートは鳴らさない・見逃しにも数えない(依頼 187)', () => {
  const t = (d: number, h: number, mi: number): number => new Date(2026, 9, d, h, mi).getTime();
  const body = '- [ ] 打合せ @2026-10-20 14:00\n';
  const cards = (lid: string): TaskCard[] => taskCardsOf(lid, body);

  it('silencedLidsOf は、片付けたノートと「出すもの」で外したノートを足す', () => {
    const metas = new Map([
      ['a', { archived: true }],
      ['b', { archived: false }],
      ['c', { archived: false }],
    ]);
    expect([...silencedLidsOf(metas, ['c'])].sort()).toEqual(['a', 'c']);
    expect([...silencedLidsOf(metas, [])]).toEqual(['a']);
  });

  it('🔴 外したノートの予定は鳴らず、見逃しにも数えない。対照群: 外していなければ両方に出る', () => {
    const metas = new Map([['n1', { archived: false }]]);
    const all = cards('n1');
    expect(dueAlarms(all, t(20, 13, 59), t(20, 14, 0), silencedLidsOf(metas, []))).toHaveLength(1);
    expect(dueAlarms(all, t(20, 13, 59), t(20, 14, 0), silencedLidsOf(metas, ['n1']))).toEqual([]);
    expect(missedItems(all, t(20, 13, 0), t(20, 15, 0), silencedLidsOf(metas, []))).toHaveLength(1);
    expect(missedItems(all, t(20, 13, 0), t(20, 15, 0), silencedLidsOf(metas, ['n1']))).toEqual([]);
    // 別のノートを外しても、このノートは鳴る
    expect(dueAlarms(all, t(20, 13, 59), t(20, 14, 0), silencedLidsOf(metas, ['other']))).toHaveLength(1);
  });
});

describe('起動したときの「今日の予定 N 件 / 明日の予定 N 件」(依頼 57 の 1)', () => {
  const cards = (body: string, lid = 'n'): TaskCard[] => taskCardsOf(lid, body);

  it('日付だけの予定・時刻つき・期間・繰り返しを、その日に出る分だけ数える。済んだ・片付けたは数えない', () => {
    const body = [
      '- [ ] 日付だけ @2026-10-20',
      '- [ ] 時刻つき @2026-10-20 14:00',
      '- [ ] 期間 @2026-10-19..2026-10-21',
      '- [ ] 毎週 @2026-10-13 毎週',
      '- [ ] 明日だけ @2026-10-21',
      '- [x] 済んだ @2026-10-20',
      '- [ ] 別の日 @2026-10-25',
    ].join('\n');
    // 10/20(火): 日付だけ・時刻つき・期間・毎週(10/13 から毎週火曜)= 4 / 10/21(水): 期間・明日だけ = 2
    expect(upcomingCounts(cards(body), '2026-10-20')).toEqual({ today: 4, tomorrow: 2 });
    // 片付けたノートは数えない
    expect(upcomingCounts(cards(body), '2026-10-20', new Set(['n']))).toEqual({ today: 0, tomorrow: 0 });
  });

  it('字: 件数のある日だけ言い、両方 0 なら言わない', () => {
    expect(upcomingLabel({ today: 2, tomorrow: 1 })).toBe('今日の予定 2 件 / 明日の予定 1 件');
    expect(upcomingLabel({ today: 0, tomorrow: 1 })).toBe('明日の予定 1 件');
    expect(upcomingLabel({ today: 3, tomorrow: 0 })).toBe('今日の予定 3 件');
    expect(upcomingLabel({ today: 0, tomorrow: 0 })).toBeNull();
  });
});
