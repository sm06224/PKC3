/** @vitest-environment happy-dom */
/**
 * フォルダの探し方(P3-7b / P8 段⑤)の end-to-end: binder(実クリック)→ BrowseRouter →
 * breadcrumb / explorer table。read-only ビュー(relation 作成 UI なし)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string, order: number, archetype = 'text'): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
  };
}

const rel = (id: string, from: string, to: string): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  document.body.textContent = '';
});

function setup(metas: EntryMeta[], relations: Relation[]) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  // 🔑 フォルダは**左の列**の探し方(P8 段⑤)── 中央のビューではない
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  // 🔑 探し方の切替は **service** が受ける(state ではなく画面側の都合 ── P8 段⑤)。
  // ⚠ ここを dispatch に置き換えると、タブを押しても切り替わらない実装が緑になる
  let mode: 'list' | 'filer' | 'launcher' = 'list';
  d.onState((s) => browse.render(s, mode));
  bindActions(root, d, {
    setBrowse: (m) => {
      mode = m as typeof mode;
      browse.render(d.getState(), mode);
    },
  });
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
  // ⚠ 器は**左の列**へ移った(P8 段⑤)
  const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]')!;
  const q = <T extends HTMLElement>(sel: string) => pane.querySelector<T>(sel);
  const rows = () =>
    [...pane.querySelectorAll('tbody [data-pkc-entry]')].map((r) =>
      r.getAttribute('data-pkc-entry'),
    );
  return { root, d, pane, q, rows };
}

describe('filer view (P3-7b)', () => {
  const METAS = [
    meta('f1', 1, 'folder'),
    meta('b', 2),
    meta('f2', 3, 'folder'),
    meta('a', 4),
  ];
  // f1 ── { f2, a }、f2 ── { b }。root: f1 のみ(b は f2 配下)
  const RELS = [rel('r1', 'f1', 'f2'), rel('r2', 'f1', 'a'), rel('r3', 'f2', 'b')];

  /**
   * 🔴 **1 クリックは選ぶだけ / 2 クリックで入る**(#240 段①。user 指示 2026-08-17
   * 「フォルダをダブルクリックで開くように変更」)。
   *
   * ⚠ 直す前は現在地が `selectedLid` の純関数で、**1 クリックで入って**いた ──
   * 選択が集合になった瞬間に「選択 → 現在地」の写像が壊れるので、先に分けている。
   */
  it('🔴 フォルダは 1 クリックで入らない(選ぶだけ)', async () => {
    const { root, d, q, rows } = setup(METAS, RELS);
    root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
    expect(rows()).toEqual(['f1']);

    q<HTMLElement>('tbody [data-pkc-entry="f1"]')!.click();
    await tick();
    expect(rows(), '1 クリックで入ってしまった').toEqual(['f1']);
    expect(d.getState().selectedLid, '選べてもいない').toBe('f1');
    expect(d.getState().scopeLid, '現在地が動いた').toBeNull();
  });

  it('🔴 2 クリックで入り、パンくずで戻れる', async () => {
    const { root, d, q, rows } = setup(METAS, RELS);
    root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
    const enter = (lid: string) => {
      const row = q<HTMLElement>(`tbody [data-pkc-entry="${lid}"]`)!;
      row.click();
      row.click(); // ⚠ 2 回目(#240 段①)── ネイティブ dblclick には頼らない
    };
    enter('f1');
    await tick();
    expect(rows()).toEqual(['f2', 'a']); // entryOrder 順
    expect(d.getState().scopeLid).toBe('f1');

    enter('f2');
    await tick();
    expect(rows()).toEqual(['b']);
    const crumb = q('[data-pkc-region="filer-breadcrumb"]')!;
    expect(crumb.textContent).toContain('t-f1');
    expect(crumb.textContent).toContain('t-f2');

    // パンくずの段は 1 クリックで戻る(選ぶ操作ではない)
    crumb.querySelector<HTMLElement>('[data-pkc-entry="f1"]')!.click();
    await tick();
    expect(rows()).toEqual(['f2', 'a']);
    expect(d.getState().scopeLid).toBe('f1');
  });

  it('🔴 ノートは 2 回押しても「入る」先にならない', () => {
    // ⚠ 変異試験 O3 が生き延びて判明 ── 種別の門を外しても誰も落ちなかった。
    //    外すと、ノートを 2 回押しただけで**中身が空の面**に迷い込む
    const { root, d, q } = setup(METAS, RELS);
    root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
    const row = q<HTMLElement>('tbody [data-pkc-entry="f1"]')!;
    row.click();
    row.click(); // f1 はフォルダ ── ここは入る
    expect(d.getState().scopeLid).toBe('f1');
    const note = q<HTMLElement>('tbody [data-pkc-entry="a"]')!;
    note.click();
    note.click(); // 'a' はノート ── 入らない
    expect(d.getState().scopeLid, 'ノートに入ってしまった').toBe('f1');
  });

  /**
   * 🔴 **2 回のクリックの間に行が作り直されても入れる**(#240 段①)。
   *
   * ⚠ ネイティブの `dblclick` はブラウザが「同じ node を 2 回」押したときにしか
   * 出さない ── この面は保存の ack で表を組み直すので、**実 user も「開かない」を踏む**
   * (実ブラウザ smoke で実際に落ちた形)。判定は lid で見る。
   */
  it('🔴 2 回目の前に行が作り直されても、フォルダに入れる', async () => {
    const { root, d, q, rows } = setup(METAS, RELS);
    root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
    q<HTMLElement>('tbody [data-pkc-entry="f1"]')!.click();
    await tick();
    // ⚠ 表を丸ごと組み直す(= 行の node が別物になる)
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '' });
    d.dispatch({ type: 'ENTRY_STAMPED', lid: 'f1', createdAt: '2026-08-18 00:00:00', updatedAt: '2026-08-18 00:00:01' });
    await tick();
    const again = q<HTMLElement>('tbody [data-pkc-entry="f1"]')!;
    again.click();
    await tick();
    expect(d.getState().scopeLid, '行が作り直されると入れない').toBe('f1');
    expect(rows()).toEqual(['f2', 'a']);
  });

  /**
   * 🔴 **ルートへ戻っても、開いているノートは閉じない**(#240 段①で直した)。
   * ⚠ 直す前は `DESELECT_ENTRY` を撃っていたので、**現在地を戻すだけで中央が空**に
   * なっていた ── 現在地と選択が同じ 1 つの値だったことの副作用である。
   */
  it('🔴 ルートへ戻しても選択と本文は残る', async () => {
    const { root, d, q, rows } = setup(METAS, RELS);
    root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
    const row = q<HTMLElement>('tbody [data-pkc-entry="f1"]')!;
    row.click();
    row.click(); // ⚠ 2 回目(#240 段①)
    await tick();
    q<HTMLElement>('tbody [data-pkc-entry="a"]')!.click();
    await tick();
    expect(d.getState().selectedLid).toBe('a');

    q<HTMLElement>('[data-pkc-region="filer-breadcrumb"] button')!.click();
    await tick();
    expect(rows()).toEqual(['f1']);
    expect(d.getState().scopeLid).toBeNull();
    expect(d.getState().selectedLid, 'ルートへ戻すと選択まで捨てている').toBe('a');
  });

  it('🔴 表そのものにも焦点を置ける(空のフォルダでも鍵の面に入れる)', async () => {
    /**
     * 🔴 **属性で見る** ── `tabIndex` の getter は置いていなくても `-1` を返すので
     * `toBe(-1)` は**外しても緑**になる(#240 で実際に生き延びた変異)。
     * ⚠ 直す前は binder の `focusFirstRow()` の中で付けていた ── つまり
     *   **その関数を 1 度通るまで表に焦点が入らない**ので、マウスだけの user は
     *   空のフォルダで鍵の面へ入れなかった(描く側が持つべき属性である)。
     */
    const { root, pane } = setup(METAS, RELS);
    root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
    await tick();
    const table = pane.querySelector('[data-pkc-region="filer-table"]')!;
    expect(table.hasAttribute('tabindex'), '表に焦点が入らない').toBe(true);
    expect(table.getAttribute('tabindex'), 'Tab の巡回に入れてはいけない').toBe('-1');
  });

  it('同一 scope 内の選択変更は属性 patch のみ(table を作り直さない ── review #2)', async () => {
    const { root, q, pane } = setup(METAS, RELS);
    root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
    const f1 = q<HTMLElement>('tbody [data-pkc-entry="f1"]')!;
    f1.click();
    f1.click(); // ⚠ 2 回目(#240 段①)
    await tick();
    const rowA = q<HTMLElement>('tbody [data-pkc-entry="a"]')!;
    const table = pane.querySelector('[data-pkc-region="filer-table"]');
    rowA.click(); // 非 folder 選択 ── scope 不変
    await tick();
    expect(q('tbody [data-pkc-entry="a"]')).toBe(rowA); // 同一ノード
    expect(pane.querySelector('[data-pkc-region="filer-table"]')).toBe(table);
    expect(rowA.hasAttribute('data-pkc-selected')).toBe(true);
  });

  /**
   * 🔴 **別のフォルダのノートを選んでも現在地は動かない**(#240 段①)。
   * ⚠ 直す前は「最近傍の祖先フォルダ」へ**勝手に移動**していた ── 一覧から
   * 検索で当てたノートを選ぶだけで、整理していた場所を見失う形だった。
   */
  it('🔴 非 folder を選んでも現在地は動かない', async () => {
    const { root, d, rows } = setup(METAS, RELS);
    root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' }); // 別のフォルダの中のノート
    await tick();
    expect(rows(), '選んだだけで現在地が動いた').toEqual(['f1']);
    expect(d.getState().scopeLid).toBeNull();
    expect(d.getState().selectedLid).toBe('a');
  });

  it('relations の無い container では全 entry が root に平置き', () => {
    const { root, rows } = setup([meta('x', 2), meta('y', 1)], []);
    root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
    expect(rows()).toEqual(['y', 'x']); // entryOrder 順
  });
});

