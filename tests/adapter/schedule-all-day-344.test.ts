/** @vitest-environment happy-dom */
/**
 * 🔴 **札の「終日」と、期間・繰り返しのノートを掴んで動かす**(台帳 #344 の残り)。
 *
 * ① 札の字: 終日と明示した予定には「終日」と出す。時刻を書かなかっただけ(時刻未定)の予定には何も出さない(区別する)
 * ② 掴んで落とす: 期間のノートは「掴んだ日が落とした日に来る」ように開始をずらす(長さを保つ)。繰り返しのノートは規則ごと動く
 *    (行の繰り返しのように小窓で聞かない ── ノートには「その回だけ」を持つ行が無い)。単日のノートは今までどおり
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { createTaskCard, patchTaskCard } from '../../src/adapter/ui/render/task-card';
import { dropTaskCard } from '../../src/adapter/ui/render/schedule-drag';
import type { AgendaItem } from '../../src/features/schedule/agenda';
import type { NoteTime } from '../../src/features/schedule/task-cards';

const item = (over: Partial<AgendaItem> = {}): AgendaItem => ({
  key: 'n1 0',
  lid: 'n1',
  line: 0,
  text: '休み',
  done: false,
  date: '2026-10-20',
  time: null,
  timeEnd: null,
  until: null,
  repeat: null,
  ...over,
});

const whenOf = (card: HTMLElement): HTMLElement => card.querySelector<HTMLElement>('[data-pkc-field="when"]')!;

describe('札の字 (#344 の残り)', () => {
  it('🔴 終日と明示した予定には「終日」と出て、印が付く。時刻未定には出ない', () => {
    const a = createTaskCard(item({ allDay: true }));
    patchTaskCard(a, item({ allDay: true }), '休み', 2026, false);
    expect(whenOf(a).textContent).toBe('終日');
    expect(whenOf(a).hidden).toBe(false);
    expect(a.hasAttribute('data-pkc-task-allday')).toBe(true);

    const b = createTaskCard(item());
    patchTaskCard(b, item(), '休み', 2026, false);
    expect(whenOf(b).hidden, '時刻未定の札に「終日」と出ている').toBe(true);
    expect(b.hasAttribute('data-pkc-task-allday')).toBe(false);
  });

  it('日付を出す面では「10/20 終日」/ 時刻つきは時刻のまま / 札の使い回しで印が外れる', () => {
    const a = createTaskCard(item({ allDay: true }));
    patchTaskCard(a, item({ allDay: true }), '休み', 2026, true);
    expect(whenOf(a).textContent).toMatch(/終日$/);
    patchTaskCard(a, item({ time: '09:00' }), '休み', 2026, false);
    expect(whenOf(a).textContent).toBe('09:00');
    expect(a.hasAttribute('data-pkc-task-allday')).toBe(false);
  });
});

function noteDrag(noteTimes: NoteTime[], date: string, grabbed: { from: string; repeat?: string }, dropDate: string) {
  const d = new Dispatcher();
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      { lid: 'n1', title: '出張', archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date, archived: false, bodyChars: null },
    ],
    relations: [],
  });
  d.dispatch({ type: 'SET_TASK_SCAN', scan: { cards: [], noteTimes, totalNotes: 1, scannedNotes: 1, truncated: false } });
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  const host = document.createElement('div');
  document.body.append(host);
  dropTaskCard(d, { lid: 'n1', line: '', from: grabbed.from, repeat: grabbed.repeat ?? '' }, dropDate, host);
  return sent.filter((a) => a.type === 'SET_ENTRY_DATE');
}

describe('ノート 1 件の予定を掴んで落とす (#344 の残り)', () => {
  it('🔴 期間のノート: 3 日目の札を掴んで落とすと、全体が同じ日数ずれる(長さは変わらない)', () => {
    const sent = noteDrag([{ lid: 'n1', date: '2026-10-20', time: null, until: '2026-10-22' }], '2026-10-20', { from: '2026-10-22' }, '2026-10-30');
    // 22 → 30 は +8 日 ⇒ 開始 20 → 28
    expect(sent).toEqual([{ type: 'SET_ENTRY_DATE', lid: 'n1', date: '2026-10-28' }]);
  });

  it('🔴 繰り返しのノート: 小窓で聞かず、規則ごと動く(掴んだ回が落とした日に来る)', () => {
    const sent = noteDrag([{ lid: 'n1', date: '2026-10-19', time: null, repeat: 'week' }], '2026-10-19', { from: '2026-10-26', repeat: 'week' }, '2026-10-28');
    // 26(月)→ 28(水)は +2 日 ⇒ 開始 19 → 21
    expect(sent).toEqual([{ type: 'SET_ENTRY_DATE', lid: 'n1', date: '2026-10-21' }]);
    expect(document.querySelector('[data-pkc-region="app-dialog"], dialog'), '小窓が出ている').toBeNull();
  });

  it('対照群: 単日のノートは落とした日そのもの(今までどおり)。日付なしへ外すときも日付ごと外れる', () => {
    expect(noteDrag([], '2026-10-20', { from: '2026-10-20' }, '2026-10-27')).toEqual([
      { type: 'SET_ENTRY_DATE', lid: 'n1', date: '2026-10-27' },
    ]);
    expect(
      noteDrag([{ lid: 'n1', date: '2026-10-20', time: null, until: '2026-10-22' }], '2026-10-20', { from: '2026-10-21' }, ''),
    ).toEqual([{ type: 'SET_ENTRY_DATE', lid: 'n1', date: null }]);
  });

  it('掴んだ日が取れない荷物(古い)は、落とした日そのものを使う(当てずっぽうでずらさない)', () => {
    expect(
      noteDrag([{ lid: 'n1', date: '2026-10-20', time: null, until: '2026-10-22' }], '2026-10-20', { from: '' }, '2026-10-30'),
    ).toEqual([{ type: 'SET_ENTRY_DATE', lid: 'n1', date: '2026-10-30' }]);
  });
});
