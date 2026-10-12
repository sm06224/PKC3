/**
 * 🔴 **DB 画像を出すときの複製を減らす**(#1416 ── 可搬単一 HTML の保存でメモリが山になる件)。
 *
 * 守るのは 2 つ:
 * ① **画像の bytes は worker から main へ transfer で渡る**(clone だと worker と main に
 *    画像 1 枚ずつ余計にできる)── 実際の `postMessage` と同じく `structuredClone` に transfer を
 *    渡して、**送り元の buffer が手放される**ことで見る
 * ② **memdb の DB は sqlite に複製を作らせない**(`SQLITE_SERIALIZE_NOCOPY`)。⚠ 本物の sqlite で
 *    往復して中身が戻ることまで見る(複製を省いた結果、壊れた画像を出していたら意味が無い)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import {
  exportDbImage,
  exportImageNoCopy,
  type ImageExportApi,
} from '../../src/adapter/platform/storage/db-image-export';

type Op = StorageRequest['op'];

interface Worker {
  request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]>;
  close(): Promise<void>;
  /** 返事に付いてきた transfer の一覧(op ごと)。 */
  transfers: Array<{ op: Op | undefined; list: Transferable[] }>;
  /** 返事を実際の postMessage と同じく clone / transfer した後の複製を、op の順に。 */
  delivered: unknown[];
}

let live: Worker | null = null;
/** `sqlite3__wasm_db_serialize` に渡った flags(本物の呼び出しを包んで控える)。 */
let serializeFlags: number[] = [];

async function spawn(): Promise<Worker> {
  if (live) {
    await live.close().catch(() => undefined);
    live = null;
  }
  vi.resetModules();
  serializeFlags = [];
  vi.doMock('@sqlite.org/sqlite-wasm', async () => {
    const real = await vi.importActual<typeof import('@sqlite.org/sqlite-wasm')>(
      '@sqlite.org/sqlite-wasm',
    );
    const init = real.default as unknown as (...a: unknown[]) => Promise<ImageExportApi>;
    return {
      ...real,
      default: async (...a: unknown[]) => {
        const api = await init(...a);
        // ⚠ `wasm.exports` は書き換えられない ── 包んだ面を返す(この module が呼ぶ分だけが控えに載る。
        //   上流の `sqlite3_js_db_export`(= 複製の道)は上流自身の面を見るので載らない)
        const orig = (api.wasm.exports as Record<string, unknown>)['sqlite3__wasm_db_serialize'] as (
          ...x: number[]
        ) => number;
        const wrappedExports = new Proxy({} as Record<string, unknown>, {
          get(_t, k) {
            const t = api.wasm.exports as Record<string | symbol, unknown>;
            if (k !== 'sqlite3__wasm_db_serialize') return t[k];
            return (...x: number[]) => {
              serializeFlags.push(x[4]!);
              return orig(...x);
            };
          },
        });
        const wasmProxy = new Proxy({} as Record<string | symbol, unknown>, {
          get(_t, k) {
            return k === 'exports' ? wrappedExports : (api.wasm as unknown as Record<string | symbol, unknown>)[k];
          },
        });
        return new Proxy({} as Record<string | symbol, unknown>, {
          get(_t, k) {
            return k === 'wasm' ? wasmProxy : (api as unknown as Record<string | symbol, unknown>)[k];
          },
        });
      },
    };
  });
  const pending = new Map<number, (resp: StorageResponse) => void>();
  let seq = 0;
  const workerSelf: {
    onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
  } = { onmessage: null };
  const transfers: Worker['transfers'] = [];
  const delivered: unknown[] = [];
  const opOf = new Map<number, Op>();
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (
    msg: StorageResponse,
    opts?: { transfer?: Transferable[] },
  ) => {
    const list = opts?.transfer ?? [];
    transfers.push({ op: opOf.get(msg.id), list });
    // 実際の postMessage と同じ: transfer に載せた buffer は送り元で手放される
    const copy = structuredClone(msg, { transfer: list }) as StorageResponse;
    delivered.push(copy);
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(copy);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const send = <O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      opOf.set(id, req.op);
      pending.set(id, (resp) =>
        resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error)),
      );
      workerSelf.onmessage!({ data: { id, req } });
    });
  const w: Worker = {
    request: send,
    close: async () => {
      await send({ op: 'close' });
    },
    transfers,
    delivered,
  };
  live = w;
  return w;
}

