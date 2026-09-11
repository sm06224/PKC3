/**
 * 🔴 **録ったものを集める効果**(#683 段①、2026-09-09)。
 *
 * ⚠ 見るのは 3 つ:
 *   ①**添付だけ**を **1 往復**で読む(全 body を舐めない / 件数ぶん往復しない)
 *   ②音と動画だけが一覧に入る(判定は `features/capture` の 1 本)
 *   ③読めなかったときは**帯を出さず**「駄目だった」を面に届ける
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';
import type { EntryMeta } from '../../src/core/model/entry-meta';

function meta(lid: string, archetype: string): EntryMeta {
  return {
    lid,
    title: `t-${lid}`,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

function attach(name: string, mime: string): string {
  return ['---', `attachment.name: ${name}`, `attachment.mime: ${mime}`, '---', ''].join('\n');
}

/** 読みの呼ばれ方を数える最小の store(`launcher-effect.test.ts` と同じ作法)。 */
function countingStore(
  bodies: Record<string, string>,
  fail = false,
): { store: StorePort; trips: string[][]; singles: string[] } {
  const trips: string[][] = [];
  const singles: string[] = [];
  const store = {
    getBody: (lid: string) => {
      singles.push(lid);
      return Promise.resolve(bodies[lid] ?? null);
    },
    getBodies: (lids: string[]) => {
      trips.push([...lids]);
      if (fail) return Promise.reject(new Error('読めない'));
      return Promise.resolve(
        lids.filter((lid) => bodies[lid] !== undefined).map((lid) => ({ lid, body: bodies[lid]! })),
      );
    },
  } as unknown as StorePort;
  return { store, trips, singles };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const BODIES = {
  a1: attach('録音-2026-09-09-030102.webm', 'audio/webm'),
  a2: attach('写真.png', 'image/png'),
  a3: attach('会議.m4a', 'audio/mp4'),
};

function bootedDispatcher(store: StorePort): { d: Dispatcher; off: () => void } {
  const d = new Dispatcher();
  const off = connectStoreEffects(d, store);
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c',
    metas: [
      meta('n1', 'text'),
      meta('a1', 'attachment'),
      meta('a2', 'attachment'),
      meta('a3', 'attachment'),
    ],
    relations: [],
  });
  return { d, off };
}

describe('録ったものを集める(#683 段①)', () => {
  it('🔴 **添付だけ**を **1 往復で**読む(全 body を舐めない)', async () => {
    const { store, trips, singles } = countingStore(BODIES);
    const { d, off } = bootedDispatcher(store);
    d.dispatch({ type: 'REFRESH_CAPTURE_SCAN' });
    await settle();
    // ⚠ **何を**読んだか ── 全件読んでも結果は同じなので、結果だけでは区別がつかない
    expect(trips, 'ふつうのノートまで読んでいる').toEqual([['a1', 'a2', 'a3']]);
    // ⚠ **何回**往復したか ── 1 件ずつ読む実装は結果が同じで、ここでだけ落ちる
    expect(singles, '件数ぶん往復している(単一 queue の store が塞がる)').toEqual([]);
    off();
  });

  it('🔴 音と動画だけが state に還る(画像は入らない)', async () => {
    const { store } = countingStore(BODIES);
    const { d, off } = bootedDispatcher(store);
    expect(d.getState().captureItems, 'まだ読んでいないのに一覧が在る').toBeNull();
    d.dispatch({ type: 'REFRESH_CAPTURE_SCAN' });
    await settle();
    expect(d.getState().captureItems?.map((i) => i.lid)).toEqual(['a1', 'a3']);
    expect(d.getState().captureScanFailed).toBe(false);
    off();
  });

  /**
   * 🔴 **失敗は面の中で言う** ── 集め直しはタブを開くたびに走るので、
   *   赤い帯を出すと**開くたびに出る**。
   */
  it('🔴 読めなかったら「駄目だった」を立て、帯は出さない', async () => {
    const { store } = countingStore(BODIES, true);
    const { d, off } = bootedDispatcher(store);
    d.dispatch({ type: 'REFRESH_CAPTURE_SCAN' });
    await settle();
    expect(d.getState().captureScanFailed, '失敗が面に届いていない').toBe(true);
    expect(d.getState().error, '帯を出している(開くたびに出る)').toBeNull();
    off();
  });
});
