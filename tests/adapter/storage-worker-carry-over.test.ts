/**
 * 🔴 **前の日の未完了を引き継ぐ worker の口**(#1966 4-4)── `carryOverTasks`。
 *
 * 守る主張:
 * 1. 前の日の未完了を今日の末尾へ写し、前の日の行は取り消し線 + 今日へのリンクに変える(2 冊とも 1 tx で書く)
 * 2. 2 冊とも題名・並びを保ち、履歴に引き継ぐ前の版を 1 つずつ積む
 * 3. もう一度頼んでも何も書かない(同じ未完了を 2 度送らない)
 * 4. system 領域のノート・同じノートどうしは触らない
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ResultMap, StorageRequest, StorageResponse } from '../../src/adapter/platform/storage/protocol';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';

type Op = StorageRequest['op'];
const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
const workerSelf: {
  onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
} = { onmessage: null };

function request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) => (resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error))));
    workerSelf.onmessage!({ data: { id, req } });
  });
}

const CID = 'c-carry';

const put = (lid: string, body: string, over: Partial<EntryUpsert> = {}) =>
  request({
    op: 'upsertEntry',
    cid: CID,
    entry: {
      lid,
      title: `t-${lid}`,
      archetype: 'text',
      body,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
      ...over,
    },
    checkpoint: false,
  });

const bodyOf = async (lid: string): Promise<string | null> => request({ op: 'getBody', cid: CID, lid });

const PREV = '- [ ] 見積を送る @2026-11-15\n- [x] 済み\n';

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  await request({ op: 'init', dbName: 'unit-test-carry' });
  await request({ op: 'openContainer', cid: CID, title: 'carry' });
  await put('d15', PREV, { title: '2026-11-15', entryOrder: 1 });
  await put('d16', '朝のメモ\n', { title: '2026-11-16', entryOrder: 2 });
  await put('sys', PREV, { title: '2026-11-14', entryOrder: 3, realm: 'system' });
}, 30_000);

describe('carryOverTasks(worker の 1 tx)', () => {
  it('🔴 前の日の未完了を今日へ写し、前の日の行は取り消し線 + 今日へのリンクに変える', async () => {
    const r = await request({ op: 'carryOverTasks', cid: CID, lid: 'd16', sourceLid: 'd15' });
    expect(r.moved).toBe(1);
    expect(r.wrote.map((w) => w.lid)).toEqual(['d15', 'd16']);
    expect(await bodyOf('d15')).toBe('- ~~見積を送る @2026-11-15~~ → [2026-11-16](entry:d16)\n- [x] 済み\n');
    expect(await bodyOf('d16')).toBe('朝のメモ\n\n前の日から引き継ぎ: [2026-11-15](entry:d15)\n- [ ] 見積を送る @2026-11-15\n');
  });

  it('🔑 2 冊とも題名・並びを保ち、履歴に引き継ぐ前の版を積む', async () => {
    const metas = await request({ op: 'listEntryMetas', cid: CID });
    expect(metas.find((m) => m.lid === 'd15')!.title).toBe('2026-11-15');
    expect(metas.find((m) => m.lid === 'd16')!.entry_order).toBe(2);
    for (const lid of ['d15', 'd16']) {
      const revs = await request({ op: 'listRevisionMetas', cid: CID, entryLid: lid });
      expect(revs.length, `${lid} の引き継ぐ前の版が履歴に無い`).toBeGreaterThanOrEqual(1);
      // ⚠ 件数だけでは「引き継ぐ前」か「後」かを見分けられない ── 版の中身を突き合わせる
      const bodies = await Promise.all(revs.map((m) => request({ op: 'getRevision', cid: CID, id: m.id }).then((b) => b?.body)));
      expect(bodies, `${lid} の履歴に引き継ぐ前の本文が無い`).toContain(lid === 'd15' ? PREV : '朝のメモ\n');
    }
  });

  it('⚠ もう一度頼んでも何も書かない', async () => {
    const before = await bodyOf('d16');
    expect(await request({ op: 'carryOverTasks', cid: CID, lid: 'd16', sourceLid: 'd15' })).toEqual({ wrote: [], moved: 0 });
    expect(await bodyOf('d16')).toBe(before);
  });

  it('⚠ system 領域のノート・同じノートどうしは触らない', async () => {
    expect(await request({ op: 'carryOverTasks', cid: CID, lid: 'd16', sourceLid: 'sys' })).toEqual({ wrote: [], moved: 0 });
    expect(await bodyOf('sys')).toBe(PREV);
    expect(await request({ op: 'carryOverTasks', cid: CID, lid: 'd16', sourceLid: 'd16' })).toEqual({ wrote: [], moved: 0 });
  });
});
