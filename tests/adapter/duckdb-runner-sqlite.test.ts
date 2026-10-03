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
function fakeHandle(failOn: (sql: string) => Error | undefined) {
  const steps: string[] = [];
  const answer: DuckDbRaw = { columns: ['n'], types: ['Int32'], rows: [[1]] };
  const h: DuckDbHandle = {
    put: (name, bytes) => {
      steps.push(`put:${name}:${String(bytes.byteLength)}`);
      return Promise.resolve();
    },
    drop: (name) => {
      steps.push(`drop:${name}`);
      return Promise.resolve();
    },
    query: (sql) => {
      steps.push(sql);
      const err = failOn(sql);
      return err === undefined ? Promise.resolve(answer) : Promise.reject(err);
    },
    terminate: () => {
      steps.push('terminate');
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
  refused: null,
});
const empty = (name: string): SqliteExportedTable => ({
  name,
  columns: COLS,
  fks: [],
  ndjson: null,
  rows: 0,
  refused: null,
});
const refused = (name: string, why: string): SqliteExportedTable => ({
  name,
  columns: COLS,
  fks: [],
  ndjson: null,
  rows: 0,
  refused: why,
});

function make(
  tablesOf: Record<string, SqliteExportedTable[]>,
  failOn: (sql: string) => Error | undefined = () => undefined,
  over: Partial<DuckDbRunnerDeps> = {},
) {
  const made: Array<ReturnType<typeof fakeHandle>> = [];
  const exportSqlite = vi.fn((image: Uint8Array, maxTableBytes: number) => {
    void maxTableBytes; // ⚠ 呼ばれた引数は `mock.calls` で見る(ここでは使わない)
    // ⚠ 画像の大きさで「どの file か」を見分ける(1 バイト = 1 件目 / 2 バイト = 2 件目 …)
    return Promise.resolve({ tables: tablesOf[String(image.byteLength)] ?? [] });
  });
  const runner = new DuckDbRunner({
    fetchText: () => Promise.resolve(PACK),
    open: () => {
      const f = fakeHandle(failOn);
      made.push(f);
      return Promise.resolve(f.h);
    },
    baseUrl: 'https://example.test/app/',
    exportSqlite,
    ...over,
  });
  return { runner, exportSqlite, made };
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
    const { runner, exportSqlite } = make({ '1': [withRows('a')] });
    await runner.run({ sql: 'SELECT 1', sources: [input(src('l1', '家計.sqlite'), 1)] });
    expect(exportSqlite).toHaveBeenCalledTimes(1);
    expect(exportSqlite.mock.calls[0]?.[1]).toBe(SQLITE_NDJSON_TABLE_MAX_BYTES);
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
