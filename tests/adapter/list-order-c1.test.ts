/** @vitest-environment happy-dom */
/**
 * 一覧の並び順(台帳 #1852 の束 C1。依頼 193 / 275 / 198 / 274 / 334 / 82-3)。
 *
 * 🔴 守る主張:
 * 1. 種類順は**種類の札の順**、同じ種類の中は**渡された順(= 自分で並べた順)**のまま(193・275 A)
 * 2. 「最近開いた順」は**開いただけでは一覧の並びを動かさない**。絞り込み・フォルダの移動・
 *    並び順の変更・記録を消したときに初めて並べ直す(274)
 * 3. ↑↓ や Shift+クリックが読む並び(`filerRowOptions`)は、描く並びと**同じ材料**(334)
 * 4. 並びの向きを逆にするボタンが、左の列に在り、押すと向きが変わる(198)
 * 5. 並び順と向きを端末に憶え、起動で state へ戻す(82-3)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { ARCHETYPE_LABELS } from '../../src/features/flavor/archetype-label';
import { sortOrder } from '../../src/features/filter/entry-sort';
import { filerRows } from '../../src/features/relation/filer-list';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { filerRowOptions, listViewOptions } from '../../src/adapter/state/list-view-options';
import { connectOpenedEffects } from '../../src/adapter/platform/opened-effects';
import { OpenedStore, type OpenedStorage } from '../../src/adapter/platform/opened-store';
import { connectEntrySortMemory } from '../../src/adapter/platform/entry-sort-effects';
import { EntrySortStore } from '../../src/adapter/ui/render/entry-sort-memory';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
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
    bodyChars: null,
    ...over,
  };
}

const metasOf = (list: EntryMeta[]) => {
  const m = new Map(list.map((x) => [x.lid, x]));
  return (lid: string) => m.get(lid);
};

describe('種類順(依頼 193 / 275 A)', () => {
  // 札の並びの先頭から 4 つを使う。⚠ 期待値は ARCHETYPE_LABELS から引く(手で綴らない)
  const [k0, k1, k2] = ARCHETYPE_LABELS.map(([n]) => n);

  it('🔴 種類の札の順に並び、同じ種類の中は渡された順(題名でも lid でもない)', () => {
    // lid の辞書順・題名順のどちらでも「渡された順」にならない並びを作る
    const list = [
      meta('z1', { archetype: k1!, title: 'a' }),
      meta('y1', { archetype: k0!, title: 'z' }),
      meta('x1', { archetype: k1!, title: 'b' }),
      meta('w1', { archetype: k0!, title: 'y' }),
      meta('v1', { archetype: k2!, title: 'c' }),
    ];
    const order = ['z1', 'y1', 'x1', 'w1', 'v1'];
    expect(sortOrder(order, metasOf(list), 'archetype', false, () => 0)).toEqual([
      'y1', 'w1', // k0(渡された順)
      'z1', 'x1', // k1(渡された順)
      'v1', // k2
    ]);
  });

  it('🔴 向きを逆にすると、種類の並びだけが逆になる(中は渡された順のまま)', () => {
    const list = [
      meta('z1', { archetype: k1! }),
      meta('y1', { archetype: k0! }),
      meta('x1', { archetype: k1! }),
    ];
    expect(sortOrder(['z1', 'y1', 'x1'], metasOf(list), 'archetype', true, () => 0)).toEqual([
      'z1', 'x1', 'y1',
    ]);
  });

  it('知らない綴りは末尾(知らない綴りどうしは綴り順)。落とさない', () => {
    const list = [
      meta('u2', { archetype: 'zzz' }),
      meta('u1', { archetype: 'aaa' }),
      meta('k', { archetype: k0! }),
    ];
    expect(sortOrder(['u2', 'u1', 'k'], metasOf(list), 'archetype', false, () => 0)).toEqual([
      'k', 'u1', 'u2',
    ]);
  });
});

function fakeOpened(): OpenedStorage {
  let value: string | null = null;
  return {
    get: () => value,
    set: (_k, v) => {
      value = v;
    },
    remove: () => {
      value = null;
    },
  };
}

function booted() {
  const d = new Dispatcher();
  let clock = 1000;
  const store = new OpenedStore(fakeOpened());
  connectOpenedEffects(d, store, () => (clock += 10));
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      meta('a', { entryOrder: 1 }),
      meta('b', { entryOrder: 2 }),
      meta('c', { entryOrder: 3 }),
    ],
    relations: [],
  });
  const lids = () => {
    const s = d.getState();
    return filerRows(s.scopeLid, s.entryMetas, s.relations, filerRowOptions(s)).map((m) => m.lid);
  };
  return { d, lids };
}

describe('最近開いた順は、開いたその場では動かさない(依頼 274 / 334 B)', () => {
  it('🔴 開いても、一覧の並び(↑↓ と Shift+クリックが読む並びを含む)は動かない', () => {
    const { d, lids } = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'SET_ENTRY_SORT', sort: 'opened' });
    const before = lids();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'c' });
    // 前提: 記録のほうは確かに動いている(動いていないなら、この test は何も言っていない)
    expect(
      d.getState().openedAt.get('c') ?? 0,
      '前提が崩れている: 開いた記録が state に載っていない',
    ).toBeGreaterThan(d.getState().openedAt.get('a') ?? 0);
    expect(lids(), '開いただけで並びが跳んだ').toEqual(before);
    expect(listViewOptions(d.getState()).openedAt, '一覧は開いた直後の記録を読んでいる').toBe(
      d.getState().openedAtShown,
    );
  });

  it('🔴 絞り込み・種類の札・フォルダ・並び順を変えると、そのとき初めて並べ直す', () => {
    for (const change of [
      (d: Dispatcher) => d.dispatch({ type: 'SET_ENTRY_FILTER', query: 't' }),
      (d: Dispatcher) => d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'text' }),
      (d: Dispatcher) => d.dispatch({ type: 'SET_ENTRY_SORT', sort: 'opened', desc: false }),
    ]) {
      const { d, lids } = booted();
      d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
      d.dispatch({ type: 'SET_ENTRY_SORT', sort: 'opened' });
      d.dispatch({ type: 'SELECT_ENTRY', lid: 'c' });
      const stale = lids();
      change(d);
      expect(d.getState().openedAtShown, '写しが最新になっていない').toBe(d.getState().openedAt);
      expect(lids(), '変えたのに並びが動かない').not.toEqual(stale);
    }
  });

  it('起動時の読み込みと「記録を消す」は並びにも反映する(keepListOrder を付けない)', () => {
    const { d } = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    expect(d.getState().openedAtShown.size, '開いただけで写しが動いた').toBe(0);
    d.dispatch({ type: 'SET_OPENED_AT', openedAt: new Map([['b', 5]]) });
    expect(d.getState().openedAtShown.get('b')).toBe(5);
  });
});

describe('並びの向きを逆にするボタン(依頼 198)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('🔴 左の列に在り、「自分で並べた順」では押せず、他では押すと向きが変わる', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const browse = new BrowseRouter(regions.sidebar, regions.browseHost, 'filer');
    d.onState((s) => browse.render(s, 'filer'));
    bindActions(root, d);
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1', { title: 'あ', entryOrder: 1 }), meta('n2', { title: 'い', entryOrder: 2 })],
      relations: [],
    });
    const btn = root.querySelector<HTMLButtonElement>('[data-pkc-action="toggle-entry-sort-desc"]');
    expect(btn, '向きを逆にするボタンが左の列に無い').not.toBeNull();
    expect(btn!.disabled, '「自分で並べた順」なのに押せる').toBe(true);

    d.dispatch({ type: 'SET_ENTRY_SORT', sort: 'title' });
    expect(btn!.disabled, '題名順なのに押せない').toBe(false);
    const rows = () =>
      [...root.querySelectorAll('[data-pkc-region="filer-table"] tbody [data-pkc-entry]')].map((e) =>
        e.getAttribute('data-pkc-entry'),
      );
    expect(rows()).toEqual(['n1', 'n2']);
    btn!.click();
    expect(d.getState().entrySortDesc).toBe(true);
    expect(rows(), '押したのに画面の並びが逆にならない').toEqual(['n2', 'n1']);
    btn!.click();
    expect(rows(), '2 回押したのに元の向きに戻らない').toEqual(['n1', 'n2']);
  });
});

describe('並び順を端末に憶える(依頼 82-3)', () => {
  function storage(initial: string | null) {
    let v = initial;
    return {
      get raw() {
        return v;
      },
      getItem: () => v,
      setItem: (_k: string, x: string) => {
        v = x;
      },
    };
  }

  it('🔴 変えると憶え、次の起動で state に戻る(向きも)', () => {
    const st = storage(null);
    const d1 = new Dispatcher();
    d1.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    connectEntrySortMemory(d1, new EntrySortStore(st));
    d1.dispatch({ type: 'SET_ENTRY_SORT', sort: 'updated', desc: false });
    expect(st.raw, '憶えていない').toBe('updated:a');

    const d2 = new Dispatcher();
    d2.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    expect(d2.getState().entrySort, '前提: 新しい起動は既定から始まる').toBe('manual');
    connectEntrySortMemory(d2, new EntrySortStore(st));
    expect(d2.getState().entrySort).toBe('updated');
    expect(d2.getState().entrySortDesc, '向きが戻らない').toBe(false);
  });

  it('🔴 壊れた値・今は無い並びは「憶えていない」(既定のまま)', () => {
    for (const raw of ['bogus:a', 'title', 'title:x', '', 'title:a:d']) {
      const d = new Dispatcher();
      d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
      connectEntrySortMemory(d, new EntrySortStore(storage(raw)));
      expect(d.getState().entrySort, `「${raw}」で並びが変わった`).toBe('manual');
    }
  });

  it('既定のままなら、起動しただけでは何も書かない', () => {
    const st = storage(null);
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    connectEntrySortMemory(d, new EntrySortStore(st));
    expect(st.raw).toBeNull();
  });
});
