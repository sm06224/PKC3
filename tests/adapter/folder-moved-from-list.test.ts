/** @vitest-environment happy-dom */
/**
 * 🔴 **「一覧」でしかできなかった 5 つと探す範囲を、フォルダのタブが担う**(#813 段③)。
 *
 * 段③-a では、同じ操作を一覧とフォルダの両方で撃って同じ結果になることを見てから
 * 一覧を外した。ここはその**フォルダ側だけの pin**である。
 *
 * | | 操作 | 一覧タブがあった頃 | フォルダ(段③-a の前) |
 * |---|---|---|---|
 * | B | 探す欄で ↓ | 最初の行へ降りる | 何も起きない |
 * | C | 2 件選んだ後の「‹」 | 押せる | **死んだまま** |
 * | D | 200 件で切れた当たり | 「200 件より多く…」 | 言わない |
 * | E | 絞りで 0 件 | 「絞りを外す」 | 文だけ |
 * | F | 別の面の行から改名 | 欄が出る | (一覧へ切り替えていた) |
 * | A | 語を打つ | 全階層から当たる | 現在地の直下だけ |
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter, type BrowseMode } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';

const meta = (lid: string, order: number, archetype = 'text'): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: order,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});
const rel = (id: string, from: string, to: string): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

/** 木:  (root) ── f1 ── a    /    b    /    x */
const METAS = [meta('f1', 1, 'folder'), meta('a', 2), meta('b', 3), meta('x', 4)];
const RELS = [rel('r1', 'f1', 'a')];

function mount(initial: BrowseMode = 'filer') {
  document.body.textContent = '';
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost, initial);
  let mode: BrowseMode = initial;
  d.onState((s) => browse.render(s, mode));
  bindActions(root, d, {
    setBrowse: (m) => {
      mode = m as BrowseMode;
      browse.render(d.getState(), mode);
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c', metas: METAS, relations: RELS });
  return { d, root, mode: () => mode };
}

/** いま見えている面の行。 */
const shownRows = (root: HTMLElement): string[] =>
  [...root.querySelectorAll<HTMLElement>('[data-pkc-region="filer-table"] tbody [data-pkc-entry]')]
    .filter((el) => el.closest('[hidden]') === null)
    .map((el) => el.getAttribute('data-pkc-entry') ?? '');

describe('一覧から移した動線 — フォルダのタブ', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('B: 探す欄で ↓ を押すと、いま出ている面の最初の行へ焦点が降りる', () => {
    const { root } = mount('filer');
    const input = root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')!;
    input.focus();
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    const active = document.activeElement as HTMLElement;
    expect(active.getAttribute('data-pkc-entry'), '焦点が最初の行へ降りていない').toBe(shownRows(root)[0]);
    expect(ev.defaultPrevented, '降りたのに ↓ の既定が残っている').toBe(true);
  });

  it('C: 2 件選ぶと「‹」が押せる / 戻ると「›」が押せる(面に関係なく)', () => {
    const { d, root } = mount('filer');
    const back = root.querySelector<HTMLButtonElement>('[data-pkc-action="nav-back"]')!;
    const fwd = root.querySelector<HTMLButtonElement>('[data-pkc-action="nav-forward"]')!;
    expect(back.disabled).toBe(true);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    expect(back.disabled, '1 件だけで戻れることになっている').toBe(true);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'x' });
    expect(back.disabled, '2 件選んだのに「‹」が死んだまま').toBe(false);
    expect(fwd.disabled).toBe(true);
    back.click();
    expect(d.getState().selectedLid).toBe('b');
    expect(fwd.disabled, '戻ったのに「›」が死んだまま').toBe(false);
  });

  it('D: 本文の当たりが 200 件で切れたら、そう言う(切れていなければ言わない)', () => {
    const { d, root } = mount('filer');
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'q' });
    d.dispatch({ type: 'SET_SEARCH_HITS', query: 'q', lids: ['b'], truncated: false });
    const note = (): HTMLElement | null =>
      root.querySelector<HTMLElement>(
        '[data-pkc-field="filer-more"]',
      );
    expect(note(), '切れていないのに言っている').toBeNull();
    d.dispatch({ type: 'SET_SEARCH_HITS', query: 'q', lids: ['b'], truncated: true });
    expect(note()?.textContent).toContain('200 件より多く');
  });

  it('E: 絞りで 0 件のとき「絞りを外す」が出て、押すと語が空になる', () => {
    const { d, root } = mount('filer');
    expect(root.querySelector('[data-pkc-action="clear-entry-filter"]'), '絞っていないのに出ている').toBeNull();
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'zzzz' });
    const clear = root.querySelector<HTMLElement>('[data-pkc-action="clear-entry-filter"]');
    expect(clear, '0 件なのに戻り道が無い').not.toBeNull();
    expect(clear!.closest('[hidden]'), '隠れた面のボタンを数えている').toBeNull();
    clear!.click();
    expect(d.getState().filterQuery).toBe('');
  });

  it('E2: 種類の札だけで 0 件のときも、同じ字で「絞りを外す」が出る(札だけでは外せない行き止まりにしない)', () => {
    const { d, root } = mount('filer');
    d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'todo' }); // 在るノートに todo は 1 件も無い
    expect(shownRows(root)).toEqual([]);
    const clear = root.querySelector<HTMLElement>('[data-pkc-action="clear-entry-filter"]');
    expect(clear, '札で 0 件なのに戻り道が無い').not.toBeNull();
    expect(root.textContent).toContain('絞り込みに一致するものがありません');
    clear!.click();
    expect(d.getState().kindFilter.size, '札が外れていない').toBe(0);
  });

  it('A2: 種類の札だけでも、フォルダの中のノートが当たる / 札を外すと直下だけへ戻る', () => {
    const { d, root } = mount('filer');
    // 対照群: 札も語も無ければ、いま居る場所(ルート)の直下だけ ── `a` は `f1` の中
    expect(shownRows(root), '対照群: 何も絞っていないのに階層をまたいでいる').toEqual(['f1', 'b', 'x']);
    d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'text' });
    expect(shownRows(root), '札だけでは、フォルダの中の a が当たらない(一覧タブは当てていた)').toEqual([
      'a',
      'b',
      'x',
    ]);
    expect(d.getState().filerFlatten, '札を押しただけで入り切りが入っている').toBe(false);
    expect(root.querySelector('[data-pkc-field="parent-name"]')?.textContent).toBe('─ t-f1');
    d.dispatch({ type: 'CLEAR_KIND_FILTER' });
    expect(shownRows(root), '札を外しても平らなまま').toEqual(['f1', 'b', 'x']);
  });

  it('A: 語を打つとフォルダの中のノートも当たる / 消すと元へ戻る', () => {
    const { d, root } = mount('filer');
    // 前提: 打つ前は直下だけ(`a` は `f1` の中)
    expect(shownRows(root)).not.toContain('a');
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 't-a' });
    expect(shownRows(root), 'フォルダの中の a が当たらない').toEqual(['a']);
    expect(d.getState().filerFlatten, '語を打っただけで入り切りが入っている').toBe(false);
    // 平らに出した行には、どのフォルダの中かが付く(#813 の親フォルダ名)
    expect(root.querySelector('[data-pkc-field="parent-name"]')?.textContent).toBe('─ t-f1');
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '' });
    expect(shownRows(root), '語を消しても平らなまま').not.toContain('a');
  });
});

