/**
 * 🔴 **storage worker の `.sqlite` の写し(`openSqliteExport` / `exportSqliteTable` / `closeSqliteExport`)**(#682 段④d)。
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
/**
 * 🔴 **開く → 表を 1 つずつ頼む → 閉じる**(`DuckDbRunner` と同じ順)。⚠ 落ちた回も閉じる。
 * 戻りは「表ごとの写し」の一覧(名前順)── 1 回で全部返していた頃の形に揃えてある。
 */
const exportOf = async (img: Uint8Array, maxTableBytes = MAX) => {
  const opened = await request({ op: 'openSqliteExport', image: img });
  try {
    const tables = [];
    for (const table of opened.tables) {
      tables.push(
        await request({ op: 'exportSqliteTable', session: opened.session, table, maxTableBytes }),
      );
    }
    return { tables, views: opened.views, ftsTables: opened.ftsTables };
  } finally {
    await request({ op: 'closeSqliteExport', session: opened.session });
  }
};

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
      { name: 'id', type: 'INTEGER', notNull: false, primaryKey: false },
      { name: '品名', type: 'TEXT', notNull: false, primaryKey: false },
      { name: '単価', type: 'REAL', notNull: false, primaryKey: false },
      // 🔑 型の無い列は空の字(`duckDbColumnTypeOf` が VARCHAR へ写す)
      { name: '備考', type: '', notNull: false, primaryKey: false },
    ]);
    expect(t.rows).toBe(2);
    expect(t.refused).toBeNull();
    expect(rowsOf(t.ndjson)).toEqual([
      { id: 1, 品名: 'りんご', 単価: 1.5, 備考: null },
      { id: 2, 品名: 'x"y\nz', 単価: 2, 備考: 'あ' },
    ]);
  });

  /**
   * 🔴 **主キー・空を許さない印・外部キーを、宣言のまま運ぶ**(#918)。
   * ⚠ 器の表は型を 3 つへ潰し、主キーも外部キーも作らない ── 構造(つながり図)を採るとき、
   *   ここで運んだ物を重ねる。落とすと DuckDB の道だけ「主キーが無い / 線が 0 本」になる。
   */
  it('🔴 主キー(複合も)・NOT NULL・外部キー(列ごと)・相手の列を省いた書き方も運ぶ', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE 親 (id INTEGER PRIMARY KEY, 名 TEXT NOT NULL)');
      run(db, 'CREATE TABLE 別 (k TEXT PRIMARY KEY)');
      run(
        db,
        'CREATE TABLE 子 (a INTEGER, b INTEGER, 親id INTEGER REFERENCES 親, c TEXT, ' +
          'PRIMARY KEY (a, b), FOREIGN KEY (a, b) REFERENCES 親(id, 名), FOREIGN KEY (c) REFERENCES 別(k))',
      );
    });
    const r = await exportOf(img);
    const t = Object.fromEntries(r.tables.map((x) => [x.name, x]));
    expect(t['親']!.columns.map((c) => [c.name, c.primaryKey, c.notNull])).toEqual([
      ['id', true, false],
      ['名', false, true],
    ]);
    expect(
      t['子']!.columns.filter((c) => c.primaryKey).map((c) => c.name),
      '複合の主キーが片方しか運ばれていない',
    ).toEqual(['a', 'b']);
    expect(t['親']!.fks, '外部キーの無い表に線がある').toEqual([]);
    // 🔑 `PRAGMA foreign_key_list` の並び(id → seq 順。⚠ id は宣言順とは限らない)のまま ──
    //   内蔵の sqlite の道(`SCHEMA_FK_SQL` の `order by f.id, f.seq`)と同じ並び。相手の列を省いた書き方は空の字
    expect(t['子']!.fks).toEqual([
      { fromColumn: 'c', toTable: '別', toColumn: 'k' },
      { fromColumn: 'a', toTable: '親', toColumn: 'id' },
      { fromColumn: 'b', toTable: '親', toColumn: '名' },
      { fromColumn: '親id', toTable: '親', toColumn: '' },
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
      { name: 'a', type: 'INTEGER', notNull: false, primaryKey: false },
      { name: 'b', type: 'TEXT', notNull: false, primaryKey: false },
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

  /**
   * 🔴 **STORED の生成列も出る**(`table_xinfo` の `hidden = 3`。VIRTUAL は 2)。
   * ⚠ 上の test は VIRTUAL だけで、`hidden === 3` を外す変異が SURVIVED だった ──
   *   STORED が抜けると**列も値も黙って消える**(`SELECT *` には出ているのに写しだけ欠ける)。
   */
  it('🔴 STORED の生成列も、列と値の両方が出る', async () => {
    const img = await image((db) => {
      run(
        db,
        'CREATE TABLE s (a INTEGER, v INTEGER GENERATED ALWAYS AS (a + 1) VIRTUAL, st INTEGER GENERATED ALWAYS AS (a * 10) STORED)',
      );
      run(db, 'INSERT INTO s (a) VALUES (4), (5)');
    });
    const t = (await exportOf(img)).tables[0]!;
    expect(t.columns.map((c) => c.name)).toEqual(['a', 'v', 'st']);
    expect(rowsOf(t.ndjson)).toEqual([
      { a: 4, v: 5, st: 40 },
      { a: 5, v: 6, st: 50 },
    ]);
  });

  it('内部の表(sqlite_ で始まる)と view は表としては出さない(view は名前だけ `views` で返す)', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE seq (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
      run(db, "INSERT INTO seq (v) VALUES ('x')");
      run(db, 'CREATE VIEW v1 AS SELECT * FROM seq');
    });
    const got = await exportOf(img);
    const names = got.tables.map((t) => t.name);
    // ⚠ AUTOINCREMENT は `sqlite_sequence` という内部の表を作る(対照群として必ず在る)
    expect(names).toEqual(['seq']);
    // 🔴 view は写さない ── ただし**写さなかったと言える**よう、名前だけ返す(直す前は、在ることすらどこにも出なかった)
    expect(got.views, 'view の名前が返っていない').toEqual(['v1']);
  });

  it('🔴 view の名前は名前順 / view が無い DB では空 / `sqlite_` で始まる view は返さない', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE t (n INTEGER)');
      run(db, 'CREATE VIEW b_view AS SELECT * FROM t');
      run(db, 'CREATE VIEW a_view AS SELECT * FROM t');
      run(db, 'CREATE VIEW sqlitedata_view AS SELECT * FROM t');
    });
    expect((await exportOf(img)).views).toEqual(['a_view', 'b_view', 'sqlitedata_view']);
    const none = await image((db) => run(db, 'CREATE TABLE t (n INTEGER)'));
    expect((await exportOf(none)).views, 'view が無いのに返している').toEqual([]);
  });

  /**
   * 🔴 **本文検索(FTS5)の仮想表と影の表は写さない**(#682 段④d の着地後レビュー R6)。
   * ⚠ 構造を採る側(`SCHEMA_COLUMNS_SQL`)は #967 で外しているのに、写す側は判定を持たず、`_data` / `_idx` /
   *   `_docsize` / `_config` / `_content` が**全部 DuckDB へ写って user の表と並んだ**。判定は `NOT_FTS_BACKSTAGE` 1 本。
   */
  it('🔴 FTS5 の仮想表と影の表(_data / _idx / _docsize / _config / _content)は写さない。user の表は残る', async () => {
    const img = await image((db) => {
      run(db, 'CREATE VIRTUAL TABLE docs USING fts5(title, body)');
      run(db, "INSERT INTO docs VALUES ('あ', 'い')");
      run(db, 'CREATE TABLE notes (id INTEGER PRIMARY KEY, t TEXT)');
      // 対照群:名前が影の接尾辞で終わるだけの user の表は、仮想表の影ではない ── 巻き込まない
      run(db, 'CREATE TABLE sales_data (n INTEGER)');
      run(db, 'CREATE TABLE docs_extra (n INTEGER)');
    });
    const got = await exportOf(img);
    const names = got.tables.map((t) => t.name);
    // ⚠ 前提:影の表が本当に在る(無いと「外れている」が空振りで緑になる)
    const sqlite3 = await sqlite3InitModule();
    const probe = new sqlite3.oo1.DB(':memory:') as unknown as Db;
    try {
      run(probe, 'CREATE VIRTUAL TABLE docs USING fts5(title, body)');
      const shadow: string[] = [];
      (probe as unknown as { exec: (a: unknown) => void }).exec({
        sql: "SELECT name FROM sqlite_master WHERE name LIKE 'docs\\_%' ESCAPE '\\' ORDER BY name",
        rowMode: 'array',
        callback: (r: unknown[]) => shadow.push(String(r[0])),
      });
      expect(shadow.length, '前提が崩れている(影の表が無い)').toBeGreaterThanOrEqual(4);
    } finally {
      probe.close();
    }
    expect(names, 'FTS の裏方が写っている').toEqual(['docs_extra', 'notes', 'sales_data']);
    // 影の表の名前を 1 つずつ(どれか 1 つの除外が漏れても気づく)
    for (const suffix of ['', '_data', '_idx', '_docsize', '_config', '_content']) {
      expect(names, `docs${suffix} が写っている`).not.toContain(`docs${suffix}`);
    }
  });

  /**
   * 🔴 **案内に並ぶ名前(客を開く口)と、写した表の名前(写す口)が食い違わない**(着地後レビュー ⚠2 / 💭8)。
   * ⚠ 直す前は、客を開く口が FTS5 の**影の表**(`docs_data` / `docs_idx` …)まで並べ、書いてあるとおり
   *   DuckDB で打つと `no such table` だった。⚠ 仮想表**本体**(`docs`)は内蔵の sqlite なら引けるので、客の口には残り、
   *   写す口は写さずに `ftsTables` で**写さなかったと言う**。
   * 🔑 見るのは**両方の口を本物の sqlite で通した結果の関係**:客の口の名前 = 写した表 + 写さなかった仮想表。
   */
  it('🔴 客を開く口の表の名前 = 写した表 + 写さなかった全文検索の表(影の表はどちらにも出ない)', async () => {
    const img = await image((db) => {
      run(db, 'CREATE VIRTUAL TABLE docs USING fts5(title, body)');
      run(db, "INSERT INTO docs VALUES ('あ', 'い')");
      run(db, 'CREATE TABLE notes (id INTEGER PRIMARY KEY, t TEXT)');
      run(db, 'CREATE TABLE sales_data (n INTEGER)');
    });
    const guest = await request({ op: 'openSqlGuest', image: img, guest: 'w-fts-names' });
    try {
      const got = await exportOf(img);
      const copied = got.tables.map((t) => t.name);
      expect(got.ftsTables, '写さなかった全文検索の表を言っていない').toEqual(['docs']);
      expect([...copied, ...got.ftsTables].sort(), '案内の名前と、写した表 + 写さなかった表が食い違っている').toEqual(
        [...guest.tables].sort(),
      );
      // 内蔵の sqlite で引ける仮想表本体は、案内に残る(消すと、引ける表が案内から消える)
      expect(guest.tables, '内蔵の sqlite で引ける仮想表本体が案内から消えている').toContain('docs');
      for (const shadow of ['docs_data', 'docs_idx', 'docs_docsize', 'docs_config', 'docs_content']) {
        expect(guest.tables, `影の表 ${shadow} が案内に並んでいる`).not.toContain(shadow);
      }
      // 対照群:名前が接尾辞で終わるだけの user の表は、案内にも写しにも残る
      expect(guest.tables).toContain('sales_data');
      expect(copied).toContain('sales_data');
    } finally {
      await request({ op: 'closeSqlGuest', guest: 'w-fts-names' });
    }
  });

  it('対照群:全文検索の表が無い file は ftsTables が空 / 客の口と写した表が同じ集合', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE a (n INTEGER)');
      run(db, 'CREATE TABLE b (n INTEGER)');
    });
    const guest = await request({ op: 'openSqlGuest', image: img, guest: 'w-fts-none' });
    try {
      const got = await exportOf(img);
      expect(got.ftsTables).toEqual([]);
      expect(got.tables.map((t) => t.name)).toEqual(guest.tables);
    } finally {
      await request({ op: 'closeSqlGuest', guest: 'w-fts-none' });
    }
  });

  /**
   * 🔴 **`sqlite_` で始まらない名前を、内部の表と取り違えない**。`LIKE` の `_` は任意の 1 字なので、
   *   `NOT LIKE 'sqlite_%'` は `sqlitedata` / `sqlite1` のような **user の表を黙って外していた**
   *   (引くと「そんな表は無い」としか出ない)。
   */
  it('🔴 `sqlitedata` のような user の表は出る / `sqlite_sequence` は出ない(`_` は任意の 1 字ではない)', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE sqlitedata (n INTEGER)');
      run(db, 'INSERT INTO sqlitedata VALUES (1)');
      run(db, 'CREATE TABLE sqlite1 (n INTEGER)');
      run(db, 'CREATE TABLE seq (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
      run(db, "INSERT INTO seq (v) VALUES ('x')");
    });
    const names = (await exportOf(img)).tables.map((t) => t.name);
    expect(names, 'sqlitedata / sqlite1 が黙って外れた').toEqual(['seq', 'sqlite1', 'sqlitedata']);
    expect(names).not.toContain('sqlite_sequence');
    // 客を開く口(`openSqlGuest`)も同じ文 ── 片方だけ直すと、写しと客で表の一覧が食い違う
    const opened = await request({ op: 'openSqlGuest', image: img, guest: 'esc' });
    try {
      expect(opened.tables).toEqual(['seq', 'sqlite1', 'sqlitedata']);
    } finally {
      await request({ op: 'closeSqlGuest', guest: 'esc' });
    }
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

