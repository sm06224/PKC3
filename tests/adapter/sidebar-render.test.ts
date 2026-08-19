import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { SidebarRenderer } from '../../src/adapter/ui/render/sidebar';

function meta(lid: string, order: number, title = 't-' + lid): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

function bootedState(metas: EntryMeta[]): AppState {
  return reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas,
    relations: [],
  }).state;
}

function setup(metas: EntryMeta[]) {
  const root = document.createElement('div');
  const regions = buildShell(root);
  const sidebar = new SidebarRenderer(regions.sidebar);
  const state = bootedState(metas);
  sidebar.render(state);
  const rows = () =>
    Array.from(root.querySelectorAll<HTMLElement>('[data-pkc-entry]'));
  const list = root.querySelector<HTMLElement>('[data-pkc-region="entry-list"]');
  if (!list) throw new Error('no list');
  /**
   * DOM 変異(insertBefore)の実回数を数える ── ノード同一性 assert だけでは
   * remove+re-insert / move を弁別できない(review D-1: 999 move が
   * identity assert を全通過した実証を受けての計装)。
   */
  const countMoves = (fn: () => void): number => {
    let count = 0;
    const original = list.insertBefore.bind(list);
    (list as { insertBefore: typeof list.insertBefore }).insertBefore = ((
      node: Node,
      ref: Node | null,
    ) => {
      count++;
      return original(node, ref);
    }) as typeof list.insertBefore;
    try {
      fn();
    } finally {
      delete (list as Partial<typeof list>).insertBefore;
    }
    return count;
  };
  return { root, sidebar, state, rows, countMoves };
}

describe('sidebar differential rendering (P3-2 DoD)', () => {
  it('renders rows in entry_order', () => {
    const { rows } = setup([meta('a', 2), meta('b', 1)]);
    expect(rows().map((r) => r.getAttribute('data-pkc-entry'))).toEqual(['b', 'a']);
  });

  it('same snapshot → zero DOM mutation (identity AND zero insertBefore)', () => {
    const { sidebar, state, rows, countMoves } = setup([meta('a', 1), meta('b', 2)]);
    const before = rows();
    const moves = countMoves(() => sidebar.render(state)); // 同一断面
    expect(moves).toBe(0);
    const after = rows();
    expect(after.length).toBe(before.length);
    after.forEach((node, i) => expect(node).toBe(before[i]));
  });

  it('head deletion causes zero moves of remaining rows (review A-2 regression pin)', () => {
    const { sidebar, state, rows, countMoves } = setup([
      meta('a', 1),
      meta('b', 2),
      meta('c', 3),
    ]);
    const newMetas = new Map(state.entryMetas);
    newMetas.delete('a');
    const moves = countMoves(() =>
      sidebar.render({ ...state, entryMetas: newMetas, order: ['b', 'c'] }),
    );
    expect(moves).toBe(0); // 削除前置により後続行は move されない
    expect(rows().map((r) => r.getAttribute('data-pkc-entry'))).toEqual(['b', 'c']);
  });

  it('reorder (tail to head) results in correct DOM order with a single move', () => {
    const { sidebar, state, rows, countMoves } = setup([
      meta('a', 1),
      meta('b', 2),
      meta('c', 3),
    ]);
    const moves = countMoves(() =>
      sidebar.render({ ...state, order: ['c', 'a', 'b'] }),
    );
    expect(rows().map((r) => r.getAttribute('data-pkc-entry'))).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(moves).toBe(1);
  });

  it('phase-only change (edit start/commit) does not touch the sidebar', () => {
    const { sidebar, state, rows, countMoves } = setup([meta('a', 1), meta('b', 2)]);
    const before = rows();
    let s = reduce(state, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    sidebar.render(s);
    const moves = countMoves(() => {
      s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '# A' }).state;
      sidebar.render(s);
      s = reduce(s, { type: 'START_EDIT' }).state;
      sidebar.render(s);
      s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: 'x' }).state;
      sidebar.render(s);
      s = reduce(s, { type: 'COMMIT_EDIT' }).state;
      sidebar.render(s);
    });
    expect(moves).toBe(0);
    const after = rows();
    // 編集の開始〜確定を通して行ノードは 1 つも作り直されない(PKC2 #1030 の構造対策)
    after.forEach((node, i) => expect(node).toBe(before[i]));
  });

  it('selection change patches attributes only, reusing row nodes', () => {
    const { sidebar, state, rows } = setup([meta('a', 1), meta('b', 2)]);
    const before = rows();
    let s = reduce(state, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    sidebar.render(s);
    expect(before[0]?.hasAttribute('data-pkc-selected')).toBe(true);
    s = { ...s, selectedLid: 'b', openBody: null };
    sidebar.render(s);
    const after = rows();
    after.forEach((node, i) => expect(node).toBe(before[i]));
    expect(before[0]?.hasAttribute('data-pkc-selected')).toBe(false);
    expect(before[1]?.hasAttribute('data-pkc-selected')).toBe(true);
  });

  it('title change patches the one row in place; others untouched', () => {
    const { sidebar, state, rows } = setup([meta('a', 1), meta('b', 2)]);
    const before = rows();
    const newMetas = new Map(state.entryMetas);
    newMetas.set('a', { ...meta('a', 1, 'renamed') });
    sidebar.render({ ...state, entryMetas: newMetas });
    const after = rows();
    after.forEach((node, i) => expect(node).toBe(before[i]));
    expect(before[0]?.querySelector('[data-pkc-field="title"]')?.textContent).toBe(
      'renamed',
    );
  });

  it('removing an entry drops only its row; remaining nodes reused', () => {
    const { sidebar, state, rows } = setup([meta('a', 1), meta('b', 2), meta('c', 3)]);
    const before = rows();
    const newMetas = new Map(state.entryMetas);
    newMetas.delete('b');
    sidebar.render({ ...state, entryMetas: newMetas, order: ['a', 'c'] });
    const after = rows();
    expect(after.map((r) => r.getAttribute('data-pkc-entry'))).toEqual(['a', 'c']);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[2]);
  });
});
