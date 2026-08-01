/**
 * storage worker の意味論 unit(P5b 常設 ── review P5a F2)。
 *
 * P5a の mutation 4 種(hash skip / prune 境界 / trash INSERT / revisions 走査)が
 * PR gate を素通りし nightly probe だけが捕捉した ── ここで worker を**実物のまま**
 * node 実走して PR gate に載せる。`self` / `postMessage` を差してから dynamic
 * import すると、sqlite-wasm は node に OPFS が無いため :memory: fallback で
 * init まで通る(fallback 経路も含めて実物)。OPFS SAHPool 固有面(VFS / journal /
 * 永続化)は従来どおり nightly の probe が担保する。
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
  (globalThis as unknown as Record<string, unknown>).postMessage = (
    msg: StorageResponse,
  ) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: 'unit-test' });
  expect(init.vfs).toBe('memory'); // node に OPFS は無い ── memory fallback が前提
  await request({ op: 'openContainer', cid: 'c1', title: 'unit' });
}, 30_000);

afterAll(async () => {
  await request({ op: 'close' });
});

describe('storage worker (実物 node 実走)', () => {
  it('addRevision: hash skip / rev_order 採番 / keepLatest prune(P5a mutation a,b)', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('e1', 'live') });
    const rev = (body: string) => ({
      entryLid: 'e1',
      title: 't-e1',
      archetype: 'text',
      body,
    });
    expect(
      await request({ op: 'addRevision', cid: 'c1', rev: rev('v1'), keepLatest: 2 }),
    ).toEqual({ added: true, pruned: 0 });
    // 同一内容は skip(PKC2 は content_hash を作って一度も使わなかった)
    expect(
      await request({ op: 'addRevision', cid: 'c1', rev: rev('v1'), keepLatest: 2 }),
    ).toEqual({ added: false, pruned: 0 });
    expect(
      await request({ op: 'addRevision', cid: 'c1', rev: rev('v2'), keepLatest: 2 }),
    ).toEqual({ added: true, pruned: 0 });
    // 3 件目で最古(v1)が prune ── 境界は「keepLatest 件ちょうど残す」
    expect(
      await request({ op: 'addRevision', cid: 'c1', rev: rev('v3'), keepLatest: 2 }),
    ).toEqual({ added: true, pruned: 1 });
    const metas = await request({ op: 'listRevisionMetas', cid: 'c1', entryLid: 'e1' });
    expect(metas.map((m) => m.rev_order)).toEqual([3, 2]); // 新しい順・本文なし
    expect(Object.keys(metas[0]!)).not.toContain('snapshot');
  });

  it('deleteEntry: revisions 温存 + 削除直前の trash snapshot(P5a mutation c)', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('e2', '# 削除対象') });
    await request({
      op: 'addRevision',
      cid: 'c1',
      rev: { entryLid: 'e2', title: 't-e2', archetype: 'text', body: '旧稿' },
      keepLatest: 20,
    });
    await request({ op: 'deleteEntry', cid: 'c1', lid: 'e2' });
    const trash = await request({ op: 'listTrash', cid: 'c1' });
    const row = trash.find((t) => t.entry_lid === 'e2')!;
    expect(row).toBeDefined();
    expect(row.rev_order).toBe(2); // 既存 1 件 + trash snapshot
    const snap = await request({ op: 'getRevision', cid: 'c1', id: row.id });
    expect(snap).toEqual({ body: '# 削除対象', title: 't-e2', archetype: 'text' });
    // 存在しない lid の削除は無例外・無変化
    await request({ op: 'deleteEntry', cid: 'c1', lid: 'no-such' });
  });

  it('復元 → 無変更 → 再削除で同一 snapshot を積まない(P5a review F3)', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('e3', '# 同一') });
    await request({ op: 'deleteEntry', cid: 'c1', lid: 'e3' }); // trash rev 1
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('e3', '# 同一') }); // 復元相当
    await request({ op: 'deleteEntry', cid: 'c1', lid: 'e3' }); // 同一内容 ── skip
    const metas = await request({ op: 'listRevisionMetas', cid: 'c1', entryLid: 'e3' });
    expect(metas).toHaveLength(1);
  });

  it('scanAssetRefs は revisions(履歴 / ゴミ箱)も keep する(P5a mutation d)+ escape 形', async () => {
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('e4', '本文 ![e](asset:ast\\-esc-u) 参照'),
    });
    await request({
      op: 'addRevision',
      cid: 'c1',
      rev: {
        entryLid: 'e4',
        title: 't-e4',
        archetype: 'text',
        body: '旧本文 ![r](asset:ast-rev-u) だけが持つ参照',
      },
      keepLatest: 20,
    });
    const scan = await request({
      op: 'scanAssetRefs',
      cid: 'c1',
      candidates: ['ast-rev-u', 'ast-esc-u', 'ast-nowhere'],
    });
    expect([...scan.referenced].sort()).toEqual(['ast-esc-u', 'ast-rev-u']);
  });

  it('purgeTrash は削除済み lid の revisions だけ消す', async () => {
    const before = await request({ op: 'counts', cid: 'c1' });
    const r = await request({ op: 'purgeTrash', cid: 'c1' });
    expect(r.purged).toBeGreaterThan(0); // e2 の 2 件 + e3 の 1 件
    const after = await request({ op: 'counts', cid: 'c1' });
    expect(after.revisions).toBe(before.revisions - r.purged);
    // 生存 entry(e1 / e4)の履歴は残る
    expect(await request({ op: 'listRevisionMetas', cid: 'c1', entryLid: 'e1' })).toHaveLength(2);
    expect(await request({ op: 'listTrash', cid: 'c1' })).toHaveLength(0);
  });
});
