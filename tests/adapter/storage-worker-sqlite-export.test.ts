/**
 * 🔴 **storage worker の `exportSqliteForDuckDb`**(#682 段④d)。
 *
 * `self` / `postMessage` を差してから**実物の storage-worker**を dynamic import する
 * (`storage-worker.test.ts` と同じ作法)。客の `.sqlite` は **sqlite-wasm で自作**する ──
 * 手で組んだ bytes は本物ではないので、「読めた / 読めない」が本物と食い違う。
 *
 * ⚠ ここが見るのは「worker が**何を返すか**」(列 / 行の JSON / BLOB / 天井 / 後始末 / transfer)。
 *   返った NDJSON を **DuckDB が実際に読めるか**は `tests/duckdb-sqlite-ndjson.test.ts` が見る。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';

type Op = StorageRequest['op'];

const pending = new Map<number, (resp: StorageResponse) => void>();
/** `postMessage` の第 2 引数(transfer の一覧)を、id ごとに控える。 */
const transfers = new Map<number, unknown>();
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

/** 最後に返った応答の transfer の一覧(`request` を呼ぶ前の `seq` から辿る)。 */
const transferOf = (id: number): readonly ArrayBuffer[] => {
  const t = transfers.get(id) as { transfer?: ArrayBuffer[] } | undefined;
  return t?.transfer ?? [];
};

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (
    msg: StorageResponse,
    options?: unknown,
  ) => {
    transfers.set(msg.id, options);
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: 'unit-test' });
  expect(init.vfs).toBe('memory');
}, 30_000);

afterAll(async () => {
  await request({ op: 'close' });
});

type Db = { exec: (a: unknown) => unknown; pointer: unknown; close: () => void };

/** 客の `.sqlite` の画像を、sqlite-wasm で作る。 */
async function image(setup: (db: Db) => void): Promise<Uint8Array> {
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(':memory:') as unknown as Db;
  try {
    setup(db);
    const capi = sqlite3.capi as unknown as {
      sqlite3_js_db_export: (p: unknown) => Uint8Array;
    };
    return capi.sqlite3_js_db_export(db.pointer);
  } finally {
    db.close();
  }
}

const run = (db: Db, sql: string, bind: unknown[] = []): void => {
  db.exec({ sql, bind });
};

const MAX = 1024 * 1024;
const exportOf = (img: Uint8Array, maxTableBytes = MAX) =>
  request({ op: 'exportSqliteForDuckDb', image: img, maxTableBytes });

