/**
 * 🔴 **複数の file を 1 つの器へ並べる道筋**(#918 段⑦a。Gemini 裁定 2026-10-01)。
 *
 * 見るのは**器に入る順番と名前**(1 件のときの順番 = 差し込む → 写し切る → 塞ぐ、を
 * N 件へ伸ばしても保つ)と、**集合が変わったら器を作り直す(`hold` も解ける)**こと。
 * 実物の engine で「2 つの表を JOIN できる」は `tests/duckdb-write.test.ts` が見る。
 */
import { describe, expect, it, vi } from 'vitest';
import type { DuckDbHandle } from '../../src/adapter/platform/duckdb/duckdb-lease';
import type { DuckDbRaw } from '../../src/features/query/duckdb-rows';
import { DUCKDB_REQUIRED_FILES, duckDbExtensionPath } from '../../src/features/query/duckdb-pack';
import {
  DUCKDB_SEAL_SQL,
  DuckDbRunner,
  duckDbFileNameOf,
  duckDbLoadSql,
} from '../../src/adapter/platform/duckdb/duckdb-runner';
import { duckDbReadableSourceOf, type DuckDbReadableGuestSource } from '../../src/features/query/sql-guest-source';

/** 実測の byte 数(`duckdb-runner.test.ts` と同じ。目録の下限を満たす)。 */
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

function fakeHandle(answer: DuckDbRaw) {
  const steps: string[] = [];
  const h: DuckDbHandle = {
    put: (name, bytes) => {
      steps.push(`put:${name}:${String(bytes.byteLength)}`);
      return Promise.resolve();
    },
    query: (sql) => {
      steps.push(sql);
      return Promise.resolve(answer);
    },
    terminate: () => {
      steps.push('terminate');
      return Promise.resolve();
    },
  };
  return { h, steps };
}

function make(idleMs?: number) {
  const answer: DuckDbRaw = { columns: ['n'], types: ['Int32'], rows: [[1]] };
  const made: Array<ReturnType<typeof fakeHandle>> = [];
  const open = vi.fn(() => {
    const f = fakeHandle(answer);
    made.push(f);
    return Promise.resolve(f.h);
  });
  const runner = new DuckDbRunner({
    fetchText: () => Promise.resolve(PACK),
    open,
    baseUrl: 'https://example.test/app/',
    ...(idleMs === undefined ? {} : { idleMs }),
  });
  return { runner, open, made };
}

function src(lid: string, name: string): DuckDbReadableGuestSource {
  const s = duckDbReadableSourceOf(lid, name);
  if (s === null) throw new Error(`前提が崩れている(${name})`);
  return s;
}

/** 大きさで見分けられる bytes(どの file が、どの名前で入ったかを見る)。 */
function input(source: DuckDbReadableGuestSource, size: number) {
  return { source, readBytes: vi.fn(() => Promise.resolve(new Uint8Array(size))) };
}

describe('🔴 N 件を並べても、「差し込む → 写し切る → 塞ぐ」の順番は 1 つだけ', () => {
  it('2 件:2 件とも差し込んで写し、塞ぐのは**最後に 1 度だけ**(user の字はその後)', async () => {
    const { runner, made } = make();
    const a = input(src('l1', '売上.csv'), 11);
    const b = input(src('l2', '在庫.parquet'), 22);
    await runner.run({ sql: 'SELECT 1', sources: [a, b] });
    const steps = made[0]?.steps ?? [];
    expect(steps[0]).toBe('put:source.csv:11');
    expect(steps[1]).toContain('CREATE OR REPLACE TABLE 売上 AS');
    // ⚠ 2 件目を差し込む前に塞いでいない(塞ぐと file を読めない ── 実測)
    expect(steps[2]).toBe('put:source_2.parquet:22');
    expect(steps[3]).toContain('CREATE OR REPLACE TABLE 在庫 AS SELECT * FROM read_parquet(');
    expect(steps[4]).toBe(DUCKDB_SEAL_SQL);
    expect(steps[5]).toBe('SELECT 1');
    expect(steps.filter((s) => s === DUCKDB_SEAL_SQL), '塞ぎが 1 度でない').toHaveLength(1);
    expect(steps).toHaveLength(6);
  });

  it('🔴 同じ種類の file を 2 つ並べても、器の中の名前がぶつからない(2 件目が 1 件目を上書きしない)', async () => {
    const { runner, made } = make();
    await runner.run({
      sql: 'SELECT 1',
      sources: [input(src('l1', 'a.csv'), 1), input(src('l2', 'b.csv'), 2), input(src('l3', 'c.csv'), 3)],
    });
    const puts = (made[0]?.steps ?? []).filter((s) => s.startsWith('put:'));
    expect(puts).toEqual(['put:source.csv:1', 'put:source_2.csv:2', 'put:source_3.csv:3']);
    expect(new Set(puts.map((p) => p.split(':')[1])).size, '名前が重なっている').toBe(3);
  });

  it('1 件目の名前は今までどおり(source.csv)。2 件目から source_2 …', () => {
    const s = src('l1', 'a.csv');
    expect(duckDbFileNameOf(s)).toBe('source.csv');
    expect(duckDbFileNameOf(s, 0)).toBe('source.csv');
    expect(duckDbFileNameOf(s, 1)).toBe('source_2.csv');
    expect(duckDbFileNameOf(src('l', 'a.ndjson'), 2)).toBe('source_3.ndjson');
  });

  it('🔴 表の名前は file 名から(1 件のときの csv ではない)/ csv は _note・_lid を足す', async () => {
    const { runner, made } = make();
    await runner.run({
      sql: 'SELECT 1',
      sources: [input(src('l1', '売上.csv'), 1), input(src('l2', '2024-sales.csv'), 1)],
    });
    const creates = (made[0]?.steps ?? []).filter((s) => s.startsWith('CREATE'));
    expect(creates[0]).toContain('CREATE OR REPLACE TABLE 売上 AS SELECT ');
    expect(creates[0]).toContain("'売上.csv' AS _note");
    expect(creates[1]).toContain('CREATE OR REPLACE TABLE _2024_sales AS SELECT ');
    expect(creates[1]).toContain("'l2' AS _lid");
  });

  it('1 件のときの SQL は 1 バイトも変わらない', () => {
    const s = src('l1', '売上.csv');
    expect(duckDbLoadSql(s, 'source.csv')).toBe(duckDbLoadSql(s, 'source.csv', 'csv'));
    expect(duckDbLoadSql(s, 'source.csv')).toContain('CREATE OR REPLACE TABLE csv AS');
  });

  it('2 件目が読めなかったら、その名前で断る(外が開いたままの器を残さない = 塞いでいない)', async () => {
    const { runner, made } = make();
    const bad = { source: src('l2', '在庫.csv'), readBytes: () => Promise.resolve(null) };
    await expect(runner.run({ sql: 'SELECT 1', sources: [input(src('l1', '売上.csv'), 1), bad] })).rejects.toThrow(
      '在庫.csv の中身を読めませんでした',
    );
    expect(made[0]?.steps ?? []).not.toContain(DUCKDB_SEAL_SQL);
  });

  it('相手が空なら走らせない(1 件も無い器へ打たない)', async () => {
    const { runner, open } = make();
    await expect(runner.run({ sql: 'SELECT 1', sources: [] })).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(0);
  });
});

