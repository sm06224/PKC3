/** @vitest-environment node */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState, type Dispatchable } from '../../src/adapter/state/app-state';
import { MAX_TABS } from '../../src/features/nav/note-tabs';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid, title: 't-' + lid, archetype: 'text', createdAt: null, updatedAt: null,
    entryOrder: order, status: null, date: null, archived: false, bodyChars: null,
  };
}

function boot(n: number, cid = 'c1'): AppState {
  const metas = Array.from({ length: n }, (_, i) => meta('n' + i, i));
  return reduce(initialState, { type: 'SYS_BOOTED', cid, metas, relations: [] }).state;
}

const d = (s: AppState, a: Dispatchable): AppState => reduce(s, a).state;
const lids = (s: AppState): string[] => s.noteTabs.tabs.map((t) => t.lid);

/** 不変条件: 選択があれば active と一致 / タブがあれば active はそのどれか / 0 枚なら null */
function expectConsistent(s: AppState): void {
  if (s.selectedLid !== null && s.entryMetas.has(s.selectedLid)) expect(s.noteTabs.active).toBe(s.selectedLid);
  if (s.noteTabs.tabs.length > 0) expect(lids(s)).toContain(s.noteTabs.active);
  else expect(s.noteTabs.active).toBeNull();
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.ts$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

describe('note tabs: state wiring', () => {
  it('normal select replaces the active tab; a second tab only via NOTE_TAB_OPEN', () => {
    let s = boot(5);
    s = d(s, { type: 'SELECT_ENTRY', lid: 'n0' });
    s = d(s, { type: 'SELECT_ENTRY', lid: 'n1' });
    expect(lids(s)).toEqual(['n1']);
    s = d(s, { type: 'NOTE_TAB_OPEN', lid: 'n2' });
    expect(lids(s)).toEqual(['n1', 'n2']);
    expect(s.selectedLid).toBe('n2');
    expectConsistent(s);
  });

  it('every selectedLid-changing action keeps tabs consistent', () => {
    const steps: Dispatchable[] = [
      { type: 'SELECT_ENTRY', lid: 'n0' },
      { type: 'NOTE_TAB_OPEN', lid: 'n1' },
      { type: 'SELECT_ENTRY', lid: 'n2' },
      { type: 'NAV_HISTORY', dir: 'back' },
      { type: 'NAV_HISTORY', dir: 'forward' },
      { type: 'DESELECT_ENTRY' },
      { type: 'SELECT_ENTRY', lid: 'n3' },
      { type: 'NOTE_TAB_NEXT' },
      { type: 'NOTE_TAB_PREV' },
      { type: 'NOTE_TAB_ACTIVATE', lid: 'n1' },
      { type: 'CREATE_ENTRY', archetype: 'text', lid: 'new1', title: 'x', edit: false },
      { type: 'DELETE_ENTRY', lid: 'new1' },
      { type: 'NOTE_TAB_CLOSE', lid: 'n1' },
      { type: 'NOTE_TAB_REOPEN' },
      { type: 'DELETE_ENTRIES', lids: ['n0', 'n3'] },
    ];
    let s = boot(5);
    const moved = new Set<string>();
    for (const a of steps) {
      const before = s;
      s = d(s, a);
      if (s.selectedLid !== before.selectedLid) moved.add(a.type);
      expectConsistent(s);
    }
    // 経路が実際に通った(空振りでない)
    for (const t of ['SELECT_ENTRY', 'NAV_HISTORY', 'CREATE_ENTRY', 'DELETE_ENTRY', 'NOTE_TAB_NEXT'])
      expect(moved.has(t), t).toBe(true);
  });

  it('deselect keeps the active tab, so the next click replaces instead of adding', () => {
    let s = boot(4);
    s = d(s, { type: 'SELECT_ENTRY', lid: 'n0' });
    s = d(s, { type: 'DESELECT_ENTRY' });
    expect(s.selectedLid).toBeNull();
    expect(s.noteTabs.active).toBe('n0');
    s = d(s, { type: 'SELECT_ENTRY', lid: 'n1' });
    expect(lids(s)).toEqual(['n1']);
  });

  it('a pinned active tab is not replaced by a normal click', () => {
    let s = boot(4);
    s = d(s, { type: 'SET_NOTE_PINS', lids: ['n0'] });
    s = d(s, { type: 'SELECT_ENTRY', lid: 'n0' });
    s = d(s, { type: 'SELECT_ENTRY', lid: 'n1' });
    expect(lids(s)).toEqual(['n0', 'n1']);
    expectConsistent(s);
  });

  it('an editing note cannot be left (select blocked) and its tab survives', () => {
    let s = boot(4);
    s = d(s, { type: 'SELECT_ENTRY', lid: 'n0' });
    s = d(s, { type: 'BODY_LOADED', lid: 'n0', body: 'x' });
    s = d(s, { type: 'START_EDIT' });
    expect(s.phase).toBe('editing');
    const before = s;
    s = d(s, { type: 'SELECT_ENTRY', lid: 'n1' });
    s = d(s, { type: 'NOTE_TAB_OPEN', lid: 'n1' });
    expect(s.noteTabs).toBe(before.noteTabs);
    expect(lids(s)).toEqual(['n0']);
  });

  it('13th open evicts the oldest non-active tab (enforceLimit is chained)', () => {
    let s = boot(14);
    for (let i = 0; i < MAX_TABS + 1; i++) s = d(s, { type: 'NOTE_TAB_OPEN', lid: 'n' + i });
    expect(lids(s)).toHaveLength(MAX_TABS);
    expect(lids(s)).not.toContain('n0');
    expect(s.noteTabs.closed.map((c) => c.lid)).toContain('n0');
    expectConsistent(s);
  });

  it('background open (activate: false) also goes through the limit', () => {
    let s = boot(14);
    for (let i = 0; i < MAX_TABS; i++) s = d(s, { type: 'NOTE_TAB_OPEN', lid: 'n' + i });
    s = d(s, { type: 'NOTE_TAB_OPEN', lid: 'n12', activate: false });
    expect(lids(s)).toHaveLength(MAX_TABS);
    expect(lids(s)).toContain('n12');
    expect(s.selectedLid).toBe('n11');
  });

  it('pinned tabs are not evicted by the limit', () => {
    let s = boot(14);
    s = d(s, { type: 'SET_NOTE_PINS', lids: ['n0'] });
    for (let i = 0; i < MAX_TABS + 1; i++) s = d(s, { type: 'NOTE_TAB_OPEN', lid: 'n' + i });
    expect(lids(s)).toContain('n0');
    expect(lids(s)).not.toContain('n1');
  });

  it('deleting the active tab moves selection to the tab neighbour (right, else left), not the list successor', () => {
    let s = boot(6);
    for (const l of ['n0', 'n1', 'n2']) s = d(s, { type: 'NOTE_TAB_OPEN', lid: l });
    s = d(s, { type: 'NOTE_TAB_ACTIVATE', lid: 'n1' });
    s = d(s, { type: 'DELETE_ENTRY', lid: 'n1' });
    expect(lids(s)).toEqual(['n0', 'n2']);
    expect(s.selectedLid).toBe('n2');
    expect(s.noteTabs.active).toBe('n2');
    s = d(s, { type: 'DELETE_ENTRY', lid: 'n2' });
    expect(s.selectedLid).toBe('n0');
    expect(s.noteTabs.closed.map((c) => c.lid)).not.toContain('n1');
    expectConsistent(s);
  });

  it('🔴 following the tab neighbour does not leave the unseen list successor in history', () => {
    // 対照群: タブが 1 枚なら、削除後の選択は一覧の後継(= n1)── 後継が n1 であることを確かめる
    let c = boot(6);
    c = d(c, { type: 'SELECT_ENTRY', lid: 'n0' });
    c = d(c, { type: 'DELETE_ENTRY', lid: 'n0' });
    expect(c.selectedLid).toBe('n1');
    // タブ n0, n3。n0 を消すとタブの隣 n3 へ従う ── 一覧の後継 n1 は一度も見ていない
    let s = boot(6);
    s = d(s, { type: 'SELECT_ENTRY', lid: 'n3' });
    s = d(s, { type: 'SELECT_ENTRY', lid: 'n5' });
    s = d(s, { type: 'NOTE_TAB_OPEN', lid: 'n0' });
    s = d(s, { type: 'NOTE_TAB_OPEN', lid: 'n3' });
    s = d(s, { type: 'NOTE_TAB_ACTIVATE', lid: 'n0' });
    s = d(s, { type: 'DELETE_ENTRY', lid: 'n0' });
    expect(s.selectedLid).toBe('n3');
    expect(s.selectionHistory.past).not.toContain('n1');
    expect(s.selectionHistory.past[s.selectionHistory.past.length - 1]).toBe('n3');
    // 戻ると、前に見ていたノートへ(見ていない n1 ではない)
    expect(d(s, { type: 'NAV_HISTORY', dir: 'back' }).selectedLid).not.toBe('n1');
    expectConsistent(s);
  });

  it('an action that touches neither selection nor entries returns the same tab state', () => {
    let s = boot(4);
    s = d(s, { type: 'SELECT_ENTRY', lid: 'n0' });
    const r = d(s, { type: 'SET_NOTE_PINS', lids: ['n2'] });
    expect(r).not.toBe(s);
    expect(r.noteTabs).toBe(s.noteTabs);
    expect(r.tabSeq).toBe(s.tabSeq);
  });

  it('deleting a background tab leaves selection and active alone', () => {
    let s = boot(4);
    for (const l of ['n0', 'n1']) s = d(s, { type: 'NOTE_TAB_OPEN', lid: l });
    s = d(s, { type: 'DELETE_ENTRY', lid: 'n0' });
    expect(lids(s)).toEqual(['n1']);
    expect(s.selectedLid).toBe('n1');
  });

  it('closing the last tab deselects; reopen brings it back', () => {
    let s = boot(3);
    s = d(s, { type: 'SELECT_ENTRY', lid: 'n0' });
    s = d(s, { type: 'NOTE_TAB_CLOSE', lid: 'n0' });
    expect(s.noteTabs.tabs).toHaveLength(0);
    expect(s.selectedLid).toBeNull();
    s = d(s, { type: 'NOTE_TAB_REOPEN' });
    expect(s.selectedLid).toBe('n0');
    expect(lids(s)).toEqual(['n0']);
    // 戻せるものが無ければ何も起きない
    expect(d(s, { type: 'NOTE_TAB_REOPEN' })).toBe(s);
  });

  it('reopen skips notes that no longer exist', () => {
    let s = boot(4);
    for (const l of ['n0', 'n1']) s = d(s, { type: 'NOTE_TAB_OPEN', lid: l });
    s = d(s, { type: 'NOTE_TAB_CLOSE', lid: 'n0' });
    s = d(s, { type: 'DELETE_ENTRY', lid: 'n0' });
    expect(d(s, { type: 'NOTE_TAB_REOPEN' })).toBe(s);
  });

  it('move / external only touch the tab set', () => {
    let s = boot(4);
    for (const l of ['n0', 'n1', 'n2']) s = d(s, { type: 'NOTE_TAB_OPEN', lid: l });
    const sel = s.selectedLid;
    s = d(s, { type: 'NOTE_TAB_MOVE', lid: 'n2', before: 'n0' });
    expect(lids(s)).toEqual(['n2', 'n0', 'n1']);
    s = d(s, { type: 'NOTE_TAB_EXTERNAL', lid: 'n0', external: true });
    expect(s.noteTabs.tabs.find((t) => t.lid === 'n0')?.external).toBe(true);
    expect(s.selectedLid).toBe(sel);
  });

  it('container switch resets the set', () => {
    let s = boot(4);
    for (const l of ['n0', 'n1']) s = d(s, { type: 'NOTE_TAB_OPEN', lid: l });
    s = reduce(s, { type: 'SYS_BOOTED', cid: 'c2', metas: [meta('n0', 0)], relations: [] }).state;
    expect(s.noteTabs.tabs).toHaveLength(0);
    expect(s.noteTabs.closed).toHaveLength(0);
    expectConsistent(s);
  });

  it('same-container reload drops tabs of notes that vanished', () => {
    let s = boot(4);
    for (const l of ['n0', 'n1', 'n2']) s = d(s, { type: 'NOTE_TAB_OPEN', lid: l });
    s = reduce(s, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n0', 0), meta('n2', 2)], relations: [] }).state;
    expect(lids(s)).toEqual(['n0', 'n2']);
    expectConsistent(s);
  });

  it('tab state is not in any persisted / snapshot path', () => {
    expect(Object.keys(boot(3))).toEqual(expect.arrayContaining(['noteTabs', 'tabSeq', 'notePins']));
    const root = resolve(__dirname, '../../src');
    const files = [...walk(join(root, 'adapter/platform')), join(root, 'adapter/state/reload-snapshot.ts')];
    expect(files.length).toBeGreaterThan(5);
    const offenders = files.filter((f) => /\b(noteTabs|tabSeq)\b/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
