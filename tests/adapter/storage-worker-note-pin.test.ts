/**
 * 🔴 **worker の `listNotePins` / `putNotePin`**(#1377)。
 *
 * 守るもの:①付けたピンが留めた順に読み戻せる ②外すと消え、他は動かない ③付け直しは順を変えない
 * ④prune で消えたノートのピンを同じ呼びで掃除する ⑤器ごとに分かれる ⑥上限(100)で新しい lid だけ断り、外す・掃除は通す。
 * 守っていないもの:多重タブでの同時書込(1 タグ 1 行の UPSERT であることをコードで確認しただけ)。
 */
import { beforeAll, describe, expect, it } from 'vitest';
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

function request<O extends Op>(
  req: Extract<StorageRequest, { op: O }>,
): Promise<ResultMap[O]> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) =>
      resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error)),
    );
    workerSelf.onmessage!({ data: { id, req } });
  });
}

const CID = 'c-notepin';
const OTHER = 'c-other';

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: 'unit-test-note-pin' });
  expect(init.vfs).toBe('memory');
  await request({ op: 'openContainer', cid: CID, title: 'a' });
  await request({ op: 'openContainer', cid: OTHER, title: 'b' });
}, 30_000);

describe('ノートのピン留め(worker)', () => {
  it('留めた順に読み戻せ、付け直しても順は変わらず、外すと消える', async () => {
    await request({ op: 'putNotePin', cid: CID, lid: 'b', on: true });
    await request({ op: 'putNotePin', cid: CID, lid: 'a', on: true });
    await request({ op: 'putNotePin', cid: CID, lid: 'c', on: true });
    expect(await request({ op: 'listNotePins', cid: CID })).toEqual(['b', 'a', 'c']);
    await request({ op: 'putNotePin', cid: CID, lid: 'b', on: true }); // 付け直し
    expect(await request({ op: 'listNotePins', cid: CID })).toEqual(['b', 'a', 'c']);
    await request({ op: 'putNotePin', cid: CID, lid: 'a', on: false });
    expect(await request({ op: 'listNotePins', cid: CID })).toEqual(['b', 'c']);
  });

  it('prune で、消えたノートのピンを同じ呼びで掃除する(付けると同時・外すと同時)', async () => {
    await request({ op: 'putNotePin', cid: CID, lid: 'd', on: true, prune: ['b'] });
    expect(await request({ op: 'listNotePins', cid: CID })).toEqual(['c', 'd']);
    await request({ op: 'putNotePin', cid: CID, lid: 'd', on: false, prune: ['c'] });
    expect(await request({ op: 'listNotePins', cid: CID })).toEqual([]);
  });

  it('器ごとに分かれる', async () => {
    await request({ op: 'putNotePin', cid: CID, lid: 'x', on: true });
    expect(await request({ op: 'listNotePins', cid: OTHER })).toEqual([]);
    await request({ op: 'putNotePin', cid: OTHER, lid: 'y', on: true });
    expect(await request({ op: 'listNotePins', cid: CID })).toEqual(['x']);
    await request({ op: 'putNotePin', cid: CID, lid: 'x', on: false });
    await request({ op: 'putNotePin', cid: OTHER, lid: 'y', on: false });
  });

  it('上限(100)では新しい lid だけ断り、外す・掃除は通る', async () => {
    for (let i = 0; i < 100; i += 1) await request({ op: 'putNotePin', cid: CID, lid: `p${i}`, on: true });
    await expect(request({ op: 'putNotePin', cid: CID, lid: 'over', on: true })).rejects.toThrow();
    expect((await request({ op: 'listNotePins', cid: CID })).includes('over')).toBe(false);
    // 掃除つきで外せる / 掃除つきなら足せる(掃除した分が空く)
    await request({ op: 'putNotePin', cid: CID, lid: 'over', on: true, prune: ['p0', 'p1'] });
    const now = await request({ op: 'listNotePins', cid: CID });
    expect(now).toHaveLength(99);
    expect(now[now.length - 1]).toBe('over');
  });
});
