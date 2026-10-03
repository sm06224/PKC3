/**
 * 🔴 **`.sqlite` を DuckDB の器へ写す道筋**(#682 段④d。🟣 Gemini 裁定 2026-10-02)。
 *
 * 見るのは**器に入る順番と名前**(表ごとに:作る → NDJSON を差す → 入れる → **外す**。全部写し切ってから
 * 塞ぐ)と、**1 表の失敗がほかの表を巻き込まない**こと。
 * ⚠ 実物の engine で「ほんとうに読めるか」は `tests/duckdb-sqlite-ndjson.test.ts` が見る
 *   (字を pin する test は「その字が出ていること」しか言えない)。
 */
import { describe, expect, it, vi } from 'vitest';
import type { DuckDbHandle } from '../../src/adapter/platform/duckdb/duckdb-lease';
import type { DuckDbRaw } from '../../src/features/query/duckdb-rows';
import { DUCKDB_REQUIRED_FILES, duckDbExtensionPath } from '../../src/features/query/duckdb-pack';
import {
  DUCKDB_SEAL_SQL,
  DuckDbRunner,
  duckDbFileNameOf,
  type DuckDbRunnerDeps,
} from '../../src/adapter/platform/duckdb/duckdb-runner';
import {
  DUCKDB_READABLE_KINDS,
  duckDbReadableSourceOf,
  type DuckDbReadableGuestSource,
} from '../../src/features/query/sql-guest-source';
import {
  SQLITE_NDJSON_TABLE_MAX_BYTES,
  tooBigReason,
  type SqliteExportSession,
  type SqliteExportedTable,
} from '../../src/features/query/sqlite-ndjson';

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

/** 打たれた字を順番どおりに積む器。`failOn` が答えた字は落とす。 */
function fakeHandle(failOn: (sql: string) => Error | undefined, log: string[] = []) {
  // ⚠ `steps` は器の側だけ / `log` は器と storage worker の口を**時系列で 1 本に**した物(順番を見る test 用)
  const steps: string[] = [];
  const push = (s: string): void => {
    steps.push(s);
    log.push(s);
  };
  const answer: DuckDbRaw = { columns: ['n'], types: ['Int32'], rows: [[1]] };
  const h: DuckDbHandle = {
    put: (name, bytes) => {
      push(`put:${name}:${String(bytes.byteLength)}`);
      return Promise.resolve();
    },
    drop: (name) => {
      push(`drop:${name}`);
      return Promise.resolve();
    },
    query: (sql) => {
      push(sql);
      const err = failOn(sql);
      return err === undefined ? Promise.resolve(answer) : Promise.reject(err);
    },
    terminate: () => {
      push('terminate');
      return Promise.resolve();
    },
  };
  return { h, steps };
}

const COLS = [
  { name: 'id', type: 'INTEGER', notNull: false, primaryKey: true },
  { name: '品名', type: 'TEXT', notNull: false, primaryKey: false },
];

/** 行が在る表 / 空の表 / 断った表。⚠ NDJSON の中身は fake なので大きさだけで見分ける。 */
const withRows = (name: string, bytes = 11): SqliteExportedTable => ({
  name,
  columns: COLS,
  fks: [],
  ndjson: new Uint8Array(bytes),
  rows: 2,
  asText: false,
  refused: null,
});
const empty = (name: string): SqliteExportedTable => ({
  name,
  columns: COLS,
  fks: [],
  ndjson: null,
  rows: 0,
  asText: false,
  refused: null,
});
const refused = (name: string, why: string): SqliteExportedTable => ({
  name,
  columns: COLS,
  fks: [],
  ndjson: null,
  rows: 0,
  asText: false,
  refused: why,
});

