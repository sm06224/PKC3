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
import { APP_GROUP_RESET_ACTION } from '../../src/features/entry-actions';
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
    const r = move(s2, '道具', -1);
    const w = r.events.find((e) => e.type === 'REQUEST_APP_GROUP_ORDER');
    const rows = (w as { rows: { name: string; lid: string }[] }).rows;
    expect(rows.find((x) => x.name === '道具')?.lid, '在るノートを使っていない').toBe('g1');
    /**
     * 🔴 **対照群 ── ノートの無い群は「書く行」ではなく「作る」側へ回る**
     *   (2026-09-13 に作り方を変えた)。
     * ⚠ 直す前は effect が `store.persistEntry` で直に行を作っていたが、
     *   作った物が `entryMetas` に入らないので**サイドバーにも目録にも出なかった**。
     * 🔑 いまは `CREATE_ENTRY` を通すので、**その場で state に入る**。
     */
    expect(rows.some((x) => x.name === '資料'), '無い群が書く行に混ざっている').toBe(false);
    // ⚠ **増えた分だけ**を見る(元から在る `g1` も同じ archetype なので、
    //    素の絞り込みでは「作った物」と「在った物」が混ざる)
    const made = [...r.state.entryMetas.values()]
      .filter((m) => !s2.entryMetas.has(m.lid))
      .map((m) => m.title);
    expect(made, '作った群のノートが state に入っていない').toContain('資料');
    expect(made, '既に在る群のノートを二重に作った').not.toContain('道具');
  });

  /**
   * 🔴 **動線レビューが出した D2 の検算**(2026-09-13)。
   *
   * ⚠ レビューの読み:「ノートが在るか」は `entryMetas` で見るが、**保存は非同期**なので
   *   届く前にもう一度動かすと**同じ名前のノートがもう 1 枚**できるのではないか。
   * 🔑 いまは `CREATE_ENTRY` を reducer の中で通すので、**次の dispatch の時点で
   *   既に `entryMetas` に居る** ── disk を待たない。だから重複しない。
   * ⚠ この test は「速いか」ではなく「**disk の往復を 1 度も挟まずに 2 回押す**」形で見る
   *   (待ちを挟むと、この当の経路を通らない)。
   */
  it('🔴 ⑨ 保存を待たずに続けて動かしても、同じ群のノートは 2 枚にならない', () => {
    const first = move(st, '道具', -1);
    const made = [...first.state.entryMetas.values()].filter(
      (m) => m.archetype === APP_GROUP_ARCHETYPE,
    );
    // 前提を assert(ゼロ件の次元を作らない ── 1 回目で本当に作られている)
    expect(made.length, '1 回目で 1 枚も作られていない(前提が崩れている)').toBeGreaterThan(0);

    const second = reduce(first.state, {
      type: 'MOVE_APP_GROUP',
      name: '道具',
      by: 1,
      // ⚠ **別の lid を渡す** ── 使い回すと「重複しなかった」の理由が lid になる
      newLids: ['m1', 'm2', 'm3'],
    });
    const after = [...second.state.entryMetas.values()].filter(
      (m) => m.archetype === APP_GROUP_ARCHETYPE,
    );
    expect(after.length, '2 回目でノートが増えた(同じ群のノートが 2 枚)').toBe(made.length);
    const names = after.map((m) => m.title);
    expect(new Set(names).size, '同じ名前のノートが 2 枚ある').toBe(names.length);
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

    const asked: Array<readonly string[]> = [];
    const detach = bindActions(root, d, {
      confirmAppGroupNotes: (names) => {
        asked.push(names);
        return Promise.resolve(false); // やめる
      },
    });
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(asked, '聞かずに増やした').toHaveLength(1);
    expect(asked[0]!.length, '増える枚数を言っていない').toBeGreaterThan(0);
    /**
     * 🔴 **どの群が巻き込まれるかを渡している**(2026-09-13、動線レビュー D1)。
     * ⚠ 枚数だけだと「1 つ動かしただけなのに、なぜか複数のノートが増える」に見える ──
     *   押した群(道具)以外も並ぶことが、この assert の当の主張である。
     */
    expect(asked[0], '押した群しか渡していない(文面に名前を出せない)').toContain('仕事');
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
  /**
   * 🔴 **保存が飛んでいる間・起動中は動かさない**(変異試験 M11 が SURVIVED で教えた、
   * 2026-09-13)。
   * ⚠ 門は在ったが、**この状態を作って押す test が 1 本も無かった** ── 「弱い」ではなく
   *   **その枝を 1 度も通っていない**(CLAUDE.md §2)。
   * ⚠ 門を 2 つ置いたので、**2 つ目だけが鳴る場面**も作る(片方が死んでも気づけるように)。
   */
  it('🔴 ⑩ 保存中・起動中は動かさない(門を 2 つとも通す)', () => {
    const locked = { ...st, writeLock: { kind: 'save' } } as unknown as AppState;
    expect(move(locked, '道具', -1).events, '保存が飛んでいる間に動かした').toEqual([]);
    expect(move(locked, '道具', -1).state.appGroupOrders, '保存中なのに番号が動いた').toEqual({});

    const booting = { ...st, phase: 'initializing' } as unknown as AppState;
    expect(move(booting, '道具', -1).events, '起動中に動かした').toEqual([]);

    // 対照群 ── 門が外れているときは動く(規則そのものが生きている)
    expect(move(st, '道具', -1).events.length, '普通の状態でも動かない').toBeGreaterThan(0);
  });

  /**
   * 🔴 **書いた「あと」に読み直す**(2026-09-13、着地前レビューが出した)。
   * ⚠ 画面は先に動かすので、**書込が途中で止まると画面と disk が食い違う** ──
   *   読み直しが無いと `F5` まで誰も気づかない。
   */
  it('🔴 ⑪ 並べ替えたら、書いたあとに読み直す(画面と disk を離さない)', () => {
    const evs = move(st, '道具', -1).events;
    const write = evs.findIndex((e) => e.type === 'REQUEST_APP_GROUP_ORDER');
    const read = evs.findIndex((e) => e.type === 'REQUEST_APP_GROUP_NOTES');
    expect(write, '書く指示が出ていない').toBeGreaterThanOrEqual(0);
    expect(read, '読み直していない(衝突すると画面と disk が食い違ったまま残る)').toBeGreaterThan(
      write,
    );
  });

  /**
   * 🔴 **lid が足りないときに黙って止まらない**(2026-09-13、着地前レビュー)。
   * ⚠ 呼び側は確認の小窓を出す**前**に lid を採るので、「はい」を押すまでの間に
   *   別のタブが群を増やすと足りなくなる ── 黙って返すと
   *   **「はい」を押したのに画面が 1 ドットも変わらない**。
   */
  it('🔴 ⑫ lid が足りないときは、理由を言う(無言で止まらない)', () => {
    const r = reduce(st, { type: 'MOVE_APP_GROUP', name: '道具', by: -1, newLids: [] });
    expect(r.events, 'lid が足りないのに書いた').toEqual([]);
    expect(r.state.error, '黙って止まった(user には何も起きなかったように見える)').not.toBeNull();
    expect(r.state.error, '理由が読めない').toContain('もう一度');
  });
});

