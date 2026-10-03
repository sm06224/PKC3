/**
 * 🔴 **`.sqlite` を DuckDB で引く ── 実物の engine と実物の storage worker をつないで**(#682 段④d)。
 *
 * ## なぜここまでやるのか
 *
 * 字を pin する test(`duckdb-runner-sqlite.test.ts`)は「その字が出ていること」しか言えない。
 * 🔑 ここは **実物の `DuckDbRunner` が、実物の storage worker から NDJSON の写しを受け取り、
 * 実物の DuckDB wasm へ入れて、引いた行を見る**(取り替えているのは「器を起こす所」だけ ──
 * `DuckDbHandle` を node 版の DuckDB で包んでいる)。
 *
 * ## ⚠ 何は言えないか
 *
 * node と実ブラウザは**別の経路**(`duckdb-read-formats.test.ts` の冒頭と同じ)。ここで言えるのは
 * 「この写しと SQL で、この表が引ける」までで、「画面から選んで引ける」は
 * `tests/smoke/attach.smoke.spec.ts` が実ブラウザで見る。
 *
 * ⚠ 拡張は **別プロセスの** HTTP で配る / `@vitest-environment node` で走らせる
 * (どちらも `duckdb-read-formats.test.ts` の冒頭に理由が在る)。
 */
/** @vitest-environment node */
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { DUCKDB_REQUIRED_FILES, duckDbExtensionPath } from '../src/features/query/duckdb-pack';
import { DuckDbRunner } from '../src/adapter/platform/duckdb/duckdb-runner';
import type { DuckDbHandle } from '../src/adapter/platform/duckdb/duckdb-lease';
import type { DuckDbRaw } from '../src/features/query/duckdb-rows';
import { duckDbReadableSourceOf } from '../src/features/query/sql-guest-source';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../src/adapter/platform/storage/protocol';

const require = createRequire(import.meta.url);
const DIST = dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'));
const VENDOR = join(import.meta.dirname, '../vendor/duckdb-extensions');

const SERVER = `
const { createServer } = require('node:http');
const { existsSync, readFileSync } = require('node:fs');
const { join, normalize } = require('node:path');
const ROOT = process.argv[1];
createServer((req, res) => {
  const rel = normalize(decodeURIComponent((req.url || '').split('?')[0]));
  const p = join(ROOT, rel);
  if (!p.startsWith(ROOT) || !existsSync(p)) { res.statusCode = 404; res.end('no'); return; }
  res.setHeader('content-type', 'application/wasm');
  res.end(readFileSync(p));
}).listen(0, '127.0.0.1', function () { console.log(this.address().port); });
`;

interface Conn {
  query: (s: string) => {
    schema: { fields: Array<{ name: string; type: unknown }> };
    toArray: () => Array<Record<string, unknown>>;
  };
  close: () => void;
}
interface Engine {
  instantiate: () => Promise<unknown>;
  connect: () => Conn;
  registerFileBuffer: (name: string, bytes: Uint8Array) => void;
  dropFile: (name: string) => void;
}

let child: ChildProcess | null = null;
let port = 0;
let createDuckDB: (b: unknown, l: unknown, r: unknown) => Promise<Engine>;
let logger: unknown;
let runtime: unknown;

/** 器を 1 つ起こす(`json` 拡張を読み込み済み)。⚠ 塞いだ器は作り直すしか無いので、相手ごとに 1 つ。 */
async function openReal(): Promise<DuckDbHandle> {
  const db = await createDuckDB(
    {
      mvp: { mainModule: join(DIST, 'duckdb-mvp.wasm'), mainWorker: null },
      eh: { mainModule: join(DIST, 'duckdb-eh.wasm'), mainWorker: null },
    },
    logger,
    runtime,
  );
  await db.instantiate();
  const conn = db.connect();
  conn.query(`SET custom_extension_repository='http://127.0.0.1:${String(port)}'`);
  conn.query('INSTALL json');
  conn.query('LOAD json');
  const files = new Set<string>();
  return {
    put: (name, bytes) => {
      db.registerFileBuffer(name, bytes);
      files.add(name);
      return Promise.resolve();
    },
    drop: (name) => {
      db.dropFile(name);
      files.delete(name);
      return Promise.resolve();
    },
    query: (sql) => {
      const t = conn.query(sql);
      const columns = t.schema.fields.map((f) => f.name);
      const raw: DuckDbRaw = {
        columns,
        types: t.schema.fields.map((f) => String(f.type)),
        rows: t.toArray().map((r) => columns.map((c) => (r as Record<string, unknown>)[c])),
      };
      return Promise.resolve(raw);
    },
    // ⚠ node 版の engine には `terminate` が無い(接続を閉じれば足りる ── 実ブラウザの worker とは別の経路)
    terminate: () => {
      conn.close();
      return Promise.resolve();
    },
  };
}