function make(
  tablesOf: Record<string, SqliteExportedTable[]>,
  failOn: (sql: string) => Error | undefined = () => undefined,
  over: Partial<DuckDbRunnerDeps> = {},
) {
  const made: Array<ReturnType<typeof fakeHandle>> = [];
  /** 器の側と storage worker の口の**時系列**(`worker:open` / `worker:table:名前` / `worker:close`)。 */
  const log: string[] = [];
  /** worker へ「この表を」と頼んだときの天井(表ごと)。 */
  const tableCalls: Array<{ name: string; max: number }> = [];
  let open = 0;
  let closed = 0;
  const exportSqlite = vi.fn((image: Uint8Array) => {
    // ⚠ 画像の大きさで「どの file か」を見分ける(1 バイト = 1 件目 / 2 バイト = 2 件目 …)
    const tables = tablesOf[String(image.byteLength)] ?? [];
    log.push('worker:open');
    open += 1;
    const session: SqliteExportSession = {
      tables: tables.map((t) => t.name),
      table: (name, max) => {
        log.push('worker:table:' + name);
        tableCalls.push({ name, max });
        const t = tables.find((x) => x.name === name);
        return t === undefined ? Promise.reject(new Error('前提が崩れている(' + name + ')')) : Promise.resolve(t);
      },
      close: () => {
        log.push('worker:close');
        closed += 1;
        return Promise.resolve();
      },
    };
    return Promise.resolve(session);
  });
  const runner = new DuckDbRunner({
    fetchText: () => Promise.resolve(PACK),
    open: () => {
      const f = fakeHandle(failOn, log);
      made.push(f);
      return Promise.resolve(f.h);
    },
    baseUrl: 'https://example.test/app/',
    exportSqlite,
    ...over,
  });
  return {
    runner,
    exportSqlite,
    made,
    log,
    tableCalls,
    /** 開いたのに閉じていない写しの数(0 であるべき)。 */
    leaked: () => open - closed,
  };
}

function src(lid: string, name: string): DuckDbReadableGuestSource {
  const s = duckDbReadableSourceOf(lid, name);
  if (s === null) throw new Error(`前提が崩れている(${name})`);
  return s;
}

/** 画像の大きさ = 何件目かの目印。 */
const input = (source: DuckDbReadableGuestSource, size: number) => ({
  source,
  readBytes: vi.fn(() => Promise.resolve(new Uint8Array(size))),
});

describe('🔴 .sqlite を 1 件だけ引く ── 表は元の名前のまま', () => {
  it('🔴 表ごとに「作る → 差す → 入れる → 外す」。塞ぐのは最後に 1 度、user の字はその後', async () => {
    const { runner, made } = make({ '1': [withRows('売上', 11), empty('空表')] });
    await runner.run({ sql: 'SELECT * FROM 売上', sources: [input(src('l1', '家計.sqlite'), 1)] });
    const steps = made[0]?.steps ?? [];
    expect(steps).toEqual([
      'CREATE OR REPLACE TABLE "売上" ("id" BIGINT, "品名" VARCHAR)',
      'put:source_t1.ndjson:11',
      expect.stringContaining(`INSERT INTO "売上" SELECT * FROM read_json('source_t1.ndjson'`),
      // 🔴 写し終えた NDJSON は外す(表と同じ中身を 2 回持たない)
      'drop:source_t1.ndjson',
      // 🔴 空の表は file を作らず、列だけ在る表を作る(read_json_auto は空だと列を失う)
      'CREATE OR REPLACE TABLE "空表" ("id" BIGINT, "品名" VARCHAR)',
      DUCKDB_SEAL_SQL,
      'SELECT * FROM 売上',
    ]);
  });

  it('🔴 表の名前を csv に潰さない(1 つに潰せないので)', async () => {
    const { runner, made } = make({ '1': [withRows('a'), withRows('b')] });
    await runner.run({ sql: 'SELECT 1', sources: [input(src('l1', '家計.sqlite'), 1)] });
    const creates = (made[0]?.steps ?? []).filter((s) => s.startsWith('CREATE'));
    expect(creates).toHaveLength(2);
    expect(creates.join('\n')).not.toMatch(/TABLE "?csv"?\b/);
    expect(creates[0]).toContain('TABLE "a"');
    expect(creates[1]).toContain('TABLE "b"');
  });

  it('🔴 NDJSON の file 名は表ごとに違う(同じ名前を 2 度 put すると入れ替わる)', async () => {
    const { runner, made } = make({ '1': [withRows('a', 5), withRows('b', 6), withRows('c', 7)] });
    await runner.run({ sql: 'SELECT 1', sources: [input(src('l1', '家計.sqlite'), 1)] });
    const puts = (made[0]?.steps ?? []).filter((s) => s.startsWith('put:'));
    expect(puts).toEqual(['put:source_t1.ndjson:5', 'put:source_t2.ndjson:6', 'put:source_t3.ndjson:7']);
    // 外す file も同じ数(`drop` を落とすと、写した後も NDJSON が器に残る)
    const drops = (made[0]?.steps ?? []).filter((s) => s.startsWith('drop:'));
    expect(drops).toEqual(['drop:source_t1.ndjson', 'drop:source_t2.ndjson', 'drop:source_t3.ndjson']);
  });

  it('🔴 DuckDB へ渡すのは 1 表あたりの天井つき(storage worker へ天井を渡している)', async () => {
    const { runner, exportSqlite, tableCalls } = make({ '1': [withRows('a'), withRows('b')] });
    await runner.run({ sql: 'SELECT 1', sources: [input(src('l1', '家計.sqlite'), 1)] });
    expect(exportSqlite).toHaveBeenCalledTimes(1);
    // 🔑 天井は**表ごとの頼みに付く**(開く口には付かない ── 開いた時点では行を読まない)
    expect(tableCalls).toEqual([
      { name: 'a', max: SQLITE_NDJSON_TABLE_MAX_BYTES },
      { name: 'b', max: SQLITE_NDJSON_TABLE_MAX_BYTES },
    ]);
  });

  it('同じ器のまま打ち直しても、読み直さない(打鍵のたびに写し直さない)', async () => {
    const { runner, exportSqlite, made } = make({ '1': [withRows('a')] });
    const s = input(src('l1', '家計.sqlite'), 1);
    await runner.run({ sql: 'SELECT 1', sources: [s] });
    await runner.run({ sql: 'SELECT 2', sources: [s] });
    expect(exportSqlite).toHaveBeenCalledTimes(1);
    expect(s.readBytes).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(1);
  });
});