/**
 * 🔴 **並べ替えをやめて名前順へ戻す**(#857 段③。着地前の動線レビューが出した)。
 *
 * ⚠ **片道の操作を作らない**(CLAUDE.md 不可侵)── 「上へ / 下へ」を逆に押せば
 *   見た目は戻るが、**番号はノートに残り続ける**ので「番号の付いていない状態」へは
 *   帰れなかった(目印は「なし」で 1 回で外せるのに、並びだけ戻せない)。
 */
describe('名前順に戻す(#857 段③)', () => {
  const ordered = (): AppState => {
    const r = move(st, '道具', -1);
    // 前提を assert ── 番号が本当に付いている(ゼロ件の次元を作らない)
    expect(Object.keys(r.state.appGroupOrders).length, '前提が崩れている').toBeGreaterThan(0);
    return r.state;
  };

  it('🔴 番号を全部外す(画面はその場で名前順へ戻る)', () => {
    const r = reduce(ordered(), { type: 'RESET_APP_GROUP_ORDER' });
    expect(r.state.appGroupOrders, '番号が残っている').toEqual({});
  });

  it('🔴 ノートからも番号を消す指示を出す(画面だけ戻して disk を放置しない)', () => {
    const r = reduce(ordered(), { type: 'RESET_APP_GROUP_ORDER' });
    const w = r.events.find((e) => e.type === 'REQUEST_APP_GROUP_ORDER');
    expect(w, '書く指示が出ていない').toBeDefined();
    const rows = (w as { rows: { name: string; order: number | null }[] }).rows;
    expect(rows.length, '1 行も書かない(画面だけ戻して disk が置き去り)').toBeGreaterThan(0);
    for (const row of rows)
      expect(row.order, `${row.name} の番号を消していない`).toBeNull();
    // ⚠ 書いたあとに読み直す(動かすときと同じ)
    const read = r.events.findIndex((e) => e.type === 'REQUEST_APP_GROUP_NOTES');
    expect(read, '読み直していない').toBeGreaterThan(
      r.events.findIndex((e) => e.type === 'REQUEST_APP_GROUP_ORDER'),
    );
  });

  it('⚠ 保存中・起動中は戻さない', () => {
    const locked = { ...ordered(), writeLock: { kind: 'save' } } as unknown as AppState;
    expect(reduce(locked, { type: 'RESET_APP_GROUP_ORDER' }).events, '保存中に戻した').toEqual([]);
    expect(
      reduce(locked, { type: 'RESET_APP_GROUP_ORDER' }).state.appGroupOrders,
      '保存中なのに番号が消えた',
    ).not.toEqual({});
  });

  it('⚠ 番号が 1 つも無ければ、何も起きない(押し所もそもそも出ない)', () => {
    const r = reduce(st, { type: 'RESET_APP_GROUP_ORDER' });
    expect(r.events, '番号が無いのに書いた').toEqual([]);
  });

  /**
   * 🔴 **番号は在るのに、ノートが消えている**(2026-09-13。自分の diff を読み直して
   * 見つけた、**誰も通っていなかった枝**)。
   *
   * ⚠ 別の端末で、あるいはサイドバーから、グループ用のノートを**普通のノートとして
   *   消せる** ── そのとき画面の番号だけが残る。
   * 🔑 ここで止めてはいけない ── **書く先が無いだけ**で、画面は名前順へ戻すのが正しい
   *   (止めると「押しても何も起きない」が残り、しかも**戻す手が他に無い**)。
   */
  it('🔴 ノートが消えていても、画面の並びは名前順へ戻る(書く先が無いだけ)', () => {
    const before = ordered();
    // グループ用のノートだけを落とす(番号は state に残ったまま)
    const metas = new Map(before.entryMetas);
    for (const [lid, m] of metas) if (m.archetype === APP_GROUP_ARCHETYPE) metas.delete(lid);
    const orphan: AppState = {
      ...before,
      entryMetas: metas,
      order: before.order.filter((lid) => metas.has(lid)),
    };
    // 前提を assert ── 番号は在るが、書く先のノートは 1 枚も無い
    expect(Object.keys(orphan.appGroupOrders).length, '前提が崩れている').toBeGreaterThan(0);
    expect(
      [...orphan.entryMetas.values()].filter((m) => m.archetype === APP_GROUP_ARCHETYPE),
      '前提が崩れている(ノートが残っている)',
    ).toEqual([]);

    const r = reduce(orphan, { type: 'RESET_APP_GROUP_ORDER' });
    expect(r.state.appGroupOrders, '画面の番号が残った(名前順へ戻れない)').toEqual({});
    const w = r.events.find((e) => e.type === 'REQUEST_APP_GROUP_ORDER');
    expect((w as { rows: unknown[] } | undefined)?.rows, '消えたノートへ書こうとした').toEqual([]);
  });
});

