/** @vitest-environment happy-dom */
/**
 * 予定の面の「済んだ」の扱い(K1)。
 * K1: 取り込んだ ToDo(frontmatter `status: done`)の日付つきノートは、済みとして扱う
 *     (赤い期限切れにしない / 「済み」を畳めば隠れる / 件数に入る)。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { scheduleItemsOf } from '../../src/adapter/ui/render/schedule-items';
import { itemOfNote } from '../../src/features/schedule/agenda';
import { taskCardsOf } from '../../src/features/schedule/task-cards';

const TODAY = new Date(2026, 7, 23);

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    entryOrder: Number(lid.slice(1)) || 0,
    status: null,
    date: null,
    archived: false,
    bodyChars: 10,
    ...over,
  };
}

function stateOf(metas: EntryMeta[], over: Partial<AppState> = {}, cardsOf?: [string, string]): AppState {
  const cards = cardsOf ? taskCardsOf(cardsOf[0], cardsOf[1]) : [];
  return {
    ...initialState,
    entryMetas: new Map(metas.map((m) => [m.lid, m])),
    order: metas.map((m) => m.lid),
    taskScan: { cards, totalNotes: 1, scannedNotes: 1, truncated: false },
    ...over,
  } as AppState;
}

describe('K1: 済んだ ToDo のノート', () => {
  it('status: done のノートの予定は done になる(open は done ではない)', () => {
    expect(itemOfNote(meta('e1', { date: '2026-08-01', status: 'done' })).done).toBe(true);
    expect(itemOfNote(meta('e2', { date: '2026-08-01', status: 'open' })).done).toBe(false);
    expect(itemOfNote(meta('e3', { date: '2026-08-01', status: null })).done).toBe(false);
  });

  const metas = [
    meta('e1', { date: '2026-08-01', status: 'done' }),
    meta('e2', { date: '2026-08-02', status: 'open' }),
  ];

  it('「済み」を畳んでいるとき、済んだノートは出ない', () => {
    const r = scheduleItemsOf(stateOf(metas, { showDoneTasks: false }));
    expect(r.notes.map((n) => n.lid)).toEqual(['e2']);
    expect(r.items.map((n) => n.lid)).toEqual(['e2']);
    expect(r.doneNotes).toBe(1);
  });

  it('「済み」を出しているときは済んだノートも出る', () => {
    const r = scheduleItemsOf(stateOf(metas, { showDoneTasks: true }));
    expect(r.notes.map((n) => n.lid)).toEqual(['e1', 'e2']);
  });

  it('面の「済み(N)」に、済んだノートが数えられる', () => {
    const host = document.createElement('div');
    document.body.append(host);
    new ScheduleRenderer(host, () => TODAY).render(stateOf(metas, { showDoneTasks: false }));
    const text = host.querySelector('[data-pkc-field="schedule-done"]')?.closest('label')?.textContent ?? '';
    expect(text).toContain('済み(1)');
  });
});
