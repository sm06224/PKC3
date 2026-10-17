/** @vitest-environment node */
/**
 * 🔴 **予定表の不具合 3 件**(#1087)。
 *
 * A-1 繰り返しの「全部動かす」で、曜日の列(`毎週 月水金`)も回る
 * A-2 本体で保存するたび、同じ中身を見ている別ウィンドウの予定表が空へ戻らない
 * A-3 区切りの空白が全角(U+3000)でも、時刻・繰り返し・曜日の列が読まれる
 */
import { describe, expect, it } from 'vitest';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { repeatMoveAction } from '../../src/adapter/ui/render/schedule-drag';
import { shiftWeekdaysUnit, readRepeatTail, repeatWord } from '../../src/features/schedule/repeat';
import { readLineDate } from '../../src/features/schedule/line-date';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { applyOpened } from '../helpers/open-line';

const SP = '\u3000';

describe('A-1: 「全部」で曜日の列も回る', () => {
  const RULE = '- [ ] 定例 @2026-10-05 毎週 月水金';
  const state = (repeat: string, rawLine: string): AppState =>
    ({
      taskScan: {
        cards: [
          {
            lid: 'e1', line: 0, text: '定例', done: false, date: '2026-10-05', time: null,
            until: null, repeat, substitutes: null, rawLine,
          },
        ],
        totalNotes: 1, scannedNotes: 1, truncated: false,
      },
    }) as unknown as AppState;

  it('🔴 水曜の札を木曜へ「全部」── 日付も列も +1 日(火木土)になる', () => {
    const act = repeatMoveAction(
      state('days:135', RULE),
      { lid: 'e1', line: '0', from: '2026-10-07', repeat: 'days:135' },
      0, '2026-10-07', '2026-10-08', 1, 'all',
    );
    expect(act).toMatchObject({ type: 'SET_TASK_DATE', date: '2026-10-06', repeat: 'days:246' });
    // 本文まで通す(撃たれた手をそのまま書換に当てる)
    const out = applyOpened(RULE + '\n', {
      kind: 'line-date', line: 0, date: '2026-10-06', repeat: (act as unknown as { repeat: never }).repeat,
    });
    expect(out).toBe('- [ ] 定例 @2026-10-06 毎週 火木土\n');
  });

  it('列は週をまたいで回る(金土日を +2 日 → 日月火)', () => {
    expect(shiftWeekdaysUnit('days:567', 2)).toBe('days:127');
    expect(shiftWeekdaysUnit('days:135', -1)).toBe('days:247');
    expect(shiftWeekdaysUnit('days:135', 7)).toBe('days:135');
    expect(repeatWord(shiftWeekdaysUnit('days:135', 1))).toBe('毎週 火木土');
  });

  it('🔴 対照群: 毎週・隔週・毎月は repeat を渡さない(今のまま日付だけ)', () => {
    for (const unit of ['week', 'biweek', 'month']) {
      const act = repeatMoveAction(
        state(unit, '- [ ] x @2026-10-05 毎週'),
        { lid: 'e1', line: '0', from: '2026-10-07', repeat: unit },
        0, '2026-10-07', '2026-10-08', 1, 'all',
      );
      expect(act, unit).toMatchObject({ type: 'SET_TASK_DATE', date: '2026-10-06' });
      expect(act as object, unit).not.toHaveProperty('repeat');
    }
    expect(shiftWeekdaysUnit('biweek', 3)).toBe('biweek');
  });
});

describe('A-2: 同じ container の再読込で予定の札を残す', () => {
  const meta = (lid: string): EntryMeta => ({
    lid, title: lid, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1,
    status: null, date: null, archived: false, bodyChars: null,
  });
  const card = (lid: string) => ({
    lid, line: 0, text: 'x', done: false, date: null, time: null,
  });
  const withScan = (): AppState => ({
    ...initialState,
    cid: 'c1',
    taskScan: { cards: [card('a'), card('gone')], totalNotes: 2, scannedNotes: 2, truncated: false },
  } as unknown as AppState);

  it('🔴 同じ cid: 札は残り、消えた lid だけ落ち、集め直しも頼む', () => {
    const out = reduce(withScan(), { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    expect(out.state.taskScan?.cards.map((c) => c.lid)).toEqual(['a']);
    expect(out.events).toContainEqual({ type: 'REQUEST_TASK_SCAN' });
  });

  it('生きている札だけなら同じ参照のまま', () => {
    const s = { ...withScan(), taskScan: { cards: [card('a')], totalNotes: 1, scannedNotes: 1, truncated: false } } as unknown as AppState;
    const out = reduce(s, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    expect(out.state.taskScan).toBe(s.taskScan);
  });

  it('🔴 別 container なら捨てる(lid の偶然衝突を持ち越さない)', () => {
    const out = reduce(withScan(), { type: 'SYS_BOOTED', cid: 'c2', metas: [meta('a')], relations: [] });
    expect(out.state.taskScan).toBeNull();
    expect(out.events).toContainEqual({ type: 'REQUEST_TASK_SCAN' });
  });
});

describe('A-3: 区切りの空白が全角でも読まれる', () => {
  it('🔴 日付と繰り返しのあいだ', () => {
    expect(readLineDate(`会議 @2026-10-17${SP}毎週`)).toMatchObject({ date: '2026-10-17', repeat: 'week' });
  });
  it('🔴 日付と時刻のあいだ(時刻も取れ、後ろの繰り返しも付く)', () => {
    expect(readLineDate(`会議 @2026-10-17${SP}14:00`)).toMatchObject({ date: '2026-10-17', time: '14:00', repeat: null });
    expect(readLineDate(`会議 @2026-10-17${SP}14:00${SP}毎週`)).toMatchObject({ time: '14:00', repeat: 'week' });
  });
  it('🔴 毎週と曜日の列のあいだ・列の中', () => {
    expect(readLineDate(`会議 @2026-10-17${SP}毎週${SP}月水金`)?.repeat).toBe('days:135');
    expect(readRepeatTail(`${SP}毎週${SP}月${SP}水${SP}金`)?.unit).toBe('days:135');
  });
  it('全角の数字・コロンも読む(台帳 #1852 束 E1、依頼 188。以前は「今までどおり読まない」を pin していた)', () => {
    expect(readLineDate('会議 @２０２６-10-17')).toMatchObject({ date: '2026-10-17' });
    expect(readLineDate(`会議 @2026-10-17${SP}１４：００`)?.time).toBe('14:00');
  });
  it('本文の書換: 全角空白で書かれた行でも壊さず書き換える', () => {
    const body = `- [ ] 会議 @2026-10-17${SP}14:00${SP}毎週${SP}月水金 です\n`;
    expect(applyOpened(body, { kind: 'line-date', line: 0, date: '2026-10-18', time: '14:00' })).toBe(
      '- [ ] 会議 @2026-10-18 14:00 毎週 月水金 です\n',
    );
    // 外すときも、前後の字を巻き込まない
    expect(applyOpened(body, { kind: 'line-date', line: 0, date: null })).toBe('- [ ] 会議 です\n');
  });
});
