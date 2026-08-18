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
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { OpenInEditStore } from '../../src/adapter/ui/render/open-in-edit';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { BrowseModeStore, DEFAULT_BROWSE_MODE } from '../../src/adapter/ui/render/browse-mode';
import { readFileSync } from 'node:fs';

/** その test だけの保存(共有の localStorage を汚さない)。 */
function memStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

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

/** 親 → 子の構造辺(folder 木は `kind: 'structural'` の辺で組む)。 */
function rel(id: string, fromLid: string, toLid: string): Relation {
  return { id, fromLid, toLid, kind: 'structural', createdAt: null, updatedAt: null };
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

describe('印が指すものと、画面に見えているもの(#240 着地前レビュー)', () => {
  /** はこ(フォルダ)+ 平置き 4 件。 */
  const WITH_FOLDER = [meta('f', 0, 'はこ', 'folder'), ...METAS];
  const bootedF = (metas: EntryMeta[] = WITH_FOLDER): AppState =>
    reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;

  it('🔴 別タブが消したフォルダ・行は、現在地からも印からも落ちる', () => {
    let s = bootedF();
    s = reduce(s, { type: 'SET_SCOPE', lid: 'f' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'a' }).state;
    expect(s.scopeLid).toBe('f');
    expect(s.selection).toEqual(['a']);
    // ⚠ 別タブの書込は `SYS_BOOTED` で届く(300ms 束ね)── ここで検めないと
    //   「現在地は在るが実体は無い」= 表 0 行・パンくずはルートだけ、になる
    const gone = WITH_FOLDER.filter((m) => m.lid !== 'f' && m.lid !== 'a');
    const r = reduce(s, { type: 'SYS_BOOTED', cid: 'c1', metas: gone, relations: [] });
    expect(r.state.scopeLid, '消えたフォルダを現在地に残した').toBeNull();
    expect(r.state.selection, '消えた行が印に残った').toEqual([]);
    expect(r.state.selectionAnchor).toBeNull();
  });

  it('⚠ 逆に、**在るものは残す**(再読込のたびに現在地へ戻されない)', () => {
    let s = bootedF();
    s = reduce(s, { type: 'SET_SCOPE', lid: 'f' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'a' }).state;
    const r = reduce(s, { type: 'SYS_BOOTED', cid: 'c1', metas: WITH_FOLDER, relations: [] });
    expect(r.state.scopeLid, '在るフォルダなのに現在地を捨てた').toBe('f');
    expect(r.state.selection).toEqual(['a']);
  });

  it('別の container の再読込では、現在地も印も捨てる(lid の偶然衝突)', () => {
    let s = bootedF();
    s = reduce(s, { type: 'SET_SCOPE', lid: 'f' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'a' }).state;
    const r = reduce(s, { type: 'SYS_BOOTED', cid: 'c2', metas: WITH_FOLDER, relations: [] });
    expect(r.state.scopeLid).toBeNull();
    expect(r.state.selection).toEqual([]);
  });

  it('🔴 入っているフォルダを消したら、現在地はルートへ戻る(袋小路にしない)', () => {
    let s = bootedF();
    s = reduce(s, { type: 'SET_SCOPE', lid: 'f' }).state;
    // ⚠ 右のペインから消すと、**現在地だけが死んだ lid を指す** ──
    //   表は 0 行・パンくずはルートだけ・「まだ何もありません」で袋小路になる
    const r = reduce(s, { type: 'DELETE_ENTRY', lid: 'f' });
    expect(r.state.scopeLid, '消したフォルダの中に取り残された').toBeNull();
  });

  it('🔴 場所を移ったら印は外れる(印は現在地のもの)', () => {
    let s = bootedF();
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'a' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'b' }).state;
    expect(s.selection).toHaveLength(2);
    const r = reduce(s, { type: 'SET_SCOPE', lid: 'f' });
    expect(r.state.selection, '別の場所の印を持ち越した').toEqual([]);
    expect(r.state.selectionAnchor, '起点が別の場所を指したまま').toBeNull();
  });

  it('🔴 絞り込みで見えなくなった行は、帯にも数えない', () => {
    document.body.innerHTML = '';
    const region = document.createElement('div');
    document.body.append(region);
    const filer = new FilerRenderer(region);
    let s = booted();
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'a' }).state; // 題名 zz
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'b' }).state; // 題名 yy
    filer.render(s);
    expect(region.querySelector('[data-pkc-field="filer-bulk-count"]')?.textContent).toContain(
      '2 件',
    );
    // 「zz」だけ残す絞り込み ── b は画面から消える
    s = reduce(s, { type: 'SET_ENTRY_FILTER', query: 'zz' }).state;
    filer.render(s);
    expect(region.querySelectorAll('[data-pkc-region="filer-table"] tbody tr')).toHaveLength(1);
    expect(
      region.querySelector('[data-pkc-field="filer-bulk"]'),
      '画面に印が 1 つしか無いのに帯が出ている',
    ).toBeNull();
  });

  it('🔴 絞り込みで見えなくなった行は、まとめて削除でも消えない', () => {
    document.body.innerHTML = '';
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
    // ⚠ 押す口は**自分で置く** ── 帯は「見えている印が 2 件以上」でしか出ないので、
    //   帯から辿ると**帯が出ないこと自体に救われて**空振りする(緑の意味が変わる)
    const del = document.createElement('button');
    del.setAttribute('data-pkc-action', 'delete-selected');
    root.append(del);

    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'a' });
    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'b' });
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'zz' }); // 題名 zz = a だけ残る
    expect(
      regions.browseHost.querySelectorAll('[data-pkc-region="filer-table"] tbody tr'),
      '絞り込みが効いていない(この test は空振り)',
    ).toHaveLength(1);
    del.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(d.getState().entryMetas.has('b'), '画面に無い行がゴミ箱へ入った').toBe(true);
    expect(d.getState().entryMetas.has('a'), '見えている印は消えるはず').toBe(false);

    // ⚠ 逆側 ── 絞り込みを外せば**両方**消える(消せなくなっていないこと)
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '' });
    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'c' });
    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'd' });
    del.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(d.getState().entryMetas.has('c')).toBe(false);
    expect(d.getState().entryMetas.has('d')).toBe(false);
  });

  it('🔴 印が全部見えなくなっているとき、押しても黙らない(理由を出す)', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
    const del = document.createElement('button');
    del.setAttribute('data-pkc-action', 'delete-selected');
    root.append(del);
    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'b' }); // 題名 yy
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'zz' }); // b は消える
    del.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(d.getState().entryMetas.has('b')).toBe(true);
    expect(d.getState().error ?? '', '無言の dead click になっている').toContain('絞り込み');
  });

  it('🔴 修飾つきのクリックは**フォルダ面の中だけ**(一覧・カンバンで印を作らない)', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
    // フォルダ面**ではない**器に、同じ `select-entry` の行を置く(sidebar と同型)
    const outside = document.createElement('div');
    outside.setAttribute('data-pkc-region', 'entry-list');
    outside.innerHTML =
      '<button data-pkc-action="select-entry" data-pkc-entry="a">a</button>' +
      '<button data-pkc-action="select-entry" data-pkc-entry="c">c</button>';
    root.append(outside);
    const btn = (lid: string) => outside.querySelector<HTMLElement>(`[data-pkc-entry="${lid}"]`)!;
    btn('a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    btn('c').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    // 🔑 一覧では **Ctrl クリックも普通のクリック**(印が 2 件に増えず、開き直す)──
    //    増やすと、画面に印が 1 つも出ないまま帯だけが数える形になる
    expect(d.getState().selection, '印の出ない面で印が増えた').toEqual(['c']);
    expect(d.getState().selectedLid, '普通のクリックとして扱われていない').toBe('c');
  });

  it('🔴 「もう一度押す」もフォルダ面の中だけ(見えない現在地が動かない)', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    bindActions(root, d);
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('f', 0, 'はこ', 'folder')],
      relations: [],
    });
    const outside = document.createElement('div');
    outside.setAttribute('data-pkc-region', 'entry-list');
    outside.innerHTML = '<button data-pkc-action="select-entry" data-pkc-entry="f">f</button>';
    root.append(outside);
    const btn = outside.querySelector('button')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(d.getState().scopeLid, '一覧タブの 2 回押しで現在地が動いた').toBeNull();
  });
});

