/**
 * listBodies は、予算に達したら**残りの行を読まずに**止まる(バックアップの書出しの二乗時間対策)。
 *
 * 旧実装は after より後ろの**全行の本文**を毎ページ読んでから切っていたので、
 * N 件のノートで N^2 に近い時間と、全本文ぶんの heap を使っていた。
 * 出力(行・並び・次のカーソル)は変わらないので、出力だけを見る test では区別できない。
 * ── sqlite の exec を包み、**callback に渡された行数**を数えて見る。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';

const counter = vi.hoisted(() => ({ rows: 0 }));

vi.mock('@sqlite.org/sqlite-wasm', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@sqlite.org/sqlite-wasm')>();
  const init = orig.default as unknown as (...a: unknown[]) => Promise<{
    oo1: { DB: { prototype: { exec: (...a: unknown[]) => unknown } } };
  }>;
  return {
    ...orig,
    default: async (...a: unknown[]) => {
      const api = await init(...a);
      const proto = api.oo1.DB.prototype;
      const real = proto.exec;
      proto.exec = function (this: unknown, ...args: unknown[]) {
        const o = args[0] as { sql?: unknown; callback?: (r: unknown) => unknown } | undefined;
        if (
          o !== undefined &&
          typeof o === 'object' &&
          typeof o.sql === 'string' &&
          o.sql.includes('SELECT lid, body, entry_order FROM entries') &&
          typeof o.callback === 'function'
        ) {
          const cb = o.callback;
          return real.call(this, {
            ...o,
            callback: (r: unknown) => {
              counter.rows++;
              return cb(r);
            },
          });
        }
        return real.apply(this, args);
      };
      return api;
    },
  };
});

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

const CID = 'c-lb';
const N = 60;
const BODY = 200;

function entryOf(lid: string, order: number): EntryUpsert {
  return {
    lid,
    title: `t-${lid}`,
    archetype: 'text',
    body: lid.padEnd(BODY, 'x'),
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
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
  await request({ op: 'init', dbName: 'unit-test-lb' });
  await request({ op: 'openContainer', cid: CID, title: 'lb' });
  for (let i = 0; i < N; i++) {
    // 順序値を 2 件ずつ共有させる(複合カーソルの境界も踏ませる)
    await request({
      op: 'upsertEntry',
      cid: CID,
      entry: entryOf(`n${String(i).padStart(3, '0')}`, Math.floor(i / 2)),
      checkpoint: false,
    });
  }
}, 30_000);

describe('listBodies は予算に達したら読むのを止める', () => {
  it('3 件ぶんの予算で 1 ページ目を取ると、読む行数は 3 + 1 件で、残りは読まない', async () => {
    counter.rows = 0;
    const r = await request({ op: 'listBodies', cid: CID, maxBytes: BODY * 3 });
    expect(r.rows).toHaveLength(3);
    expect(r.done).toBe(false);
    // 空振り防止: callback 経由で読んでいること(0 なら計器が効いていない)
    expect(counter.rows, '計器が効いていない').toBeGreaterThan(0);
    // 予算を超える行を 1 件見つけた所で止める(= returned + 1)。全 N 行を読まない
    expect(counter.rows).toBeLessThanOrEqual(4);
  });

  it('ページを追って全部集めると、全件が重複・欠落なく entry_order → lid の順で出る', async () => {
    const got: string[] = [];
    let after: { entryOrder: number; lid: string } | undefined;
    counter.rows = 0;
    let pages = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const r = await request({
        op: 'listBodies',
        cid: CID,
        maxBytes: BODY * 7,
        ...(after ? { after } : {}),
      });
      pages++;
      got.push(...r.rows.map((x) => x.lid));
      if (r.done || !r.next) break;
      after = r.next;
    }
    const expected = Array.from({ length: N }, (_, i) => `n${String(i).padStart(3, '0')}`);
    expect(got).toEqual(expected);
    expect(pages).toBeGreaterThan(5);
    // 読んだ行の総数は N + (ページ数 - 1)(各ページの超過 1 行)。二乗にならない
    expect(counter.rows).toBeLessThanOrEqual(N + pages);
  });

  it('1 件目は予算より大きくても必ず返る(進まなくならない)', async () => {
    const r = await request({ op: 'listBodies', cid: CID, maxBytes: 1 });
    expect(r.rows).toHaveLength(1);
    expect(r.done).toBe(false);
    expect(r.next).toEqual({ entryOrder: 0, lid: 'n000' });
  });
});