/** NDJSON の bytes → 行ごとの object。 */
const rowsOf = (u: Uint8Array | null): Array<Record<string, unknown>> =>
  u === null
    ? []
    : new TextDecoder()
        .decode(u)
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('🔴 表の一覧・列・行', () => {
  it('🔴 表ごとに「列(名前と宣言の型)」と「行の NDJSON」を返す(名前順)', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE 売上 (id INTEGER, 品名 TEXT, 単価 REAL, 備考)');
      run(db, "INSERT INTO 売上 VALUES (1, 'りんご', 1.5, NULL)");
      run(db, "INSERT INTO 売上 VALUES (2, 'x\"y' || char(10) || 'z', 2, 'あ')");
      run(db, 'CREATE TABLE a表 (n INT)');
      run(db, 'INSERT INTO a表 VALUES (7)');
    });
    const r = await exportOf(img);
    expect(r.tables.map((t) => t.name)).toEqual(['a表', '売上']);
    const t = r.tables[1]!;
    expect(t.columns).toEqual([
      { name: 'id', type: 'INTEGER' },
      { name: '品名', type: 'TEXT' },
      { name: '単価', type: 'REAL' },
      // 🔑 型の無い列は空の字(`duckDbColumnTypeOf` が VARCHAR へ写す)
      { name: '備考', type: '' },
    ]);
    expect(t.rows).toBe(2);
    expect(t.refused).toBeNull();
    expect(rowsOf(t.ndjson)).toEqual([
      { id: 1, 品名: 'りんご', 単価: 1.5, 備考: null },
      { id: 2, 品名: 'x"y\nz', 単価: 2, 備考: 'あ' },
    ]);
  });

  it('🔴 BLOB は base64 の字で入る(NULL にして黙って捨てない)', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE b (k INTEGER, data BLOB)');
      run(db, 'INSERT INTO b VALUES (1, x\'000102\')');
      run(db, 'INSERT INTO b VALUES (2, NULL)');
    });
    const r = await exportOf(img);
    expect(rowsOf(r.tables[0]!.ndjson)).toEqual([
      { k: 1, data: 'AAEC' },
      { k: 2, data: null },
    ]);
  });

  it('🔴 2^53 を超える整数も桁が変わらない', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE big (n INTEGER)');
      run(db, 'INSERT INTO big VALUES (9007199254740993)');
    });
    const r = await exportOf(img);
    const text = new TextDecoder().decode(r.tables[0]!.ndjson!);
    expect(text, 'Number へ丸めて桁が変わった').toContain('"n":9007199254740993');
  });

  it('🔴 空の表は列が残り、行は 0 件(file にならない)', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE 空 (a INTEGER, b TEXT)');
    });
    const t = (await exportOf(img)).tables[0]!;
    expect(t.name).toBe('空');
    expect(t.columns).toEqual([
      { name: 'a', type: 'INTEGER' },
      { name: 'b', type: 'TEXT' },
    ]);
    expect(t.rows).toBe(0);
    expect(t.ndjson).toBeNull();
    // 🔑 空は「写せている」(断ってはいない)── `refused` は null のまま
    expect(t.refused).toBeNull();
  });

  it('生成列は出る(`SELECT *` に出る物)', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE g (a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2) VIRTUAL)');
      run(db, 'INSERT INTO g (a) VALUES (21)');
    });
    const t = (await exportOf(img)).tables[0]!;
    expect(t.columns.map((c) => c.name)).toEqual(['a', 'b']);
    expect(rowsOf(t.ndjson)).toEqual([{ a: 21, b: 42 }]);
  });

  it('内部の表(sqlite_ で始まる)と view は出さない', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE seq (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
      run(db, "INSERT INTO seq (v) VALUES ('x')");
      run(db, 'CREATE VIEW v1 AS SELECT * FROM seq');
    });
    const names = (await exportOf(img)).tables.map((t) => t.name);
    // ⚠ AUTOINCREMENT は `sqlite_sequence` という内部の表を作る(対照群として必ず在る)
    expect(names).toEqual(['seq']);
  });

  it('🔴 名前に二重引用符や空白が在る表・列も読める', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE "we""ird name" ("a b" INTEGER, "c""d" TEXT)');
      run(db, "INSERT INTO \"we\"\"ird name\" VALUES (1, 'x')");
    });
    const t = (await exportOf(img)).tables[0]!;
    expect(t.name).toBe('we"ird name');
    expect(rowsOf(t.ndjson)).toEqual([{ 'a b': 1, 'c"d': 'x' }]);
  });
});

describe('🔴 天井 ── 超えた表だけ断る', () => {
  it('🔴 大きい表だけ `refused`、ほかの表は写せている', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE big (t TEXT)');
      for (let i = 0; i < 100; i += 1) run(db, 'INSERT INTO big VALUES (?)', ['x'.repeat(200)]);
      run(db, 'CREATE TABLE small (n INTEGER)');
      run(db, 'INSERT INTO small VALUES (1)');
    });
    // 天井 2KB:big は 100 × 200 字で超える / small は 8 bytes で収まる
    const r = await exportOf(img, 2048);
    const big = r.tables.find((t) => t.name === 'big')!;
    const small = r.tables.find((t) => t.name === 'small')!;
    expect(big.refused, '天井を超えた表を断っていない').toContain('2.0 KB');
    expect(big.refused).toContain('内蔵の sqlite');
    expect(big.ndjson, '断った表の bytes を返している').toBeNull();
    // 🔑 列は返す(呼び側が「どの表を断ったか」を名前で言える)
    expect(big.columns).toEqual([{ name: 't', type: 'TEXT' }]);
    expect(small.refused).toBeNull();
    expect(rowsOf(small.ndjson)).toEqual([{ n: 1 }]);
  });

  it('🔴 天井ちょうどは通り、1 バイト足りなければ断る(境界)', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE t (n INTEGER)');
      run(db, 'INSERT INTO t VALUES (1)');
    });
    // `{"n":1}` + 改行 = 8 bytes
    expect((await exportOf(img, 8)).tables[0]!.refused).toBeNull();
    expect((await exportOf(img, 7)).tables[0]!.refused).not.toBeNull();
  });
});

