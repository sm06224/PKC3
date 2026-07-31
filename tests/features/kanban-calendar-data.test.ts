import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { groupTodosByStatus } from '../../src/features/kanban/kanban-data';
import {
  groupTodosByDate,
  getMonthGrid,
  dateKey,
} from '../../src/features/calendar/calendar-data';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'todo',
    createdAt: null,
    updatedAt: null,
    entryOrder: 0,
    status: 'open',
    date: null,
    archived: false,
    ...over,
  };
}

describe('kanban-data(抽出列駆動 ── body を読まない)', () => {
  it('todo を status で振り分け、archived は常に除外、入力順を保持', () => {
    const grouped = groupTodosByStatus([
      meta('a'),
      meta('b', { status: 'done' }),
      meta('c', { archived: true }),
      meta('d', { archetype: 'text', status: null }),
      meta('e'),
    ]);
    expect(grouped.open.map((m) => m.lid)).toEqual(['a', 'e']);
    expect(grouped.done.map((m) => m.lid)).toEqual(['b']);
  });

  it("status null / 不明値は 'open' 扱い(todo は常にどこかの列に立つ)", () => {
    const grouped = groupTodosByStatus([meta('x', { status: null })]);
    expect(grouped.open.map((m) => m.lid)).toEqual(['x']);
  });
});

describe('calendar-data', () => {
  it('date を持つ todo だけを日付ごとにまとめ、showArchived を尊重', () => {
    const metas = [
      meta('a', { date: '2026-08-01' }),
      meta('b', { date: '2026-08-01', archived: true }),
      meta('c'), // date なし
      meta('d', { date: '2026-08-02', archetype: 'text' }),
    ];
    expect(groupTodosByDate(metas, false)['2026-08-01']?.map((m) => m.lid)).toEqual(['a']);
    expect(groupTodosByDate(metas, true)['2026-08-01']?.map((m) => m.lid)).toEqual([
      'a',
      'b',
    ]);
    expect(groupTodosByDate(metas, true)['2026-08-02']).toBeUndefined();
  });

  it('月間グリッド: 2026-08 は土曜始まり 31 日', () => {
    const grid = getMonthGrid(2026, 8);
    expect(grid[0]).toEqual([null, null, null, null, null, null, 1]); // 8/1 = Sat
    const days = grid.flat().filter((d) => d !== null);
    expect(days.length).toBe(31);
    expect(days[30]).toBe(31);
    expect(dateKey(2026, 8, 3)).toBe('2026-08-03');
  });
});
