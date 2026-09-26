import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { SidebarRenderer } from '../../src/adapter/ui/render/sidebar';
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

  /**
   * 🔴 **印(複数選択)も指紋の一部**(#1038 台帳③ 段 G、C13)。⚠ `selectedLid`
   * を動かさずに `state.selection` だけ動くのが本来の形(Ctrl クリック)
   * ── `selectionChanged` だけを指紋にすると、このケースで DOM に触れない
   * (§7「同じ判定が複数の場所にある」の速い経路版)。
   */
  it('🔴 印(marked)は selectedLid を動かさずに patch される', () => {
    const { sidebar, state, rows } = setup([meta('a', 1), meta('b', 2), meta('c', 3)]);
    const before = rows();
    let s = reduce(state, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'c' }).state;
    // ⚠ この時点で selectedLid は動いていない('a' のまま)。⚠ `SELECT_ENTRY` は
    //   選択を `[lid]` へ置き換えるので、開いている 'a' 自身も印の集合に居る
    //   (= 「開いていて、かつ印が付いている」行 ── CSS 側は `!important` で
    //   開いている見え方を保つ。`tests/adapter/mark-bg-css.test.ts` が pin)
    expect(s.selectedLid, '印を付けただけで中央が変わった').toBe('a');
    expect(s.selection).toEqual(['a', 'c']);
    sidebar.render(s);
    const after = rows();
    after.forEach((node, i) => expect(node).toBe(before[i]));
    expect(before[0]?.hasAttribute('data-pkc-marked'), '開いている a に印が出ていない').toBe(
      true,
    );
    expect(before[1]?.hasAttribute('data-pkc-marked'), '選んでいない b に印が付いた').toBe(false);
    expect(before[2]?.hasAttribute('data-pkc-marked'), 'c に印が出ていない').toBe(true);
    // 外すと消える
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'c' }).state;
    sidebar.render(s);
    expect(before[2]?.hasAttribute('data-pkc-marked'), '外した印が残っている').toBe(false);
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
    /**
     * 🔴 **teardown を必ず呼ぶ**(#1042 C2 の実装中に判明)。
     * ⚠ `doc, 'keydown', onShortcut` は `document` に付くので、呼ばずに `it` を
     *   終えると次の `it`(や別の `describe`)にも生き残り、そちらの keydown を
     *   二重に処理する(この `it` の行「買い物メモ」が、無関係な後続 test の
     *   焦点の行として実際に漏れて出た)。
     */
    const unbind = bindActions(root, d);
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
    unbind();
  });

  /**
   * ⚠ **2026-09-05(#722 P2-13)に観測点を絞った。** 直す前は「器ごと出ない」を
   *   見ていたが、ノートが 1 件も無いときは**器を出して「次の一手」を置く**ように
   *   なった(作る / 取り込む)。
   * 🔑 **この test が守っているのは「外す物が無いのに『絞りを外す』を出さない」**
   *   ── dead click の禁止であって、器の有無ではない。だから見るのはボタンの側。
   */
  it('⚠ ノートが 1 件も無い器では「絞りを外す」を出さない(外す物が無い)', () => {
    const root = document.createElement('div');
    const regions = buildShell(root);
    const sidebar = new SidebarRenderer(regions.sidebar);
    sidebar.render({ ...bootedState([]), filterQuery: 'x' });
    expect(clear(root), 'ノートが無いのに「絞りを外す」を出した(dead click)').toBeNull();
    // ⚠ 空振り防止 ── 器ごと出ていないなら、この test は何も見ていない(#722 で器は出る)
    expect(box(root), '0 件の器そのものが出ていない(次の一手も出ていない)').not.toBeNull();
  });
});

/**
 * 🔴 **一覧タブの行を 2 回続けて押すと、別のウィンドウ(付箋)で開く**(#1042 C14)。
 *
 * ⚠ フォルダ表 / 2 ペインの「2 回押し」(#240 段①)は「中へ入る」だが、一覧タブに
 * `scopeLid`(現在地)の概念は無いので、フォルダの行でも「中へ入る」は起こさない
 * (`tests/adapter/multi-select.test.ts`「もう一度押す」もフォルダ面の中だけ ──
 * 見えない現在地が動かないことを既に pin している)。行の種類に関わらず、
 * `open-note-window`(右クリック / 右の列「別のウィンドウで開く」)と**同じ経路**
 * (`services.openNoteWindow`)で開く。
 */