/**
 * 🔴 **指紋に入れ忘れた材料は「死んだ操作子」になる**(#240 の着地前レビュー 3)。
 * ⚠ `filerRows` に渡していても、指紋に入っていなければ**1 バイトも描き直さない**。
 * ⚠ 同じ罠を sidebar で踏んで直した回帰 test は `SidebarRenderer` しか import して
 *    いなかった ── だからこちらは誰にも守られていなかった。
 */
describe('フォルダ面が描き直る材料(指紋)', () => {
  // ⚠ 題名の順と手動の順が**わざと逆**(同じなら、この test は空振りする)
  const M = [
    { ...meta('a', 1), title: 'zz' },
    { ...meta('b', 2), title: 'yy' },
    { ...meta('c', 3), title: 'xx' },
  ];

  it('🔴 並べ替えを選んだら、フォルダ面の並びも変わる', () => {
    const { root, d, rows } = setup(M, []);
    root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
    expect(rows()).toEqual(['a', 'b', 'c']); // 手動(entryOrder)順
    d.dispatch({ type: 'SET_ENTRY_SORT', sort: 'title' });
    expect(rows(), '並べ替えを選んでも表が組み直されない(死んだ操作子)').toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('🔴 本文検索の当たりが返ったら、フォルダ面にも増える', () => {
    const { root, d, rows } = setup(M, []);
    root.querySelector<HTMLElement>('[data-pkc-browse="filer"]')!.click();
    // 題名には無い語で絞る ── 当たりが返るまでは 0 行
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'なかみ' });
    expect(rows()).toEqual([]);
    d.dispatch({ type: 'SET_SEARCH_HITS', query: 'なかみ', lids: ['b'] });
    expect(rows(), '本文の当たりがフォルダ面に届いていない').toEqual(['b']);
  });
});