describe('🔴 型へ写すと値が黙って変わる表は、最初から全列 VARCHAR にする旗(asText)', () => {
  /**
   * ⚠ DuckDB は INTEGER 親和性の列の小数を BIGINT へ**丸めて**入れ(19.99 → 20)、DOUBLE へ `Infinity` を
   *   **NULL** で入れる。**落ちない**ので既存の「型が合わなければ作り直す」では救えない ── 読む側(worker)が
   *   旗を立てる。`tests/duckdb-sqlite-ndjson.test.ts` が実物の DuckDB で「値が変わらない」まで見る。
   */
  it('🔴 INTEGER の列に小数が在れば旗が立つ(sqlite の INTEGER 親和性は小数を REAL のまま保つ)', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE price (name TEXT, p INTEGER)');
      run(db, "INSERT INTO price VALUES ('a', 3), ('b', 19.99)");
      run(db, 'CREATE TABLE plain (p INTEGER)');
      run(db, 'INSERT INTO plain VALUES (1), (2)');
    });
    const { tables } = await exportOf(img);
    expect(tables.find((t) => t.name === 'price')!.asText).toBe(true);
    // 対照群:整数だけの表は旗が立たない(型どおり BIGINT で写す)
    expect(tables.find((t) => t.name === 'plain')!.asText).toBe(false);
  });

  it('🔴 REAL の列の Infinity / NUMERIC の列の 2^53 超の整数でも旗が立つ。ふつうの小数・整数では立たない', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE inf (x REAL)');
      run(db, 'INSERT INTO inf VALUES (1.5), (9e999)');
      run(db, 'CREATE TABLE big (x NUMERIC)');
      run(db, 'INSERT INTO big VALUES (9007199254740993)');
      run(db, 'CREATE TABLE ok (x REAL, n NUMERIC)');
      run(db, 'INSERT INTO ok VALUES (1.5, 2), (2, 3.25)');
    });
    const { tables } = await exportOf(img);
    const flag = (n: string) => tables.find((t) => t.name === n)!.asText;
    expect(flag('inf'), 'Infinity が DuckDB で NULL になる').toBe(true);
    expect(flag('big'), '2^53 超の整数が倍精度へ丸まる').toBe(true);
    expect(flag('ok')).toBe(false);
  });

  it('🔴 旗が立っても、行の写しは今までどおり(値は字のまま運ぶ)/ 断った表・空の表には旗が立たない', async () => {
    const img = await image((db) => {
      run(db, 'CREATE TABLE price (p INTEGER)');
      run(db, 'INSERT INTO price VALUES (19.99), (3)');
      run(db, 'CREATE TABLE empty (p INTEGER)');
    });
    const { tables } = await exportOf(img);
    const price = tables.find((t) => t.name === 'price')!;
    expect(rowsOf(price.ndjson)).toEqual([{ p: 19.99 }, { p: 3 }]);
    expect(tables.find((t) => t.name === 'empty')!.asText).toBe(false);
    // 天井で断った表は、読むのを途中でやめるので旗は意味を持たない(false で返す)
    const refusedOne = (await exportOf(img, 4)).tables.find((t) => t.name === 'price')!;
    expect(refusedOne.refused).not.toBeNull();
    expect(refusedOne.asText).toBe(false);
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
    // 🔴 file の大きさではなく「写した行」の大きさだと言う(file が小さくても出るので、誤読させない)
    expect(big.refused).toContain('写した行が');
    expect(big.refused).toContain('元の file より大きくなる');
    expect(big.ndjson, '断った表の bytes を返している').toBeNull();
    // 🔑 列は返す(呼び側が「どの表を断ったか」を名前で言える)
    expect(big.columns).toEqual([{ name: 't', type: 'TEXT', notNull: false, primaryKey: false }]);
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
    const opened = await request({ op: 'openSqliteExport', image: img });
    try {
      const got: Array<{ name: string; bytes: Uint8Array | null; list: readonly ArrayBuffer[] }> = [];
      for (const table of opened.tables) {
        const before = seq;
        const t = await request({ op: 'exportSqliteTable', session: opened.session, table, maxTableBytes: MAX });
        got.push({ name: t.name, bytes: t.ndjson, list: transferOf(before + 1) });
      }
      const withBytes = got.filter((g) => g.bytes !== null);
      expect(withBytes).toHaveLength(2);
      for (const g of withBytes) {
        expect(g.list, `${g.name}: transfer の一覧が空 ── bytes を複製して運んでいる`).toHaveLength(1);
        expect(g.list, `${g.name} の buffer が transfer に無い`).toContain(g.bytes!.buffer);
      }
      // 空の表は運ぶ物が無い
      expect(got.find((g) => g.name === 'c')!.list).toEqual([]);
    } finally {
      await request({ op: 'closeSqliteExport', session: opened.session });
    }
  });

  it('⚠ 対照群 ── 別の op は transfer を使わない(影響を広げない)', async () => {
    const before = seq;
    await request({ op: 'listContainerIds' });
    expect(transferOf(before + 1)).toEqual([]);
  });
});