describe('🔴 一覧タブの 2 回押しで別のウィンドウ(付箋)を開く(#1042 C14)', () => {
  /**
   * 🔴 **`bindActions` の teardown を必ず呼ぶ**(#1042 C2 の実装中に判明)。
   * ⚠ `doc, 'keydown', onShortcut` は **`document` に付く**(root ではない)ので、
   *   呼ばずに `it` を終えると**次の `it` にも生き残り**、そちらの keydown を
   *   二重に処理する(古い `root` は detached でも `.focus()` は通ってしまう ──
   *   happy-dom は detached 要素でも focus を受け付ける)。C2 の絞り込み降下の
   *   test がこれで実際に外した(無関係な前の `it` の行へ焦点が飛んだ)。
   */
  let unbind: (() => void) | null = null;
  afterEach(() => {
    unbind?.();
    unbind = null;
  });
  function setupBound(metas: EntryMeta[]) {
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const sidebar = new SidebarRenderer(regions.sidebar);
    const d = new Dispatcher();
    d.onState((st) => sidebar.render(st));
    const openedWindows: string[] = [];
    unbind = bindActions(root, d, { openNoteWindow: (lid) => openedWindows.push(lid) });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
    const row = (lid: string) =>
      root.querySelector<HTMLElement>(`[data-pkc-region="entry-list"] [data-pkc-entry="${lid}"]`)!;
    return { root, d, row, openedWindows };
  }

  it('🔴 ノートを 2 回続けて押すと、別のウィンドウ(付箋)で開く', () => {
    const { row, openedWindows, d } = setupBound([meta('a', 1, '買い物メモ')]);
    row('a').click();
    expect(openedWindows, '1 回目で開いてしまった').toEqual([]);
    row('a').click();
    expect(openedWindows, '2 回目で開かなかった').toEqual(['a']);
    // ⚠ 1 回目で中央に出す選択そのものは今までどおり(2 回目でも壊れていない)
    expect(d.getState().selectedLid).toBe('a');
  });

  it('🔴 フォルダの行を 2 回続けて押しても、一覧では中へ入らず別のウィンドウ(付箋)で開く', () => {
    // ⚠ フォルダ表 / 2 ペインとは違う結果になることを言う test ── 一覧に
    //   `scopeLid` の概念が無いことの確認(見えない現在地を動かさない)
    const { row, openedWindows, d } = setupBound([meta('f1', 1, 'はこ', 'folder')]);
    row('f1').click();
    row('f1').click();
    expect(openedWindows, 'フォルダなのに別窓で開かなかった').toEqual(['f1']);
    expect(d.getState().scopeLid, '一覧タブの 2 回押しで見えない現在地が動いた').toBeNull();
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
});

/**
 * 🔴 **一覧タブに矢印・Enter・絞り込みからの降下・打ち替え後の焦点の戻しを付ける**
 * (#1042 C2)。
 *
 * ⚠ フォルダの表(`filer.ts`)・2 ペイン(`dual-filer.ts`)は既に行が焦点を持ち、
 * ↑↓ で送り Enter で開けたが、一覧タブだけ例外だった(`tests/adapter/multi-select.test.ts`
 * 「一覧タブの 2 回押しで現在地が動いた」と同じ、面ごとの不揃い)。行に
 * `tabIndex=-1`(`filer.ts` の `tr.tabIndex=-1` と同じ作法)、一覧そのものに
 * `tabIndex=0` を付け、`filer-row-down` / `filer-row-up` / `filer-open` を共有する。
 * ⚠ フォルダの行でも「中へ入る」は起こさない(一覧に `scopeLid` の概念は無い ──
 * C14 の control group と同じ理由)。
 */
describe('🔴 一覧タブでも矢印・Enter・絞り込みからの降下が効く(#1042 C2)', () => {
  // ⚠ `bindActions` の teardown を必ず呼ぶ(上の C14 の describe と同じ理由 ──
  //   呼ばないと `document` の keydown 購読が次の `it` へ漏れる)。
  let unbind: (() => void) | null = null;
  afterEach(() => {
    unbind?.();
    unbind = null;
  });
  function setupBound(metas: EntryMeta[]) {
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const sidebar = new SidebarRenderer(regions.sidebar);
    const d = new Dispatcher();
    d.onState((st) => sidebar.render(st));
    unbind = bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
    const row = (lid: string) =>
      root.querySelector<HTMLElement>(`[data-pkc-region="entry-list"] [data-pkc-entry="${lid}"]`)!;
    const filterInput = root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')!;
    const press = (el: HTMLElement, key: string): void => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    };
    return { root, d, row, filterInput, press };
  }

  it('🔴 一覧そのものと行が、フォルダの表と同じ tabindex を持つ(属性で見る)', () => {
    /**
     * 🔴 **属性で見る**(`tests/adapter/filer-view.test.ts` と同じ理由)── `tabIndex`
     * の getter は置いていなくても `-1` を返すので `toBe(-1)` は**外しても緑**になる
     * (実際に変異試験で確かめた:`row.tabIndex = -1;` を消しても `toBe(-1)` は
     * 通ってしまい、`.focus()` も happy-dom では通ってしまう)。
     */
    const { root, row } = setupBound([meta('a', 1, 'あ')]);
    const list = root.querySelector('[data-pkc-region="entry-list"]')!;
    expect(list.hasAttribute('tabindex'), '一覧に焦点が入らない').toBe(true);
    expect(list.getAttribute('tabindex'), 'Tab で一覧に入れない').toBe('0');
    expect(row('a').getAttribute('tabindex'), '行まで巡回に入れると Tab が件数分になる').toBe(
      '-1',
    );
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

  it('🔴 フォルダの行で Enter を押しても、一覧では中へ入らずクリックと同じ挙動になる', () => {
    const { row, press, d } = setupBound([meta('f1', 1, 'はこ', 'folder')]);
    row('f1').focus();
    press(row('f1'), 'Enter');
    expect(d.getState().selectedLid, 'Enter で開いていない').toBe('f1');
    expect(d.getState().scopeLid, '一覧で中へ入ってしまった(現在地が動いた)').toBeNull();
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
});