describe('🔴 2 件以上並べる ── 「ファイル名_表名」', () => {
  it('🔴 .sqlite の表は全部「ファイル名_表名」、csv は file 名のまま。1 件目の元の名前は残らない', async () => {
    const { runner, made } = make({ '1': [withRows('売上'), withRows('客')] });
    const csv = input(src('l2', '在庫.csv'), 9);
    await runner.run({ sql: 'SELECT 1', sources: [input(src('l1', '家計.sqlite'), 1), csv] });
    const creates = (made[0]?.steps ?? []).filter((s) => s.startsWith('CREATE'));
    expect(creates[0]).toContain('TABLE "家計_売上"');
    expect(creates[1]).toContain('TABLE "家計_客"');
    expect(creates[2]).toContain('TABLE 在庫 AS');
    // 対照群:1 件のときの元の名前は、2 件では出ない
    expect(creates.join('\n')).not.toContain('TABLE "売上"');
  });

  it('🔴 2 件目が .sqlite でも名前が決まる(1 件目が csv)。NDJSON の file 名は相手ごとに分かれる', async () => {
    const { runner, made } = make({ '2': [withRows('売上', 5)] });
    await runner.run({
      sql: 'SELECT 1',
      sources: [input(src('l1', '在庫.csv'), 9), input(src('l2', '家計.sqlite'), 2)],
    });
    const steps = made[0]?.steps ?? [];
    expect(steps).toContain('put:source.csv:9');
    // 🔴 2 件目の相手(slot 1)の 1 枚目 ── `source_2` の幹から外れない
    expect(steps).toContain('put:source_2_t1.ndjson:5');
    expect(steps.filter((s) => s.startsWith('CREATE')).some((s) => s.includes('TABLE "家計_売上"'))).toBe(true);
    // 塞ぐのは全部を写し切った後に 1 度だけ
    expect(steps.filter((s) => s === DUCKDB_SEAL_SQL)).toHaveLength(1);
    expect(steps.indexOf(DUCKDB_SEAL_SQL)).toBeGreaterThan(steps.indexOf('drop:source_2_t1.ndjson'));
  });

  it('🔴 別の 2 つの .sqlite に同じ名前の表が在っても、ぶつからない', async () => {
    const { runner, made } = make({ '1': [withRows('t')], '2': [withRows('t')] });
    await runner.run({
      sql: 'SELECT 1',
      sources: [input(src('l1', 'a.sqlite'), 1), input(src('l2', 'b.sqlite'), 2)],
    });
    const creates = (made[0]?.steps ?? []).filter((s) => s.startsWith('CREATE'));
    expect(creates[0]).toContain('TABLE "a_t"');
    expect(creates[1]).toContain('TABLE "b_t"');
  });
});

