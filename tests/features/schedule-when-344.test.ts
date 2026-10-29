/** @vitest-environment node */
/**
 * 🔴 **ノート 1 件の予定(前書きの `date:`)にも、期間・繰り返し・終日を書ける**(台帳 #344 の残り)。
 *
 * 書き方は**行の記法と同じ文法**(`schedule-when.ts`):
 * `date: 2026-10-20..2026-10-22` / `date: 2026-10-20 毎週` / `date: 2026-10-20 14:00 毎週` / `date: 2026-10-20 終日`。
 *
 * 守る主張:
 * ① これまでの形(日付 / 日付 + 時刻)の読みは 1 バイトも変わらない。読めない形は読まない
 * ② 抽出列には開始の日だけ(保存の形は変えない)。期間の終わり・刻み・終日は走査が運ぶ
 * ③ 予定の束には、行の予定と同じように期間は全部の日・繰り返しは窓の中の回が載る
 * ④ 動かすとき、形を保つ(期間の長さ・曜日の列・終日)。黙って 毎週 や期間の終わりを落とさない
 */
import { describe, expect, it } from 'vitest';
import { parseScheduleWhen, withScheduleDate } from '../../src/features/schedule/schedule-when';
import { extractSchedule } from '../../src/features/schedule/schedule-keys';
import { noteTimeCards, noteTimeOf, noteWhenFor, replaceNoteTime } from '../../src/features/schedule/task-cards';
import { buildAgenda, itemOfNote } from '../../src/features/schedule/agenda';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const fm = (date: string, rest = ''): string => `---\ndate: ${date}\n${rest}---\n本文\n`;

