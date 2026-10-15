/**
 * 取り込んだノートの作成・更新時刻(#1087)── 実物の storage worker で見る。
 *
 * 🔑 INSERT は運ばれた時刻を刻む(省略 / null は今)。ON CONFLICT(通常の保存)は
 *   渡されても今で刻み、作成時刻は動かさない。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';

type Op = StorageRequest['op'];
const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
const workerSelf: {
  onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
} = { onmessage: null };

function request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) =>
      resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error)),
    );
    workerSelf.onmessage!({ data: { id, req } });
  });
}

function entry(lid: string, body: string, over: Record<string, unknown> = {}) {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    body,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    ...over,
  };
}

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  await request({ op: 'init', dbName: 'unit-stamps' });
  await request({ op: 'openContainer', cid: 'c1', title: 'unit' });
}, 30_000);

afterAll(async () => {
  await request({ op: 'close' });
});

const metaOf = async (lid: string) =>
  (await request({ op: 'listEntryMetas', cid: 'c1' })).find((m) => m.lid === lid)!;

describe('取り込んだノートの作成・更新時刻 (#1087)', () => {
  it('🔴 INSERT は運ばれた時刻を刻み、省略(null)なら今を刻む', async () => {
    await request({
      op: 'bulkUpsertEntries',
      cid: 'c1',
      entries: [
        entry('ts-old', 'a', { createdAt: '2020-01-02 03:04:05', updatedAt: '2021-02-03 04:05:06' }),
        entry('ts-none', 'b', { createdAt: null, updatedAt: null }),
        entry('ts-omit', 'c'),
      ],
    });
    const old = await metaOf('ts-old');
    expect(old.created_at).toBe('2020-01-02 03:04:05');
    expect(old.updated_at).toBe('2021-02-03 04:05:06');
    const thisYear = String(new Date().getUTCFullYear());
    for (const lid of ['ts-none', 'ts-omit']) {
      const m = await metaOf(lid);
      expect(m.created_at, lid).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(m.created_at!.startsWith(thisYear), `${lid}: 今で刻まれていない`).toBe(true);
      expect(m.updated_at!.startsWith(thisYear), `${lid}: 今で刻まれていない`).toBe(true);
    }
  });

  it('🔴 通常の保存(ON CONFLICT)は時刻を渡されても今で刻み、作成時刻は動かさない', async () => {
    await request({
      op: 'bulkUpsertEntries',
      cid: 'c1',
      entries: [entry('ts-upd', 'a', { createdAt: '2020-01-02 03:04:05', updatedAt: '2021-02-03 04:05:06' })],
    });
    await request({
      op: 'bulkUpsertEntries',
      cid: 'c1',
      entries: [entry('ts-upd', 'c', { createdAt: '1999-01-01 00:00:00', updatedAt: '1999-01-01 00:00:00' })],
    });
    const m = await metaOf('ts-upd');
    const thisYear = String(new Date().getUTCFullYear());
    expect(m.created_at, '作成時刻が動いた').toBe('2020-01-02 03:04:05');
    expect(m.updated_at!.startsWith(thisYear), `更新が今で刻まれていない: ${m.updated_at}`).toBe(true);
  });
});
