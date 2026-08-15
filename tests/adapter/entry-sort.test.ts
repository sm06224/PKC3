/** @vitest-environment happy-dom */
/**
 * 一覧の並び順(#183 / 台帳 #180 A-3)。
 *
 * 🔴 守る主張:
 * 1. 既定は **手で並べ替えた順**(`entry_order`)── 手動の導線を置き換えない
 * 2. 更新順は**新しい順**、題名・種類は昇順
 * 3. **同点は lid で割る**(割らないと行が実行のたびに入れ替わって見える)
 * 4. 選んだら**画面の並びが実際に変わる**(state だけ動いても意味が無い)
 * 5. 並べ替えても**選択は消えない**
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { sortOrder, isEntrySort, DEFAULT_ENTRY_SORT } from '../../src/features/filter/entry-sort';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { SidebarRenderer } from '../../src/adapter/ui/render/sidebar';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    ...over,
  };
}

const metasOf = (list: EntryMeta[]) => {
  const m = new Map(list.map((x) => [x.lid, x]));
  return (lid: string) => m.get(lid);
};

describe('並び順の規則', () => {
  it('既定は手動の順(渡された order をそのまま)', () => {
    expect(DEFAULT_ENTRY_SORT).toBe('manual');
    const list = [meta('c'), meta('a'), meta('b')];
    expect(sortOrder(['c', 'a', 'b'], metasOf(list), 'manual')).toEqual(['c', 'a', 'b']);
  });

  it('元の配列を壊さない(state の参照は指紋でもある)', () => {
    const order = ['b', 'a'];
    sortOrder(order, metasOf([meta('a'), meta('b')]), 'title');
    expect(order, '呼び側の配列がその場で書き換わった').toEqual(['b', 'a']);
  });

  it('題名順は昇順', () => {
    const list = [meta('x', { title: 'んご' }), meta('y', { title: 'あい' })];
    expect(sortOrder(['x', 'y'], metasOf(list), 'title')).toEqual(['y', 'x']);
  });

  it('🔴 更新順は**新しい順**(古い順にしない)', () => {
    const list = [
      meta('old', { updatedAt: '2026-01-01T00:00:00Z' }),
      meta('new', { updatedAt: '2026-08-15T00:00:00Z' }),
    ];
    expect(sortOrder(['old', 'new'], metasOf(list), 'updated')).toEqual(['new', 'old']);
  });

  it('種類順は archetype の昇順', () => {
    const list = [meta('t', { archetype: 'todo' }), meta('a', { archetype: 'attachment' })];
    expect(sortOrder(['t', 'a'], metasOf(list), 'archetype')).toEqual(['a', 't']);
  });

  it('🔴 同点は lid で割る(並びが実行ごとに変わらない)', () => {
    const list = [meta('b', { title: '同じ' }), meta('a', { title: '同じ' })];
    const once = sortOrder(['b', 'a'], metasOf(list), 'title');
    const twice = sortOrder(['a', 'b'], metasOf(list), 'title');
    expect(once).toEqual(['a', 'b']);
    expect(twice, '入力の順で結果が変わる = 不安定').toEqual(once);
  });

  it('未知の lid は落とさず末尾へ(黙って消えるほうが害が大きい)', () => {
    const list = [meta('a', { title: 'あ' })];
    expect(sortOrder(['ghost', 'a'], metasOf(list), 'title')).toEqual(['a', 'ghost']);
  });

  it('isEntrySort は 4 つだけ通す', () => {
    expect(['manual', 'updated', 'title', 'archetype'].every(isEntrySort)).toBe(true);
    expect(isEntrySort('relevance')).toBe(false);
  });
});

describe('並び順の配線(選ぶ → 画面が変わる)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('🔴 選ぶと一覧の並びが実際に変わり、選択は消えない', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const sidebar = new SidebarRenderer(regions.sidebar);
    d.onState((s) => sidebar.render(s));
    bindActions(root, d);
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        meta('n1', { title: 'ん', entryOrder: 1 }),
        meta('n2', { title: 'あ', entryOrder: 2 }),
      ],
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    const rows = () =>
      [...root.querySelectorAll('[data-pkc-region="entry-list"] [data-pkc-entry]')].map((e) =>
        e.getAttribute('data-pkc-entry'),
      );
    expect(rows()).toEqual(['n1', 'n2']); // 手動の順

    const sel = root.querySelector<HTMLSelectElement>('[data-pkc-field="entry-sort"]');
    expect(sel, '並び順の選択欄が画面に無い').not.toBeNull();
    sel!.value = 'title';
    sel!.dispatchEvent(new Event('change', { bubbles: true }));

    expect(d.getState().entrySort).toBe('title');
    expect(rows(), '選んだのに画面の並びが変わらない(指紋の入れ忘れ)').toEqual(['n2', 'n1']);
    expect(d.getState().selectedLid, '並べ替えで選択が消えた').toBe('n1');
  });
});
