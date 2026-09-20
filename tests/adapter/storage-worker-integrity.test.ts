/**
 * 🔴 **起動の検めの口を、本物の worker で通す**(#1007 段①)。
 *
 * ⚠ 健全な DB の側。壊れた側は `storage-worker-corrupt.test.ts`(旗を立てる test は
 *   専用の worker を持つ file に置く ── あちらの冒頭に理由が在る)。
 *
 * 見るのは:
 * - `integrityPlan` が**印 null + btree を持つ表**を返す(FTS の仮想表は入らない)
 * - `checkIntegrity({ table })` が**その表だけ**を見て ok を返す / 無い表は落とす
 * - `integrityStamp` → `integrityPlan` で**同じ印**が戻る(往復)
 * - 駆動部を本物に繋ぐと **ok → 2 回目は skipped**
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import { runStartupIntegrity } from '../../src/adapter/platform/storage/startup-integrity';

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

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: 'unit-integrity' });
  expect(init.vfs).toBe('memory');
  await request({ op: 'openContainer', cid: 'c1', title: 'unit' });
  await request({
    op: 'upsertEntry',
    cid: 'c1',
    entry: {
      lid: 'k1',
      title: '検める本文',
      archetype: 'text',
      body: '起動のたびに軽く検める',
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
    },
  });
}, 30_000);

afterAll(async () => {
  await request({ op: 'close' });
});

describe('integrityPlan / checkIntegrity({ table }) / integrityStamp', () => {
  it('🔴 印が無ければ null、表は btree を持つものだけ(FTS の仮想表は入らない)', async () => {
    const plan = await request({ op: 'integrityPlan' });
    expect(plan.lastCheckedAt).toBeNull();
    expect(plan.tables, '本文の表が無い(空振り)').toContain('entries');
    expect(plan.tables, '仮想表(rootpage 0)を検めようとしている').not.toContain('entries_fts');
    // 🔑 影の表(btree)は入る ── ここが壊れると全文検索が黙って空になる
    expect(plan.tables).toContain('entries_fts_data');
  });

  it('🔴 表ごとの検めは、その表だけを見て ok を返す', async () => {
    const plan = await request({ op: 'integrityPlan' });
    for (const table of plan.tables) {
      const res = await request({ op: 'checkIntegrity', table });
      expect(res.rows, `${table} が ok でない`).toEqual(['ok']);
      expect(res.schema.length, 'schema が読めていない').toBeGreaterThan(0);
    }
  });

  it('🔴 無い表を名指ししたら落とす(黙って丸ごとへ倒さない)', async () => {
    await expect(request({ op: 'checkIntegrity', table: 'nosuch' })).rejects.toThrow('検める表が無い');
    // ⚠ 引用符を混ぜても SQL として通らない(名前として突き合わせて落ちる)
    await expect(request({ op: 'checkIntegrity', table: 'entries") OR 1=1 --' })).rejects.toThrow(
      '検める表が無い',
    );
  });

  it('⚠ table 無しは今までどおり丸ごと(押した検め)', async () => {
    const res = await request({ op: 'checkIntegrity' });
    expect(res.rows).toEqual(['ok']);
  });

  it('🔴 印は往復する(書いて、計画で読める)', async () => {
    await request({ op: 'integrityStamp', at: '2026-09-20T03:00:00.000Z' });
    const plan = await request({ op: 'integrityPlan' });
    expect(plan.lastCheckedAt).toBe('2026-09-20T03:00:00.000Z');
    // 上書き(2 行にならない)
    await request({ op: 'integrityStamp', at: '2026-09-21T03:00:00.000Z' });
    expect((await request({ op: 'integrityPlan' })).lastCheckedAt).toBe('2026-09-21T03:00:00.000Z');
  });
});

describe('駆動部を本物の worker に繋ぐ', () => {
  it('🔴 印が古ければ ok(印が更新される)→ すぐ 2 回目は skipped', async () => {
    await request({ op: 'integrityStamp', at: '2020-01-01T00:00:00.000Z' });
    const now = Date.parse('2026-09-20T04:00:00Z');
    const broken: string[] = [];
    const deps = {
      request,
      isHost: () => true,
      now: () => now,
      wait: async () => {},
      cancelled: () => false,
      onBroken: (t: string) => {
        broken.push(t);
      },
    };
    expect(await runStartupIntegrity(deps)).toBe('ok');
    expect(broken).toEqual([]);
    expect((await request({ op: 'integrityPlan' })).lastCheckedAt).toBe(new Date(now).toISOString());
    expect(await runStartupIntegrity(deps)).toBe('skipped');
  });
});