describe('🔴 集合が変わったら器を作り直す(足す / 外す / 順番)', () => {
  const A = (): ReturnType<typeof input> => input(src('l1', '売上.csv'), 1);
  const B = (): ReturnType<typeof input> => input(src('l2', '在庫.csv'), 1);
  const C = (): ReturnType<typeof input> => input(src('l3', '客.csv'), 1);

  it('同じ集合なら作り直さない(打鍵のたびに読み直さない)', async () => {
    const { runner, open } = make();
    await runner.run({ sql: 'SELECT 1', sources: [A(), B()] });
    await runner.run({ sql: 'SELECT 2', sources: [A(), B()] });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('足したら作り直す(1 → 2)/ 外したら作り直す(2 → 1)', async () => {
    const { runner, open, made } = make();
    await runner.run({ sql: 'SELECT 1', sources: [A()] });
    await runner.run({ sql: 'SELECT 2', sources: [A(), B()] });
    expect(open, '足したのに器を作り直していない').toHaveBeenCalledTimes(2);
    expect(made[0]?.steps).toContain('terminate');
    await runner.run({ sql: 'SELECT 3', sources: [A()] });
    expect(open, '外したのに器を作り直していない').toHaveBeenCalledTimes(3);
    // 1 件へ戻れば、表の名前も今までどおり(csv)
    expect(made[2]?.steps[1]).toContain('CREATE OR REPLACE TABLE csv AS');
  });

  it('入れ替え(同じ数で別の file)/ 順番の入れ替えでも作り直す', async () => {
    const { runner, open } = make();
    await runner.run({ sql: 'SELECT 1', sources: [A(), B()] });
    await runner.run({ sql: 'SELECT 2', sources: [A(), C()] });
    expect(open, '入れ替えたのに作り直していない').toHaveBeenCalledTimes(2);
    await runner.run({ sql: 'SELECT 3', sources: [C(), A()] });
    // ⚠ 順番が変わると**表の名前の割り当て**(同名の _2)が変わりうるので、作り直す
    expect(open, '順番が変わったのに作り直していない').toHaveBeenCalledTimes(3);
  });

  it('🔴 書き込みで持ち続けている器も、集合が変われば畳んで作り直す(hold が解ける)', async () => {
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const { runner, made, open } = make(5);
    await runner.run({ sql: 'CREATE TABLE t (a INT)', sources: [A(), B()] });
    await wait(40);
    expect(runner.awake, '前提が崩れている(書き込んだのに畳んでいる)').toBe(true);
    // 集合を変えて読むだけの字を打つ → 作り直し + hold が無くなるのでアイドルで畳まれる
    await runner.run({ sql: 'SELECT 1', sources: [A()] });
    expect(open).toHaveBeenCalledTimes(2);
    expect(made[0]?.steps, '古い器を畳んでいない').toContain('terminate');
    await wait(40);
    expect(runner.awake, '集合が変わったのに hold が残って畳まれない').toBe(false);
  });
});