describe('🔴 後始末と取り違え', () => {
  it('🔴 でたらめな bytes は、DB として読めないと言って断る(表の一覧を空で返さない)', async () => {
    const junk = new Uint8Array(4096).fill(7);
    await expect(exportOf(junk)).rejects.toThrow(/DB として読めませんでした/);
  });

  it('🔴 窓の客(guestDbs)には入らない ── 開いてある客を押し出さず、客として残らない', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE t (n INTEGER)');
      run(db, 'INSERT INTO t VALUES (1)');
    });
    // 客を上限(4)まで開く ── 写しを取るたびに押し出す実装だと、先頭の客が消える
    for (const w of ['w1', 'w2', 'w3', 'w4']) {
      await request({ op: 'openSqlGuest', image: img, guest: w });
    }
    await exportOf(img);
    await exportOf(img);
    const ask = (guest: string) =>
      request({
        op: 'runReadOnlySql',
        sql: 'SELECT count(*) FROM t',
        maxRows: 10,
        maxSteps: 1_000_000,
        maxMs: 60_000,
        guest,
      });
    for (const w of ['w1', 'w2', 'w3', 'w4']) {
      await expect(ask(w), `${w} の客が押し出された`).resolves.toBeDefined();
    }
    for (const w of ['w1', 'w2', 'w3', 'w4']) await request({ op: 'closeSqlGuest', guest: w });
  });

  it('🔴 うちの DB(ノート)には触らない ── 同じ名前の表が在っても取り違えない', async () => {
    const own = () =>
      request({
        op: 'runReadOnlySql',
        sql: 'SELECT count(*) FROM entries',
        maxRows: 10,
        maxSteps: 1_000_000,
        maxMs: 60_000,
      });
    const before = await own();
    const img = await image((db) => {
      run(db, 'CREATE TABLE entries (lid TEXT)');
      run(db, "INSERT INTO entries VALUES ('x')");
    });
    const r = await exportOf(img);
    // 客の `entries` を読んだのであって、うちの `entries` ではない
    expect(rowsOf(r.tables[0]!.ndjson)).toEqual([{ lid: 'x' }]);
    expect((await own()).rows).toEqual(before.rows);
  });
});

describe('🔴 応答の bytes は transfer で渡る(ゼロコピー)', () => {
  it('行の在る表の buffer が、transfer の一覧に入っている(空・断った表は入らない)', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE a (n INTEGER)');
      run(db, 'INSERT INTO a VALUES (1)');
      run(db, 'CREATE TABLE b (n INTEGER)');
      run(db, 'INSERT INTO b VALUES (2)');
      run(db, 'CREATE TABLE c (n INTEGER)');
    });
    const before = seq;
    const r = await exportOf(img);
    const list = transferOf(before + 1);
    const withBytes = r.tables.filter((t) => t.ndjson !== null);
    expect(withBytes).toHaveLength(2);
    expect(list, 'transfer の一覧が空 ── bytes を複製して運んでいる').toHaveLength(2);
    for (const t of withBytes) {
      expect(list, `${t.name} の buffer が transfer に無い`).toContain(t.ndjson!.buffer);
    }
  });

  it('⚠ 対照群 ── 別の op は transfer を使わない(影響を広げない)', async () => {
    const before = seq;
    await request({ op: 'listContainerIds' });
    expect(transferOf(before + 1)).toEqual([]);
  });
});
