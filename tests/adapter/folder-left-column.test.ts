/** @vitest-environment happy-dom */
/**
 * 🔴 **左の列(フォルダのタブ)の、描きと鍵の道中**(#813 段③。旧 `sidebar-render.test.ts` の
 * うち、「一覧」という面に依らない物をフォルダへ移した)。
 *
 * 「一覧」タブを外したので、かつて一覧の描画器に pin してあった次の物は**フォルダの表**が
 * 担う。差分描画(行ノードの再利用)は一覧の描画器の仕組みで、フォルダの表は丸ごと組み直す
 * ので引き継がない(組み直しの前後で焦点を持ち越す仕組みは `filer-view.test.ts`)。
 *
 * - 探す欄は、どの面でも state に合う(#536 ②)
 * - 絞りで 0 件のとき、理由と戻り道を出す(#550)
 * - 2 回続けて押すと、ノートは別のウィンドウ(付箋)で開く(#1042 C14)
 * - ↑↓ / Enter / Alt+Enter(スタック)/ 打ち替え後の焦点の戻し(#1042 C2 / #1092)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';

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
    bodyChars: null,
  };
}

/**
 * 🔴 **`bindActions` の teardown を必ず呼ぶ**(#1042 C2 の実装中に判明)。
 * ⚠ `doc, 'keydown', onShortcut` は **`document` に付く**(root ではない)ので、呼ばずに `it` を
 *   終えると**次の `it` にも生き残り**、そちらの keydown を二重に処理する
 *   (happy-dom は detached 要素でも focus を受け付ける)。
 */
let unbind: (() => void) | null = null;
afterEach(() => {
  unbind?.();
  unbind = null;
  document.body.textContent = '';
});

function setupBound(metas: EntryMeta[], services: Record<string, unknown> = {}) {
  document.body.textContent = '';
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost, 'filer');
  const d = new Dispatcher();
  d.onState((st) => browse.render(st, 'filer'));
  const openedWindows: string[] = [];
  unbind = bindActions(root, d, { openNoteWindow: (lid: string) => openedWindows.push(lid), ...services });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  const row = (lid: string) =>
    root.querySelector<HTMLElement>(`[data-pkc-region="filer-table"] tbody [data-pkc-entry="${lid}"]`)!;
  const filterInput = root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')!;
  const press = (el: HTMLElement, key: string, opts: Partial<KeyboardEventInit> = {}): void => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
  };
  return { root, d, row, filterInput, press, openedWindows };
}

describe('🔴 探す欄は、どの面でも state に合う(#536 ②)', () => {
  const field = (root: HTMLElement): HTMLInputElement =>
    root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')!;

  it('どの面を開いていても、絞りを変えると欄が追いつく', () => {
    const root = document.createElement('div');
    const regions = buildShell(root);
    const b = new BrowseRouter(regions.sidebar, regions.sidebar, 'contacts', () => new Date());
    b.render({ ...initialState, filterQuery: '会議' } as AppState, 'contacts');
    expect(field(root).value, '別の面で欄が追いつかない').toBe('会議');

    // 🔑 **外したときも追いつく**(片道にしない)
    b.render({ ...initialState, filterQuery: '' } as AppState, 'contacts');
    expect(field(root).value, '外したのに古い字が残っている').toBe('');
  });
});

