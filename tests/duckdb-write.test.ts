/**
 * 🔴 **配っている DuckDB に、書き込みの 5 形を実際に打たせる**(#918 段⑧)。
 *
 * ## なぜ engine で見るのか
 *
 * ⚠ 字の門(`tests/features/duckdb-write.test.ts`)が言えるのは「**通した字**」までで、
 *   🔴 その字を **engine が本当に実行できるか**、**外を塞いだ後でも動くか**、
 *   **返ってくる値が `duckDbWriteNote` の読む形か**は 1 バイトも言わない。
 * 🔑 この 3 つは**実測**で決めた(2026-10-01、配っている `duckdb-eh.wasm` を node で起こした):
 *
 * | 打った字(塞いだ後) | 返ってくる物 |
 * |---|---|
 * | `CREATE TABLE t (a INT)` | `Count` の列 / **0 行** |
 * | `CREATE TABLE u AS SELECT …` / `INSERT` / `UPDATE` / `DELETE` | `Count`(Int64)/ **1 行** |
 * | `DROP TABLE t` | `Success` の列 |
 * | `CREATE TABLE x AS SELECT * FROM read_csv_auto('https://…')` | 🔴 `Permission Error`(塞ぎが効いている) |
 *
 * ## ⚠ 何は言えないか
 *
 * node と実ブラウザは**別の経路**である(`tests/duckdb-read-formats.test.ts` の冒頭と同じ)。
 * ここで言えるのは「**この engine で、塞いだ後でも書き込みが動く**」までで、
 * 「画面から打って通る」は `tests/smoke/attach.smoke.spec.ts` が実ブラウザで見る。
 *
 * ⚠ **拡張は読み込まない**(書き込みに拡張は要らない ── 配る拡張と無関係に見られる)。
 *
 * ## ⚠ **node の環境で走らせる**(`@vitest-environment node`)
 */
/** @vitest-environment node */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DUCKDB_SEAL_SQL, duckDbFileNameOf, duckDbLoadSql } from '../src/adapter/platform/duckdb/duckdb-runner';
import { duckDbReadableSourceOf } from '../src/features/query/sql-guest-source';
import { checkDuckDbRunSql, duckDbWriteKind, duckDbWriteNote } from '../src/features/query/duckdb-write';
import { duckDbTable, type DuckDbRaw } from '../src/features/query/duckdb-rows';

const require = createRequire(import.meta.url);
const DIST = dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'));

interface ArrowLike {
  schema: { fields: { name: string; type: unknown }[] };
  toArray: () => { toJSON: () => Record<string, unknown> }[];
}
interface Conn {
  query: (s: string) => ArrowLike;
}

let conn: Conn | null = null;

/** 製品の `openDuckDb().query` と同じ形(列 / 型 / 行)へ揃える。 */
function ask(sql: string): DuckDbRaw {
  const table = (conn as Conn).query(sql);
  const columns = table.schema.fields.map((f) => f.name);
  return {
    columns,
    types: table.schema.fields.map((f) => String(f.type)),
    rows: table.toArray().map((r) => {
      const o = r.toJSON();
      return columns.map((c) => o[c]);
    }),
  };
}

/** 門を通してから打つ(製品と同じ順番)。⚠ 門が断った字は engine へ渡さない。 */
function run(input: string): { raw: DuckDbRaw; note: string } {
  const checked = checkDuckDbRunSql(input);
  if (!checked.ok) throw new Error(`門が断った: ${checked.why}`);
  const raw = ask(checked.sql);
  const t = duckDbTable(raw);
  const kind = duckDbWriteKind(checked.sql);
  return { raw, note: kind === null ? '' : duckDbWriteNote(kind, t.columns, t.rows) };
}

beforeAll(async () => {
  const mod = (await import(/* @vite-ignore */ join(DIST, 'duckdb-node-blocking.cjs'))) as unknown as {
    default?: Record<string, unknown>;
  };
  const duck = (mod.default ?? mod) as {
    ConsoleLogger: new (l: unknown) => unknown;
    LogLevel: { ERROR: unknown };
    NODE_RUNTIME: unknown;
    createDuckDB: (b: unknown, l: unknown, r: unknown) => Promise<{
      instantiate: () => Promise<unknown>;
      connect: () => Conn;
      registerFileBuffer: (name: string, bytes: Uint8Array) => void;
    }>;
  };
  const db = await duck.createDuckDB(
    {
      mvp: { mainModule: join(DIST, 'duckdb-mvp.wasm'), mainWorker: null },
      eh: { mainModule: join(DIST, 'duckdb-eh.wasm'), mainWorker: null },
    },
    new duck.ConsoleLogger(duck.LogLevel.ERROR),
    duck.NODE_RUNTIME,
  );
  await db.instantiate();
  const c = db.connect();
  conn = c;
  /**
   * 🔑 **製品と同じ順番**で器を作る(`DuckDbRunner.load`):差し込む → 写し切る → **塞ぐ**。
   * ⚠ 塞いだ後の器で書き込みが動くことが、この file の主張である。
   */
  const src = duckDbReadableSourceOf('lid-1', '売上.csv');
  if (src === null) throw new Error('前提が崩れている(売上.csv が DuckDB へ渡せる形にならない)');
  const file = duckDbFileNameOf(src);
  db.registerFileBuffer(file, new TextEncoder().encode('id,品名\n1,牛乳\n2,パン\n3,卵\n'));
  c.query(duckDbLoadSql(src, file));
  c.query(DUCKDB_SEAL_SQL);
}, 120_000);