/** 実物の storage worker(node。`storage-worker.test.ts` と同じ作法)。 */
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
  await import('../src/adapter/platform/storage/storage-worker');
  await request({ op: 'init', dbName: 'unit-test' });

  port = await new Promise<number>((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', SERVER, VENDOR], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = c;
    c.stdout?.once('data', (b: Buffer) => {
      resolve(Number(b.toString('utf8').trim()));
    });
    c.once('error', reject);
  });
  const mod = (await import(/* @vite-ignore */ join(DIST, 'duckdb-node-blocking.cjs'))) as unknown as {
    default?: Record<string, unknown>;
  };
  const duck = (mod.default ?? mod) as {
    ConsoleLogger: new (l: unknown) => unknown;
    LogLevel: { ERROR: unknown };
    NODE_RUNTIME: unknown;
    createDuckDB: typeof createDuckDB;
  };
  createDuckDB = duck.createDuckDB;
  logger = new duck.ConsoleLogger(duck.LogLevel.ERROR);
  runtime = duck.NODE_RUNTIME;
}, 120_000);

afterAll(async () => {
  child?.kill();
  await request({ op: 'close' });
});

/** 客の `.sqlite` の画像を sqlite-wasm で自作する。 */
type Db = { exec: (a: unknown) => unknown; pointer: unknown; close: () => void };
async function image(setup: (db: Db) => void): Promise<Uint8Array> {
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(':memory:') as unknown as Db;
  try {
    setup(db);
    return (sqlite3.capi as unknown as { sqlite3_js_db_export: (p: unknown) => Uint8Array }).sqlite3_js_db_export(
      db.pointer,
    );
  } finally {
    db.close();
  }
}
const run = (db: Db, sql: string, bind: unknown[] = []): void => {
  db.exec({ sql, bind });
};

const REAL_BYTES: Readonly<Record<string, number>> = {
  'duckdb-eh.wasm': 35_913_747,
  'duckdb-browser-eh.worker.js': 773_223,
  [duckDbExtensionPath('json')]: 821_413,
  [duckDbExtensionPath('parquet')]: 3_218_307,
  [duckDbExtensionPath('sqlite_scanner')]: 1_641_696,
};
const PACK = JSON.stringify({
  version: '1.33.1',
  files: DUCKDB_REQUIRED_FILES.map((path) => ({ path, bytes: REAL_BYTES[path] ?? 0 })),
});

/** 製品と同じ `DuckDbRunner`(器を起こす所と、storage worker の口だけを差す)。 */
function makeRunner(maxTableBytes?: number): DuckDbRunner {
  return new DuckDbRunner({
    fetchText: () => Promise.resolve(PACK),
    open: () => openReal(),
    baseUrl: 'https://example.test/app/',
    exportSqlite: (img, max) =>
      request({ op: 'exportSqliteForDuckDb', image: img, maxTableBytes: maxTableBytes ?? max }),
  });
}

const sqliteSource = (lid: string, name: string) => {
  const s = duckDbReadableSourceOf(lid, name);
  if (s === null) throw new Error(`前提が崩れている(${name})`);
  return s;
};
const asFile = (img: Uint8Array) => () => Promise.resolve(new Uint8Array(img));
const csvBytes = (text: string) => () => Promise.resolve(new TextEncoder().encode(text));

