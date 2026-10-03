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
import {
  SCHEMA_COLUMNS_SQL,
  SCHEMA_FK_SQL,
  countsSql,
  renderSchemaDigest,
  schemaModel,
  schemaTableNames,
  type Grid,
} from '../src/features/query/schema-digest';
import { buildParquet } from './features/parquet-fixture';
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
  // 🔴 構造を採る test(#918)が `.parquet` を持ち込む ── 製品も同梱の拡張を全部読む
  conn.query('INSTALL parquet');
  conn.query('LOAD parquet');
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
/** 🔴 storage worker へ「`.sqlite` を写して」と頼んだ回数(#918:構造を採った後の SQL が差し込み直さないことを見る)。 */
let exportCalls = 0;
/** 最後に起こした器(実物)。⚠ 塞いだ後に「器の中へ別の file を差す」test が使う。 */
let lastHandle: DuckDbHandle | null = null;
function makeRunner(maxTableBytes?: number): DuckDbRunner {
  return new DuckDbRunner({
    fetchText: () => Promise.resolve(PACK),
    open: async () => {
      lastHandle = await openReal();
      return lastHandle;
    },
    baseUrl: 'https://example.test/app/',
    // 🔴 製品の `main.ts` と同じ形:開く → 表ごとに頼む → 閉じる(storage worker の 3 つの口)
    exportSqlite: async (img) => {
      exportCalls += 1;
      const opened = await request({ op: 'openSqliteExport', image: img });
      return {
        tables: opened.tables,
        table: (name, max) =>
          request({ op: 'exportSqliteTable', session: opened.session, table: name, maxTableBytes: maxTableBytes ?? max }),
        close: async () => {
          await request({ op: 'closeSqliteExport', session: opened.session });
        },
      };
    },
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

  /**
   * 🔴 **塞ぎ(`SET enable_external_access=false`)が効いている**ことを、**塞ぎが無いと通る相手**で見る。
   * ⚠ 1 稿目は「写し終えた NDJSON の読み直し」「遠くの URL」が断られることを見ていたが、前者は
   *   **手放した file** なので塞ぎが無くても落ち、後者は **httpfs が無い**ので塞ぎが無くても落ちた
   *   (塞ぎを外す変異で、両方とも緑のまま)。
   * 🔑 いまの相手は、**塞いだ後に器へ差した別の file**(`put` した NDJSON)── 塞ぎが無ければ `read_json` で読めて、
   *   塞いだ後は読めない(上の対照群で「塞ぐ前は読める」を同じ器の作りで見ている)。
   */
  it('🔴 外は塞がっている ── 写した表は引けるが、塞いだ後に差した file は読めない(塞ぐ前は読める)', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE t (n INTEGER)');
      run(db, 'INSERT INTO t VALUES (1)');
    });
    const other = new TextEncoder().encode('{"x":7}\n');
    // 対照群:塞いでいない器なら、差した file は読める(= 下の「読めない」は file のせいではない)
    const bare = await openReal();
    try {
      await bare.put('other.ndjson', other);
      // ⚠ 器の生の答えは BigInt で返る(`DuckDbRunner` が数へ直す前)── 字で比べる
      expect((await bare.query("SELECT x FROM read_json('other.ndjson')")).rows.map((r) => String(r[0]))).toEqual(['7']);
    } finally {
      await bare.terminate();
    }
    const runner = makeRunner();
    const sources = [{ source: sqliteSource('l1', 'x.sqlite'), readBytes: asFile(img) }];
    try {
      expect((await runner.run({ sql: 'SELECT count(*) FROM t', sources })).rows).toEqual([[1]]);
      // 器は塞がれた後。ここで別の file を差しても、user の字からは読めない
      await lastHandle!.put('other.ndjson', other);
      await expect(
        runner.run({ sql: "SELECT x FROM read_json('other.ndjson')", sources }),
        '塞ぎが効いていない(塞いだ後に差した file が読めてしまう)',
      ).rejects.toThrow();
      // 写した表は塞いだ後も引ける
      expect((await runner.run({ sql: 'SELECT n FROM t', sources })).rows).toEqual([[1]]);
    } finally {
      await runner.release();
    }
  }, 60_000);

  /**
   * 🔴 **「値は 1 つも失わない」**(着地後のレビューで偽と分かった)。宣言が INTEGER でも sqlite は小数を
   *   REAL のまま保てる(価格 19.99)── DuckDB の BIGINT へ `read_json` で入れると**落ちずに丸まる**。
   *   DOUBLE の `Infinity` は **NULL**、NUMERIC の 2^53 超は丸まる。worker が旗を立て、全列 VARCHAR で写す。
   */
  it('🔴 INTEGER の列の小数 / REAL の Infinity / NUMERIC の 2^53 超が、丸まらず・消えずに届く', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE price (name TEXT, p INTEGER)');
      run(db, "INSERT INTO price VALUES ('a', 3), ('b', 19.99), ('c', 2.5), ('d', 3.5)");
      run(db, 'CREATE TABLE inf (x REAL)');
      run(db, 'INSERT INTO inf VALUES (1.5), (9e999), (-9e999)');
      run(db, 'CREATE TABLE big (x NUMERIC)');
      run(db, 'INSERT INTO big VALUES (9007199254740993)');
      run(db, 'CREATE TABLE fp (x FLOATING POINT)');
      run(db, 'INSERT INTO fp VALUES (0.1), (2)');
      // 対照群:ふつうの表は型どおり(旗が立つ表の足を引っ張らない)
      run(db, 'CREATE TABLE plain (p INTEGER, r REAL)');
      run(db, 'INSERT INTO plain VALUES (1, 1.5), (2, 2.5)');
    });
    const runner = makeRunner();
    const sources = [{ source: sqliteSource('l1', 'x.sqlite'), readBytes: asFile(img) }];
    try {
      const price = await runner.run({ sql: 'SELECT name, p FROM price ORDER BY name', sources });
      expect(price.rows, '小数が丸まった(3.5 → 4 / 2.5 → 2 / 19.99 → 20)').toEqual([
        ['a', '3'],
        ['b', '19.99'],
        ['c', '2.5'],
        ['d', '3.5'],
      ]);
      const inf = await runner.run({ sql: 'SELECT x FROM inf ORDER BY x', sources });
      expect(inf.rows, 'Infinity が NULL になった').toEqual([['-Infinity'], ['1.5'], ['Infinity']]);
      expect((await runner.run({ sql: 'SELECT x FROM big', sources })).rows, '2^53 超の整数が丸まった').toEqual([
        ['9007199254740993'],
      ]);
      // 型名に INT を含む `FLOATING POINT`(sqlite は INTEGER 親和性)も、小数を失わない
      expect((await runner.run({ sql: 'SELECT x FROM fp ORDER BY x', sources })).rows).toEqual([['0.1'], ['2']]);
      // 字で届くので、user は CAST で自分で選べる
      expect((await runner.run({ sql: 'SELECT sum(CAST(p AS DOUBLE)) FROM price', sources })).rows).toEqual([[28.99]]);
      // 対照群:旗の立たない表は、今までどおり型のまま
      const types = await runner.run({
        sql: "SELECT data_type FROM information_schema.columns WHERE table_name = 'plain' ORDER BY ordinal_position",
        sources,
      });
      expect(types.rows).toEqual([['BIGINT'], ['DOUBLE']]);
    } finally {
      await runner.release();
    }
  }, 60_000);

  /**
   * 🔴 **DuckDB が作れない宣言(空の名前)は、その表だけ断る**。sqlite は空の表名・列名を許すが、
   *   DuckDB は `zero-length delimited identifier` で断る ── 外へ投げると file 全体が英語の断りで落ちていた。
   */
  it('🔴 名前が空の表・列が在っても、ほかの表は引ける(その表だけ理由つきで断る)', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE "" (a INTEGER)');
      run(db, 'CREATE TABLE emptycol ("" INTEGER, b INTEGER)');
      run(db, 'CREATE TABLE 無事 (n INTEGER)');
      run(db, 'INSERT INTO 無事 VALUES (5)');
    });
    const runner = makeRunner();
    const sources = [{ source: sqliteSource('l1', 'x.sqlite'), readBytes: asFile(img) }];
    try {
      expect((await runner.run({ sql: 'SELECT n FROM 無事', sources })).rows, '無事な表まで引けなくなった').toEqual([[5]]);
      let msg = '';
      await runner.run({ sql: 'SELECT * FROM emptycol', sources }).catch((e: unknown) => {
        msg = e instanceof Error ? e.message : String(e);
      });
      expect(msg).toContain('emptycol は DuckDB へ写せませんでした');
      expect(msg).toContain('(名前の無い表) は DuckDB へ写せませんでした');
    } finally {
      await runner.release();
    }
  }, 60_000);

  /**
   * 🔴 **表が多くても、同時に載るのは 1 表ぶん**(実物で、写し終えた表の NDJSON を手放していること)。
   * ⚠ 順番と「開いた写しを残さない」は `duckdb-runner-sqlite.test.ts` が持つ。ここは**実物の engine で全表が引ける**こと
   *   (表ごとに頼む形にしても、1 表も欠けない)。
   */
  it('🔴 表が 12 枚あっても、全部が元の名前で引ける(表ごとに頼む形でも 1 表も欠けない)', async () => {
    const img = await image((db) => {
      for (let i = 0; i < 12; i += 1) {
        run(db, `CREATE TABLE t${String(i)} (n INTEGER)`);
        run(db, `INSERT INTO t${String(i)} VALUES (${String(i)})`);
      }
    });
    const runner = makeRunner();
    const sources = [{ source: sqliteSource('l1', 'x.sqlite'), readBytes: asFile(img) }];
    try {
      const parts = Array.from({ length: 12 }, (_, i) => `SELECT n FROM t${String(i)}`).join(' UNION ALL ');
      const r = await runner.run({ sql: `SELECT count(*), sum(n) FROM (${parts})`, sources });
      expect(r.rows).toEqual([[12, 66]]);
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

/**
 * 🔴 **DuckDB の器の中の構造 ── 構造ノート・つながり図が、DuckDB で引く相手でも出る**(#918。
 * 🟣 Gemini 裁定 2026-10-02 = A)。
 *
 * ⚠ 字を pin する test は「その SQL が出ていること」しか言えない ── ここは**実物の DuckDB に打たせ、
 *   描く側(`schemaModel` / `renderSchemaDigest`)が読む形になっているか**を見る。
 * 🔑 いちばん強い主張は **parity**:**同じ `.sqlite` を、内蔵の sqlite の道と DuckDB の道で採って
 *   markdown が 1 字も違わない**(描く側は触っていない ── 入力の形が同じであることの検査)。
 */
describe('🔴 DuckDB の器の構造(#918)', () => {
  /** 内蔵の sqlite の道(実物の storage worker に客として開かせ、構造を採る 3 本を打つ)。 */
  const sqliteSide = async (img: Uint8Array, guest: string) => {
    await request({ op: 'openSqlGuest', image: img, guest });
    try {
      const ask = async (sql: string): Promise<Grid> => {
        const r = await request({
          op: 'runReadOnlySql',
          sql,
          maxRows: 10_000,
          maxSteps: 1_000_000,
          maxMs: 60_000,
          guest,
        });
        return { columns: r.columns, rows: r.rows };
      };
      const columns = await ask(SCHEMA_COLUMNS_SQL);
      const fks = await ask(SCHEMA_FK_SQL);
      const sql = countsSql(schemaTableNames(columns));
      return { columns, fks, counts: sql === null ? null : await ask(sql) };
    } finally {
      await request({ op: 'closeSqlGuest', guest });
    }
  };

  /** 外部キー・主キー(複合も)・NOT NULL・型なしの列・日本語の名前、を一通り持つ `.sqlite`。 */
  const richImage = () =>
    image((db) => {
      run(db, 'CREATE TABLE 客 (id INTEGER PRIMARY KEY, 名前 TEXT NOT NULL, 備考)');
      run(db, 'CREATE TABLE 売上 (id INTEGER PRIMARY KEY, 客id INTEGER REFERENCES 客(id), 金額 REAL)');
      run(
        db,
        'CREATE TABLE 明細 (売上id INTEGER, 行 INTEGER, 品名 TEXT, PRIMARY KEY (売上id, 行), FOREIGN KEY (売上id) REFERENCES 売上(id))',
      );
      run(db, 'CREATE TABLE 空 (a INTEGER)');
      run(db, "INSERT INTO 客 VALUES (1, 'A', NULL), (2, 'B', 'x')");
      run(db, 'INSERT INTO 売上 VALUES (10, 1, 1.5), (11, 2, 2.5), (12, 2, 3)');
      run(db, "INSERT INTO 明細 VALUES (10, 1, 'りんご'), (10, 2, 'みかん')");
    });

  it('🔴 parity:同じ .sqlite を、内蔵の sqlite の道と DuckDB の道で採って、構造が 1 字も違わない', async () => {
    const img = await richImage();
    const expected = await sqliteSide(img, 'parity');
    const runner = makeRunner();
    try {
      const got = await runner.schema([{ source: sqliteSource('l1', '家計.sqlite'), readBytes: asFile(img) }]);
      const want = { source: '家計.sqlite', columns: expected.columns, fks: expected.fks, counts: expected.counts! };
      const have = { source: '家計.sqlite', columns: got.columns, fks: got.fks, counts: got.counts! };
      const a = schemaModel(want);
      const b = schemaModel(have);
      // 🔑 前提:比べる中身が空でない(空どうしの一致で緑にしない)
      expect(a.tables.map((t) => t.name), '前提が崩れている(表が採れていない)').toEqual(['売上', '客', '明細', '空']);
      expect(a.links.length, '前提が崩れている(外部キーが採れていない)').toBe(2);
      expect(a.tables.find((t) => t.name === '明細')?.columns.filter((c) => c.primaryKey).length).toBe(2);
      expect(a.tables.find((t) => t.name === '客')?.columns.find((c) => c.name === '備考')?.type).toBe('');
      expect(b, '描く側へ渡る構造が、内蔵の sqlite の道と違う').toEqual(a);
      expect(renderSchemaDigest(have), '構造ノートの字が違う').toBe(renderSchemaDigest(want));
    } finally {
      await runner.release();
    }
  }, 60_000);

  it('🔴 .sqlite の外部キーが線になる(列ごと / 器の表そのものには外部キーを作らない)', async () => {
    const img = await richImage();
    const runner = makeRunner();
    const sources = [{ source: sqliteSource('l1', '家計.sqlite'), readBytes: asFile(img) }];
    try {
      const got = await runner.schema(sources);
      expect(schemaModel({ source: 'x', columns: got.columns, fks: got.fks }).links).toEqual([
        { from: '売上', fromColumn: '客id', to: '客', toColumn: 'id' },
        { from: '明細', fromColumn: '売上id', to: '売上', toColumn: 'id' },
      ]);
      // ⚠ 器の表そのものには外部キーを作っていない(作ると、sqlite では通った行の INSERT が落ちる)
      const inDb = await runner.run({
        sql: "SELECT count(*) FROM duckdb_constraints() WHERE constraint_type = 'FOREIGN KEY'",
        sources,
      });
      expect(inDb.rows).toEqual([[0]]);
    } finally {
      await runner.release();
    }
  }, 60_000);

  it('🔴 .parquet 1 件:列と型と行数が採れ、外部キーは 0 本(四角だけの図)', async () => {
    const bytes = buildParquet([
      { name: 'id', type: 'int32', values: [1, 2, 3] },
      { name: '品名', type: 'utf8', values: ['a', 'b', 'c'] },
    ]);
    const runner = makeRunner();
    try {
      const got = await runner.schema([{ source: sqliteSource('p1', '売上.parquet'), readBytes: asFile(bytes) }]);
      const m = schemaModel({ source: '売上.parquet', columns: got.columns, fks: got.fks, counts: got.counts! });
      expect(m.tables).toEqual([
        {
          name: 'parquet',
          kind: 'table',
          rows: 3,
          columns: [
            { name: 'id', type: 'INTEGER', notNull: false, primaryKey: false },
            { name: '品名', type: 'VARCHAR', notNull: false, primaryKey: false },
          ],
        },
      ]);
      expect(m.links, '持ち込んだ file に外部キーは無い').toEqual([]);
    } finally {
      await runner.release();
    }
  }, 60_000);

  it('🔴 2 件並べると表は「ファイル名_表名」/ .sqlite の外部キーの相手も同じ名前へ直る', async () => {
    const img = await richImage();
    const csv = 'id,在庫\n1,5\n2,7\n';
    const runner = makeRunner();
    try {
      const got = await runner.schema([
        { source: sqliteSource('l1', '家計.sqlite'), readBytes: asFile(img) },
        { source: sqliteSource('l2', '在庫.csv'), readBytes: csvBytes(csv) },
      ]);
      const m = schemaModel({ source: 'x', columns: got.columns, fks: got.fks, counts: got.counts! });
      expect(m.tables.map((t) => t.name).sort()).toEqual(
        ['在庫', '家計_売上', '家計_客', '家計_明細', '家計_空'].sort(),
      );
      // 🔴 線の両端は、図に出ている四角の名前と同じ(元の名前のままだと、箱の無い線になる)
      expect(m.links).toEqual([
        { from: '家計_売上', fromColumn: '客id', to: '家計_客', toColumn: 'id' },
        { from: '家計_明細', fromColumn: '売上id', to: '家計_売上', toColumn: 'id' },
      ]);
      const names = new Set(m.tables.map((t) => t.name));
      for (const l of m.links) {
        expect(names.has(l.from) && names.has(l.to), `箱の無い線: ${l.from} → ${l.to}`).toBe(true);
      }
      expect(m.tables.find((t) => t.name === '在庫')?.rows).toBe(2);
    } finally {
      await runner.release();
    }
  }, 60_000);

  it('🔴 器へ user が作った表の主キー / 外部キー / ビューも、duckdb_constraints() から採れる', async () => {
    const sources = [{ source: sqliteSource('l1', '在庫.csv'), readBytes: csvBytes('id\n1\n') }];
    const runner = makeRunner();
    try {
      await runner.run({ sql: 'CREATE TABLE p (id BIGINT PRIMARY KEY, n VARCHAR NOT NULL)', sources });
      await runner.run({ sql: 'CREATE TABLE c (pid BIGINT, FOREIGN KEY (pid) REFERENCES p(id))', sources });
      await runner.run({ sql: 'CREATE VIEW v AS SELECT * FROM p', sources });
      const got = await runner.schema(sources);
      const m = schemaModel({ source: 'x', columns: got.columns, fks: got.fks, counts: got.counts! });
      expect(m.links).toEqual([{ from: 'c', fromColumn: 'pid', to: 'p', toColumn: 'id' }]);
      const p = m.tables.find((t) => t.name === 'p');
      expect(p?.columns.map((c) => [c.name, c.primaryKey, c.notNull])).toEqual([
        ['id', true, true],
        ['n', false, true],
      ]);
      const v = m.tables.find((t) => t.name === 'v');
      expect(v?.kind, 'ビューが表として出ている').toBe('view');
      expect(v?.rows, 'ビューを数えている(その場でビューが走る)').toBeNull();
    } finally {
      await runner.release();
    }
  }, 60_000);

  it('🔴 写せなかった表は図に出さず、その表を指す線も出さない(箱の無い線を作らない)', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE 大 (id INTEGER PRIMARY KEY, t TEXT)');
      run(db, 'BEGIN');
      for (let i = 0; i < 200; i += 1) run(db, 'INSERT INTO 大 VALUES (?, ?)', [i, 'x'.repeat(200)]);
      run(db, 'COMMIT');
      run(db, 'CREATE TABLE 小 (id INTEGER, 大id INTEGER REFERENCES 大(id))');
      run(db, 'INSERT INTO 小 VALUES (1, 1)');
    });
    const runner = makeRunner(4096);
    try {
      const got = await runner.schema([{ source: sqliteSource('l1', 'x.sqlite'), readBytes: asFile(img) }]);
      const m = schemaModel({ source: 'x', columns: got.columns, fks: got.fks });
      expect(m.tables.map((t) => t.name), '断った表が出ている').toEqual(['小']);
      expect(m.links, '箱の無い線が出ている').toEqual([]);
    } finally {
      await runner.release();
    }
  }, 60_000);

  it('🔴 構造を採った後の SQL は器を作り直さない / 同時に飛んでも二重に差し込まない', async () => {
    const img = await richImage();
    const runner = makeRunner();
    const sources = [{ source: sqliteSource('l1', '家計.sqlite'), readBytes: asFile(img) }];
    try {
      exportCalls = 0;
      // 図を開いた直後に SQL を走らせる(同時)── 器へ触る仕事は 1 本ずつ通る
      const [got, ran] = await Promise.all([
        runner.schema(sources),
        runner.run({ sql: 'SELECT count(*) FROM 客', sources }),
      ]);
      expect(got.columns.rows.length).toBeGreaterThan(0);
      expect(ran.rows).toEqual([[2]]);
      expect(exportCalls, '同じ相手の組なのに差し込み直している').toBe(1);
      await runner.schema(sources);
      await runner.run({ sql: 'SELECT 1', sources });
      expect(exportCalls, '2 回目以降も差し込み直している').toBe(1);
    } finally {
      await runner.release();
    }
  }, 60_000);
});
