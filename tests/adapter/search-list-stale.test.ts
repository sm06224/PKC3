/** @vitest-environment happy-dom */
/**
 * 消したノートが「探す」の結果に残らない / 編集中の修飾クリックが黙らない(#1087)。
 *
 * ⚠ 2 件とも「直す前の実装へ戻すと落ちる」ことを変異で確かめてある。
 */
import { describe, expect, it } from 'vitest';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function meta(lid: string, i: number): EntryMeta {
  return {
    lid,
    title: lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: i,
    status: null,
    date: null,
    archived: false,
    bodyChars: 0,
  };
}
const METAS = [meta('a', 1), meta('b', 2), meta('c', 3)];
const row = (lid: string) => ({ lid, title: lid, snippet: '', rank: 0 });

function withSearch(): AppState {
  const s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] }).state;
  return {
    ...s,
    filterQuery: 'q',
    searchHits: new Set(['a', 'b', 'c']),
    searchPage: { query: 'q', rows: [row('a'), row('b'), row('c')], rowsQuery: 'q', truncated: false, failed: false },
  };
}

describe('消したノートは探す面の結果と本文の当たりから落ちる', () => {
  it('1 件消す: 行と当たりから外れ、残りは変わらない', () => {
    const s = reduce(withSearch(), { type: 'DELETE_ENTRY', lid: 'b' }).state;
    expect(s.entryMetas.has('b'), '前提: 消えている').toBe(false);
    expect(s.searchPage.rows.map((r) => r.lid)).toEqual(['a', 'c']);
    expect([...(s.searchHits ?? [])].sort()).toEqual(['a', 'c']);
    expect(s.searchPage.query).toBe('q');
  });

  it('まとめて消す: 全部の lid が落ちる', () => {
    const s = reduce(withSearch(), { type: 'DELETE_ENTRIES', lids: ['a', 'c'] }).state;
    expect(s.entryMetas.size, '前提: 2 件消えている').toBe(1);
    expect(s.searchPage.rows.map((r) => r.lid)).toEqual(['b']);
    expect([...(s.searchHits ?? [])]).toEqual(['b']);
  });

  it('対照群: 結果に居ないノートを消しても元の参照のまま、searchHits が null なら null のまま', () => {
    const s0 = withSearch();
    const none = { ...s0, searchHits: null, searchPage: { ...s0.searchPage, rows: [row('a')] } };
    const s = reduce(none, { type: 'DELETE_ENTRY', lid: 'c' }).state;
    expect(s.entryMetas.has('c'), '前提: 消えている').toBe(false);
    expect(s.searchHits).toBeNull();
    expect(s.searchPage).toBe(none.searchPage);
  });
});

function mount(state: AppState) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher(state);
  const opened: string[] = [];
  bindActions(root, d, { openNoteWindow: (lid) => void opened.push(lid) });
  return { root, d, opened };
}

describe('消えたノートの行から別の窓を開かない', () => {
  it('entryMetas に無い lid は開かず、理由を出す(対照群: 居る lid は開く)', () => {
    const { root, d, opened } = mount(withSearch());
    const press = (lid: string) => {
      const host = document.createElement('div');
      host.setAttribute('data-pkc-entry', lid);
      const b = document.createElement('button');
      b.setAttribute('data-pkc-action', 'open-note-window');
      host.append(b);
      root.append(host);
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    };
    press('a');
    expect(opened, '対照群: 居るノートが開かない').toEqual(['a']);
    press('gone');
    expect(opened, '無いノートの窓を開いた').toEqual(['a']);
    expect(d.getState().error).toBe('そのノートは見つかりません');
  });
});

describe('編集中の Ctrl / Shift クリックは理由を言う', () => {
  function filerRow(root: HTMLElement, lid: string): HTMLElement {
    const region = document.createElement('div');
    region.setAttribute('data-pkc-region', 'filer-table');
    const r = document.createElement('div');
    r.setAttribute('data-pkc-entry', lid);
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'select-entry');
    r.append(b);
    region.append(r);
    root.append(region);
    return b;
  }
  it.each([
    ['ctrlKey', { ctrlKey: true }],
    ['shiftKey', { shiftKey: true }],
  ])('%s: editing では黙らない / ready では印が動く', (_n, mod) => {
    const s0 = withSearch();
    const { root, d } = mount({ ...s0, phase: 'editing', editingLid: 'a' } as AppState);
    filerRow(root, 'b').dispatchEvent(new MouseEvent('click', { bubbles: true, ...mod }));
    expect(d.getState().error ?? '', '理由が出ていない').toContain('フォルダの操作をしてください');

    const ready = mount(s0);
    filerRow(ready.root, 'b').dispatchEvent(new MouseEvent('click', { bubbles: true, ...mod }));
    expect(ready.d.getState().error, '対照群: ready で理由が出た').toBeNull();
    expect(ready.d.getState().selection.length, '対照群: ready で印が動いていない').toBeGreaterThan(0);
  });
});