/**
 * 🔴 **「すべて名前順に戻す」は、押した見出し以外にも効く**(2026-09-13、
 * 着地前の動線レビュー 欠陥 1)。
 *
 * ⚠ 直す前は字が「**名前順に戻す**」で、**押す前に何も聞かなかった** ──
 *   同じメニューの「上へ / 下へ」は押した見出しだけに効くので、user はこれも
 *   「この群だけ」と読む。🔴 実際は**番号を持つ群を全部**戻す
 *   (「資料」から押したのに、見てもいない「作業」の並びが消える。#677 の型)。
 * 🔑 群ごとに戻す形にはしない ── 1 群だけ番号を外すと**その群だけ末尾へ飛ぶ**
 *   (番号のある群が先に来る規則なので)。**全部戻すのが正しい**が、
 *   **そう書いていなかった**のが欠陥である。
 */
describe('「すべて名前順に戻す」は範囲を言う(#857 段③)', () => {
  /** 番号が付いた状態の画面を組む(押し所は「戻す」1 つだけ置く)。 */
  const mounted = async (): Promise<{
    root: HTMLElement;
    d: InstanceType<typeof import('../../src/adapter/state/dispatcher').Dispatcher>;
    btn: HTMLElement;
  }> => {
    const { Dispatcher } = await import('../../src/adapter/state/dispatcher');
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.append(root);
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'reset-app-group-order');
    root.append(btn);

    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a1', 'a', 'attachment', 1), meta('b1', 'b', 'attachment', 2), meta('c1', 'c', 'attachment', 3)],
      relations: [],
    });
    d.dispatch({ type: 'LAUNCHER_TILES_LOADED', tiles: TILES() });
    // 番号を付ける(lid は使われないこともあるが、足りないと 1 行も書かない)
    d.dispatch({ type: 'MOVE_APP_GROUP', name: '道具', by: -1, newLids: ['n1', 'n2', 'n3'] });
    return { root, d, btn };
  };

  it('🔴 字に「すべて」が入っている(押した見出しだけだと読ませない)', () => {
    expect(APP_GROUP_RESET_ACTION.label, '効く範囲が字から読めない').toContain('すべて');
  });

  it('🔴 押す前に聞く。やめたら 1 つも戻さない', async () => {
    const { bindActions } = await import('../../src/adapter/ui/actions/binder');
    const { root, d, btn } = await mounted();
    const before = { ...d.getState().appGroupOrders };
    // 前提 ── 戻す前に番号が在る(ゼロ件の次元を作らない)
    expect(Object.keys(before).length, '前提が崩れている').toBeGreaterThan(0);

    const asked: number[] = [];
    const detach = bindActions(root, d, {
      confirmResetAppGroupOrder: (count) => {
        asked.push(count);
        return Promise.resolve(false); // やめる
      },
    });
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(asked, '聞かずに全部戻した').toHaveLength(1);
    // ⚠ **いくつ戻るのか**を渡している(数を言わないと範囲が読めない)
    expect(asked[0], '戻る群の数を言っていない').toBe(Object.keys(before).length);
    expect(d.getState().appGroupOrders, 'やめたのに戻した').toEqual(before);
    detach();
  });

  it('🔴 はいなら、番号を持つ群が全部戻る', async () => {
    const { bindActions } = await import('../../src/adapter/ui/actions/binder');
    const { root, d, btn } = await mounted();
    const detach = bindActions(root, d, {
      confirmResetAppGroupOrder: () => Promise.resolve(true),
    });
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(d.getState().appGroupOrders, '戻っていない').toEqual({});
    detach();
  });
});