afterEach(async () => {
  if (live) await live.close().catch(() => undefined);
  live = null;
  vi.doUnmock('@sqlite.org/sqlite-wasm');
});

async function seed(w: Worker, lid: string, body: string, order: number): Promise<void> {
  await w.request({ op: 'openContainer', cid: 'c1', title: 'unit' });
  await w.request({
    op: 'upsertEntry',
    cid: 'c1',
    entry: {
      lid,
      title: `題 ${lid}`,
      archetype: 'text',
      body,
      entryOrder: order,
      status: null,
      date: null,
      archived: false,
    },
    checkpoint: false,
  });
}

describe('#1416 ── 画像は transfer で渡る', () => {
  it('exportImage の返事は画像の buffer を transfer し、送り元は手放す', async () => {
    const w = await spawn();
    await w.request({ op: 'init', dbName: 'x1', memory: true });
    await seed(w, 'e1', '一行目\n', 1);
    const { image } = await w.request({ op: 'exportImage' });
    // 空振り防止: 画像が本当に出ている
    expect(image.byteLength).toBeGreaterThan(1000);

    const sent = w.transfers.find((t) => t.op === 'exportImage');
    expect(sent, 'exportImage の返事が記録されていない(検査が空振りしている)').toBeDefined();
    expect(sent!.list, '画像の buffer が transfer に載っていない(clone になっている)').toHaveLength(1);
    // 受け取った側の buffer が、載せたものである(`structuredClone` が送り元を手放した)
    const res = (w.delivered[w.transfers.indexOf(sent!)] as { result: { image: Uint8Array } }).result;
    expect(res.image.buffer).toBe(image.buffer);
    // 載せた buffer は送り元では 0 バイトになっている ── transfer の実際の効果
    expect((sent!.list[0] as ArrayBuffer).byteLength, '送り元が手放していない').toBe(0);
  }, 60_000);

  it('対照群: 他の op は transfer を付けない(画像だけが対象)', async () => {
    const w = await spawn();
    await w.request({ op: 'init', dbName: 'x2', memory: true });
    await seed(w, 'e1', 'x', 1);
    await w.request({ op: 'getBody', cid: 'c1', lid: 'e1' });
    const getBody = w.transfers.filter((t) => t.op === 'getBody');
    expect(getBody.length, '対照の op が記録されていない').toBe(1);
    expect(getBody[0]!.list).toEqual([]);
  }, 60_000);

  it('transfer した後も、次の exportImage は新しい画像を返せる(同じ buffer を再利用しない)', async () => {
    const w = await spawn();
    await w.request({ op: 'init', dbName: 'x3', memory: true });
    await seed(w, 'e1', 'a', 1);
    const a = await w.request({ op: 'exportImage' });
    const sizeA = a.image.byteLength;
    await seed(w, 'e2', 'あ'.repeat(30_000), 2);
    const b = await w.request({ op: 'exportImage' });
    expect(a.image.buffer).not.toBe(b.image.buffer);
    expect(b.image.byteLength).toBeGreaterThan(sizeA);
  }, 60_000);
});

