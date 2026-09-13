/** @vitest-environment happy-dom */
/**
 * 🔴 **グループ自体を並べ替える**(#857 段③)── 繋がりの側。
 *
 * ⚠ 意味論(並ぶ規則 / 何を書くか)は `tests/features/group-order.test.ts`。
 *   ここが見るのは「**押したら、画面と保存にどう届くか**」である。
 *
 * 🔴 守る主張:
 * 1. 「上へ」で**画面の並びがその場で変わる**(disk の往復を待たない)
 * 2. 🔴 **ノートが増えるときは、押す前に聞く**(黙って N 枚生やさない)
 * 3. ⚠ **やめたら 1 バイトも書かない**
 * 4. ⚠ 2 回目からは聞かない(もう番号が付いている)
 * 5. ⚠ 絞り込み中は動かさない(見えていない群をまたぐ)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { APP_GROUP_ARCHETYPE } from '../../src/features/launcher/app-group-spec';
import { withBuiltinTiles, type LauncherTile } from '../../src/features/launcher/tiles';

function meta(lid: string, title: string, archetype: string, order: number): EntryMeta {
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

/** 群 3 つ(名前順 = 仕事 / 資料 / 道具)+ 組み込み。 */
const TILES = (): LauncherTile[] =>
  withBuiltinTiles(
    [
      { lid: 'a1', title: 'a', group: '仕事', kind: 'url', url: 'https://a.test/', order: 0 },
      { lid: 'b1', title: 'b', group: '資料', kind: 'url', url: 'https://b.test/', order: 0 },
      { lid: 'c1', title: 'c', group: '道具', kind: 'url', url: 'https://c.test/', order: 0 },
    ],
    { office: false },
  );

let st: AppState;

beforeEach(() => {
  st = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a1', 'a', 'attachment', 1), meta('b1', 'b', 'attachment', 2), meta('c1', 'c', 'attachment', 3)],
    relations: [],
  }).state;
  st = reduce(st, { type: 'LAUNCHER_TILES_LOADED', tiles: TILES() }).state;
});

const move = (s: AppState, name: string, by: -1 | 1): ReturnType<typeof reduce> =>
  reduce(s, { type: 'MOVE_APP_GROUP', name, by, newLids: ['n1', 'n2', 'n3'] });

describe('グループを動かす(#857 段③)', () => {
  it('🔴 ① 画面の並びがその場で変わる(disk を待たない)', () => {
    const r = move(st, '道具', -1);
    expect(r.state.appGroupOrders, '番号が state に入っていない').not.toEqual({});
    // 🔑 「道具」が「資料」より前に来ていること(番号で見る ── 画面の組み立ては renderer)
    const o = r.state.appGroupOrders;
    expect((o['道具'] ?? 99) < (o['資料'] ?? 99), '上へ動いていない').toBe(true);
  });

  it('🔴 ② 書く群の数だけ lid を採っていないと、1 バイトも書かない', () => {
    // ⚠ 足りないぶんを別の群の lid で埋めると、**別のノートを書き潰す**
    const r = reduce(st, { type: 'MOVE_APP_GROUP', name: '道具', by: -1, newLids: [] });
    expect(r.events, 'lid が足りないのに書こうとした').toEqual([]);
    expect(r.state.appGroupOrders, 'lid が足りないのに画面を動かした').toEqual({});
  });

  it('⚠ ③ 端では何もしない(押せて何も起きない、を作らない)', () => {
    expect(move(st, '仕事', -1).events, '先頭をさらに上へ動かした').toEqual([]);
    expect(move(st, '道具', 1).events, '末尾をさらに下へ動かした').toEqual([]);
  });

  it('🔴 ④ 絞り込み中は動かさない(見えていない群をまたぐ)', () => {
    const filtered = reduce(st, { type: 'SET_ENTRY_FILTER', query: 'a' }).state;
    const r = move(filtered, '道具', -1);
    expect(r.events, '絞り込み中に動かした').toEqual([]);
    expect(r.state.error ?? '', '断った理由を言っていない').toContain('絞り込み');
  });

  it('⚠ ⑤ 既にノートが在る群は、作らずにそこへ書く', () => {
    const withNote = reduce(st, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        meta('a1', 'a', 'attachment', 1),
        meta('b1', 'b', 'attachment', 2),
        meta('c1', 'c', 'attachment', 3),
        meta('g1', '道具', APP_GROUP_ARCHETYPE, 4),
      ],
      relations: [],
    }).state;
    const s2 = reduce(withNote, { type: 'LAUNCHER_TILES_LOADED', tiles: TILES() }).state;
    const w = move(s2, '道具', -1).events.find((e) => e.type === 'REQUEST_APP_GROUP_ORDER');
    const rows = (w as { rows: { name: string; lid: string | null }[] }).rows;
    expect(rows.find((x) => x.name === '道具')?.lid, '在るノートを使っていない').toBe('g1');
    // ⚠ 対照群 ── ノートの無い群は作る側になる
    expect(rows.find((x) => x.name === '資料')?.lid, '無い群に lid が付いている').toBeNull();
  });

  it('⚠ ⑥ 組み込みしか居ない群は動かせない(末尾に固定のまま)', () => {
    const r = move(st, '組み込みアプリ', -1);
    expect(r.events, '組み込みの群を動かした').toEqual([]);
  });
});

