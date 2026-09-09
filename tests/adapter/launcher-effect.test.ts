/** @vitest-environment node */
/**
 * P7b 段⑩: ランチャーのタイルを**どう読むか**(効果側)。
 *
 * 🔴 「attachment だけ読む」は**性能の主張**である ── 全 entry を読んでも
 * 出来上がるタイルは同じなので、**結果を見る test では区別できない**
 * (変異試験で実際に生き残った)。だから**何を・何回読んだか**を見る。
 *
 * 🔴 「1 往復で読む」も同型の主張(review L-7)── `getBody` を添付の件数ぶん
 * 呼ぶ実装でも出来上がりは同じなので、**往復の回数**を数える。
 *
 * ⚠ 5,000 件のノートを持つ user がランチャーを開くたびに全 body を舐めると、
 * 「速く、安く」に真っ向から反する。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';
import { BUILTIN_GROUP, DUAL_TILE_LID,
  MANUAL_TILE_LID, OFFICE_TILE_LID, SCHEDULE_TILE_LID, CONTACTS_TILE_LID, type LauncherTile } from '../../src/features/launcher/tiles';
import type { EntryMeta } from '../../src/core/model/entry-meta';

function meta(lid: string, archetype: string): EntryMeta {
  return {
    lid,
    title: lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 0,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

/** 読みの呼ばれ方を数える最小の store。 */
function countingStore(bodies: Record<string, string>): {
  store: StorePort;
  /** `getBodies` 1 回 = 1 往復。要求された lid をそのまま積む */
  trips: string[][];
  /** 1 件ずつの読み(こちらが使われたら往復が増えている) */
  singles: string[];
} {
  const trips: string[][] = [];
  const singles: string[] = [];
  const store = {
    getBody: (lid: string) => {
      singles.push(lid);
      return Promise.resolve(bodies[lid] ?? null);
    },
    getBodies: (lids: string[]) => {
      trips.push([...lids]);
      return Promise.resolve(
        lids
          .filter((lid) => bodies[lid] !== undefined)
          .map((lid) => ({ lid, body: bodies[lid]! })),
      );
    },
  } as unknown as StorePort;
  return { store, trips, singles };
}

const APP_BODY = '---\nattachment.registered_as_app: true\nattachment.asset_key: k\n---\n';