describe('読み (#344 の残り)', () => {
  it('🔴 これまでの形は変わらない(日付 / 日付 + 時刻)', () => {
    expect(parseScheduleWhen('2026-10-20')).toEqual({ date: '2026-10-20', until: null, time: null, repeat: null, allDay: false, extended: false });
    expect(parseScheduleWhen('2026-10-20 14:00')).toMatchObject({ date: '2026-10-20', time: '14:00', extended: false });
    expect(parseScheduleWhen('2026-10-20T09:30')).toMatchObject({ time: '09:30', extended: false });
  });

  it('期間 / 繰り返し / 終日 / 組み合わせ', () => {
    expect(parseScheduleWhen('2026-10-20..2026-10-22')).toMatchObject({ date: '2026-10-20', until: '2026-10-22', extended: true });
    expect(parseScheduleWhen('2026-10-20 毎週')).toMatchObject({ repeat: 'week', until: null, time: null });
    expect(parseScheduleWhen('2026-10-20 14:00 毎週')).toMatchObject({ repeat: 'week', time: '14:00' });
    expect(parseScheduleWhen('2026-10-20..2026-12-31 毎週')).toMatchObject({ repeat: 'week', until: '2026-12-31' });
    expect(parseScheduleWhen('2026-10-20 終日')).toMatchObject({ allDay: true, time: null });
    expect(parseScheduleWhen('2026-10-20 終日 毎週')).toMatchObject({ allDay: true, repeat: 'week' });
    // 全角・〜 も行と同じに読む
    expect(parseScheduleWhen('２０２６-１０-２０〜２０２６-１０-２２')).toMatchObject({ until: '2026-10-22' });
  });

  it('🔴 読めない形は読まない(余計な字が残る / 逆順 / 幅 / 振替 / 散文)', () => {
    for (const bad of [
      '2026-10-20 毎週 打合せ',
      '2026-10-22..2026-10-20',
      '2026-10-20..',
      '2026-10-20 14:00..15:00 毎週',
      '2026-10-20 毎週 振替2026-10-13',
      '2026-10-20 終日の休み',
      '週明け',
      '',
    ]) {
      expect(parseScheduleWhen(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('抽出列と走査 (#344 の残り)', () => {
  it('🔴 抽出列には開始の日だけが入る(保存の形は変えない)', () => {
    expect(extractSchedule(fm('2026-10-20..2026-10-22')).date).toBe('2026-10-20');
    expect(extractSchedule(fm('2026-10-20 毎週')).date).toBe('2026-10-20');
    expect(extractSchedule(fm('2026-10-20 終日')).date).toBe('2026-10-20');
  });

  it('noteTimeOf: 期間・刻み・終日のどれかがあれば運ぶ。日付だけは運ばない(従来どおり)', () => {
    expect(noteTimeOf('n', fm('2026-10-20'))).toBeNull();
    expect(noteTimeOf('n', fm('2026-10-20..2026-10-22'))).toEqual({ lid: 'n', date: '2026-10-20', time: null, until: '2026-10-22', raw: '2026-10-20..2026-10-22' });
    expect(noteTimeOf('n', fm('2026-10-20 14:00 毎週'))).toEqual({ lid: 'n', date: '2026-10-20', time: '14:00', repeat: 'week', raw: '2026-10-20 14:00 毎週' });
    expect(noteTimeOf('n', fm('2026-10-20 終日'))).toEqual({ lid: 'n', date: '2026-10-20', time: null, allDay: true, raw: '2026-10-20 終日' });
    // 担当だけ(従来)は変わらない
    expect(noteTimeOf('n', fm('2026-10-20', 'owner: 山田\n'))).toEqual({ lid: 'n', date: '2026-10-20', time: null, owner: '山田' });
  });

  it('replaceNoteTime: 期間・刻み・終日が変わったら差し替える(同じなら同じ配列)', () => {
    const a = replaceNoteTime(undefined, 'n', fm('2026-10-20..2026-10-22'))!;
    expect(replaceNoteTime(a, 'n', fm('2026-10-20..2026-10-22'))).toBe(a);
    const b = replaceNoteTime(a, 'n', fm('2026-10-20..2026-10-25'))!;
    expect(b).not.toBe(a);
    expect(b[0]!.until).toBe('2026-10-25');
    expect(replaceNoteTime(b, 'n', fm('2026-10-20'))).toEqual([]);
  });

  it('noteWhenFor: 抽出列の日付と食い違う組は使わない', () => {
    const scan = { noteTimes: [{ lid: 'n', date: '2026-10-20', time: null, until: '2026-10-22' }] };
    expect(noteWhenFor(scan, 'n', '2026-10-20').until).toBe('2026-10-22');
    expect(noteWhenFor(scan, 'n', '2026-10-21').until).toBeNull();
    expect(noteWhenFor(null, 'n', '2026-10-20')).toEqual({ time: null, until: null, repeat: null, allDay: false, raw: null });
  });

  it('アラーム / 見逃しの数え方には、繰り返しと時刻を渡す', () => {
    const cards = noteTimeCards(
      { noteTimes: [{ lid: 'n', date: '2026-10-20', time: '14:00', repeat: 'week' }] },
      new Map([['n', { title: '定例', date: '2026-10-20', status: null }]]),
    );
    expect(cards[0]).toMatchObject({ repeat: 'week', time: '14:00', text: '定例' });
  });
});

describe('予定の束 (#344 の残り)', () => {
  const meta = (date: string): EntryMeta => ({
    lid: 'n',
    title: '出張',
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date,
    archived: false,
    bodyChars: null,
  });

  it('🔴 期間のノートは、出る日ぜんぶの束に載る(1 日だけに置かれない)', () => {
    const g = buildAgenda([itemOfNote(meta('2026-10-20'), null, { until: '2026-10-22' })], '2026-10-20');
    expect(g.map((x) => x.date)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
    expect(new Set(g.flatMap((x) => x.cards.map((c) => c.key))).size, '鍵が日をまたいで重複している').toBe(3);
  });

  it('🔴 繰り返しのノートは、今日から先の窓に毎週載る', () => {
    const g = buildAgenda([itemOfNote(meta('2026-10-20'), '14:00', { repeat: 'week' })], '2026-10-20', false, { horizonDays: 21 });
    expect(g.map((x) => x.date)).toEqual(['2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10']);
    expect(g[1]!.cards[0]).toMatchObject({ time: '14:00', line: null, repeat: 'week' });
  });

  it('終日のノートは allDay で載り、先頭に並ぶ', () => {
    const g = buildAgenda(
      [itemOfNote(meta('2026-10-20'), '10:00'), { ...itemOfNote(meta('2026-10-20'), null, { allDay: true }), key: 'k2', lid: 'm' }],
      '2026-10-20',
    );
    expect(g[0]!.cards.map((c) => c.allDay === true)).toEqual([true, false]);
  });
});

describe('動かす (#344 の残り)', () => {
  it('🔴 期間は長さを保つ / 終日は残る / 曜日の列は一緒に回る', () => {
    expect(withScheduleDate('2026-10-20..2026-10-22', '2026-10-27')).toBe('2026-10-27..2026-10-29');
    expect(withScheduleDate('2026-10-20 終日', '2026-10-21')).toBe('2026-10-21 終日');
    expect(withScheduleDate('2026-10-19 毎週 月水金', '2026-10-20')).toBe('2026-10-20 毎週 火木土');
    expect(withScheduleDate('2026-10-20 14:00 毎週', '2026-10-27')).toBe('2026-10-27 14:00 毎週');
  });

  it('これまでの形は今までどおり(時刻を残す)', () => {
    expect(withScheduleDate('2026-10-20 14:00', '2026-10-21')).toBe('2026-10-21 14:00');
    expect(withScheduleDate('2026-10-20', '2026-10-21')).toBe('2026-10-21');
    expect(withScheduleDate('', '2026-10-21')).toBe('2026-10-21');
  });

  it('🔴 本文の書き換え(entry-date)でも形が残る', () => {
    const body = '---\ndate: 2026-10-20..2026-10-22\ntitle: x\n---\n本文\n';
    const next = applyBodyRewrite(body, { kind: 'entry-date', date: '2026-10-23' });
    expect(next).toContain('date: 2026-10-23..2026-10-25');
    expect(next).toContain('title: x');
    expect(next).toContain('本文');
  });
});
