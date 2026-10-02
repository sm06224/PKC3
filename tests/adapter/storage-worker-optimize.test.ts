/**
 * 🔴 **索引の片づけ(`optimizeIndexes`)を、本物の worker で通す**(#999 段③)。
 *
 * 見るのは:
 * - 返る形(前後の `storageGauge` と所要。⚠ 期待値は**実物の worker から読む** ── 手で書かない)
 * - **索引の段が畳まれる**(before が複数段 → after が 1 段)と、**探した結果は変わらない**
 * - **書込と並走しない**: 直前に投げた `upsertEntry` が**終わってから**走る
 *   (awaitせず続けて投げ、before の段数に 1 本ぶんが載っていること)
 * - 🔴 **VACUUM を打っていない**(file は縮まない ── 縮むなら #1218 を踏む)
 * - 一覧の仕分け: 壊れの門・空きの門の両方に入っている(断る理由は別 file が見る)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import { CORRUPT_BLOCKED_OPS } from '../../src/features/storage/db-corruption';
import { QUOTA_BLOCKED_OPS } from '../../src/features/storage/write-quota';

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

async function put(lid: string, body: string): Promise<void> {
  await request({
    op: 'upsertEntry',
    cid: 'c1',
    entry: {
      lid,
      title: `題名 ${lid}`,
      archetype: 'text',
      body,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
    },
  });
}

/** 決定的な本文(語が毎回違うので索引の段がちゃんと増える)。 */
const bodyOf = (i: number, kb: number): string =>
  `# 本文 ${i}\n` + `語${i}-とりあえず試す文章を繰り返す。`.repeat(Math.ceil((kb * 1024) / 30));

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  await request({ op: 'init', dbName: 'unit-optimize' });
  await request({ op: 'openContainer', cid: 'c1', title: 'unit' });
}, 30_000);

afterAll(async () => {
  await request({ op: 'close' });
});

describe('optimizeIndexes(#999 段③)', () => {
  it('🔴 溜まった索引の段を 1 段へ畳み、前後の計器と所要を返す', async () => {
    // ⚠ 大きめの本文を先に 1 件(1 段が複数の葉を持つ形)→ 畳んで基準を揃える → 小さく 4 回別々に書く
    await put('keeper', bodyOf(99, 300));
    await request({ op: 'optimizeIndexes' });
    for (let i = 0; i < 4; i++) await put(`s${i}`, bodyOf(100 + i, 1));

    const r = await request({ op: 'optimizeIndexes' });
    // ⚠ 空振り防止 ── 畳む前に複数段が在ったことを実物から読む(1 段なら「畳んだ」と言えない)
    expect(r.before.ftsSegments, '前提: 畳む前に段が溜まっていない').toBeGreaterThanOrEqual(3);
    expect(r.after.ftsSegments, '畳まれていない').toBe(1);
    // 返る形: 前後とも `storageGauge` と同じ形で、所要は数字
    for (const g of [r.before, r.after]) {
      expect(g.fileBytes).toBe(g.pageCount * g.pageSize);
      expect(g.freeBytes).toBe(g.freelistCount * g.pageSize);
    }
    expect(Number.isFinite(r.elapsedMs)).toBe(true);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    // 🔑 返した after は、いま測り直した値と同じ(嘘の after を返していない)
    const now = await request({ op: 'storageGauge' });
    expect(r.after.pageCount).toBe(now.pageCount);
    expect(r.after.freelistCount).toBe(now.freelistCount);
    expect(r.after.ftsSegments).toBe(now.ftsSegments);
  });

  it('🔴 畳んでも、探した結果は変わらない(中身を消していない)', async () => {
    const q = { op: 'searchEntries', cid: 'c1', query: '語100' } as const;
    const before = await request(q);
    expect(before.lids.length, '前提: 当たりが 1 件も無い').toBeGreaterThan(0);
    await request({ op: 'optimizeIndexes' });
    const after = await request(q);
    expect([...after.lids].sort()).toEqual([...before.lids].sort());
    expect(await request({ op: 'getBody', cid: 'c1', lid: 's0' })).toBe(bodyOf(100, 1));
  });

  it('🔴 書込と並走しない: 直前に投げた upsertEntry が終わってから走る', async () => {
    await request({ op: 'optimizeIndexes' });
    const base = (await request({ op: 'storageGauge' })).ftsSegments;
    expect(base, '前提: 畳んだ直後が 1 段').toBe(1);
    // ⚠ await しない ── 同じ瞬間に 2 つ投げ、順番だけで決まる形にする
    const writing = put('late', bodyOf(200, 2));
    const optimizing = request({ op: 'optimizeIndexes' });
    await writing;
    const r = await optimizing;
    // 書込が先に終わっていれば、片づけの before には**その書込の段**が載っている
    expect(r.before.ftsSegments, '書込より先に片づけが走った(並走 / 順序の逆転)').toBeGreaterThan(
      base ?? 0,
    );
    expect(r.after.ftsSegments).toBe(1);
    // 書いた本文は片づけの後も読める
    expect(await request({ op: 'getBody', cid: 'c1', lid: 'late' })).toBe(bodyOf(200, 2));
  });

  it('🔴 VACUUM ではない: 片づけても file は縮まない(空きは増えるか同じ)', async () => {
    for (let i = 0; i < 4; i++) await put(`v${i}`, bodyOf(300 + i, 2));
    const r = await request({ op: 'optimizeIndexes' });
    expect(r.after.fileBytes, 'file が縮んだ(VACUUM を打っている)').toBeGreaterThanOrEqual(
      r.before.fileBytes,
    );
    expect(r.before.freelistCount, '前提: 空きページが 1 つも無い(縮む対象が無い)').toBeGreaterThan(0);
    expect(r.after.freelistCount).toBeGreaterThanOrEqual(r.before.freelistCount);
  });

  it('🔴 壊れの門にも空きの門にも入っている(書き込みなので)', () => {
    expect(CORRUPT_BLOCKED_OPS).toContain('optimizeIndexes');
    expect(QUOTA_BLOCKED_OPS).toContain('optimizeIndexes');
  });

  it('🔴 索引の表が無いときは落ちる(黙って成功と言わない)', async () => {
    // ⚠ 最後に置く ── 索引の表を落とすので、以降の test は索引を持たない
    await request({
      op: 'runReadOnlySql',
      sql: 'PRAGMA query_only = 0; DROP TABLE entries_fts',
      maxRows: 1,
      maxSteps: 1_000_000,
      maxMs: 10_000,
    });
    await expect(request({ op: 'optimizeIndexes' })).rejects.toThrow();
  });
});