describe('🔴 絞りで 0 件のとき、理由と戻り道を出す(#550)', () => {
  const empty = (root: HTMLElement): HTMLElement | null =>
    root.querySelector<HTMLElement>('[data-pkc-field="filer-empty"]');
  const clear = (root: HTMLElement): HTMLElement | null =>
    root.querySelector<HTMLElement>('[data-pkc-field="filer-clear-filter"]');

  const three = [meta('a', 1, '買い物メモ'), meta('b', 2, '会議録')];

  it('🔴 絞って 0 件なら、そう言って戻り道を出す', () => {
    const { root, d } = setupBound(three);
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '存在しない語' });
    expect(empty(root)?.textContent, '0 件の字が出ていない').toContain('絞り込みに一致するものがありません');
    expect(clear(root), '戻り道が無い').not.toBeNull();
  });

  it('⚠ 対照群: 1 件でも当たれば出さない', () => {
    const { root, d } = setupBound(three);
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '買い物' });
    expect(empty(root), '当たっているのに 0 件の字が出た').toBeNull();
    expect(clear(root)).toBeNull();
  });

  it('⚠ 対照群: 絞っていなければ出さない(ノートが在るのに空と言わない)', () => {
    const { root } = setupBound(three);
    expect(empty(root), '絞っていないのに 0 件の字が出た').toBeNull();
    expect(clear(root)).toBeNull();
  });

  it('🔑 種類の札だけで 0 件になったときも、戻り道を出す', () => {
    // ⚠ ここで出さないと、種類で絞った user は戻し方が画面から読めない
    const { root, d } = setupBound(three);
    d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'form' });
    expect(empty(root), '種類で 0 件になったのに何も出ない').not.toBeNull();
    expect(clear(root), '戻り道が無い').not.toBeNull();
  });

  /**
   * 🔴 **押したら本当に外れる**(2026-08-29)。⚠ 絞りは 2 種類ある(語と種類の札)ので、
   *   語だけ空にすると**種類で 0 件の user が押しても何も起きない**= dead click。
   */
  it('🔴 種類だけで絞っているときに押すと、ちゃんと外れる(dead click にしない)', () => {
    const { root, d } = setupBound([meta('a', 1, '買い物メモ')]);
    d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'form' });
    // ⚠ **前提** ── 種類で 0 件になっている(ここが崩れると何も見ていない)
    expect(d.getState().kindFilter.size, '前提が崩れている').toBe(1);
    const btn = clear(root);
    expect(btn, '種類で 0 件なのに戻り道が無い').not.toBeNull();
    btn!.click();
    expect(d.getState().kindFilter.size, '押しても種類の絞りが残っている(dead click)').toBe(0);
    expect(d.getState().filterQuery, '語の絞りも空になっていない').toBe('');
  });

  it('⚠ ノートが 1 件も無く、絞ってもいないときは「絞りを外す」を出さない(外す物が無い)', () => {
    const { root } = setupBound([]);
    expect(clear(root), '外す物が無いのに「絞りを外す」を出した(dead click)').toBeNull();
    // ⚠ 空振り防止 ── 器ごと出ていないなら、この test は何も見ていない
    expect(empty(root)?.textContent, '0 件の字が出ていない').toBe('まだ何もありません');
  });
});

describe('🔴 ノートの行を 2 回続けて押すと、別のウィンドウ(付箋)で開く(#1042 C14)', () => {
  it('🔴 ノートを 2 回続けて押すと、別のウィンドウ(付箋)で開く', () => {
    const { row, openedWindows, d } = setupBound([meta('a', 1, '買い物メモ')]);
    row('a').click();
    expect(openedWindows, '1 回目で開いてしまった').toEqual([]);
    row('a').click();
    expect(openedWindows, '2 回目で開かなかった').toEqual(['a']);
    // ⚠ 1 回目で中央に出す選択そのものは今までどおり(2 回目でも壊れていない)
    expect(d.getState().selectedLid).toBe('a');
  });

  it('⚠ 間が空いたら「2 回押した」と数えない(席を立って戻ったら開く、を作らない)', () => {
    // ⚠ 観測点は `Date.now` ── unit の 2 回のクリックは同一ミリ秒で走るので、
    //   差し替えないと 500ms の窓を 1 度も通らない(通らない経路は守れない)
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    const { row, openedWindows } = setupBound([meta('a', 1, '買い物メモ')]);
    row('a').click();
    now.mockReturnValue(6_000); // 5 秒後
    row('a').click();
    expect(openedWindows, '5 秒空いたのに「続けて押した」と数えた').toEqual([]);
    now.mockReturnValue(6_200); // 続けて押した
    row('a').click();
    expect(openedWindows, '続けて押しても開かない').toEqual(['a']);
    now.mockRestore();
  });

  it('⚠ 対照群: フォルダの行を 2 回続けて押すと、別窓ではなく中へ入る', () => {
    const { row, openedWindows, d } = setupBound([meta('f1', 1, 'はこ', 'folder')]);
    row('f1').click();
    row('f1').click();
    expect(d.getState().scopeLid, 'フォルダの 2 回押しで中へ入っていない').toBe('f1');
    expect(openedWindows, 'フォルダを別窓で開いた').toEqual([]);
  });
});

