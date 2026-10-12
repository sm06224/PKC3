/**
 * 🔴 **答えを Parquet にして書き出す道筋**(#918 段⑥)。
 *
 * ⚠ ここで守るのは**打つ順番と後始末**である ── 実物の engine で書けること・読み戻せることは
 *   `tests/duckdb-parquet-export.test.ts` が見る(こちらは取っ手を模している)。
 * 🔑 user の `COPY` を通さない代わりに、**こちらが組んだ 1 文だけ**を、塞いだ後の器へ打つ。
 */
import { describe, expect, it, vi } from 'vitest';
import type { DuckDbHandle } from '../../src/adapter/platform/duckdb/duckdb-lease';
import { DUCKDB_REQUIRED_FILES } from '../../src/features/query/duckdb-pack';
import { DUCKDB_SEAL_SQL, DuckDbRunner } from '../../src/adapter/platform/duckdb/duckdb-runner';

/** ⚠ 目録は `DUCKDB_REQUIRED_FILES` から組む(手で並べると、足した日に古くなる)。 */
const PACK = JSON.stringify({
  version: '1.33.1',
  files: DUCKDB_REQUIRED_FILES.map((path) => ({ path, bytes: 99_000_000 })),
});

const SRC = { kind: 'csv', lang: 'csv', lid: 'l1', name: '売上.csv' } as const;
const PAR1 = [0x50, 0x41, 0x52, 0x31];

/** 打たれた字を順番どおりに積む器。`readFile` は決め打ちの 4 バイト(PAR1)を返す。 */
function fakeHandle(opts: { failOn?: (sql: string) => boolean; withReadFile?: boolean } = {}) {
  const steps: string[] = [];
  const h: DuckDbHandle = {
    put: (name) => {
      steps.push('put:' + name);
      return Promise.resolve();
    },
    drop: (name) => {
      steps.push('drop:' + name);
      return Promise.resolve();
    },
    query: (sql) => {
      steps.push(sql);
      if (opts.failOn?.(sql) === true) return Promise.reject(new Error('断られた'));
      return Promise.resolve({ columns: ['n'], types: ['Int32'], rows: [[1]] });
    },
    terminate: () => {
      steps.push('terminate');
      return Promise.resolve();
    },
    ...(opts.withReadFile === false
      ? {}
      : {
          readFile: (name: string) => {
            steps.push('read:' + name);
            return Promise.resolve(new Uint8Array(PAR1));
          },
        }),
  };
  return { h, steps };
}

function make(opts: { failOn?: (sql: string) => boolean; withReadFile?: boolean } = {}) {
  const made: Array<ReturnType<typeof fakeHandle>> = [];
  const open = vi.fn(() => {
    const f = fakeHandle(opts);
    made.push(f);
    return Promise.resolve(f.h);
  });
  const readBytes = vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3])));
  const runner = new DuckDbRunner({
    fetchText: () => Promise.resolve(PACK),
    open,
    baseUrl: 'https://example.test/app/',
  });
  return { runner, open, readBytes, made };
}

const COPY_STATEMENT =
  "COPY (SELECT * FROM (SELECT * FROM csv\n)) TO 'pkc-export.parquet' (FORMAT PARQUET)";

describe('🔴 Parquet の書き出し(#918 段⑥)', () => {
  it('🔴 打つ順番が「差し込む → 塞ぐ → COPY → 読む → 外す」で、bytes が返る', async () => {
    const { runner, made, readBytes } = make();
    const bytes = await runner.exportParquet({ sql: 'SELECT * FROM csv', sources: [{ source: SRC, readBytes }] });
    expect(Array.from(bytes), '取り出した bytes が返っていない').toEqual(PAR1);
    const steps = made[0]?.steps ?? [];
    expect(steps[2]).toBe(DUCKDB_SEAL_SQL);
    expect(steps.slice(3), '塞いだ後に COPY → 読む → 外す の順').toEqual([
      COPY_STATEMENT,
      'read:pkc-export.parquet',
      'drop:pkc-export.parquet',
    ]);
  });

  it('🔴 書いた file は、COPY が落ちた回も外す(生成物の即破棄)', async () => {
    const { runner, made, readBytes } = make({ failOn: (sql) => sql.startsWith('COPY') });
    await expect(
      runner.exportParquet({ sql: 'SELECT * FROM csv', sources: [{ source: SRC, readBytes }] }),
    ).rejects.toThrow('断られた');
    const steps = made[0]?.steps ?? [];
    expect(steps, '落ちたのに外していない').toContain('drop:pkc-export.parquet');
    expect(steps, '落ちたのに読みに行っている').not.toContain('read:pkc-export.parquet');
  });

  it('🔑 同じ相手なら器を作り直さない(引いた直後に書き出しても、写し直さない)', async () => {
    const { runner, open, made, readBytes } = make();
    await runner.run({ sql: 'SELECT * FROM csv', sources: [{ source: SRC, readBytes }] });
    await runner.exportParquet({ sql: 'SELECT * FROM csv', sources: [{ source: SRC, readBytes }] });
    expect(open, '書き出しのために器を起こし直している').toHaveBeenCalledTimes(1);
    expect(made[0]?.steps.filter((s) => s === DUCKDB_SEAL_SQL), '2 回塞いでいる').toHaveLength(1);
    expect(readBytes, '相手を読み直している').toHaveBeenCalledTimes(1);
  });

  it('🔴 書き込みの SQL と EXPLAIN と COPY は、器に 1 文も打たずに断る', async () => {
    const { runner, open, readBytes } = make();
    for (const sql of ['CREATE TABLE t AS SELECT 1', 'EXPLAIN SELECT 1', "COPY csv TO 'x.csv'", '']) {
      await expect(
        runner.exportParquet({ sql, sources: [{ source: SRC, readBytes }] }),
        sql,
      ).rejects.toThrow();
    }
    expect(open, '断る回で器を起こしている').toHaveBeenCalledTimes(0);
  });

  it('相手が 0 件なら断る(空の器を起こさない)', async () => {
    const { runner, open } = make();
    await expect(runner.exportParquet({ sql: 'SELECT 1', sources: [] })).rejects.toThrow('調べる対象がありません');
    expect(open).toHaveBeenCalledTimes(0);
  });

  it('⚠ 取り出す口が無い取っ手には、理由を言って断る(黙って空の file を返さない)', async () => {
    const { runner, made, readBytes } = make({ withReadFile: false });
    await expect(
      runner.exportParquet({ sql: 'SELECT * FROM csv', sources: [{ source: SRC, readBytes }] }),
    ).rejects.toThrow('書き出せません');
    // 🔑 断る回でも COPY は打っていない(書いたまま残さない)
    expect(made[0]?.steps ?? [], '取り出せないのに COPY を打っている').not.toContain(COPY_STATEMENT);
  });
});
