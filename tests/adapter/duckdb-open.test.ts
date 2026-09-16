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

async function open(extensions?: readonly { name: string; url: string }[]) {
  const { openDuckDb } = await import('../../src/adapter/platform/duckdb/duckdb-open');
  return openDuckDb({ ...URLS, ...(extensions === undefined ? {} : { extensions }) });
}

describe('🔴 開いた直後に拡張を読み込む(#682 段④b)', () => {
  afterEach(() => {
    sql.length = 0;
    registered.length = 0;
    vi.unstubAllGlobals();
  });

  it('🔴 外を切ってから読み込む(順番)+ 打ち方は INSTALL → LOAD', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    mockFetch(() => new Response(new Uint8Array(1234)));
    await open([{ name: 'parquet', url: 'blob:p' }]);

    expect(sql).toEqual([
      'SET autoinstall_known_extensions=false',
      'SET autoload_known_extensions=false',
      "INSTALL 'parquet.duckdb_extension.wasm'",
      'LOAD parquet',
    ]);
    // 🔴 **門より先に読み込んでいない** ── 逆順だと、その間だけ外へ出られる
    expect(sql.indexOf('SET autoload_known_extensions=false')).toBeLessThan(
      sql.findIndex((q) => q.startsWith('INSTALL')),
    );
    expect(registered, '取ってきた bytes を器へ差し込んでいない').toEqual([
      { name: 'parquet.duckdb_extension.wasm', bytes: 1234 },
    ]);
  });

  it('🔴 渡された在り処から取る(こちらで組み直さない)', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((u: string) => {
        seen.push(String(u));
        return Promise.resolve(new Response(new Uint8Array(9)));
      }),
    );
    await open([
      { name: 'json', url: 'https://x.test/app/duckdb/ext/json.duckdb_extension.wasm' },
      { name: 'sqlite_scanner', url: 'blob:sq' },
    ]);
    expect(seen).toEqual([
      'https://x.test/app/duckdb/ext/json.duckdb_extension.wasm',
      'blob:sq',
    ]);
    // ⚠ 渡した順に読み込む(名前と在り処が取り違わっていない)
    expect(sql.filter((q) => q.startsWith('LOAD '))).toEqual(['LOAD json', 'LOAD sqlite_scanner']);
  });

  it('🔴 取ってこられなければ、名前を添えて投げる(黙って飲まない)', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    mockFetch(() => new Response('nope', { status: 404 }));
    await expect(open([{ name: 'parquet', url: 'blob:p' }])).rejects.toThrow(/parquet.*404/u);
  });

  it('⚠ 対照群 ── 拡張を渡さなければ、取りにも行かず INSTALL も打たない', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(new Uint8Array(9))));
    vi.stubGlobal('fetch', fetchSpy);
    await open();
    expect(fetchSpy, '渡していないのに取りに行った').not.toHaveBeenCalled();
    expect(sql.filter((q) => q.startsWith('INSTALL') || q.startsWith('LOAD '))).toEqual([]);
    // ⚠ 空振り防止 ── 門の 2 行は打たれている(この test が何も通っていないわけではない)
    expect(sql).toHaveLength(2);
  });
});
