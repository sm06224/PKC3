/**
 * @vitest-environment happy-dom
 *
 * 🔴 **器を開いた直後に、拡張を読み込む**(#682 段④b)。
 *
 * ## ここで見るもの
 *
 * ① **順番** ── 外の自動取得を切ってから読み込む(逆にすると、その間だけ外へ出る窓が開く)
 * ② **渡された在り処から取る**(こちらで組み直さない = 別 origin を作る口を増やさない)
 * ③ **落ちたら名前を添えて投げる**(飲むと「parquet を開いた人だけ、遠い所で落ちる」)
 * ④ ⚠ **対照群** ── 拡張を渡さなければ、`INSTALL` も `LOAD` も `fetch` も 0 件
 *
 * ⚠ **上流は丸ごと差し替える** ── ここで見たいのは打つ順番と配線であって、
 *   DuckDB が本当に読み込めるかではない(そちらは段④a が実ブラウザではなく
 *   node で、CI の `duckdb-ext-probe.yml` で実測済み)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

/** 打たれた SQL と、取りに行った URL を並べる場所。 */
const sql: string[] = [];
const registered: { name: string; bytes: number }[] = [];

vi.mock('@duckdb/duckdb-wasm', () => {
  class FakeDb {
    instantiate = vi.fn(async () => undefined);
    connect = vi.fn(async () => ({
      query: vi.fn(async (q: string) => {
        sql.push(q);
        return { schema: { fields: [] }, toArray: () => [] };
      }),
      close: vi.fn(async () => undefined),
    }));
    registerFileBuffer = vi.fn(async (name: string, bytes: Uint8Array) => {
      registered.push({ name, bytes: bytes.byteLength });
    });
    dropFile = vi.fn(async () => undefined);
    terminate = vi.fn(async () => undefined);
  }
  return { AsyncDuckDB: FakeDb, VoidLogger: class {} };
});

class FakeWorker {
  terminate = vi.fn();
}

const URLS = { wasmUrl: 'https://x.test/app/duckdb/duckdb-eh.wasm', workerUrl: 'https://x.test/app/duckdb/w.js' };

function mockFetch(handler: (url: string) => Response): void {
  vi.stubGlobal('fetch', vi.fn((input: string | URL) => Promise.resolve(handler(String(input)))));
}

async function open(extensions?: { repository: string; names: readonly string[] }) {
  const { openDuckDb } = await import('../../src/adapter/platform/duckdb/duckdb-open');
  return openDuckDb({ ...URLS, ...(extensions === undefined ? {} : { extensions }) });
}

describe('🔴 開いた直後に拡張を読み込む(#682 段④b)', () => {
  afterEach(() => {
    sql.length = 0;
    registered.length = 0;
    vi.unstubAllGlobals();
  });

  it('🔴 外を切ってから読み込む(順番)+ 打ち方は置き場 → INSTALL → LOAD', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    mockFetch(() => new Response(new Uint8Array(1234)));
    await open({ repository: 'https://x.test/app/duckdb/ext', names: ['parquet'] });

    expect(sql).toEqual([
      'SET autoinstall_known_extensions=false',
      'SET autoload_known_extensions=false',
      "SET custom_extension_repository='https://x.test/app/duckdb/ext'",
      'INSTALL parquet',
      'LOAD parquet',
    ]);
    /**
     * 🔴 **門より先に読み込んでいない** ── 逆順だと、その間だけ外へ出られる。
     * ⚠ 上の `toEqual` は**順番ごと**見ているが、それだけだと「並びが違う」としか
     *   読めない ── だから**何が守れていないか**が文言に出る形で 1 本足す。
     */
    expect(
      sql.indexOf('SET autoload_known_extensions=false'),
      '拡張を読み込んでから外を切っている(その間だけ外へ出られる)',
    ).toBeLessThan(sql.findIndex((q) => q.startsWith('INSTALL')));
  });

  it('🔴 器の中へ bytes を差し込まない ── 取りに行くのは engine 自身(実測 2026-09-16)', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(new Uint8Array(9))));
    vi.stubGlobal('fetch', fetchSpy);
    await open({ repository: 'https://x.test/app/duckdb/ext', names: ['json'] });
    /**
     * ⚠ **こちらが取ってきて差し込む道は、実ブラウザで通らなかった**
     *   (`registerFileBuffer` で置いても素通りして HTTP GET が飛ぶ)。
     * 🔑 だから**こちらは 1 バイトも取らない** ── ここが変わったら、
     *   また外へ出る道を作りかけている合図である。
     */
    expect(fetchSpy, 'こちらが拡張を取りに行っている(engine に任せる作りのはず)').not
      .toHaveBeenCalled();
    expect(registered, '器へ差し込んでいる(その道は通らない)').toEqual([]);
  });

  it('🔴 名前は engine へそのまま渡るので、受ける字を絞る', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    mockFetch(() => new Response(new Uint8Array(9)));
    await expect(
      open({ repository: 'https://x.test/app/duckdb/ext', names: ['json; DROP'] }),
    ).rejects.toThrow(/名前が不正/u);
  });

  it("⚠ 置き場の `'` は畳む(引用符が閉じない)", async () => {
    vi.stubGlobal('Worker', FakeWorker);
    mockFetch(() => new Response(new Uint8Array(9)));
    // ⚠ 名前を 1 つ渡す ── 0 件だと置き場そのものを打たない(下の対照群がその形)
    await open({ repository: "https://x.test/a'b", names: ['json'] });
    expect(sql.find((q) => q.startsWith('SET custom_extension_repository'))).toBe(
      "SET custom_extension_repository='https://x.test/a''b'",
    );
  });

  it('⚠ 対照群 ── 拡張を渡さなければ、置き場も INSTALL も打たない', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    await open();
    expect(
      sql.filter((q) => q.startsWith('INSTALL') || q.startsWith('LOAD ') || q.includes('repository')),
    ).toEqual([]);
    // ⚠ 空振り防止 ── 門の 2 行は打たれている(この test が何も通っていないわけではない)
    expect(sql).toHaveLength(2);
  });
});