describe('🔴 1 表の失敗は、その表だけ ── ほかの表は引ける', () => {
  const sources = () => [input(src('l1', '家計.sqlite'), 1)];

  it('🔴 断った表は作らない(空の表を残すと「0 件の表」に読める)。ほかの表は作る', async () => {
    const { runner, made } = make({
      '1': [withRows('小さい'), refused('大きい', tooBigReason(SQLITE_NDJSON_TABLE_MAX_BYTES)), withRows('別')],
    });
    await runner.run({ sql: 'SELECT 1', sources: sources() });
    const creates = (made[0]?.steps ?? []).filter((s) => s.startsWith('CREATE'));
    expect(creates).toHaveLength(2);
    expect(creates.join('\n')).not.toContain('大きい');
    // 塞ぐ所まで進んでいる(1 表で止まっていない)
    expect(made[0]?.steps).toContain(DUCKDB_SEAL_SQL);
  });

  it('🔴 その表を引いて落ちた回にだけ、理由を添える(表の名前つき)', async () => {
    const why = tooBigReason(SQLITE_NDJSON_TABLE_MAX_BYTES);
    const { runner } = make({ '1': [withRows('小さい'), refused('大きい', why)] }, (sql) =>
      sql === 'SELECT * FROM 大きい' ? new Error('Catalog Error: Table with name 大きい does not exist!') : undefined,
    );
    let msg = '';
    await runner.run({ sql: 'SELECT * FROM 大きい', sources: sources() }).catch((e: unknown) => {
      msg = e instanceof Error ? e.message : String(e);
    });
    expect(msg, 'DuckDB の断りが消えている').toContain('does not exist');
    expect(msg, '写せなかった表の理由が添わない').toContain('大きい は DuckDB へ写せませんでした');
    expect(msg).toContain('64.0 MB');
    expect(msg, '内蔵の sqlite という逃げ道を案内していない').toContain('内蔵の sqlite');
  });

  it('🔴 ほかの表を引いて通った回には、何も添えない(黙って引ける)', async () => {
    const { runner } = make({ '1': [withRows('小さい'), refused('大きい', 'x')] });
    const r = await runner.run({ sql: 'SELECT * FROM 小さい', sources: sources() });
    expect(r.rows).toEqual([[1]]);
  });

  it('🔴 引いていない表の失敗(構文の誤りなど)にも、断った表の理由は添える(原因が見えない回を作らない)', async () => {
    const { runner } = make({ '1': [refused('大きい', 'x')] }, (sql) =>
      sql === 'SELEKT 1' ? new Error('Parser Error') : undefined,
    );
    let msg = '';
    await runner.run({ sql: 'SELEKT 1', sources: sources() }).catch((e: unknown) => {
      msg = e instanceof Error ? e.message : String(e);
    });
    expect(msg).toContain('Parser Error');
    expect(msg).toContain('大きい は DuckDB へ写せませんでした');
  });

  it('🔴 器を入れ直すと、前の器の理由は持ち越さない(別の相手を引く回に出ない)', async () => {
    const { runner } = make({ '1': [refused('大きい', 'x')] }, (sql) =>
      sql === 'SELEKT 1' ? new Error('Parser Error') : undefined,
    );
    await runner.run({ sql: 'SELECT 1', sources: sources() });
    // 相手を替える(鍵が変わる → 器ごと作り直す)
    let msg = '';
    await runner
      .run({ sql: 'SELEKT 1', sources: [input(src('l9', '別.sqlite'), 9)] })
      .catch((e: unknown) => {
        msg = e instanceof Error ? e.message : String(e);
      });
    expect(msg).toBe('Parser Error');
  });

  it('🔴 型が合わない行が在る表は、その表だけ全列 VARCHAR で作り直す(値を失わない)', async () => {
    const { runner, made } = make(
      { '1': [withRows('混在'), withRows('普通')] },
      (() => {
        let first = true;
        return (sql: string) => {
          // 「混在」の最初の INSERT だけ落とす(型の合わない行)
          if (first && sql.startsWith('INSERT INTO "混在"')) {
            first = false;
            return new Error('Invalid Input Error: Failed to cast value to numerical');
          }
          return undefined;
        };
      })(),
    );
    await runner.run({ sql: 'SELECT 1', sources: sources() });
    const steps = made[0]?.steps ?? [];
    const creates = steps.filter((s) => s.startsWith('CREATE') && s.includes('"混在"'));
    expect(creates, '作り直していない').toHaveLength(2);
    expect(creates[0]).toContain('"id" BIGINT');
    expect(creates[1], '全列 VARCHAR になっていない').toBe(
      'CREATE OR REPLACE TABLE "混在" ("id" VARCHAR, "品名" VARCHAR)',
    );
    const inserts = steps.filter((s) => s.startsWith('INSERT INTO "混在"'));
    expect(inserts).toHaveLength(2);
    expect(inserts[1]).toContain("'id': 'VARCHAR'");
    // 対照群:ほかの表は型どおりのまま
    expect(steps.some((s) => s.includes('CREATE OR REPLACE TABLE "普通" ("id" BIGINT'))).toBe(true);
    // 断ってはいない(値は入った)
    expect(steps.some((s) => s.startsWith('DROP TABLE'))).toBe(false);
  });

  it('🔴 全列 VARCHAR でも入らない表は、その表だけ断る(作りかけを残さず、NDJSON も外す)', async () => {
    const { runner, made } = make({ '1': [withRows('壊れ'), withRows('無事')] }, (sql) => {
      if (sql.startsWith('INSERT INTO "壊れ"')) return new Error('Invalid Input Error: broken\nLINE 1');
      if (sql === 'SELECT * FROM 壊れ') return new Error('Catalog Error');
      return undefined;
    });
    let msg = '';
    await runner.run({ sql: 'SELECT * FROM 壊れ', sources: sources() }).catch((e: unknown) => {
      msg = e instanceof Error ? e.message : String(e);
    });
    expect(msg).toContain('壊れ は DuckDB へ写せませんでした');
    // 理由の 1 行目だけ(DuckDB の複数行の断りをそのまま画面へ流さない)
    expect(msg).toContain('DuckDB が読めませんでした: Invalid Input Error: broken');
    expect(msg).not.toContain('LINE 1');
    const steps = made[0]?.steps ?? [];
    expect(steps).toContain('DROP TABLE "壊れ"');
    expect(steps, '落ちた表の NDJSON を外していない').toContain('drop:source_t1.ndjson');
    // 無事な表は作って、外している
    expect(steps).toContain('drop:source_t2.ndjson');
    expect(steps).toContain(DUCKDB_SEAL_SQL);
  });
});

