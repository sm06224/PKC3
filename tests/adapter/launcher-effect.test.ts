/** @vitest-environment node */
/**
 * P7b 段⑩: ランチャーのタイルを**どう読むか**(効果側)。
 *
 * 🔴 「attachment だけ読む」は**性能の主張**である ── 全 entry を読んでも
 * 出来上がるタイルは同じなので、**結果を見る test では区別できない**
 * (変異試験で実際に生き残った)。だから**読んだ回数そのもの**を見る。
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

/** `getBody` の呼ばれ方を数える最小の store。 */
function countingStore(bodies: Record<string, string>): {
  store: StorePort;
  reads: string[];
} {
  const reads: string[] = [];
  const store = {
    getBody: (lid: string) => {
      reads.push(lid);
      return Promise.resolve(bodies[lid] ?? null);
    },
  } as unknown as StorePort;
  return { store, reads };
}

const APP_BODY = '---\nattachment.registered_as_app: true\nattachment.asset_key: k\n---\n';

async function settle(): Promise<void> {
  // 効果は単一 chain に直列化されている ── microtask を数回回せば行き渡る
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('ランチャーのタイルを読む', () => {
  it('🔴 **attachment だけ**読む(全 body を舐めない)', async () => {
    const { store, reads } = countingStore({ a1: APP_BODY });
    const dispatcher = new Dispatcher();
    const off = connectStoreEffects(dispatcher, store);
    dispatcher.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c',
      metas: [meta('n1', 'text'), meta('n2', 'todo'), meta('a1', 'attachment')],
      relations: [],
    });
    dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'launcher' });
    await settle();
    // ⚠ **回数**で見る ── 出来上がるタイルは全件読んでも同じなので、
    // 結果だけを見ると「全部読む」実装と区別がつかない
    expect(reads).toEqual(['a1']);
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
    const { store, reads } = countingStore({ a1: APP_BODY });
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
    expect(reads).toEqual(['a1', 'a1']);
    off();
  });

  it('ランチャー以外のビューでは読まない', async () => {
    const { store, reads } = countingStore({ a1: APP_BODY });
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
    expect(reads).toEqual([]);
    off();
  });
});
