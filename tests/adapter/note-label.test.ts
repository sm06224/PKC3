/** @vitest-environment happy-dom */
/**
 * 🔴 ノートの色ラベル(#1982 段 4)── 写し(store)・state・行の線・色で絞る札・右クリックの両方向。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { NoteLabelStore } from '../../src/adapter/platform/note-label-store';
import { entryMenuActions, ENTRY_MENU_ACTIONS } from '../../src/features/entry-actions';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
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

const booted = (): AppState =>
  reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1), meta('b', 2), meta('c', 3)], relations: [] }).state;

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]')!;
  return {
    render: (s: AppState) => browse.render(s, 'filer'),
    rows: () => [...pane.querySelectorAll<HTMLElement>('tbody tr')].map((r) => r.getAttribute('data-pkc-entry')),
    row: (lid: string) => pane.querySelector<HTMLElement>(`tbody tr[data-pkc-entry="${lid}"]`),
    bar: () => regions.sidebar.querySelector<HTMLElement>('[data-pkc-region="kind-bar"]')!,
  };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('NoteLabelStore(写しと直列の書込)', () => {
  it('付ける → 外すが、書き手へ順に 1 件ずつ渡る / 変わらない操作は書かない', async () => {
    const st = new NoteLabelStore();
    const wrote: Array<[string, number | null]> = [];
    st.attach(async (l, c) => void wrote.push([l, c]), () => undefined);
    st.set('a', 3);
    st.set('a', 3); // 同じ色 = 変化なし
    st.set('a', 5);
    st.set('a', null);
    st.set('zz', null); // 付いていない物を外す = 変化なし
    st.set('a', 99); // 範囲外は無視
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(wrote).toEqual([['a', 3], ['a', 5], ['a', null]]);
    expect(st.get('a')).toBeNull();
  });

  it('書けなかったら正本の読み直しを頼む / setAll は同じ中身なら知らせない', async () => {
    const st = new NoteLabelStore();
    let failed = 0;
    st.attach(async () => Promise.reject(new Error('x')), () => void (failed += 1));
    st.set('a', 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(failed).toBe(1);
    let n = 0;
    st.onChange(() => void (n += 1));
    st.setAll([{ lid: 'a', color: 1 }]);
    st.setAll([{ lid: 'a', color: 1 }]);
    expect(n, '同じ中身を 2 回入れて 2 回知らせた').toBe(0);
    st.setAll([{ lid: 'a', color: 2 }]);
    expect(n).toBe(1);
  });
});

describe('state と絞り込み', () => {
  it('色の絞りは、その色のノートだけを残す / 解くと全部戻る(両方向)', () => {
    const t = setup();
    let s = reduce(booted(), { type: 'SET_NOTE_LABELS', labels: new Map([['a', 2], ['c', 2], ['b', 5]]) }).state;
    t.render(s);
    expect(t.rows()).toEqual(['a', 'b', 'c']);
    s = reduce(s, { type: 'SET_LABEL_FILTER', color: 2 }).state;
    t.render(s);
    expect(t.rows()).toEqual(['a', 'c']);
    s = reduce(s, { type: 'SET_LABEL_FILTER', color: null }).state;
    t.render(s);
    expect(t.rows()).toEqual(['a', 'b', 'c']);
  });

  it('絞っている色が 1 つも無くなったら、絞りも解ける(解き方の見えない 0 件にしない)', () => {
    let s = reduce(booted(), { type: 'SET_NOTE_LABELS', labels: new Map([['a', 2]]) }).state;
    s = reduce(s, { type: 'SET_LABEL_FILTER', color: 2 }).state;
    s = reduce(s, { type: 'SET_NOTE_LABELS', labels: new Map() }).state;
    expect(s.labelFilter).toBeNull();
  });

  it('同じ中身の SET_NOTE_LABELS は state を作り直さない(描き直しを呼ばない)', () => {
    const s = reduce(booted(), { type: 'SET_NOTE_LABELS', labels: new Map([['a', 2]]) }).state;
    expect(reduce(s, { type: 'SET_NOTE_LABELS', labels: new Map([['a', 2]]) }).state).toBe(s);
  });
});

describe('行の左の線と札', () => {
  it('🔴 色を付けた行だけが data-pkc-note-label を持ち、外すと消える(行を組み直して反映)', () => {
    const t = setup();
    let s = booted();
    t.render(s);
    expect(t.row('a')!.hasAttribute('data-pkc-note-label')).toBe(false);
    s = reduce(s, { type: 'SET_NOTE_LABELS', labels: new Map([['a', 4]]) }).state;
    t.render(s);
    expect(t.row('a')!.getAttribute('data-pkc-note-label')).toBe('4');
    expect(t.row('b')!.hasAttribute('data-pkc-note-label')).toBe(false);
    // 🔴 色だけの手がかりにしない: 題名のセルが色の名前を持ち(青 = 5 ではなく 4 = 青緑)、付いていない行には添えない
    const titleOf = (lid: string): string => t.row(lid)!.querySelector<HTMLElement>('td')!.title;
    expect(titleOf('a')).toContain('色ラベル: 青緑');
    expect(titleOf('b')).not.toContain('色ラベル');
    s = reduce(s, { type: 'SET_NOTE_LABELS', labels: new Map() }).state;
    t.render(s);
    expect(t.row('a')!.hasAttribute('data-pkc-note-label')).toBe(false);
  });

  it('🔴 使っている色の札が出て、押した状態(aria-pressed)と「色の絞りを外す」が絞りに追従する', () => {
    const t = setup();
    let s = reduce(booted(), { type: 'SET_NOTE_LABELS', labels: new Map([['a', 2], ['b', 5], ['c', 2]]) }).state;
    t.render(s);
    const chips = () => [...t.bar().querySelectorAll<HTMLElement>('[data-pkc-action="toggle-label-filter"]')];
    expect(chips().map((c) => [c.getAttribute('data-pkc-note-label-value'), c.textContent])).toEqual([
      ['2', '黄 2'],
      ['5', '青 1'],
    ]);
    expect(chips().every((c) => c.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(t.bar().querySelector('[data-pkc-action="clear-label-filter"]')).toBeNull();
    s = reduce(s, { type: 'SET_LABEL_FILTER', color: 5 }).state;
    t.render(s);
    expect(chips().find((c) => c.getAttribute('data-pkc-note-label-value') === '5')!.getAttribute('aria-pressed')).toBe('true');
    expect(t.bar().querySelector('[data-pkc-action="clear-label-filter"]')).not.toBeNull();
  });

  it('色ラベルが 1 つも無ければ色の札は出ない(対照群)', () => {
    const t = setup();
    t.render(booted());
    expect(t.bar().querySelector('[data-pkc-action="toggle-label-filter"]')).toBeNull();
  });
});

describe('メニュー項目は両方向(付けられるなら外せる)', () => {
  const ids = (labelled: boolean | undefined) =>
    entryMenuActions({ archetype: 'text', linkedFile: null, ...(labelled === undefined ? {} : { labelled }) })
      .map((a) => a.action)
      .filter((a) => a.startsWith('note-label'));

  it('「色ラベルを付ける…」は常に在り、「外す」は付いているときだけ出る', () => {
    expect(ids(undefined)).toEqual(['note-label-set']);
    expect(ids(false)).toEqual(['note-label-set']);
    expect(ids(true)).toEqual(['note-label-set', 'note-label-clear']);
  });

  it('「付ける…」は右の列の「その他 ▾」にも出る(menuOnly ではない)/ 「外す」は右クリック用', () => {
    const set = ENTRY_MENU_ACTIONS.find((a) => a.action === 'note-label-set')!;
    expect(set.menuOnly).not.toBe(true);
    expect(set.label).toBe('色ラベルを付ける…');
    expect(ENTRY_MENU_ACTIONS.find((a) => a.action === 'note-label-clear')!.label).toBe('色ラベルを外す');
  });
});