describe('🔴 開いた写しの寿命(表ごとに頼むので、開いたまま待つ)', () => {
  const tiny = () =>
    image((db) => {
      run(db, 'CREATE TABLE t (n INTEGER)');
      run(db, 'INSERT INTO t VALUES (1)');
    });

  it('🔴 閉じた後は頼めない(別の file の表を黙って返さない)/ 二度閉じても落ちない', async () => {
    const opened = await request({ op: 'openSqliteExport', image: await tiny() });
    expect(opened.tables).toEqual(['t']);
    await request({ op: 'closeSqliteExport', session: opened.session });
    await expect(
      request({ op: 'exportSqliteTable', session: opened.session, table: 't', maxTableBytes: MAX }),
    ).rejects.toThrow(/写しが開かれていません/);
    await expect(request({ op: 'closeSqliteExport', session: opened.session })).resolves.toBeNull();
    // 知らない合言葉も同じ
    await expect(
      request({ op: 'exportSqliteTable', session: 'nope', table: 't', maxTableBytes: MAX }),
    ).rejects.toThrow(/写しが開かれていません/);
  });

  it('🔴 2 つ開いても取り違えない(それぞれ自分の file の表を返す)', async () => {
    const a = await request({ op: 'openSqliteExport', image: await image((db) => run(db, 'CREATE TABLE ta (n INTEGER)')) });
    const b = await request({ op: 'openSqliteExport', image: await image((db) => run(db, 'CREATE TABLE tb (n INTEGER)')) });
    try {
      expect(a.tables).toEqual(['ta']);
      expect(b.tables).toEqual(['tb']);
      // 他方の表は引けない(同じ名前の別の file を引く取り違えの対照)
      const t = await request({ op: 'exportSqliteTable', session: a.session, table: 'tb', maxTableBytes: MAX });
      expect(t.refused, 'a の写しから b の表を読めてしまった').not.toBeNull();
    } finally {
      await request({ op: 'closeSqliteExport', session: a.session });
      await request({ op: 'closeSqliteExport', session: b.session });
    }
  });

  it('🔴 読めなかった file は、写しの枠を使わない(開けなかった器を残さない)', async () => {
    const live = await request({ op: 'openSqliteExport', image: await tiny() });
    try {
      // 上限(8)を超える回数、でたらめな bytes で断られる ── 器が残るなら、live が押し出される
      for (let i = 0; i < 12; i += 1) {
        await expect(
          request({ op: 'openSqliteExport', image: new Uint8Array(4096).fill(7) }),
        ).rejects.toThrow(/DB として読めませんでした/);
      }
      const t = await request({ op: 'exportSqliteTable', session: live.session, table: 't', maxTableBytes: MAX });
      expect(t.refused, '断られた回の器が枠を食って、先に開いた写しが押し出された').toBeNull();
    } finally {
      await request({ op: 'closeSqliteExport', session: live.session });
    }
  });

  it('🔴 閉じ忘れても溜まり続けない ── 上限を超えたら古い物から畳む(畳まれた物には断る)', async () => {
    const img = await tiny();
    const sessions: string[] = [];
    for (let i = 0; i < 9; i += 1) sessions.push((await request({ op: 'openSqliteExport', image: img })).session);
    try {
      await expect(
        request({ op: 'exportSqliteTable', session: sessions[0]!, table: 't', maxTableBytes: MAX }),
      ).rejects.toThrow(/写しが開かれていません/);
      const last = await request({ op: 'exportSqliteTable', session: sessions[8]!, table: 't', maxTableBytes: MAX });
      expect(last.refused).toBeNull();
    } finally {
      for (const s of sessions) await request({ op: 'closeSqliteExport', session: s });
    }
  });
});