async function settle(): Promise<void> {
  // 効果は単一 chain に直列化されている ── microtask を数回回せば行き渡る
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('ランチャーのタイルを読む', () => {
  it('🔴 **attachment だけ**を **1 往復で**読む(全 body を舐めない)', async () => {
    const { store, trips, singles } = countingStore({ a1: APP_BODY, a2: APP_BODY });
    const dispatcher = new Dispatcher();
    const off = connectStoreEffects(dispatcher, store);
    dispatcher.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c',
      metas: [
        meta('n1', 'text'),
        meta('a1', 'attachment'),
        meta('n2', 'todo'),
        meta('a2', 'attachment'),
      ],
      relations: [],
    });
    dispatcher.dispatch({ type: 'REFRESH_LAUNCHER_TILES' });
    await settle();
    // ⚠ **何を**読んだか ── 出来上がるタイルは全件読んでも同じなので、
    // 結果だけを見ると「全部読む」実装と区別がつかない
    expect(trips).toEqual([['a1', 'a2']]);
    // ⚠ **何回**往復したか ── 1 件ずつ読む実装は結果が同じで、ここでだけ落ちる
    expect(singles).toEqual([]);
    off();
  });

  it('読んだ結果が state に還流する', async () => {
    const { store } = countingStore({ a1: APP_BODY });
    const dispatcher = new Dispatcher();
    const off = connectStoreEffects(dispatcher, store);
    dispatcher.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c',
      metas: [meta('a1', 'attachment')],
      relations: [],
    });
    expect(dispatcher.getState().launcherTiles).toBeNull(); // まだ読んでいない
    dispatcher.dispatch({ type: 'REFRESH_LAUNCHER_TILES' });
    await settle();
    // ⚠ 組み込み(2 ペイン #241)が常に居る ── entry 由来は 1 件
    // 🔴 **カレンダー / カンバンはここから外れた**(#292 段⑤、2026-08-23)──
    //    あの 2 つは「アプリ」ではなく**ノートの見方**だったので、左の列の
    //    「予定」タブへ引っ越した
    // ⚠ **マニュアル**(#645、2026-08-31)も常に居る ── 端末を選ばない組み込みである
    // ⚠ **予定表**(#673 段②、user 裁定 2026-09-04)── 左の「予定」タブを残したまま、
    //    同じ面を別窓で開く 2 つ目の入口として戻った
    // ⚠ **探す**(#680)── 連絡先の次。左に同じ面は無い(欄だけ)、別窓で開く組み込み
    // 🔴 **組み込みは末尾**(#531 段② / #281、2026-09-08)── user が入れた `app` が先頭
    expect(dispatcher.getState().launcherTiles?.map((t) => t.kind)).toEqual([
      'app',
      'dual',
      'schedule',
      'contacts',
      'search',
      'manual',
      // ⚠ **支度の口は最後**(#532 段 B)── 足しても他のタイルの位置が動かない
      'selfhost',
    ]);
    off();
  });

  it('🔴 開くたびに読み直す(添付を足した直後に古い一覧を見せない)', async () => {
    const { store, trips } = countingStore({ a1: APP_BODY });
    const dispatcher = new Dispatcher();
    const off = connectStoreEffects(dispatcher, store);
    dispatcher.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c',
      metas: [meta('a1', 'attachment')],
      relations: [],
    });
    dispatcher.dispatch({ type: 'REFRESH_LAUNCHER_TILES' });
    await settle();
    dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    dispatcher.dispatch({ type: 'REFRESH_LAUNCHER_TILES' });
    await settle();
    expect(trips).toEqual([['a1'], ['a1']]);
    off();
  });

  it('ランチャー以外のビューでは読まない', async () => {
    const { store, trips, singles } = countingStore({ a1: APP_BODY });
    const dispatcher = new Dispatcher();
    const off = connectStoreEffects(dispatcher, store);
    dispatcher.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c',
      metas: [meta('a1', 'attachment')],
      relations: [],
    });
    for (const mode of ['query', 'dual', 'detail'] as const) {
      dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode });
    }
    await settle();
    expect(trips).toEqual([]);
    expect(singles).toEqual([]);
    off();
  });
});

