/** @vitest-environment happy-dom */
/**
 * 複数選択とまとめて削除(#240 段②③。user 指示 2026-08-17
 * 「複数選択・範囲選択・D&D を導入すること」「まとめて消せない」)。
 *
 * 🔴 守る主張:
 * 1. **印(`selection`)と開いているノート(`selectedLid`)は別**である
 *    ── `Ctrl` クリックで中央が開き直らない(PKC2 は 2 つを union で畳んで事故った)
 * 2. **範囲は表示順で採る** ── 並べ替えを変えたら、範囲も変わる
 * 3. **まとめて消すのはゴミ箱まで**(完全削除は一括で撃たせない)
 * 4. **無言で断らない**(編集中は理由を出す)
 * 5. 消えたものが**印に残らない**
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { BrowseModeStore, DEFAULT_BROWSE_MODE } from '../../src/adapter/ui/render/browse-mode';
import { readFileSync } from 'node:fs';

function meta(lid: string, order: number, title = 't-' + lid, archetype = 'text'): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
  };
}

/** 4 件を root に平置き(題名の昇順とデータ順が**わざと逆**になっている)。 */
const METAS = [meta('a', 1, 'zz'), meta('b', 2, 'yy'), meta('c', 3, 'xx'), meta('d', 4, 'ww')];

function booted(metas: EntryMeta[] = METAS): AppState {
  return reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;
}

describe('印(複数選択)の意味論', () => {
  it('🔴 Ctrl クリック相当は印だけ動かす(開いているノートは動かない)', () => {
    let s = booted();
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    expect(s.selection).toEqual(['a']);
    const r = reduce(s, { type: 'TOGGLE_SELECT', lid: 'c' });
    expect(r.state.selection).toEqual(['a', 'c']);
    expect(r.state.selectedLid, '印を付けただけで中央が変わった').toBe('a');
    expect(
      r.events.some((e) => e.type === 'REQUEST_BODY'),
      '印を付けただけで本文を読み直している',
    ).toBe(false);
  });

  it('もう一度で外れる / 起点は外したときも更新する', () => {
    let s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'c' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'c' }).state;
    expect(s.selection).toEqual(['a']);
    expect(s.selectionAnchor).toBe('c');
  });

  it('修飾なしのクリックは印を 1 件へ置き換える', () => {
    let s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'c' }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'd' }).state;
    expect(s.selection).toEqual(['d']);
  });

  it('🔴 すでに開いている行を素で押しても、印は 1 件へ戻る', () => {
    // ⚠ 実ブラウザ smoke が捕まえた ── `SELECT_ENTRY` の「同じノートをもう一度」の
    //    早期 return が**印の外に在った**ので、3 件に印を付けたあとその 1 件を
    //    押しても印が 3 件のままだった(unit は別の行を押す筋しか通っていなかった)
    let s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '' }).state; // openBody を確立
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'b' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'c' }).state;
    expect(s.selection).toEqual(['a', 'b', 'c']);
    const r = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }); // すでに開いている行
    expect(r.state.selection, '印が残ったまま').toEqual(['a']);
    expect(r.state.selectedLid).toBe('a');
  });

  /**
   * 🔴 **範囲は表示順**(doc §3-2)。⚠ データの順で採ると、並べ替えているとき
   * **目で見た範囲と違うものが選ばれる** ── ここは並べ替えを変えて確かめる。
   */
  it('🔴 範囲選択は表示順で採る(並べ替えを変えると範囲も変わる)', () => {
    let s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state; // 起点 a
    // 既定(manual = entryOrder 順): a, b, c, d
    let r = reduce(s, { type: 'SELECT_RANGE', lid: 'c' });
    expect(r.state.selection).toEqual(['a', 'b', 'c']);

    // 題名順(ww, xx, yy, zz)= d, c, b, a ── 同じ 2 点でも間に挟まるものが違う
    s = reduce(s, { type: 'SET_ENTRY_SORT', sort: 'title' }).state;
    r = reduce(s, { type: 'SELECT_RANGE', lid: 'c' });
    expect(r.state.selection, 'データの順で範囲を採っている').toEqual(['c', 'b', 'a']);
  });

  it('絞り込みで見えていないものは範囲に入らない', () => {
    let s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'SET_ENTRY_FILTER', query: 'z' }).state; // 'zz'(= a)だけ残る
    const r = reduce(s, { type: 'SELECT_RANGE', lid: 'a' });
    expect(r.state.selection).toEqual(['a']);
  });

  it('印を全部外せる', () => {
    let s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'b' }).state;
    s = reduce(s, { type: 'CLEAR_SELECTION' }).state;
    expect(s.selection).toEqual([]);
    expect(s.selectionAnchor).toBeNull();
    expect(s.selectedLid, '印を外したら中央まで閉じた').toBe('a');
  });
});