describe('B: 隠れている面へは降りない', () => {
  it('予定の面を見ているとき、探す欄の ↓ は何も奪わない(焦点が入らないのに既定だけ消さない)', () => {
    const { root } = mount('filer'); // フォルダの面は描いた後、隠れて残る
    root.querySelector<HTMLElement>('[data-pkc-browse="schedule"]')!.click();
    const input = root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')!;
    input.focus();
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
  });
});

describe('F: 別の面の行から改名を始める', () => {
  it('予定の面から押すと、フォルダのタブへ切り替わり、親フォルダへ入って欄が出る', () => {
    const { d, root, mode } = mount('schedule');
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'rename-entry-begin');
    btn.setAttribute('data-pkc-entry', 'a');
    root.append(btn);
    btn.click();
    expect(mode(), 'フォルダのタブへ切り替わっていない').toBe('filer');
    expect(d.getState().scopeLid, 'その行の親フォルダへ入っていない').toBe('f1');
    expect(root.querySelector('[data-pkc-field="row-rename"]'), '欄が出ていない').not.toBeNull();
    expect(d.getState().renamingLid).toBe('a');
  });

  it('ルート直下の行なら現在地はルートのまま(別のフォルダに居たらルートへ戻る)', () => {
    const { d, root } = mount('schedule');
    d.dispatch({ type: 'SET_SCOPE', lid: 'f1' });
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'rename-entry-begin');
    btn.setAttribute('data-pkc-entry', 'b');
    root.append(btn);
    btn.click();
    expect(d.getState().scopeLid).toBe(null);
    expect(root.querySelector('[data-pkc-field="row-rename"]')).not.toBeNull();
  });

  it('絞り込みで行が消えているときは、欄を出さず理由を言って畳む(renamingLid を残さない)', () => {
    const { d, root } = mount('schedule');
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'x' });
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'rename-entry-begin');
    btn.setAttribute('data-pkc-entry', 'b');
    root.append(btn);
    btn.click();
    expect(d.getState().renamingLid, '黙って renamingLid を立てたまま').toBeNull();
    expect(root.querySelector('[data-pkc-field="row-rename"]')).toBeNull();
  });
});