describe('🔴 .sqlite を DuckDB で引く(実物の engine / 実物の storage worker)', () => {
  it('🔴 表は元の名前のまま引ける ── 値・NULL・BLOB・日付らしい字・改行が、そのまま届く', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE 売上 (id INTEGER, 品名 TEXT, 単価 REAL, 記録 BLOB, 日時 TEXT, 備考 TEXT)');
      run(db, "INSERT INTO 売上 VALUES (1, 'りんご', 1.5, x'000102', '2024-01-01T10:00:00', NULL)");
      run(db, "INSERT INTO 売上 VALUES (2, 'x\"y' || char(10) || 'z', 2, NULL, '2024-01-02', 'あ')");
    });
    const runner = makeRunner();
    const sources = [{ source: sqliteSource('l1', '家計.sqlite'), readBytes: asFile(img) }];
    try {
      const all = await runner.run({ sql: 'SELECT * FROM 売上 ORDER BY id', sources });
      expect(all.columns).toEqual(['id', '品名', '単価', '記録', '日時', '備考']);
      expect(all.rows).toEqual([
        [1, 'りんご', 1.5, 'AAEC', '2024-01-01T10:00:00', null],
        [2, 'x"y\nz', 2, null, '2024-01-02', 'あ'],
      ]);
      // 🔑 日付らしい字は**字のまま**(read_json_auto は `2024-01-01 10:00:00` へ化けさせる ── 実測)
      // 🔑 型は宣言どおり:INTEGER → BIGINT / REAL → DOUBLE / TEXT・BLOB → VARCHAR
      const types = await runner.run({
        sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '売上' ORDER BY ordinal_position",
        sources,
      });
      expect(types.rows).toEqual([
        ['id', 'BIGINT'],
        ['品名', 'VARCHAR'],
        ['単価', 'DOUBLE'],
        ['記録', 'VARCHAR'],
        ['日時', 'VARCHAR'],
        ['備考', 'VARCHAR'],
      ]);
      // 🔴 BLOB は base64 から元の長さへ戻せる(捨てていない)
      const blob = await runner.run({ sql: 'SELECT octet_length(from_base64(記録)) FROM 売上 WHERE id = 1', sources });
      expect(blob.rows).toEqual([[3]]);
    } finally {
      await runner.release();
    }
  }, 60_000);

  it('🔴 空の表も列が残る(行が 0 件)/ 空白の入った名前は引用して引ける', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE 空 (a INTEGER, b TEXT)');
      run(db, 'CREATE TABLE "my table" (x INTEGER)');
      run(db, 'INSERT INTO "my table" VALUES (5)');
    });
    const runner = makeRunner();
    const sources = [{ source: sqliteSource('l1', 'x.sqlite'), readBytes: asFile(img) }];
    try {
      const cols = await runner.run({
        sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '空' ORDER BY ordinal_position",
        sources,
      });
      expect(cols.rows, '空の表の列が消えている').toEqual([
        ['a', 'BIGINT'],
        ['b', 'VARCHAR'],
      ]);
      expect((await runner.run({ sql: 'SELECT count(*) FROM 空', sources })).rows).toEqual([[0]]);
      expect((await runner.run({ sql: 'SELECT x FROM "my table"', sources })).rows).toEqual([[5]]);
    } finally {
      await runner.release();
    }
  }, 60_000);

  it('🔴 型が合わない行(INTEGER の列に文字)は、その表だけ全列 VARCHAR になり、値を失わない', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE 混在 (n INTEGER, m INTEGER)');
      run(db, "INSERT INTO 混在 VALUES (1, 10), ('abc', 20)");
      run(db, 'CREATE TABLE 普通 (n INTEGER)');
      run(db, 'INSERT INTO 普通 VALUES (7)');
    });
    const runner = makeRunner();
    const sources = [{ source: sqliteSource('l1', 'x.sqlite'), readBytes: asFile(img) }];
    try {
      const r = await runner.run({ sql: 'SELECT n, m FROM 混在 ORDER BY m', sources });
      expect(r.rows, '値が NULL になった / 落ちた').toEqual([
        ['1', '10'],
        ['abc', '20'],
      ]);
      // 対照群:型の合う表は BIGINT のまま(足を引っ張られていない)
      const t = await runner.run({ sql: "SELECT data_type FROM information_schema.columns WHERE table_name = '普通'", sources });
      expect(t.rows).toEqual([['BIGINT']]);
    } finally {
      await runner.release();
    }
  }, 60_000);

  it('🔴 推定に任せると落ちる形(2 万行を過ぎてから型が変わる)も、行を失わずに入る', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE 長 (n INTEGER)');
      run(db, 'BEGIN');
      for (let i = 0; i < 25_000; i += 1) run(db, 'INSERT INTO 長 VALUES (?)', [i]);
      run(db, "INSERT INTO 長 VALUES ('late')");
      run(db, 'COMMIT');
    });
    const runner = makeRunner();
    const sources = [{ source: sqliteSource('l1', 'x.sqlite'), readBytes: asFile(img) }];
    try {
      const r = await runner.run({ sql: 'SELECT count(*), count(DISTINCT n) FROM 長', sources });
      expect(r.rows).toEqual([[25_001, 25_001]]);
    } finally {
      await runner.release();
    }
  }, 120_000);

  it('🔴 2 件並べると「ファイル名_表名」/ csv と JOIN でき、塞いだ後も引ける', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE 売上 (品番 TEXT, 数 INTEGER)');
      run(db, "INSERT INTO 売上 VALUES ('A1', 3), ('B2', 5)");
    });
    const runner = makeRunner();
    const sources = [
      { source: sqliteSource('l1', '家計.sqlite'), readBytes: asFile(img) },
      { source: sqliteSource('l2', '在庫.csv'), readBytes: csvBytes('品番,在庫\nA1,100\nB2,30\n') },
    ];
    try {
      const r = await runner.run({
        sql: 'SELECT s.品番, s.数, z.在庫 FROM 家計_売上 s JOIN 在庫 z ON z.品番 = s.品番 ORDER BY s.品番',
        sources,
      });
      expect(r.rows).toEqual([
        ['A1', 3, 100],
        ['B2', 5, 30],
      ]);
      // 🔴 1 件のときの元の名前は、2 件では引けない(名前は「ファイル名_表名」に付け直している)
      await expect(runner.run({ sql: 'SELECT * FROM 売上', sources })).rejects.toThrow();
    } finally {
      await runner.release();
    }
  }, 60_000);

  it('🔴 外は塞がっている ── 写した表は引けるが、file の読み直しは断られる(NDJSON は器に残さない)', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE t (n INTEGER)');
      run(db, 'INSERT INTO t VALUES (1)');
    });
    const runner = makeRunner();
    const sources = [{ source: sqliteSource('l1', 'x.sqlite'), readBytes: asFile(img) }];
    try {
      expect((await runner.run({ sql: 'SELECT count(*) FROM t', sources })).rows).toEqual([[1]]);
      // 塞ぎが効いている(= 差し込んだ NDJSON を読み直せない)
      await expect(
        runner.run({ sql: "SELECT * FROM read_json('source_t1.ndjson')", sources }),
      ).rejects.toThrow();
      // 遠くの file も断られる
      await expect(
        runner.run({ sql: "SELECT * FROM read_json('https://example.test/x.json')", sources }),
      ).rejects.toThrow();
    } finally {
      await runner.release();
    }
  }, 60_000);

  it('🔴 大きい表だけ断る ── ほかの表は引け、その表を引いて落ちたときだけ理由が添う', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE 大 (t TEXT)');
      run(db, 'BEGIN');
      for (let i = 0; i < 200; i += 1) run(db, 'INSERT INTO 大 VALUES (?)', ['x'.repeat(200)]);
      run(db, 'COMMIT');
      run(db, 'CREATE TABLE 小 (n INTEGER)');
      run(db, 'INSERT INTO 小 VALUES (1)');
    });
    // 天井だけ小さく(4KB)する ── 製品の定数は 64MiB なので、ここで差し替えないと大きい表を作ることになる
    const runner = makeRunner(4096);
    const sources = [{ source: sqliteSource('l1', 'x.sqlite'), readBytes: asFile(img) }];
    try {
      expect((await runner.run({ sql: 'SELECT n FROM 小', sources })).rows, '小さい表まで引けない').toEqual([[1]]);
      let msg = '';
      await runner.run({ sql: 'SELECT count(*) FROM 大', sources }).catch((e: unknown) => {
        msg = e instanceof Error ? e.message : String(e);
      });
      expect(msg, 'DuckDB の断り(表が無い)が消えている').toMatch(/大/);
      expect(msg, '理由が添わない').toContain('大 は DuckDB へ写せませんでした');
      expect(msg).toContain('内蔵の sqlite');
    } finally {
      await runner.release();
    }
  }, 60_000);
});