describe('🔴 読めない回は理由つきで断る(外が開いたままの器を残さない)', () => {
  it('中身を読めなければ、名前を添えて断る(塞いでいない)', async () => {
    const { runner, made } = make({});
    const bad = { source: src('l1', '家計.sqlite'), readBytes: () => Promise.resolve(null) };
    await expect(runner.run({ sql: 'SELECT 1', sources: [bad] })).rejects.toThrow('家計.sqlite の中身を読めませんでした');
    expect(made[0]?.steps ?? []).not.toContain(DUCKDB_SEAL_SQL);
  });

  it('storage worker の口が無い版では、理由を言って断る(黙って空の器を返さない)', async () => {
    const runner = new DuckDbRunner({
      fetchText: () => Promise.resolve(PACK),
      open: () => Promise.resolve(fakeHandle(() => undefined).h),
      baseUrl: 'https://example.test/app/',
    });
    await expect(
      runner.run({ sql: 'SELECT 1', sources: [input(src('l1', '家計.sqlite'), 1)] }),
    ).rejects.toThrow('この版では .sqlite を DuckDB で引けません');
  });

  it('🔴 file そのものが DB として読めなければ、worker の断りがそのまま画面へ出る', async () => {
    const { runner } = make({}, undefined, {
      exportSqlite: () => Promise.reject(new Error('この file は sqlite の DB として読めませんでした(file is not a database)')),
    });
    await expect(
      runner.run({ sql: 'SELECT 1', sources: [input(src('l1', '壊れ.sqlite'), 1)] }),
    ).rejects.toThrow('sqlite の DB として読めませんでした');
  });
});