/**
 * 🔴 **OS のファイラと同じ鍵**(user 裁定 2026-08-18「平仄も合わせて」)。
 * ⚠ **行に焦点があるときだけ**効く ── 面をまたいで効かせると、#240 の着地前レビューで
 * 踏んだ「見えない所で印が増える / 現在地が動く」を繰り返す。
 */
describe('フォルダの表の鍵', () => {
  const WITH_FOLDER = [meta('f', 0, 'はこ', 'folder'), ...METAS];
  /** 中身が 1 件入ったフォルダ(`focusFirstRow` の**行に置く枝**を通すため)。 */
  const WITH_CHILD = [meta('f', 0, 'はこ', 'folder'), meta('n1', 1, 'なかみ')];
  const CHILD_RELS = [rel('r1', 'f', 'n1')];
  /** 中身が 2 件のフォルダ(入った直後の Shift+↓ が伸びることを測る)。 */
  const WITH_TWO = [meta('f', 0, 'はこ', 'folder'), meta('n1', 1, 'なかみ'), meta('n2', 2, 'ふたつめ')];
  const TWO_RELS = [rel('r1', 'f', 'n1'), rel('r2', 'f', 'n2')];
  /** `f / g / n2` の 2 階層(`Backspace` が**すぐ上**へ戻ることを測る)。 */
  const DEEP = [
    meta('f', 0, 'はこ', 'folder'),
    meta('g', 1, 'なかばこ', 'folder'),
    meta('n2', 2, 'おく'),
  ];
  const DEEP_RELS = [rel('r1', 'f', 'g'), rel('r2', 'g', 'n2')];

  /**
   * 器を組んで、フォルダ面を描いた状態にする。
   * @param openInEdit 「開いたら編集に入る」の設定(user 裁定 2026-08-18)。
   *   ⚠ **自分で `new` して渡す** ── アプリ共有の 1 個を書き換えると別の test に漏れる。
   */
  function screen(
    metas: EntryMeta[] = WITH_FOLDER,
    relations: Relation[] = [],
    openInEdit: OpenInEditStore = new OpenInEditStore(memStorage()),
  ) {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    bindActions(root, d, {}, new KeymapStore(memStorage()), openInEdit);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
    const filer = new FilerRenderer(regions.browseHost);
    d.onState((st) => filer.render(st));
    filer.render(d.getState());
    const row = (lid: string) =>
      regions.browseHost.querySelector<HTMLElement>(`[data-pkc-entry="${lid}"]`)!;
    /**
     * 🔴 **実機のクリックは焦点も移す。happy-dom は移さない**(2026-08-18 実測)。
     *
     * 焦点の持ち越しは `filer.ts` が「**組み直す前に中に焦点があったか**」で
     * 決める(外に在るときに奪うと、絞り込み欄の打鍵が表へ飛ぶ)ので、
     * 焦点が `body` のままだと**この面の鍵の筋を 1 度も通れない**。
     * ⚠ ここで補うのは**環境の欠品**であって、実装の代わりではない ──
     *   「クリックで焦点が入る」こと自体は smoke(`organize.smoke.spec.ts`)が見る。
     */
    const clickRow = (lid: string): HTMLElement => {
      const el = row(lid);
      el.click();
      el.focus();
      return el;
    };
    /**
     * 🔴 **押した要素から撃つ**(2026-08-18 の着地前レビュー 3)。
     *
     * ⚠ 直す前は `document.dispatchEvent(ev)` に `Object.defineProperty(ev,'target')`
     * で偽の target を貼っていた ── **`root` の `keydown` を 1 度も通らない**
     * (document へ直接撃った event は、子孫の listener へは降りない)。
     * 実機は必ず **行 → root → document** と上がるので、その間に在る
     * `onKeydown` の分岐(Enter / Space)が **unit からは永久に見えなかった**。
     * 実際そこに、行に `tabindex` を足した副作用で開いた
     * 「**Space が印を 1 件に潰す**」という登録も説明も無い鍵が隠れていた。
     * 🔑 CLAUDE.md §2「経路が一度も通っていない ── 弱いのではなく走っていない」。
     */
    const press = (key: string, from: HTMLElement, over: Partial<KeyboardEventInit> = {}) => {
      const ev = new KeyboardEvent('keydown', {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        bubbles: true,
        cancelable: true,
        ...over,
      });
      from.dispatchEvent(ev);
      return ev;
    };
    return { root, d, row, clickRow, press, regions };
  }

  it('🔴 行は焦点を受けられる(どこで効かせるかが決まる)', () => {
    // ⚠ **属性で見る** ── `tabIndex` の getter は置いていなくても `-1` を返すので、
    //   `toBe(-1)` は**外しても緑**だった(変異が生き延びた)
    const { row } = screen();
    expect(
      row('f').hasAttribute('tabindex'),
      '行に焦点が入らない(鍵の効く場所が決まらない)',
    ).toBe(true);
  });

  it('🔴 Enter でフォルダの中へ入る', () => {
    const { d, clickRow, press } = screen();
    press('Enter', clickRow('f'));
    expect(d.getState().scopeLid, 'Enter で入れない').toBe('f');
  });

  it('🔴 Enter で入ったあとも鍵が効く(焦点が連れて行かれる)', () => {
    // ⚠ 押した行は表の組み直しで消える ── 焦点を運ばないと **次の Backspace が
    //   効かない**(鍵の動線が 1 手で死ぬ)
    const { d, clickRow, press } = screen();
    press('Enter', clickRow('f'));
    expect(d.getState().scopeLid).toBe('f');
    const now = document.activeElement as HTMLElement;
    expect(
      now.closest('[data-pkc-region="filer-table"]'),
      '入ったら焦点が表の外へ落ちた',
    ).not.toBeNull();
    press('Backspace', now);
    expect(d.getState().scopeLid, '親へ戻れない').toBeNull();
  });

  it('🔴 Ctrl+A はいま出ている行だけを選ぶ(絞り込みの外を巻き込まない)', () => {
    const { d, row, press } = screen();
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'zz' }); // 題名 zz = a だけ
    press('a', row('a'), { ctrlKey: true, code: 'KeyA' });
    expect(d.getState().selection, '画面に無い行まで選んだ').toEqual(['a']);
  });

  it('🔴 Space は行の鍵ではない(印をまとめて潰さない)', () => {
    /**
     * 🔴 行に `tabindex="-1"` を足した副作用で、`onKeydown` の
     * 「`tabindex` を持ち `data-pkc-action` を持つものは Enter / Space で押せる」
     * 経路に**行が入っていた**(2026-08-18 の着地前レビュー 3)。
     * ⚠ `Space` は `KEY_COMMANDS` にも設定画面にもマニュアルにも無いのに、
     *   `select-entry` を撃って**印を 1 件へ潰していた** ── 5 行に印を付けて
     *   一覧を送ろうとしただけで、まとめ操作の帯が消える。
     * 🔑 `-1` は「焦点を**置ける**」であって「**押せる**」ではない。
     */
    const { d, row, clickRow, press } = screen();
    clickRow('a');
    press('a', row('c'), { ctrlKey: true, code: 'KeyA' }); // Ctrl+A で全部に印
    const before = d.getState().selection;
    expect(before.length, '印が 2 件以上ある状態を作れていない(空振り)').toBeGreaterThan(1);
    press(' ', row('a'), { code: 'Space' });
    expect(d.getState().selection, 'Space が印を潰した').toEqual(before);
  });

  it('🔴 選んでいないのに Delete を押したら、理由が出る(無言で終わらない)', () => {
    /**
     * `Enter` でフォルダへ入った直後がまさにこれ ── `SET_SCOPE` が印を外すので
     * `selection` は空だが、**焦点の枠は行に見えている**。直す前は
     * `delete-selected` が `selection.length > 0` のときしか断らなかったので、
     * user から見ると「選べているのに Delete が効かない」無言 no-op だった。
     */
    const { d, row, press } = screen();
    expect(d.getState().selection, '前提が崩れている(印が空でない)').toEqual([]);
    press('Delete', row('f'));
    expect(d.getState().error ?? '', 'Delete が無言で終わった').toContain('選んでください');
  });

  it('🔴 編集中の Backspace / Ctrl+A は、理由を出して断る(既定も奪わない)', () => {
    /**
     * `SET_SCOPE` も `SELECT_ALL` も reducer が `phase !== 'ready'` で**黙って**
     * 返すので、直す前は 1 ドットも動かず理由も出なかった。同じ面の `Delete` は
     * 理由を出していたので、**4 つの鍵で断り方が揃っていなかった**。
     */
    const { d, clickRow, press } = screen();
    press('Enter', clickRow('f')); // scope = f
    // ⚠ 編集に入るには openBody が要る(未読 body の編集を構造的に禁じている)
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '編集に入れていない(空振り)').toBe('editing');
    const table = document.querySelector<HTMLElement>('[data-pkc-region="filer-table"]')!;
    for (const [key, over] of [
      ['Backspace', {}],
      ['a', { ctrlKey: true, code: 'KeyA' }],
    ] as const) {
      d.dispatch({ type: 'OP_FAILED', error: '' });
      press(key, table, over);
      expect(d.getState().error ?? '', `${key} が無言で断られた`).toContain('編集を終了');
    }
    expect(d.getState().scopeLid, '編集中に現在地が動いた').toBe('f');
  });

  it('🔴 消したあとも焦点が表に残る(2 回目の Delete が効く)', () => {
    /**
     * 表は `entryMetas` が変わると丸ごと組み直されるので、押した行と一緒に
     * **焦点が body へ落ちる** ── 直す前は 1 回消したらそこで鍵の動線が死んだ
     * (`filer-parent` / `filer-open` にだけ焦点の引き継ぎが入っていた)。
     */
    const { d, row, clickRow, press } = screen();
    clickRow('a');
    press('Delete', row('a'));
    expect(d.getState().entryMetas.has('a'), '1 件目が消えていない(空振り)').toBe(false);
    const now = document.activeElement as HTMLElement;
    expect(
      now?.closest('[data-pkc-region="filer-table"]'),
      '消したら焦点が表の外へ落ちた',
    ).not.toBeNull();
    clickRow('b');
    press('Delete', now);
    expect(d.getState().entryMetas.has('b'), '2 回目の Delete が効かない').toBe(false);
  });

  it('🔴 中身のあるフォルダへ入ると、焦点は**行**に乗る(表そのものではない)', () => {
    /**
     * ⚠ これまでの fixture はフォルダが**空**だったので、`focusFirstRow` の
     * 本命の枝(`first.focus()`)は unit でも smoke でも **1 度も実行されて
     * いなかった**(CLAUDE.md §2)。⚠ `closest(...)` で見ると**表そのもの**でも
     * 満たされるので、`TR` であることまで見る(代替物で満たせる条件にしない)。
     */
    const { d, clickRow, press } = screen(WITH_CHILD, CHILD_RELS);
    press('Enter', clickRow('f'));
    expect(d.getState().scopeLid, 'フォルダに入れていない(空振り)').toBe('f');
    const now = document.activeElement as HTMLElement;
    expect(now?.tagName, '焦点が行に乗っていない').toBe('TR');
    expect(now?.getAttribute('data-pkc-entry'), '入った先の行ではない').toBe('n1');
  });

  it('🔴 Backspace は**すぐ上の親**へ戻る(最上位へ飛ばない)', () => {
    // ⚠ 深さ 1 の fixture しか無いと、`[0]`(近い順の先頭)を
    //   `[length-1]`(最上位)に変える変異が素通りする
    const { d, clickRow, press } = screen(DEEP, DEEP_RELS);
    press('Enter', clickRow('f'));
    const inF = document.activeElement as HTMLElement;
    press('Enter', inF); // f の中の g へ
    expect(d.getState().scopeLid, '2 階層目に入れていない(空振り)').toBe('g');
    press('Backspace', document.activeElement as HTMLElement);
    expect(d.getState().scopeLid, 'すぐ上の親ではなく最上位へ戻った').toBe('f');
  });

  it('🔴 Ctrl+A は**いまの現在地**の行だけを選ぶ', () => {
    // ⚠ ルートに居るままの test しか無いと、`state.scopeLid` を `null` に
    //   すり替える変異が素通りする(画面に印が 1 つも出ないのに帯だけが数える)
    const { d, clickRow, press } = screen(WITH_CHILD, CHILD_RELS);
    press('Enter', clickRow('f'));
    press('a', document.activeElement as HTMLElement, { ctrlKey: true, code: 'KeyA' });
    expect(d.getState().selection, '現在地の外まで選んだ').toEqual(['n1']);
  });

  it('🔴 ↑↓ で行を送ると、印も一緒に動く(中央は開き直さない)', () => {
    /**
     * 🔴 user 裁定 2026-08-18「**行送りに上下キーを使うは提案通りで OK**」。
     * ⚠ **開くのは Enter の仕事** ── 送るたびに `SELECT_ENTRY` を撃つと、
     *   1 行ごとに本文の読み直し(worker 往復)が起きる。
     */
    const { d, clickRow, press } = screen();
    const first = clickRow('f');
    const opened = d.getState().selectedLid;
    press('ArrowDown', first);
    const after = d.getState();
    expect(after.selection.length, '送っても印が 1 件にならない').toBe(1);
    expect(after.selection[0], '送った先が選ばれていない').not.toBe('f');
    expect(after.selectedLid, '送っただけで中央のノートが変わった').toBe(opened);
    expect(
      (document.activeElement as HTMLElement)?.getAttribute('data-pkc-entry'),
      '焦点が送った行に乗っていない',
    ).toBe(after.selection[0]);
  });

  it('🔴 端では止まる(巻き戻らない)', () => {
    // ⚠ 端で押し続けて反対側へ飛ぶのは OS のファイラの挙動ではない
    const { d, clickRow, press } = screen();
    let el = clickRow('f'); // 先頭(entryOrder 0)
    press('ArrowUp', el);
    expect(d.getState().selection, '先頭で ↑ を押したら別の行へ飛んだ').toEqual(['f']);
    // 末尾まで送ってから、もう 1 回 ↓
    for (let i = 0; i < 10; i += 1) {
      el = document.activeElement as HTMLElement;
      press('ArrowDown', el);
    }
    const last = d.getState().selection[0];
    press('ArrowDown', document.activeElement as HTMLElement);
    expect(d.getState().selection[0], '末尾で ↓ を押したら巻き戻った').toBe(last);
  });

  it('🔴 Shift+↓ は起点から積み上がる(押すたびに 1 件へ潰れない)', () => {
    const { d, clickRow, press } = screen();
    const el = clickRow('f');
    press('ArrowDown', el, { shiftKey: true });
    expect(d.getState().selection.length, '1 回目で 2 件になっていない').toBe(2);
    press('ArrowDown', document.activeElement as HTMLElement, { shiftKey: true });
    expect(d.getState().selection.length, '2 回目で積み上がっていない').toBe(3);
  });

  it('🔴 起点が無いところからの Shift+↓ は、いまの行から伸びる', () => {
    /**
     * ⚠ フォルダへ入った直後が**まさにこれ** ── `SET_SCOPE` が印も起点も外すので、
     * 焦点だけが 1 行目に乗っている。ここで `SELECT_RANGE` をそのまま撃つと
     * `rangeInRows` が起点 `null` を「行き先 1 件」と解くので、**押しても
     * 1 件のまま**積み上がらない。
     * 🔑 上の「Shift で積み上がる」test は先にクリックしていて起点が在るので、
     *   **この経路を 1 度も通らない**(変異が生き延びた)。
     */
    const { d, clickRow, press } = screen(WITH_TWO, TWO_RELS);
    press('Enter', clickRow('f')); // f の中へ(印も起点も外れ、焦点は 1 行目)
    expect(d.getState().selectionAnchor, '起点が残っている(前提が崩れている)').toBeNull();
    expect(d.getState().scopeLid, 'フォルダに入れていない(空振り)').toBe('f');
    press('ArrowDown', document.activeElement as HTMLElement, { shiftKey: true });
    expect(
      d.getState().selection.length,
      '起点が立たず、行き先 1 件に潰れた',
    ).toBeGreaterThan(1);
  });

  it('🔴 Enter でノートを開くと、まず**読む**(既定では編集に入らない)', () => {
    /**
     * 🔴 user 裁定 2026-08-18「**Enter は閲覧を開始**」。
     * ⚠ 本文の面へ焦点も移す ── そのままスクロールと読み進めが続く。
     */
    const { d, clickRow, press } = screen();
    press('Enter', clickRow('a'));
    expect(d.getState().selectedLid, 'ノートが開いていない').toBe('a');
    expect(d.getState().phase, '既定で編集に入ってしまった').toBe('ready');
    // ⚠ **本文が届いたあとも**入らないことまで見る ── ここを見ないと、
    //   「設定を見ずに常に編集へ入る」変異が生き延びる(届く前は誰も入らない)
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# a' });
    expect(d.getState().phase, '本文が届いたら勝手に編集へ入った').toBe('ready');
    expect(
      (document.activeElement as HTMLElement)?.closest('[data-pkc-region="detail"]'),
      '本文の面へ焦点が移っていない',
    ).not.toBeNull();
  });

  it('🔴 設定を入れると、本文が届いてから編集に入る', () => {
    /**
     * ⚠ `START_EDIT` は `openBody` が揃っていないと**黙って何もしない**ので、
     * 選んだ直後に撃つと「設定を入れたのに編集にならない」になる。
     */
    const store = new OpenInEditStore(memStorage());
    store.setEnabled(true);
    const { d, clickRow, press } = screen(WITH_FOLDER, [], store);
    press('Enter', clickRow('a'));
    expect(d.getState().phase, '本文が来る前に編集へ入った').toBe('ready');
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# a' });
    expect(d.getState().phase, '本文が届いても編集に入らない').toBe('editing');
  });

  it('🔴 設定が入っていても、別のノートへ移ったら後から勝手に編集へ入らない', () => {
    // ⚠ 購読を外す条件を持たないと、user が自分で確定した瞬間にもう一度入る
    const store = new OpenInEditStore(memStorage());
    store.setEnabled(true);
    const { d, clickRow, press } = screen(WITH_FOLDER, [], store);
    press('Enter', clickRow('a'));
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' }); // 別のノートへ移る
    /**
     * 🔑 **戻ってきたときが本番**である。ここを「離れたまま」で終わらせると、
     * 購読を外さない変異が**生き延びる**(離れている間は `openBody` が別の lid
     * なので、どちらの実装でも何も起きない)。
     * ⚠ 戻り方は**クリック**(= 選ぶ)であって「開く」ではないので、
     *   編集に入ってはいけない。
     */
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# a' });
    expect(d.getState().phase, '選び直しただけで編集へ入った').toBe('ready');
  });

  it('🔴 面の外では効かない(一覧タブで Enter を押しても現在地が動かない)', () => {
    const { d, root, press } = screen();
    const outside = document.createElement('div');
    outside.setAttribute('data-pkc-region', 'entry-list');
    outside.innerHTML = '<button data-pkc-entry="f">f</button>';
    root.append(outside);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'f' });
    press('Enter', outside.querySelector('button')!);
    expect(d.getState().scopeLid, '面の外の Enter で現在地が動いた').toBeNull();
  });
});

