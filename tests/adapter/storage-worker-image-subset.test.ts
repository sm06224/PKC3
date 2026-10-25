/** @vitest-environment node */
/**
 * 🔴 **選んだノートだけの DB 画像**(#1038 A2。`exportImage` の `only`)。
 *
 * 守るもの(実物の sqlite で見る):
 *   ① 画像を別の worker で開くと、`only.lids` のノートだけが在る(選んでいない物は無い)
 *   ② 両端が中に居るつながりだけ残る(片端が外のつながりは無い)
 *   ③ 添付の目録は `only.assetKeys` の分だけ
 *   ④ 対照群:`only` 無しの画像には全部入っている(①〜③が空振りでないこと)
 *   ⑤ 書き出した側の DB は 1 行も減らない(本体は読むだけ)
 *   ⑥ 選んでいない題名・本文の字が、画像の bytes のどこにも残っていない
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';

type Op = StorageRequest['op'];
interface Worker {
  request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]>;
  close(): Promise<void>;
}

/** 生きている worker は常に 1 本(`storage-worker-image.test.ts` と同じ作法 ── 返事が 2 本目へ落ちる)。 */
let live: Worker | null = null;

async function spawn(): Promise<Worker> {
  if (live) {
    await live.close().catch(() => undefined);
    live = null;
  }
  vi.resetModules();
  const pending = new Map<number, (resp: StorageResponse) => void>();
  let seq = 0;
  const workerSelf: { onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null } = {
    onmessage: null,
  };
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const send = <O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (resp) => (resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error))));
      workerSelf.onmessage!({ data: { id, req } });
    });
  const w: Worker = { request: send, close: async () => void (await send({ op: 'close' })) };
  live = w;
  return w;
}

afterEach(async () => {
  if (live) await live.close().catch(() => undefined);
  live = null;
});

async function seed(w: Worker): Promise<void> {
  await w.request({ op: 'openContainer', cid: 'c1', title: 'unit' });
  const mk = (lid: string, title: string, body: string, order: number, archetype = 'text') => ({
    op: 'upsertEntry' as const,
    cid: 'c1',
    entry: { lid, title, archetype, body, entryOrder: order, status: null, date: null, archived: false },
    checkpoint: false,
  });
  await w.request(mk('f1', '親フォルダ', '', 1, 'folder'));
  await w.request(mk('a', '選んだ甲', '甲の本文 asset:keep-1\n', 2));
  await w.request(mk('b', '参照された乙', '乙の本文\n', 3));
  await w.request(mk('x', '選んでいない秘密の丙', '丙の本文 asset:drop-1\n', 4));
  await w.request({
    op: 'bulkUpsertRelations',
    cid: 'c1',
    relations: [
      { id: 'r-in', fromLid: 'f1', toLid: 'a', kind: 'structural' },
      { id: 'r-both', fromLid: 'a', toLid: 'b', kind: 'semantic' },
      { id: 'r-out', fromLid: 'a', toLid: 'x', kind: 'semantic' },
    ],
  });
  await w.request({ op: 'putAssetMeta', cid: 'c1', meta: { key: 'keep-1', mime: 'image/png', size: 3 } });
  await w.request({ op: 'putAssetMeta', cid: 'c1', meta: { key: 'drop-1', mime: 'image/png', size: 3 } });
}

describe('選んだノートだけの画像(#1038 A2)', () => {
  it('🔴 ①②③④⑥ 選んだ分だけが入り、対照の全件画像には全部入っている', async () => {
    const a = await spawn();
    await a.request({ op: 'init', dbName: 'sub1', memory: true });
    await seed(a);

    const full = (await a.request({ op: 'exportImage' })).image;
    const sub = (
      await a.request({
        op: 'exportImage',
        only: { cid: 'c1', lids: ['f1', 'a', 'b'], assetKeys: ['keep-1'] },
      })
    ).image;
    expect(sub.byteLength, '前提:画像が出ていない').toBeGreaterThan(1000);

    const g = await spawn();
    await g.request({ op: 'init', dbName: 'sub1', memory: true, image: full });
    expect(
      (await g.request({ op: 'listEntryMetas', cid: 'c1' })).map((r) => r.lid).sort(),
      '対照:全件画像に全部無い(検査が空振り)',
    ).toEqual(['a', 'b', 'f1', 'x']);
    expect((await g.request({ op: 'listRelations', cid: 'c1' })).length).toBe(3);
    expect((await g.request({ op: 'listAssetMetas', cid: 'c1' })).length).toBe(2);

    const s = await spawn();
    await s.request({ op: 'init', dbName: 'sub1', memory: true, image: sub });
    expect((await s.request({ op: 'listEntryMetas', cid: 'c1' })).map((r) => r.lid).sort()).toEqual(['a', 'b', 'f1']);
    expect(await s.request({ op: 'getBody', cid: 'c1', lid: 'a' })).toBe('甲の本文 asset:keep-1\n');
    expect(await s.request({ op: 'getBody', cid: 'c1', lid: 'x' })).toBeNull();
    expect(
      (await s.request({ op: 'listRelations', cid: 'c1' })).map((r) => r.id).sort(),
      '片端が外のつながりが残った',
    ).toEqual(['r-both', 'r-in']);
    expect((await s.request({ op: 'listAssetMetas', cid: 'c1' })).map((r) => r.key)).toEqual(['keep-1']);
    // ⑥ 選んでいない題名・本文の字が bytes に残っていない(全文検索の索引にも)
    const text = new TextDecoder('utf-8', { fatal: false }).decode(sub);
    expect(text.includes('選んでいない秘密の丙'), '外したノートの題名が画像に残っている').toBe(false);
    expect(text.includes('丙の本文')).toBe(false);
    // 対照:全件画像には字が在る(⑥が空振りでないこと)
    expect(new TextDecoder('utf-8', { fatal: false }).decode(full).includes('丙の本文')).toBe(true);
  }, 60_000);

  it('🔴 ⑤ 書き出した側の DB は減らない', async () => {
    const a = await spawn();
    await a.request({ op: 'init', dbName: 'sub2', memory: true });
    await seed(a);
    await a.request({ op: 'exportImage', only: { cid: 'c1', lids: ['a'], assetKeys: [] } });
    expect((await a.request({ op: 'listEntryMetas', cid: 'c1' })).length).toBe(4);
    expect((await a.request({ op: 'listRelations', cid: 'c1' })).length).toBe(3);
    expect((await a.request({ op: 'listAssetMetas', cid: 'c1' })).length).toBe(2);
    expect(await a.request({ op: 'getBody', cid: 'c1', lid: 'x' })).toBe('丙の本文 asset:drop-1\n');
  }, 60_000);
});