describe('🔴 器の中の file 名(never 網羅の追随)', () => {
  it('DuckDB で読める種類は 1 つ残らず、器の中の file 名を持つ', () => {
    const sample: Record<(typeof DUCKDB_READABLE_KINDS)[number], string> = {
      csv: '客.csv',
      parquet: '客.parquet',
      json: '客.json',
      sqlite: '客.sqlite',
    };
    // ⚠ 種類を足した人がここへ書き忘れたら、この assert が落ちる(空振りで通さない)
    expect(Object.keys(sample).sort()).toEqual([...DUCKDB_READABLE_KINDS].sort());
    for (const kind of DUCKDB_READABLE_KINDS) {
      const file = duckDbFileNameOf(src('x', sample[kind]));
      expect(file.startsWith('source'), `${kind}: 器の中の名前が決まっていない`).toBe(true);
    }
  });

  it('.sqlite は「相手の番号 × 表の番号」で名前が決まる', () => {
    const s = src('x', '家計.sqlite');
    expect(duckDbFileNameOf(s)).toBe('source_t1.ndjson');
    expect(duckDbFileNameOf(s, 0, 2)).toBe('source_t3.ndjson');
    expect(duckDbFileNameOf(s, 1, 0)).toBe('source_2_t1.ndjson');
    expect(duckDbFileNameOf(s, 2, 1)).toBe('source_3_t2.ndjson');
  });
});

describe('🔴 表ごとに「頼む → 入れる → 手放す」(同時に載るのは 1 表ぶん / 開いたら必ず閉じる)', () => {
  it('🔴 次の表を頼むのは、前の表の NDJSON を外した後(全表を先に読んで抱えない)', async () => {
    const { runner, log } = make({ '1': [withRows('a', 5), withRows('b', 6), withRows('c', 7)] });
    await runner.run({ sql: 'SELECT 1', sources: [input(src('l1', '家計.sqlite'), 1)] });
    const at = (needle: string): number => log.findIndex((l) => l === needle);
    // 🔑 「全表を先に頼む」形(直す前)だと、b を頼むのが a の file を外すより**前**になる
    expect(at('worker:table:b'), 'b を頼むのが a を外す前').toBeGreaterThan(at('drop:source_t1.ndjson'));
    expect(at('worker:table:c'), 'c を頼むのが b を外す前').toBeGreaterThan(at('drop:source_t2.ndjson'));
    // 開く → 写す → 閉じる(**1 度だけ**)
    expect(log.filter((l) => l === 'worker:open')).toHaveLength(1);
    expect(log.filter((l) => l === 'worker:close')).toHaveLength(1);
    expect(at('worker:open')).toBeLessThan(at('worker:table:a'));
  });

  it('🔴 2 件の .sqlite は、1 件目を写し終えたらすぐ閉じる(2 件目を写す間、開いたまま残さない)', async () => {
    const { runner, log, leaked } = make({ '1': [withRows('t')], '2': [withRows('t')] });
    await runner.run({
      sql: 'SELECT 1',
      sources: [input(src('l1', 'a.sqlite'), 1), input(src('l2', 'b.sqlite'), 2)],
    });
    const closes = log.map((l, i) => (l === 'worker:close' ? i : -1)).filter((i) => i >= 0);
    expect(closes).toHaveLength(2);
    const firstTable = log.indexOf('worker:table:t');
    const secondTable = log.indexOf('worker:table:t', firstTable + 1);
    // 2 件目の表を頼むより前に、1 件目の写しを閉じている
    expect(closes[0]!).toBeLessThan(secondTable);
    expect(leaked()).toBe(0);
  });

  it('🔴 途中で落ちた回も、開いた写しを worker に残さない(不可侵指示「即破棄」)', async () => {
    const { runner, leaked } = make({ '1': [withRows('t')] });
    const bad = { source: src('l2', '在庫.csv'), readBytes: () => Promise.resolve(null) };
    // 🔑 読めない相手を**先に**並べる ── `.sqlite` の写しは開いたまま、その手前で落ちる
    //   (`.sqlite` を先に並べると、落ちる前に写し終えて閉じてしまい、`finally` を通らずに 0 になる)
    await expect(
      runner.run({ sql: 'SELECT 1', sources: [bad, input(src('l1', '家計.sqlite'), 1)] }),
    ).rejects.toThrow('在庫.csv の中身を読めませんでした');
    expect(leaked(), '落ちた回に写しが開いたまま残っている').toBe(0);
  });

  it('🔴 表を頼めなかった(写しが閉じられた等)ときも、その表だけ断る ── ほかの表は引ける', async () => {
    const { runner, made } = make({}, () => undefined, {
      exportSqlite: () =>
        Promise.resolve({
          tables: ['a', 'b'],
          table: (name: string) =>
            name === 'a'
              ? Promise.reject(new Error('取り込んだ .sqlite の写しが開かれていません'))
              : Promise.resolve(withRows('b')),
          close: () => Promise.resolve(),
        }),
    });
    let msg = '';
    await runner
      .run({ sql: 'SELECT * FROM a', sources: [input(src('l1', '家計.sqlite'), 1)] })
      .catch((e: unknown) => {
        msg = e instanceof Error ? e.message : String(e);
      });
    // a は作られず(断られ)、b は作られている ── 塞ぐ所まで進んでいる
    const steps = made[0]?.steps ?? [];
    expect(steps.some((s) => s.includes('TABLE "b"'))).toBe(true);
    expect(steps.some((s) => s.includes('TABLE "a"'))).toBe(false);
    expect(steps).toContain(DUCKDB_SEAL_SQL);
    // 引いた回は(fake の器は何でも通すので)落ちない ── 落ちたときに理由が付くことは別の test が見る
    expect(msg).toBe('');
  });
});