describe('#1416 ── memdb は複製を作らずに出す', () => {
  it('画像から開いた DB は NOCOPY(flags=1)で出し、書いた分まで往復で戻る', async () => {
    const a = await spawn();
    await a.request({ op: 'init', dbName: 'n1', memory: true });
    await seed(a, 'e1', 'もと\n', 1);
    const first = await a.request({ op: 'exportImage' });
    // 流し込んでいない :memory: は memdb ではない ── NOCOPY を試して断られ、今までの道へ戻る
    //  (試した記録は 1 件。⚠ 戻った先の複製の道は上流の面を通るので載らない)
    expect(serializeFlags, '流し込んでいない :memory: の最初の試みが NOCOPY ではない').toEqual([1]);

    const b = await spawn();
    await b.request({ op: 'init', dbName: 'n1', memory: true, image: first.image });
    // 🔴 大きく書く(余白に収まらず、memdb が伸びる経路まで通す)
    await seed(b, 'e2', 'あ'.repeat(50_000), 2);
    serializeFlags = [];
    const second = await b.request({ op: 'exportImage' });
    expect(serializeFlags, 'memdb なのに NOCOPY で出していない').toEqual([1]);

    const c = await spawn();
    const init = await c.request({ op: 'init', dbName: 'n1', memory: true, image: second.image });
    expect(init.restoredBytes).toBe(second.image.byteLength);
    expect(await c.request({ op: 'getBody', cid: 'c1', lid: 'e1' })).toBe('もと\n');
    expect(await c.request({ op: 'getBody', cid: 'c1', lid: 'e2' })).toBe('あ'.repeat(50_000));
  }, 120_000);

  it('NOCOPY の画像は、DB が持つバッファを解放しない(出した後も書ける・もう一度出せる)', async () => {
    const a = await spawn();
    await a.request({ op: 'init', dbName: 'n2', memory: true });
    await seed(a, 'e1', 'x', 1);
    const img = (await a.request({ op: 'exportImage' })).image;
    const b = await spawn();
    await b.request({ op: 'init', dbName: 'n2', memory: true, image: img });
    const one = await b.request({ op: 'exportImage' });
    // 出した後に書けて、もう一度出せる(DB のバッファを free していたら、ここで壊れる)
    await seed(b, 'e2', 'y', 2);
    const two = await b.request({ op: 'exportImage' });
    expect(two.image.byteLength).toBeGreaterThanOrEqual(one.image.byteLength);
    expect(one.image.buffer, '同じ buffer を使い回している').not.toBe(two.image.buffer);
    expect(serializeFlags.filter((f) => f === 1).length).toBe(2);
  }, 120_000);
});

describe('#1416 ── exportDbImage の分岐(偽の面で全部通す)', () => {
  function fakeApi(over: {
    rc?: number;
    pOut?: number;
    size?: number | bigint;
    noExport?: boolean;
  }): { api: ImageExportApi; calls: { flags: number[]; copy: number; popped: number } } {
    const heap = new Uint8Array(64).map((_, i) => i);
    const calls = { flags: [] as number[], copy: 0, popped: 0 };
    const api = {
      capi: {
        sqlite3_js_db_export: () => {
          calls.copy++;
          return new Uint8Array([9, 9, 9]);
        },
      },
      wasm: {
        exports: over.noExport
          ? {}
          : {
              sqlite3__wasm_db_serialize: (
                _db: unknown,
                _schema: number,
                _ppOut: number,
                _pSize: number,
                flags: number,
              ) => {
                calls.flags.push(flags);
                return over.rc ?? 0;
              },
            },
        heap8u: () => heap,
        scopedAllocPush: () => 1,
        scopedAllocPop: () => {
          calls.popped++;
        },
        scopedAlloc: () => 8,
        peekPtr: () => over.pOut ?? 16,
        peek: () => over.size ?? 4,
        ptr: { size: 4, add: (p: number, n: number) => p + n },
      },
    } as unknown as ImageExportApi;
    return { api, calls };
  }

  it('NOCOPY が場所を返したら、そこから写す(複製の道は呼ばない・解放もしない)', () => {
    const { api, calls } = fakeApi({ pOut: 16, size: 4 });
    const out = exportDbImage(api, 'db');
    expect([...out]).toEqual([16, 17, 18, 19]);
    expect(calls.flags).toEqual([1]);
    expect(calls.copy, '複製の道を呼んでいる').toBe(0);
    expect(calls.popped).toBe(1);
    // 写し(slice)であって、wasm の buffer の view ではない
    expect(out.buffer.byteLength).toBe(4);
  });

  it.each([
    ['場所が 0(memdb でない)', { pOut: 0 }],
    ['rc が 0 でない', { rc: 7 }],
    ['大きさが 0', { size: 0 }],
    ['serialize が無い', { noExport: true }],
  ] as const)('%s → 今までの道へ戻る', (_name, over) => {
    const { api, calls } = fakeApi(over);
    const out = exportDbImage(api, 'db');
    expect([...out]).toEqual([9, 9, 9]);
    expect(calls.copy).toBe(1);
    // 確保した作業領域は、戻る道でも必ず返している
    if (!('noExport' in over)) expect(calls.popped).toBe(1);
  });

  it('写す途中で落ちても作業領域は返す(例外はそのまま呼び側へ)', () => {
    const { api, calls } = fakeApi({ pOut: 16, size: 4 });
    (api.wasm as unknown as { heap8u: () => never }).heap8u = () => {
      throw new RangeError('Array buffer allocation failed');
    };
    expect(() => exportImageNoCopy(api, 'db')).toThrow(/allocation failed/);
    expect(calls.popped).toBe(1);
  });
});
