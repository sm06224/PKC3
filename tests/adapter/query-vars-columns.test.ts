/** @vitest-environment happy-dom */
/**
 * #2002 段 4: 集計の画面が、入力欄の値の列を出す / 読めなかった件数を言う / 記録の一覧ボタンで開く。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { QueryRenderer } from '../../src/adapter/ui/render/query';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { formHtml } from '../../src/features/markdown/form-def';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype: 'text',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: 10,
});

describe('集計: 入力欄の値の列', () => {
  const base = {
    ...initialState,
    entryMetas: new Map([
      ['e1', meta('e1')],
      ['e2', meta('e2')],
    ]),
    queryKey: 'template',
    queryKeys: { keys: [{ key: 'template', count: 2 }], omittedKeys: 0, scanned: 2, unreadable: 3 },
    queryGroups: {
      groups: [{ value: '回帰', total: 2, lids: ['e1', 'e2'] }],
      omittedGroups: 0,
      scanned: 2,
      columns: ['ビルド', '結果'],
      cells: { e1: ['1.2', '合格'], e2: ['1.3', ''] },
    },
  } as unknown as AppState;

  it('見出しと、行ごとの値が同じ順で並ぶ', () => {
    const host = document.createElement('div');
    new QueryRenderer(host).render(base);
    const heads = [...host.querySelectorAll('[data-pkc-field="query-column"]')].map((e) => e.textContent);
    expect(heads).toEqual(['ビルド', '結果']);
    const cells = [...host.querySelectorAll('li[data-pkc-entry="e1"] [data-pkc-field="query-cell"]')].map(
      (e) => e.textContent,
    );
    expect(cells).toEqual(['1.2', '合格']);
    expect(host.querySelectorAll('li[data-pkc-entry="e2"] [data-pkc-field="query-cell"]')).toHaveLength(2);
  });

  it('読めなかった件数を画面に言う / 0 なら言わない(対照)', () => {
    const host = document.createElement('div');
    new QueryRenderer(host).render(base);
    expect(host.querySelector('[data-pkc-field="query-note"]')!.textContent).toContain('3 件は先頭の設定欄が長すぎて');
    const host2 = document.createElement('div');
    new QueryRenderer(host2).render({
      ...base,
      queryKeys: { ...base.queryKeys!, unreadable: 0 },
    } as AppState);
    expect(host2.querySelector('[data-pkc-field="query-note"]')!.textContent).not.toContain('長すぎて');
  });

  it('列が無い結果には見出しも値も出さない(対照)', () => {
    const host = document.createElement('div');
    new QueryRenderer(host).render({
      ...base,
      queryGroups: { groups: [{ value: '回帰', total: 1, lids: ['e1'] }], omittedGroups: 0, scanned: 1 },
    } as AppState);
    expect(host.querySelector('[data-pkc-field="query-columns"]')).toBeNull();
    expect(host.querySelector('[data-pkc-field="query-cell"]')).toBeNull();
  });
});

describe('入力欄の「記録の一覧」ボタン', () => {
  it('入力欄に出る。項目が無ければ出ない', () => {
    expect(formHtml('fields:\n  - name: 一つ\n', { interactive: true, vars: {} })).toContain(
      'data-pkc-action="form-open-list"',
    );
    expect(formHtml('fields: []\n', { interactive: true, vars: {} })).not.toContain('form-open-list');
  });

  it('押すと集計が template で開く', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    root.innerHTML = '<button data-pkc-action="form-open-list">x</button>';
    root.querySelector<HTMLElement>('button')!.click();
    expect(d.getState().viewMode).toBe('query');
    expect(d.getState().queryKey).toBe('template');
  });
});