/**
 * 🔴 **大きい表を写している間も、この worker の他の依頼が待たされない**(着地後の測定)。
 *
 * 実測(2026-10-03、100k 行 = 30.7MB の表):読み切るまで **約 0.75〜0.8 秒**、その間に投げた別の依頼
 * (`listContainerIds`)は **同じだけ待たされた**。写しを取る間は DB の錠を握る worker が 1 本の同期の処理で
 * 塞がるので、ノートの保存・検索が全部待つ ── 区切って譲るようにしたら、別の依頼は **約 27 ms** で返った
 * (写しそのものは約 1〜2 割遅い)。
 * 🔑 見るのは時間ではなく**順番**(時間は環境で動く):写しを頼んだ**後**に投げた軽い依頼が、
 * 写しの**前**に返ること。譲らない実装(`exec` の callback で一気に読む)では、必ず写しが先に返る。
 */
describe('🔴 大きい表の途中でも、他の依頼に順番を譲る', () => {
  const bigImage = () =>
    image((db) => {
      run(db, 'CREATE TABLE big (id INTEGER, body TEXT)');
      run(db, 'BEGIN');
      const body = 'abcdefghij'.repeat(25);
      for (let i = 0; i < 30_000; i += 1) run(db, 'INSERT INTO big VALUES (?, ?)', [i, body]);
      run(db, 'COMMIT');
    });

  it('🔴 写しを頼んだ後に投げた別の依頼が、写しより先に返る(写しの結果は欠けない)', async () => {
    const img = await bigImage();
    const opened = await request({ op: 'openSqliteExport', image: img });
    try {
      const order: string[] = [];
      const heavy = request({
        op: 'exportSqliteTable',
        session: opened.session,
        table: 'big',
        maxTableBytes: 64 * 1024 * 1024,
      }).then((r) => {
        order.push('heavy');
        return r;
      });
      // 🔑 本物の worker では依頼は**別々のメッセージ(別の回)**で届く ── ここでは次の回に投げて真似る
      //   (同じ回に続けて投げると、写しの返事が待つ数手の間に軽い依頼が先に済んでしまい、譲らなくても順番が付く)
      const light = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          request({ op: 'listContainerIds' }).then(() => {
            order.push('light');
            resolve();
          }, reject);
        }, 0);
      });
      const [r] = await Promise.all([heavy, light]);
      expect(order, '写しが終わるまで別の依頼が待たされた(順番を譲っていない)').toEqual(['light', 'heavy']);
      // 🔑 譲っても、写しは 1 行も欠けない
      expect(r.refused).toBeNull();
      expect(r.rows).toBe(30_000);
      expect(rowsOf(r.ndjson)).toHaveLength(30_000);
      expect(rowsOf(r.ndjson)[29_999]).toMatchObject({ id: 29_999 });
    } finally {
      await request({ op: 'closeSqliteExport', session: opened.session });
    }
  }, 60_000);

  it('🔴 譲っている間に写しが閉じられたら、閉じた器を読み続けず、その表だけ断る', async () => {
    const img = await bigImage();
    const opened = await request({ op: 'openSqliteExport', image: img });
    const heavy = request({
      op: 'exportSqliteTable',
      session: opened.session,
      table: 'big',
      maxTableBytes: 64 * 1024 * 1024,
    });
    // 写しの途中(最初に譲った所)で閉じる ── 投げた順に、写し → 閉じる
    const closed = request({ op: 'closeSqliteExport', session: opened.session });
    const r = await heavy;
    await closed;
    expect(r.ndjson, '閉じられた写しの bytes を返している').toBeNull();
    expect(r.refused).toContain('閉じられました');
    // 後始末:同じ合言葉で頼んでも断られる(閉じた器は残っていない)
    await expect(
      request({ op: 'exportSqliteTable', session: opened.session, table: 'big', maxTableBytes: MAX }),
    ).rejects.toThrow(/写しが開かれていません/);
  }, 60_000);
});
