/**
 * 🔴 **保存領域の太り具合を測る口(`storageGauge`)を、本物の worker で通す**(#999 段①)。
 *
 * 見るのは:
 * - 返る形(全 field が数 / 字で揃い、`fileBytes` / `freeBytes` が掛け算と一致する)
 * - **空の DB**(ノートを 1 件も書く前)では空きも索引の段も 0
 * - **書いて消すと `freelistCount` が増える**(= 「消しても file は縮まない」を数が言う)
 * - 索引の段数は**書くたびに増え、`optimize` で 1 に畳まれる**(= 代理が段を数えている)
 * - **読むだけ**: 呼んでも `freelistCount` / `pageCount` が動かない / 壊れ・空きの門に入っていない
 *
 * ⚠ 片づけ(`optimize` / `VACUUM`)の口は製品に無い。この file が `optimize` を打つのは
 *   `runReadOnlySql` の複文(`PRAGMA query_only = 0` を先頭に置く)で、**実測用の迂回**である
 *   (実ブラウザの probe `tests/probe/storage-gauge-probe.mjs` が同じ手で打つ ──
 *   それが node でも通ることをここで見ておく)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

/** 複文で `query_only` を外してから打つ(probe と同じ迂回)。 */
async function rawWrite(sql: string): Promise<void> {
  await request({
    op: 'runReadOnlySql',
    sql: `PRAGMA query_only = 0; ${sql}`,
    maxRows: 10,
    maxSteps: 1_000_000_000,
    maxMs: 60_000,
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

/** 決定的な本文(乱数を使わない)。語が毎回違うので索引がちゃんと伸びる。 */
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
  const init = await request({ op: 'init', dbName: 'unit-gauge' });
  expect(init.vfs).toBe('memory');
}, 30_000);

afterAll(async () => {
  await request({ op: 'close' });
});

describe('storageGauge(#999 段①)', () => {
  it('🔴 空の DB では、空きも索引の段も 0(ノートを 1 件も書く前)', async () => {
    const g = await request({ op: 'storageGauge' });
    // ⚠ 空振り防止 ── 何も読めていない 0 で「空」と言わない(schema だけで数ページ在る)
    expect(g.pageCount, 'page_count を読めていない').toBeGreaterThan(0);
    expect(g.pageSize, 'page_size を読めていない').toBeGreaterThan(0);
    expect(g.freelistCount).toBe(0);
    expect(g.freeBytes).toBe(0);
    // 🔑 null でも 0 でもなく **0**(索引の表は在る。無いなら null ── 下の test)
    expect(g.ftsSegments).toBe(0);
  });

  it('🔴 返る形: 掛け算が合い、journalMode / tempStore / elapsedMs が実値で入る', async () => {
    const g = await request({ op: 'storageGauge' });
    expect(g.fileBytes).toBe(g.pageCount * g.pageSize);
    expect(g.freeBytes).toBe(g.freelistCount * g.pageSize);
    // ⚠ `:memory:` の journal は `memory`(実値を読んでいる ── 要求値の既定 `truncate` ではない)
    expect(g.journalMode).toBe('memory');
    expect([0, 1, 2]).toContain(g.tempStore);
    // 🔴 `synchronous` は FULL と決めた(#1007 段③)── 読み戻しが 2 でなければ耐久性が落ちている
    expect(g.synchronous, 'synchronous が FULL(2)でない').toBe(2);
    expect(Number.isFinite(g.elapsedMs)).toBe(true);
    for (const v of [g.pageCount, g.pageSize, g.freelistCount, g.fileBytes, g.freeBytes]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('🔴 書くと file が太り、消すと freelistCount が増える(消しても file は縮まない)', async () => {
    await request({ op: 'openContainer', cid: 'c1', title: 'unit' });
    const before = await request({ op: 'storageGauge' });
    for (let i = 0; i < 30; i++) await put(`g${i}`, bodyOf(i, 20));
    const grown = await request({ op: 'storageGauge' });
    expect(grown.fileBytes, '書いても file が太っていない').toBeGreaterThan(before.fileBytes);
    expect(grown.ftsSegments, '書いても索引の段が数えられない').toBeGreaterThan(0);

    for (let i = 0; i < 30; i++) await request({ op: 'deleteEntry', cid: 'c1', lid: `g${i}` });
    await request({ op: 'purgeTrash', cid: 'c1' });
    const emptied = await request({ op: 'storageGauge' });
    expect(emptied.freelistCount, '消したのに空きページが増えていない').toBeGreaterThan(
      grown.freelistCount,
    );
    expect(emptied.freeBytes).toBe(emptied.freelistCount * emptied.pageSize);
    // 🔑 縮んでいない(縮むなら freelist は要らない)── 「戻す操作が無い」の根拠
    expect(emptied.fileBytes).toBeGreaterThanOrEqual(grown.fileBytes);
  });

  it('🔴 索引の段は書くたびに増え、optimize で 1 に畳まれる(代理が段を数えている)', async () => {
    // ⚠ 先に畳んで基準を揃える ── 前の test の書き込みで automerge が走った後の段数は
    //    順番次第で動く。⚠ 3 回に留める(FTS5 は同じ段が 4 つ溜まると自動で畳む)
    //    (前の test で全部消してあるので、1 件置かないと畳んでも 0 段になる)
    //    ⚠ 本文は大きめ(300 KB)にする ── 1 段が**複数の葉**を持つ形でないと、段を数える代わりに
    //    葉の数(`count(*)`)を数える間違いが同じ値になって見分けられない
    await put('keeper', bodyOf(99, 300));
    await rawWrite(`INSERT INTO entries_fts(entries_fts) VALUES ('optimize')`);
    const base = (await request({ op: 'storageGauge' })).ftsSegments;
    expect(base, '前提: 畳んだ直後は 1 段(葉は複数)').toBe(1);
    const leaves = Number(
      (await request({ op: 'runReadOnlySql', sql: 'SELECT count(*) FROM entries_fts_idx', maxRows: 1, maxSteps: 1_000_000, maxMs: 10_000 })).rows[0]?.[0],
    );
    expect(leaves, '前提: 1 段が複数の葉を持つ(でないと段と葉を区別できない)').toBeGreaterThan(1);
    for (let i = 0; i < 3; i++) await put(`s${i}`, bodyOf(100 + i, 1));
    const grown = (await request({ op: 'storageGauge' })).ftsSegments;
    expect(grown, '3 回別々に書いたのに段が増えていない').toBeGreaterThanOrEqual(3);
    await rawWrite(`INSERT INTO entries_fts(entries_fts) VALUES ('optimize')`);
    const merged = (await request({ op: 'storageGauge' })).ftsSegments;
    expect(merged, 'optimize で 1 段に畳まれていない').toBe(1);
  });

  it('🔴 読むだけ: 呼んでも page_count / freelist_count が動かない(何度呼んでも同じ)', async () => {
    const a = await request({ op: 'storageGauge' });
    const b = await request({ op: 'storageGauge' });
    const c = await request({ op: 'storageGauge' });
    for (const g of [b, c]) {
      expect(g.pageCount).toBe(a.pageCount);
      expect(g.freelistCount).toBe(a.freelistCount);
      expect(g.ftsSegments).toBe(a.ftsSegments);
    }
  });

  it('🔴 索引の表が無ければ null(0 と嘘を言わない)。他の数は返す', async () => {
    // ⚠ 最後に置く ── 索引の表を落とすので、以降の test は索引を持たない
    await rawWrite('DROP TABLE entries_fts');
    const g = await request({ op: 'storageGauge' });
    expect(g.ftsSegments).toBeNull();
    expect(g.pageCount).toBeGreaterThan(0);
  });

  it('🔴 壊れの門にも空きの門にも入っていない(読むだけ)', () => {
    expect(CORRUPT_BLOCKED_OPS).not.toContain('storageGauge');
    expect(QUOTA_BLOCKED_OPS).not.toContain('storageGauge');
  });
});

/**
 * 🔴 **`synchronous = FULL` を字で置いていること**(#1007 段③)。
 *
 * ⚠ sqlite の既定が FULL(2)なので、上の読み戻しの pin は**その行を消しても緑**になる
 *   (CLAUDE.md §1「強制する規則は、強制しなければ false になる場面で見る」── ここは
 *   既定が同じ値なので、その場面を作れない)。だから**原文**で 1 行を pin する。
 * ⚠ 見るのは**実行する行**(注釈を剥いでから)── docstring にも同じ字が在る。
 */
describe('#1007 段③ ── synchronous を FULL と決めて、字で置いている', () => {
  it('🔴 storage-worker.ts の実行する行に PRAGMA synchronous = FULL が在る', () => {
    const src = readFileSync('src/adapter/platform/storage/storage-worker.ts', 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const hits = src.match(/PRAGMA synchronous = FULL/g) ?? [];
    expect(hits, 'synchronous を既定に任せている(上流が変えた日に黙って落ちる)').toHaveLength(1);
    // 空振り防止 ── 剥いだ後も、読み戻しの行(gauge)は残っている
    expect(src).toContain("num('PRAGMA synchronous')");
  });
});
