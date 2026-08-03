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
    dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'launcher' });
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
    dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'launcher' });
    await settle();
    expect(dispatcher.getState().launcherTiles).toHaveLength(1);
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
    dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'launcher' });
    await settle();
    dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'launcher' });
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
    for (const mode of ['kanban', 'calendar', 'filer', 'detail'] as const) {
      dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode });
    }
    await settle();
    expect(trips).toEqual([]);
    expect(singles).toEqual([]);
    off();
  });
});
