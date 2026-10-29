/**
 * 🔴 **worker の `listNotePins` / `putNotePin`**(#1377)。
 *
 * 守るもの:①付けたピンが留めた順に読み戻せる ②外すと消え、他は動かない ③付け直しは順を変えない
 * ④付け外しの tx の中で、entries にもゴミ箱にも無い lid のピンだけを worker が掃除する(ゴミ箱のノートのピンは残り、戻すと戻る)
 * ⑤器ごとに分かれる ⑥上限(100)で新しい lid だけ断り、外すのは通る。
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

const upsert = (cid: string, lid: string) =>
  request({
    op: 'upsertEntry',
    cid,
    entry: { lid, title: lid, archetype: 'text', body: 'x', entryOrder: 1, status: null, date: null, archived: false },
    checkpoint: false,
  });

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
    for (const l of ['a', 'b', 'c']) await upsert(CID, l);
    await request({ op: 'putNotePin', cid: CID, lid: 'b', on: true });
    await request({ op: 'putNotePin', cid: CID, lid: 'a', on: true });
    await request({ op: 'putNotePin', cid: CID, lid: 'c', on: true });
    expect(await request({ op: 'listNotePins', cid: CID })).toEqual(['b', 'a', 'c']);
    await request({ op: 'putNotePin', cid: CID, lid: 'b', on: true }); // 付け直し
    expect(await request({ op: 'listNotePins', cid: CID })).toEqual(['b', 'a', 'c']);
    await request({ op: 'putNotePin', cid: CID, lid: 'a', on: false });
    expect(await request({ op: 'listNotePins', cid: CID })).toEqual(['b', 'c']);
    for (const l of ['b', 'c']) await request({ op: 'putNotePin', cid: CID, lid: l, on: false });
  });

  it('🔴 永久削除・存在しない lid のピンだけを、付け外しのたびに worker が掃除する(ゴミ箱のノートは残す)', async () => {
    await upsert(CID, 'live');
    await upsert(CID, 'goner');
    await request({ op: 'putNotePin', cid: CID, lid: 'live', on: true });
    await request({ op: 'putNotePin', cid: CID, lid: 'goner', on: true });
    // 存在しない lid(以前の端末の残り・永久削除済み)のピンを直接作る = 存在しない lid へ留める
    await request({ op: 'putNotePin', cid: CID, lid: 'ghost', on: true });
    await request({ op: 'deleteEntry', cid: CID, lid: 'goner' }); // ゴミ箱へ(版が残る)
    await request({ op: 'purgeTrash', cid: CID, lid: 'goner' }); // 永久削除
    await request({ op: 'putNotePin', cid: CID, lid: 'live', on: true }); // 付け直し = 掃除のきっかけ
    expect(await request({ op: 'listNotePins', cid: CID }), 'ghost / 永久削除したノートのピンが残っている').toEqual(['live']);
    await request({ op: 'putNotePin', cid: CID, lid: 'live', on: false });
  });

  it('🔴 A をピン → A をゴミ箱へ → B をピン → A を戻す → A のピンが残っている', async () => {
    await upsert(CID, 'A');
    await upsert(CID, 'B');
    await request({ op: 'putNotePin', cid: CID, lid: 'A', on: true });
    await request({ op: 'deleteEntry', cid: CID, lid: 'A' });
    await request({ op: 'putNotePin', cid: CID, lid: 'B', on: true }); // ← ここで掃除が走る。A はゴミ箱なので残る
    expect(await request({ op: 'listNotePins', cid: CID }), 'ゴミ箱のノートのピンを掃除した').toEqual(['A', 'B']);
    await upsert(CID, 'A'); // ゴミ箱から戻す
    expect(await request({ op: 'listNotePins', cid: CID })).toEqual(['A', 'B']);
    for (const l of ['A', 'B']) await request({ op: 'putNotePin', cid: CID, lid: l, on: false });
  });

  it('器ごとに分かれる(別の器の同じ lid の実在も見ない)', async () => {
    await upsert(CID, 'x');
    await upsert(OTHER, 'y');
    await request({ op: 'putNotePin', cid: CID, lid: 'x', on: true });
    expect(await request({ op: 'listNotePins', cid: OTHER })).toEqual([]);
    await request({ op: 'putNotePin', cid: OTHER, lid: 'y', on: true });
    expect(await request({ op: 'listNotePins', cid: CID })).toEqual(['x']);
    // OTHER に x は無い ── CID の x のピンは OTHER の付け外しでは消えない
    await request({ op: 'putNotePin', cid: OTHER, lid: 'y', on: true });
    expect(await request({ op: 'listNotePins', cid: CID })).toEqual(['x']);
    await request({ op: 'putNotePin', cid: CID, lid: 'x', on: false });
    await request({ op: 'putNotePin', cid: OTHER, lid: 'y', on: false });
  });

  it('上限(100)では新しい lid だけ断り、外すのは通る', async () => {
    for (let i = 0; i < 100; i += 1) {
      await upsert(CID, `p${i}`);
      await request({ op: 'putNotePin', cid: CID, lid: `p${i}`, on: true });
    }
    await expect(request({ op: 'putNotePin', cid: CID, lid: 'over', on: true })).rejects.toThrow();
    expect((await request({ op: 'listNotePins', cid: CID })).includes('over')).toBe(false);
    await request({ op: 'putNotePin', cid: CID, lid: 'p0', on: false });
    await upsert(CID, 'over');
    await request({ op: 'putNotePin', cid: CID, lid: 'over', on: true });
    const now = await request({ op: 'listNotePins', cid: CID });
    expect(now).toHaveLength(100);
    expect(now[now.length - 1]).toBe('over');
  });
});