describe('ノートが増えることを、押す前に聞く(#857 段③)', () => {
  /**
   * 🔴 **黙って N 枚生やさない。**
   * ⚠ 番号は「動かした先より上に在る群」全部に要るので、初回はまとめて増える。
   */
  it('🔴 ⑦ 初回は聞く。やめたら 1 バイトも書かない', async () => {
    const { bindActions } = await import('../../src/adapter/ui/actions/binder');
    const { Dispatcher } = await import('../../src/adapter/state/dispatcher');
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.append(root);
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'move-app-group-up');
    btn.setAttribute('data-pkc-group', '道具');
    root.append(btn);

    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a1', 'a', 'attachment', 1), meta('b1', 'b', 'attachment', 2), meta('c1', 'c', 'attachment', 3)],
      relations: [],
    });
    d.dispatch({ type: 'LAUNCHER_TILES_LOADED', tiles: TILES() });

    const asked: number[] = [];
    const detach = bindActions(root, d, {
      confirmAppGroupNotes: (count) => {
        asked.push(count);
        return Promise.resolve(false); // やめる
      },
    });
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(asked, '聞かずに増やした').toHaveLength(1);
    expect(asked[0], '増える枚数を言っていない').toBeGreaterThan(0);
    expect(d.getState().appGroupOrders, 'やめたのに書いた').toEqual({});
    detach();
  });

  it('⚠ ⑧ 番号が付いていれば聞かない(2 回目以降)', async () => {
    const { bindActions } = await import('../../src/adapter/ui/actions/binder');
    const { Dispatcher } = await import('../../src/adapter/state/dispatcher');
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.append(root);
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'move-app-group-up');
    btn.setAttribute('data-pkc-group', '道具');
    root.append(btn);

    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        meta('a1', 'a', 'attachment', 1),
        meta('b1', 'b', 'attachment', 2),
        meta('c1', 'c', 'attachment', 3),
        meta('g1', '仕事', APP_GROUP_ARCHETYPE, 4),
        meta('g2', '資料', APP_GROUP_ARCHETYPE, 5),
        meta('g3', '道具', APP_GROUP_ARCHETYPE, 6),
      ],
      relations: [],
    });
    d.dispatch({ type: 'LAUNCHER_TILES_LOADED', tiles: TILES() });
    d.dispatch({
      type: 'APP_GROUP_NOTES_LOADED',
      icons: {},
      orders: { 仕事: 0, 資料: 1, 道具: 2 },
    });

    const asked = vi.fn(() => Promise.resolve(true));
    const detach = bindActions(root, d, { confirmAppGroupNotes: asked });
    btn.click();
    await Promise.resolve();
    expect(asked, 'もうノートが在るのに聞いた').not.toHaveBeenCalled();
    expect(d.getState().appGroupOrders['道具'], '動いていない').toBe(1);
    detach();
  });
});