describe('🔴 フォルダの表でも矢印・Enter・絞り込みからの降下が効く(#1042 C2 / #1092)', () => {
  it('🔴 行と表が、Tab と矢印の受け皿になる tabindex を持つ(属性で見る)', () => {
    /**
     * 🔴 **属性で見る**(`tests/adapter/filer-view.test.ts` と同じ理由)── `tabIndex` の getter は
     * 置いていなくても `-1` を返すので `toBe(-1)` は**外しても緑**になる。
     */
    const { root, row } = setupBound([meta('a', 1, 'あ')]);
    const table = root.querySelector('[data-pkc-region="filer-table"]')!;
    expect(table.getAttribute('tabindex'), 'Tab で表に入れない').toBe('0');
    expect(row('a').getAttribute('tabindex'), '行まで巡回に入れると Tab が件数分になる').toBe('-1');
  });

  it('🔴 行を押した後、↓ で次の行、↑ で前の行へ焦点が移る(端では止まる)', () => {
    const { row, press } = setupBound([meta('a', 1, 'あ'), meta('b', 2, 'い'), meta('c', 3, 'う')]);
    row('a').focus();
    press(row('a'), 'ArrowDown');
    expect(document.activeElement, '次の行へ焦点が移っていない').toBe(row('b'));
    press(row('b'), 'ArrowDown');
    expect(document.activeElement).toBe(row('c'));
    press(row('c'), 'ArrowDown'); // ⚠ 端 ── 巻き戻らない
    expect(document.activeElement, '末尾で巻き戻った').toBe(row('c'));
    press(row('c'), 'ArrowUp');
    expect(document.activeElement).toBe(row('b'));
  });

  it('🔴 焦点の行で Enter を押すと、クリックと同じく中央にそのノートが出る', () => {
    const { row, press, d } = setupBound([meta('a', 1, 'あ'), meta('b', 2, 'い')]);
    row('b').focus();
    press(row('b'), 'Enter');
    expect(d.getState().selectedLid, 'Enter で開いていない').toBe('b');
  });

  it('🔴 絞り込みの欄で ↓ を押すと、1 件目の行へ焦点が移る', () => {
    const { filterInput, row, press } = setupBound([meta('a', 1, 'あ'), meta('b', 2, 'い')]);
    filterInput.focus();
    press(filterInput, 'ArrowDown');
    expect(document.activeElement, '1 件目へ焦点が移っていない').toBe(row('a'));
  });

  it('⚠ 対照群: 行が 1 件も無いとき、絞り込みの欄で ↓ を押しても何も起きない(空振り防止)', () => {
    const { filterInput, press } = setupBound([]);
    filterInput.focus();
    press(filterInput, 'ArrowDown');
    expect(document.activeElement, '行が無いのに焦点が動いた').toBe(filterInput);
  });

  it('🔴 名前の打ち替えを Escape でやめると、焦点がその行へ戻る', () => {
    const { root, row, d, press } = setupBound([meta('a', 1, '買い物メモ')]);
    d.dispatch({ type: 'ROW_RENAME_BEGIN', lid: 'a' });
    const input = root.querySelector<HTMLInputElement>('[data-pkc-field="row-rename"]')!;
    press(input, 'Escape');
    expect(d.getState().renamingLid, '打ち替えが終わっていない').toBeNull();
    expect(document.activeElement, 'やめても行へ焦点が戻っていない').toBe(row('a'));
  });

  it('🔴 焦点の行で Alt+Enter を押すと、中央のノートは動かさず横の枠(スタック)に開く(#1092)', () => {
    const { row, press, d } = setupBound([meta('a', 1, 'ノートA'), meta('b', 2, 'ノートB')]);
    // 先にノートAを中央に開いておく
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    expect(d.getState().selectedLid).toBe('a');

    // ノートBを選んで Alt+Enter を押す
    row('b').focus();
    press(row('b'), 'Enter', { altKey: true, code: 'Enter' });

    // 中央のノートAは維持されたまま、ノートBがスタックに載る
    expect(d.getState().selectedLid, '中央のノートが動いてしまった').toBe('a');
    expect(d.getState().splitLids, 'スタックに開いていない').toContain('b');
    expect(d.getState().splitLids[0], '新しく載せた物が先頭に来ていない').toBe('b');
  });

  it('🔴 すでにスタックに留められているノートで Alt+Enter を押すと、先頭へ上がる(#1092)', () => {
    const { row, press, d } = setupBound([
      meta('a', 1, 'ノートA'),
      meta('b', 2, 'ノートB'),
      meta('c', 3, 'ノートC'),
    ]);
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'c' });
    // スタックは現在 ['c', 'b']
    expect(d.getState().splitLids).toEqual(['c', 'b']);

    // ノートBで Alt+Enter を押すと一番上へ上がる
    row('b').focus();
    press(row('b'), 'Enter', { altKey: true, code: 'Enter' });
    expect(d.getState().splitLids, '先頭へ繰り上がっていない').toEqual(['b', 'c']);
  });

  it('🔴 画面が狭いとき(phone)、Alt+Enter を押すと横に開かず画面下に理由を通知する(#1092)', () => {
    const showStatus = vi.fn();
    const { root, row, press, d } = setupBound(
      [meta('a', 1, 'ノートA'), meta('b', 2, 'ノートB')],
      { showStatus },
    );
    root.setAttribute('data-pkc-layout', 'phone');

    row('b').focus();
    press(row('b'), 'Enter', { altKey: true, code: 'Enter' });

    expect(d.getState().splitLids.length, '狭い画面なのにスタックに載ってしまった').toBe(0);
    expect(showStatus).toHaveBeenCalledWith('画面が狭いため横に並べられません');
  });
});