describe('🔴 塞いだ後の器で、書き込みの 5 形が動く(実物の engine)', () => {
  it('前提 ── 写した表が引け、外は塞がっている(対照群)', () => {
    expect(duckDbTable(ask('SELECT count(*) AS n FROM csv')).rows).toEqual([[3]]);
    // 🔴 外を読む道は塞がっている ── 書き込みを通しても、ここは開いていない
    expect(() => ask("SELECT * FROM read_csv_auto('source.csv')"), '塞いだのに file を読み直せる').toThrow();
  });

  it('🔴 CREATE TABLE(AS 無し)── 0 行を返し、「実行しました」と言う', () => {
    const { raw, note } = run('CREATE TABLE memo (k INT, v TEXT)');
    expect(raw.rows).toHaveLength(0);
    expect(note).toBe('実行しました ── 作った表はウィンドウを閉じると消えます');
  });

  it('🔴 INSERT ── 件数が返り、入れた行が引ける', () => {
    const { note } = run("INSERT INTO memo VALUES (1, 'a'), (2, 'b'), (3, 'c')");
    expect(note).toBe('3 行に効きました ── 元の file は書き換わりません');
    expect(duckDbTable(ask('SELECT k, v FROM memo ORDER BY k')).rows).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
  });

  it('🔴 UPDATE ── 効いた行数が出て、値が変わる', () => {
    const { note } = run("UPDATE memo SET v = 'z' WHERE k >= 2");
    expect(note).toContain('2 行に効きました');
    expect(duckDbTable(ask('SELECT v FROM memo ORDER BY k')).rows).toEqual([['a'], ['z'], ['z']]);
  });

  it('🔴 DELETE ── 効いた行数が出て、行が減る(0 行にも効いたと言える)', () => {
    expect(run('DELETE FROM memo WHERE k = 3').note).toContain('1 行に効きました');
    expect(run('DELETE FROM memo WHERE k = 999').note).toContain('0 行に効きました');
    expect(duckDbTable(ask('SELECT count(*) AS n FROM memo')).rows).toEqual([[2]]);
  });

  it('🔴 CREATE TABLE … AS SELECT ── 写した表から作れる(件数つき)', () => {
    const { note } = run('CREATE TABLE copy_of_csv AS SELECT * FROM csv WHERE id >= 2');
    expect(note).toBe('2 行に効きました ── 作った表はウィンドウを閉じると消えます');
    expect(duckDbTable(ask('SELECT id FROM copy_of_csv ORDER BY id')).rows).toEqual([[2], [3]]);
  });

  it('🔴 元の表を書き換えても、写した表だけが変わる(file は 1 バイトも動かない)', () => {
    run("UPDATE csv SET 品名 = '書き換えた' WHERE id = 1");
    expect(duckDbTable(ask('SELECT 品名 FROM csv WHERE id = 1')).rows).toEqual([['書き換えた']]);
  });

  it('🔴 DROP TABLE ── 消えて、引くと断られる', () => {
    expect(run('DROP TABLE copy_of_csv').note).toBe('実行しました');
    expect(() => ask('SELECT * FROM copy_of_csv')).toThrow();
    // ⚠ 無い表に IF EXISTS を付ければ通る
    expect(() => run('DROP TABLE IF EXISTS copy_of_csv')).not.toThrow();
  });

  it('🔴 外へ出る書き方は、書き込みの中でも engine が断る(塞ぎは字の門に頼らない)', () => {
    // ⚠ 字の門は通る(白名簿に合う形)── 断るのは engine である
    for (const sql of [
      "CREATE TABLE leak AS SELECT * FROM read_csv_auto('https://example.com/a.csv')",
      "INSERT INTO memo SELECT * FROM read_csv_auto('https://example.com/a.csv')",
      "CREATE TABLE leak2 AS SELECT * FROM read_csv_auto('source.csv')",
    ]) {
      expect(checkDuckDbRunSql(sql).ok, `前提が崩れている(字の門が断っている): ${sql}`).toBe(true);
      expect(() => ask(sql), `塞いだのに通った: ${sql}`).toThrow(/Permission|disabled/u);
    }
    expect(() => ask('SELECT * FROM leak')).toThrow();
  });
});