describe('🔴 写せなかった理由は、器と同じ寿命(別の失敗に付かない)', () => {
  const sources = () => [input(src('l1', '家計.sqlite'), 1)];

  it('🔴 器が畳まれた後、電波なしで落ちた回に、前の器の理由を添えない', async () => {
    let opens = 0;
    const { runner } = make({ '1': [withRows('小さい'), refused('大きい', 'x')] }, () => undefined, {
      open: () => {
        opens += 1;
        // 2 回目(畳んだ後の起こし直し)は器を起こせない
        return opens === 1
          ? Promise.resolve(fakeHandle(() => undefined).h)
          : Promise.reject(new Error('Failed to fetch'));
      },
    });
    const s = sources();
    await runner.run({ sql: 'SELECT 1', sources: s });
    // 面を閉じる / しばらく使わない = 器が畳まれる
    await runner.release();
    let msg = '';
    await runner.run({ sql: 'SELECT 1', sources: s }).catch((e: unknown) => {
      msg = e instanceof Error ? e.message : String(e);
    });
    expect(msg).toContain('Failed to fetch');
    expect(msg, 'もう無い器の理由が別の失敗に付いている').not.toContain('写せませんでした');
  });

  it('⚠ 対照群 ── 器が生きている間は、2 回目以降の失敗にも理由を添える(最初の 1 回だけにしない)', async () => {
    const { runner } = make({ '1': [withRows('小さい'), refused('大きい', 'x')] }, (sql) =>
      sql === 'SELECT * FROM 大きい' ? new Error('Catalog Error') : undefined,
    );
    const s = sources();
    await runner.run({ sql: 'SELECT 1', sources: s });
    let msg = '';
    await runner.run({ sql: 'SELECT * FROM 大きい', sources: s }).catch((e: unknown) => {
      msg = e instanceof Error ? e.message : String(e);
    });
    expect(msg).toContain('大きい は DuckDB へ写せませんでした');
  });

  it('🔴 構造を採る回(schema)から入っても同じ ── 畳まれた後に落ちた回へ、前の理由を添えない', async () => {
    let opens = 0;
    const { runner } = make({ '1': [refused('大きい', 'x')] }, () => undefined, {
      open: () => {
        opens += 1;
        return opens === 1
          ? Promise.resolve(fakeHandle(() => undefined).h)
          : Promise.reject(new Error('Failed to fetch'));
      },
    });
    const s = sources();
    await runner.run({ sql: 'SELECT 1', sources: s });
    await runner.release();
    // schema は理由を添えない作りだが、先頭で「器が無ければ前の理由を捨てる」を通る ── 次の run に漏れない
    await runner.schema(s).catch(() => undefined);
    let msg = '';
    await runner.run({ sql: 'SELECT 1', sources: s }).catch((e: unknown) => {
      msg = e instanceof Error ? e.message : String(e);
    });
    expect(msg).toContain('Failed to fetch');
    expect(msg).not.toContain('写せませんでした');
  });
});