describe('組み込み Office タイルの合流 (#148)', () => {
  async function tilesWith(officeInstalled: boolean): Promise<readonly LauncherTile[]> {
    const { store } = countingStore({ a1: APP_BODY });
    const dispatcher = new Dispatcher();
    const off = connectStoreEffects(dispatcher, store, {
      officeInstalled: () => officeInstalled,
    });
    dispatcher.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c',
      metas: [meta('a1', 'attachment')],
      relations: [],
    });
    dispatcher.dispatch({ type: 'REFRESH_LAUNCHER_TILES' });
    await settle();
    const tiles = dispatcher.getState().launcherTiles ?? [];
    off();
    return tiles;
  }

  /**
   * 🔴 **並びは固定**(#241 で 2 ペインが加わった。user 指摘 2026-08-19)。
   * ⚠ 2 ペインは**アプリに最初から在る**ので組み込みの束の先頭、Office は
   *   **入れた端末だけ**なのでその後ろ ── 入れたり消したりで 2 ペインの位置が
   *   動かない向きに並べる(「同じものが常に同じ場所にある」)。
   *
   * 🔴 **2026-09-08(#531 段② / #281)に束ごと末尾へ移した。**
   * ⚠ 直す前は組み込み 6 枚が**先頭**に居たので、user が自分で入れたタイルが
   *   **下へ押し下がって見えた**(#281 の実害)。いまは
   *   「**自分のもの → 「組み込みアプリ」の見出し → 組み込み 6 枚**」である。
   * 🔑 だから位置は**先頭からではなく、user のタイルの後ろから**数える ──
   *   前から数える書き方に戻すと、user のタイルが 1 枚増えるたびに落ちる。
   */
  /** user 由来のタイル(この fixture では `a1` の 1 枚)より後ろ = 組み込みの束。 */
  function builtinBlock(tiles: readonly LauncherTile[]): readonly LauncherTile[] {
    const own = tiles.findIndex((t) => t.lid === 'a1');
    // 空振り防止 ── user のタイルが 1 枚も出ていなければ、以降は何も見ていない
    expect(own, 'user 由来のタイル a1 が出ていない(以降の位置の主張が空振りする)').toBe(0);
    return tiles.slice(own + 1);
  }

  it('組み込みは 2 ペイン → 予定表 → Office の順で、user のタイルの後ろに付く', async () => {
    const tiles = await tilesWith(true);
    const b = builtinBlock(tiles);
    expect(b[0]?.lid, '2 ペインが組み込みの先頭でない').toBe(DUAL_TILE_LID);
    // ⚠ 予定表(#673 段②)は Office より前 ── アプリに最初から在るものを先に
    expect(b[1]?.lid, '予定表が 2 ペインの次に居ない').toBe(SCHEDULE_TILE_LID);
    expect(b[2]?.lid, '連絡先が予定表の次に居ない').toBe(CONTACTS_TILE_LID);
    // ⚠ 探す(#680)は連絡先の次 ── Office より前(アプリに最初から在る側)
    expect(b[3]?.kind, '探すが連絡先の次に居ない').toBe('search');
    expect(b[4]?.kind).toBe('office');
    expect(b[4]?.lid).toBe(OFFICE_TILE_LID);
    expect(b[5]?.lid, 'マニュアルが Office の次に居ない').toBe(MANUAL_TILE_LID);
    // ⚠ **支度の口は最後**(#532 段 B)── 1 度だけ使う物なので、他の位置を動かさない
    expect(b[6]?.kind, '自分のパソコンで動かす が組み込みの最後に居ない').toBe('selfhost');
    // 🔴 7 枚とも「組み込みアプリ」の群に居る(見出しが 1 本引かれる条件)
    expect(
      b.map((t) => t.group),
      '組み込みが既定群のまま(見出しが引かれず、自分のものと地続きに見える)',
    ).toEqual(Array.from({ length: 7 }, () => BUILTIN_GROUP));
  });

  it('🔴 Office が入っていなくても、最初から在るものは出る(位置も動かない)', async () => {
    const tiles = await tilesWith(false);
    expect(tiles.some((t) => t.kind === 'office')).toBe(false);
    // 🔴 組み込みを末尾へ回した効き ── Office の有無で
    //    **user のタイルの位置が 1px も動かない**(前に居たときは動いていた)
    expect(tiles[0]?.lid, 'Office の有無で entry 由来の位置が動いた').toBe('a1');
    const b = builtinBlock(tiles);
    expect(b[0]?.lid, 'Office の有無で 2 ペインの位置が動いた').toBe(DUAL_TILE_LID);
    expect(b[1]?.lid, 'Office の有無で予定表の位置が動いた').toBe(SCHEDULE_TILE_LID);
    expect(b[2]?.lid, 'Office の有無で連絡先の位置が動いた').toBe(CONTACTS_TILE_LID);
    expect(b[3]?.kind, 'Office の有無で探すの位置が動いた').toBe('search');
    // ⚠ **マニュアル**(#645)は Office の有無に依らず、組み込みの最後に居る
    expect(b[4]?.lid, 'Office の有無でマニュアルの位置が動いた').toBe(MANUAL_TILE_LID);
    expect(b[5]?.kind, 'Office の有無で支度の口の位置が動いた').toBe('selfhost');
    expect(b, '組み込みが 6 枚でない').toHaveLength(6);
  });
});
