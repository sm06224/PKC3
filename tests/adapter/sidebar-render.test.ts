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

/**
 * 🔴 **探す欄は「面の外」にある ── どの面でも state に合う**(#536 ②、2026-08-29)。
 *
 * ⚠ 同期は 1 稿目まで `SidebarRenderer` が持っていたが、あれは
 *   **一覧の面を開いているときしか走らない**(`browse.ts` が
 *   `mode === 'list'` のときだけ呼ぶ)── そのため
 *   **フォルダ / 連絡先 / 予定のタブで絞りが変わると、欄だけ古い字が残っていた**
 *   (タグの札を押した直後がその形)。
 * 🔑 #478「札の帯は面に関係なく描く」と同じ理由で、`browse.ts` へ移した。
 */
describe('🔴 探す欄は、どの面でも state に合う(#536 ②)', () => {
  const field = (root: HTMLElement): HTMLInputElement =>
    root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')!;

  it('一覧以外の面でも、絞りを変えると欄が追いつく', async () => {
    const { BrowseRouter } = await import('../../src/adapter/ui/render/browse');
    const root = document.createElement('div');
    const regions = buildShell(root);
    const b = new BrowseRouter(regions.sidebar, regions.sidebar, 'contacts', () => new Date());
    b.render({ ...initialState, filterQuery: '会議' } as AppState, 'contacts');
    expect(field(root).value, '一覧以外の面で欄が追いつかない').toBe('会議');

    // 🔑 **外したときも追いつく**(片道にしない)
    b.render({ ...initialState, filterQuery: '' } as AppState, 'contacts');
    expect(field(root).value, '外したのに古い字が残っている').toBe('');
  });
});

/**
 * 🔴 **0 件のときに、そう言って戻り道を出す**(2026-08-29 の動線レビュー)。
 *
 * ⚠ フォルダ・アプリ・連絡先の面には 0 件の字が出るのに、**既定の一覧タブだけ
 *   何も出なかった** ── 行が全部消えたように見え、しかも
 *   **自分が打っていない語**(タグの札を押した直後)が探す欄に入っているので、
 *   戻し方が画面から読み取れない。
 */
describe('🔴 一覧が 0 件のとき、理由と戻り道を出す(#550)', () => {
  const box = (root: HTMLElement): HTMLElement | null =>
    root.querySelector<HTMLElement>('[data-pkc-field="entry-list-empty"]');
  const clear = (root: HTMLElement): HTMLElement | null =>
    root.querySelector<HTMLElement>('[data-pkc-field="entry-list-clear-filter"]');

  function shown(filterQuery: string, kinds: ReadonlySet<string> = new Set()): HTMLElement {
    const root = document.createElement('div');
    const regions = buildShell(root);
    const sidebar = new SidebarRenderer(regions.sidebar);
    const state = bootedState([meta('a', 1, '買い物メモ'), meta('b', 2, '会議録')]);
    sidebar.render({ ...state, filterQuery, kindFilter: kinds });
    return root;
  }

  it('🔴 絞って 0 件なら、その語を挙げて言う', () => {
    const root = shown('存在しない語');
    expect(box(root)?.textContent, '0 件の字が出ていない').toContain('存在しない語');
    expect(clear(root), '戻り道が無い').not.toBeNull();
  });

  it('⚠ 対照群: 1 件でも当たれば出さない', () => {
    const root = shown('買い物');
    expect(box(root), '当たっているのに 0 件の字が出た').toBeNull();
  });

  it('⚠ 対照群: 絞っていなければ出さない(ノートが在るのに空と言わない)', () => {
    const root = shown('');
    expect(box(root), '絞っていないのに 0 件の字が出た').toBeNull();
  });

  it('🔑 種類の札だけで 0 件になったときも、戻り道を出す', () => {
    // ⚠ ここで出さないと、種類で絞った user は戻し方が画面から読めない
    const root = shown('', new Set(['form']));
    expect(box(root), '種類で 0 件になったのに何も出ない').not.toBeNull();
    expect(clear(root), '戻り道が無い').not.toBeNull();
  });

  /**
   * 🔴 **押したら本当に外れる**(2026-08-29)。⚠ 絞りは 2 種類ある(語と種類の札)ので、
   *   語だけ空にすると**種類で 0 件の user が押しても何も起きない**= dead click。
   */
  it('🔴 種類だけで絞っているときに押すと、ちゃんと外れる(dead click にしない)', async () => {
    const { Dispatcher } = await import('../../src/adapter/state/dispatcher');
    const { bindActions } = await import('../../src/adapter/ui/actions/binder');
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const sidebar = new SidebarRenderer(regions.sidebar);
    const d = new Dispatcher();
    d.onState((st) => sidebar.render(st));
    bindActions(root, d);
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a', 1, '買い物メモ')],
      relations: [],
    });
    d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'form' });
    // ⚠ **前提** ── 種類で 0 件になっている(ここが崩れると何も見ていない)
    expect(d.getState().kindFilter.size, '前提が崩れている').toBe(1);
    const btn = root.querySelector<HTMLElement>('[data-pkc-field="entry-list-clear-filter"]');
    expect(btn, '種類で 0 件なのに戻り道が無い').not.toBeNull();
    btn!.click();
    expect(d.getState().kindFilter.size, '押しても種類の絞りが残っている(dead click)').toBe(0);
    expect(d.getState().filterQuery, '語の絞りも空になっていない').toBe('');
  });

  it('⚠ ノートが 1 件も無い器では出さない(外す物が無い)', () => {
    const root = document.createElement('div');
    const regions = buildShell(root);
    const sidebar = new SidebarRenderer(regions.sidebar);
    sidebar.render({ ...bootedState([]), filterQuery: 'x' });
    expect(box(root), 'ノートが無いのに「絞りを外す」を出した(dead click)').toBeNull();
  });
});