describe('まとめてゴミ箱へ', () => {
  it('🔴 1 回の操作で全部消え、件数ぶんの削除要求が出る', () => {
    let s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'b' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'c' }).state;
    const r = reduce(s, { type: 'DELETE_ENTRIES', lids: s.selection });
    expect([...r.state.entryMetas.keys()]).toEqual(['d']);
    expect(
      r.events.filter((e) => e.type === 'REQUEST_DELETE').map((e) => (e as { lid: string }).lid),
      '要求が件数ぶん出ていない(半分だけ消える形)',
    ).toEqual(['a', 'b', 'c']);
    expect(r.state.selection, '消したのに印が残っている').toEqual([]);
  });

  it('編集中は受け付けない(黙って捨てない)', () => {
    let s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '' }).state;
    s = reduce(s, { type: 'START_EDIT' }).state;
    const r = reduce(s, { type: 'DELETE_ENTRIES', lids: ['a'] });
    expect(r.state.entryMetas.has('a'), '編集中に消えた').toBe(true);
  });

  it('居ない lid は黙って落とす(消えた行を選んだまま押しても事故にしない)', () => {
    const s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    const r = reduce(s, { type: 'DELETE_ENTRIES', lids: ['a', 'ghost'] });
    expect(r.state.entryMetas.has('a')).toBe(false);
    expect(r.events.filter((e) => e.type === 'REQUEST_DELETE')).toHaveLength(1);
  });

  it('🔴 1 件消すと、その 1 件だけ印から外れる', () => {
    let s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'b' }).state;
    const r = reduce(s, { type: 'DELETE_ENTRY', lid: 'b' });
    expect(r.state.selection).toEqual(['a']);
  });
});

describe('画面(フォルダの面)', () => {
  let region: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    region = document.createElement('div');
    document.body.append(region);
  });

  const rowOf = (lid: string) =>
    region.querySelector<HTMLElement>(`[data-pkc-region="filer-table"] [data-pkc-entry="${lid}"]`)!;

  it('🔴 印が行に出る(state だけ動いて画面が嘘をつかない)', () => {
    const filer = new FilerRenderer(region);
    let s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    filer.render(s);
    expect(rowOf('a').hasAttribute('data-pkc-marked')).toBe(true);
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'c' }).state;
    filer.render(s);
    expect(rowOf('c').hasAttribute('data-pkc-marked'), '印が画面に出ていない').toBe(true);
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'c' }).state;
    filer.render(s);
    expect(rowOf('c').hasAttribute('data-pkc-marked'), '外した印が残っている').toBe(false);
  });

  it('🔴 まとめての帯は 2 件以上のときだけ出る', () => {
    const filer = new FilerRenderer(region);
    let s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    filer.render(s);
    expect(region.querySelector('[data-pkc-field="filer-bulk"]')).toBeNull();
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'b' }).state;
    filer.render(s);
    const bulk = region.querySelector('[data-pkc-field="filer-bulk"]');
    expect(bulk, '2 件選んでも帯が出ない').not.toBeNull();
    expect(bulk!.textContent).toContain('2 件');
    // ⚠ **完全削除は一括で撃たせない**(戻せない操作をまとめて撃てるようにしない)
    expect(bulk!.querySelector('[data-pkc-action="purge-trash"]')).toBeNull();
    expect(bulk!.querySelector('[data-pkc-action="delete-selected"]')).not.toBeNull();
  });

  it('🔴 修飾つきのクリックが印を動かす(binder の配線)', () => {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
    const filer = new FilerRenderer(regions.browseHost);
    d.onState((st) => filer.render(st));
    filer.render(d.getState());

    const row = (lid: string) =>
      regions.browseHost.querySelector<HTMLElement>(`[data-pkc-entry="${lid}"]`)!;
    row('a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(d.getState().selection).toEqual(['a']);
    row('c').dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    expect(d.getState().selection, 'Ctrl クリックが印にならない').toEqual(['a', 'c']);
    expect(d.getState().selectedLid, 'Ctrl クリックで中央が変わった').toBe('a');
    row('d').dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
    );
    // 起点は c(最後に印を動かした行)── 表示順で c..d
    expect(d.getState().selection).toEqual(['c', 'd']);
  });
});

describe('探し方の既定と記憶(#240 段⑤)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('🔴 既定はフォルダ(user 指示 2026-08-17)', () => {
    expect(DEFAULT_BROWSE_MODE).toBe('filer');
    expect(new BrowseModeStore({ getItem: () => null, setItem: () => {} }).get()).toBe('filer');
  });

  it('前回の探し方を覚える / 壊れた保存は既定へ落ちる', () => {
    const map = new Map<string, string>();
    const st = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    const s = new BrowseModeStore(st);
    s.set('list');
    expect(new BrowseModeStore(st).get(), '覚えていない').toBe('list');
    map.set('pkc3.browse', 'ghost');
    expect(new BrowseModeStore(st).get(), '知らない値で面が出なくなる').toBe('filer');
  });

  it('🔴 最初に出る面が、選ばれているタブと一致する', () => {
    // ⚠ 器の hidden を 'list' 固定で組んでいると、**タブはフォルダなのに中身は一覧**
    //    という食い違いが出る(段⑤ の実装中に実際に踏んだ)
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const router = new BrowseRouter(regions.sidebar, regions.browseHost, 'filer');
    router.render(booted(), 'filer');
    const filerPane = regions.browseHost.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]')!;
    const listPane = regions.browseHost.querySelector<HTMLElement>('[data-pkc-region="entry-list"]')!;
    expect(filerPane.hidden, 'フォルダの面が隠れたまま').toBe(false);
    expect(listPane.hidden, '一覧の面が重なって出ている').toBe(true);
  });

  it('🔴 一覧タブは残っている(消さない)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    expect(root.querySelector('[data-pkc-browse="list"]'), '一覧の導線が消えた').not.toBeNull();
  });

  it('🔴 boot が記憶した探し方で開く(配線の pin)', () => {
    const main = readFileSync('src/main.ts', 'utf-8');
    expect(main, '既定の探し方が boot に届いていない').toContain(
      'new BrowseRouter(regions.sidebar, regions.browseHost, appBrowseMode.get())',
    );
    expect(main, '切り替えを覚えていない').toContain('appBrowseMode.set(mode)');
    expect(main, '既定が main.ts に直書きへ戻っている').not.toContain("browseMode: BrowseMode = 'list'");
  });
});
