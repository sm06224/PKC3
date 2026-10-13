/** @vitest-environment happy-dom */
/**
 * 🔴 **左の列の欄で探した語を、別のウィンドウで開く口へも運ぶ**(依頼 70-C2)。
 *
 * 同じウィンドウで行を押す回は `startSearchJumpFromField` が既に塗る(#1102 段②、
 * `search-jump-state.test.ts`)。ここが守るのは**別のウィンドウで開く 2 つの口**
 * (「別のウィンドウで開く」/ 行の 2 回押し)── 語を運ばないと、開いた先は先頭から
 * 読み直しになる。塗る・送る部品は「探す」の行と同じ 1 本(`openNoteWindow(lid, find)`)。
 */
import { describe, expect, it, vi } from 'vitest';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, leftFilterFind } from '../../src/adapter/ui/actions/binder';

function meta(lid: string, i: number): EntryMeta {
  return {
    lid,
    title: lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: i + 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 0,
  };
}

function setup(filterQuery: string) {
  const state: AppState = {
    ...initialState,
    selectedLid: 'a',
    filterQuery,
    entryMetas: new Map([
      ['a', meta('a', 0)],
      ['b', meta('b', 1)],
    ]),
  };
  const root = document.createElement('div');
  document.body.append(root);
  const calls: Array<[string, string | undefined]> = [];
  bindActions(root, new Dispatcher(state), {
    openNoteWindow: (lid, find) => void calls.push([lid, find]),
  });
  return { root, calls };
}

function pressMenu(root: HTMLElement, lid: string, find?: string): void {
  const host = document.createElement('div');
  host.setAttribute('data-pkc-entry', lid);
  const b = document.createElement('button');
  b.setAttribute('data-pkc-action', 'open-note-window');
  if (find !== undefined) b.setAttribute('data-pkc-find', find);
  host.append(b);
  root.append(host);
  b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('運ぶ語の決め方 (依頼 70-C2)', () => {
  it('欄の語を整えて運ぶ。空・空白だけ・「>」(操作を探している)は運ばない', () => {
    expect(leftFilterFind('  議事録 ')).toBe('議事録');
    expect(leftFilterFind('')).toBeUndefined();
    expect(leftFilterFind('   ')).toBeUndefined();
    expect(leftFilterFind('>保存')).toBeUndefined();
  });
});

describe('別のウィンドウで開く口が、欄の語を運ぶ (依頼 70-C2)', () => {
  it('🔴 「別のウィンドウで開く」: 欄に語があれば、その語を渡す', () => {
    const s = setup('議事録');
    pressMenu(s.root, 'b');
    expect(s.calls).toEqual([['b', '議事録']]);
  });

  it('対照群: 欄が空なら語は渡さない / 「探す」の行の語が先に勝つ', () => {
    const empty = setup('');
    pressMenu(empty.root, 'b');
    expect(empty.calls).toEqual([['b', undefined]]);
    const both = setup('議事録');
    pressMenu(both.root, 'b', '予算');
    expect(both.calls, '「探す」の行の語より欄の語を優先している').toEqual([['b', '予算']]);
  });

  it('🔴 行の 2 回押し(ノートの別ウィンドウ)も、欄の語を渡す', () => {
    vi.useFakeTimers();
    try {
      const s = setup('議事録');
      // 左の列の行 = 'select-entry' を持つ要素(フォルダ面の中)
      const region = document.createElement('div');
      region.setAttribute('data-pkc-region', 'filer-table');
      const row = document.createElement('tr');
      row.setAttribute('data-pkc-action', 'select-entry');
      row.setAttribute('data-pkc-entry', 'b');
      region.append(row);
      s.root.append(region);
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(s.calls).toEqual([['b', '議事録']]);
    } finally {
      vi.useRealTimers();
    }
  });
});