describe('🔴 表を作れない / 型へ写すと値が変わる ── その表だけの話にする', () => {
  const sources = () => [input(src('l1', '家計.sqlite'), 1)];

  it('🔴 名前が空の表(DuckDB が作れない)は、その表だけ断る ── file 全体を英語の断りで落とさない', async () => {
    const failEmpty = (sql: string): Error | undefined =>
      sql.startsWith('CREATE OR REPLACE TABLE ""')
        ? new Error('Parser Error: zero-length delimited identifier at or near """"')
        : undefined;
    const { runner, made } = make({ '1': [withRows(''), withRows('無事')] }, failEmpty);
    const r = await runner.run({ sql: 'SELECT * FROM 無事', sources: sources() });
    expect(r.rows, '無事な表まで引けなくなった').toEqual([[1]]);
    const steps = made[0]?.steps ?? [];
    expect(steps.some((s) => s.includes('TABLE "無事"'))).toBe(true);
    expect(steps, '塞ぐ所まで進んでいない').toContain(DUCKDB_SEAL_SQL);
    // 引いて落ちたら、何の表が写せなかったかが見える(空の名前でも)
    const { runner: r2 } = make({ '1': [withRows('')] }, (sql) =>
      sql === 'SELECT 1' ? new Error('Parser Error') : failEmpty(sql),
    );
    let msg = '';
    await r2.run({ sql: 'SELECT 1', sources: sources() }).catch((e: unknown) => {
      msg = e instanceof Error ? e.message : String(e);
    });
    expect(msg).toContain('(名前の無い表) は DuckDB へ写せませんでした');
    expect(msg).toContain('DuckDB が表を作れませんでした: Parser Error: zero-length delimited identifier');
  });

  it('🔴 旗(asText)の立った表は、作り直しではなく最初から全列 VARCHAR(1 度で入る)', async () => {
    const { runner, made } = make({ '1': [{ ...withRows('価格'), asText: true }, withRows('普通')] });
    await runner.run({ sql: 'SELECT 1', sources: sources() });
    const steps = made[0]?.steps ?? [];
    const creates = steps.filter((s) => s.startsWith('CREATE') && s.includes('"価格"'));
    expect(creates, '旗が立っているのに、型どおりに作ってから作り直している').toEqual([
      'CREATE OR REPLACE TABLE "価格" ("id" VARCHAR, "品名" VARCHAR)',
    ]);
    const inserts = steps.filter((s) => s.startsWith('INSERT INTO "価格"'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain("'id': 'VARCHAR'");
    // 対照群:旗の無い表は型どおり
    expect(steps.some((s) => s.includes('CREATE OR REPLACE TABLE "普通" ("id" BIGINT'))).toBe(true);
  });

  it('🔴 旗の立った表が入らなかったら、その表だけ断る(作り直しの 2 周目を回さない)', async () => {
    const { runner, made } = make({ '1': [{ ...withRows('価格'), asText: true }] }, (sql) =>
      sql.startsWith('INSERT INTO "価格"') ? new Error('broken') : undefined,
    );
    await runner.run({ sql: 'SELECT 1', sources: sources() });
    const steps = made[0]?.steps ?? [];
    expect(steps.filter((s) => s.startsWith('INSERT INTO "価格"'))).toHaveLength(1);
    expect(steps).toContain('DROP TABLE "価格"');
    expect(steps).toContain('drop:source_t1.ndjson');
  });
});
