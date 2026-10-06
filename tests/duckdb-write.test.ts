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
import { checkDuckDbRunSql, DUCKDB_TABLE_RESET, duckDbWriteKind, duckDbWriteNote } from '../src/features/query/duckdb-write';
import { duckDbTable, type DuckDbRaw } from '../src/features/query/duckdb-rows';
import { duckDbTableNamesOf } from '../src/features/query/sql-multi-source';

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

/** 実物の engine を起こす(node 版)。⚠ 器を塞ぐと二度と開けられないので、**シナリオごとに 1 つ**起こす。 */
interface DuckDbLike {
  instantiate: () => Promise<unknown>;
  connect: () => Conn;
  registerFileBuffer: (name: string, bytes: Uint8Array) => void;
}
async function newDb(): Promise<DuckDbLike> {
  const mod = (await import(/* @vite-ignore */ join(DIST, 'duckdb-node-blocking.cjs'))) as unknown as {
    default?: Record<string, unknown>;
  };
  const duck = (mod.default ?? mod) as {
    ConsoleLogger: new (l: unknown) => unknown;
    LogLevel: { ERROR: unknown };
    NODE_RUNTIME: unknown;
    createDuckDB: (b: unknown, l: unknown, r: unknown) => Promise<DuckDbLike>;
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
  return db;
}

beforeAll(async () => {
  const db = await newDb();
  const c = db.connect();
  conn = c;
  /**
   * 🔑 **製品と同じ順番**で器を作る(`DuckDbRunner.load`):差し込む → 写し切る → **塞ぐ**。
   * ⚠ 塞いだ後の器で書き込みが動くことが、この file の主張である。
   */
  const src = duckDbReadableSourceOf('lid-1', '売上.csv');
  if (src === null || src.kind === 'sqlite') throw new Error('前提が崩れている(売上.csv が DuckDB へ渡せる形にならない)');
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
    expect(note).toBe(`実行しました: 作った表はウィンドウを閉じると消えます。${DUCKDB_TABLE_RESET}`);
  });

  it('🔴 INSERT ── 件数が返り、入れた行が引ける', () => {
    const { note } = run("INSERT INTO memo VALUES (1, 'a'), (2, 'b'), (3, 'c')");
    expect(note).toBe('3 行が変更されました。元のファイルは書き換わりません');
    expect(duckDbTable(ask('SELECT k, v FROM memo ORDER BY k')).rows).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
  });

  it('🔴 UPDATE ── 効いた行数が出て、値が変わる', () => {
    const { note } = run("UPDATE memo SET v = 'z' WHERE k >= 2");
    expect(note).toContain('2 行が変更されました');
    expect(duckDbTable(ask('SELECT v FROM memo ORDER BY k')).rows).toEqual([['a'], ['z'], ['z']]);
  });

  it('🔴 DELETE ── 効いた行数が出て、行が減る(0 行にも効いたと言える)', () => {
    expect(run('DELETE FROM memo WHERE k = 3').note).toContain('1 行が変更されました');
    expect(run('DELETE FROM memo WHERE k = 999').note).toContain('0 行が変更されました');
    expect(duckDbTable(ask('SELECT count(*) AS n FROM memo')).rows).toEqual([[2]]);
  });

  it('🔴 CREATE TABLE … AS SELECT ── 写した表から作れる(件数つき)', () => {
    const { note } = run('CREATE TABLE copy_of_csv AS SELECT * FROM csv WHERE id >= 2');
    expect(note).toBe(`2 行が変更されました: 作った表はウィンドウを閉じると消えます。${DUCKDB_TABLE_RESET}`);
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

/**
 * 🔴 **2 つの file を 1 つの器へ並べて、1 つの SQL で JOIN する**(#918 段⑦。実物の engine)。
 *
 * ⚠ 製品(`DuckDbRunner.load`)と**同じ順番・同じ名前**で器を作る:
 *   全部の file を差し込んで写す → **最後に 1 度だけ塞ぐ** → user の字。
 *   名前は `duckDbTableNamesOf`(画面の案内と**同じ 1 本**)から取る ── 画面に出る名前で引けること。
 * ⚠ node と実ブラウザは別の経路(冒頭)── 画面から打って通るのは smoke が見る。
 */
describe('🔴 2 つの file を並べて、JOIN で突き合わせられる(実物の engine)', () => {
  let multi: Conn | null = null;
  const q = (sql: string): DuckDbRaw => {
    const table = (multi as Conn).query(sql);
    const columns = table.schema.fields.map((f) => f.name);
    return {
      columns,
      types: table.schema.fields.map((f) => String(f.type)),
      rows: table.toArray().map((r) => {
        const o = r.toJSON();
        return columns.map((c) => o[c]);
      }),
    };
  };

  beforeAll(async () => {
    const db = await newDb();
    const c = db.connect();
    multi = c;
    const files = [
      { lid: 'a', name: '売上.csv', text: '品番,数\nA1,3\nB2,5\nC3,7\n' },
      { lid: 'b', name: '2024-在庫.tsv', text: '品番\t在庫\nA1\t100\nC3\t30\nD4\t9\n' },
    ];
    const sources = files.map((f) => {
      const s = duckDbReadableSourceOf(f.lid, f.name);
      if (s === null || s.kind === 'sqlite') throw new Error(`前提が崩れている(${f.name})`);
      return s;
    });
    const tables = duckDbTableNamesOf(sources);
    sources.forEach((s, i) => {
      const file = duckDbFileNameOf(s, i);
      db.registerFileBuffer(file, new TextEncoder().encode(files[i]!.text));
      c.query(duckDbLoadSql(s, file, tables[i]));
    });
    c.query(DUCKDB_SEAL_SQL);
  }, 120_000);

  it('🔴 表の名前は file 名から(csv ではない)。数字で始まる名前は _ が付く', () => {
    const names = duckDbTable(q("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name")).rows.map((r) => r[0]);
    expect(names).toEqual(['_2024_在庫', '売上']);
  });

  it('🔴 2 つの表を JOIN した結果が返る(両方の file の列が 1 行に並ぶ)', () => {
    const r = duckDbTable(
      q('SELECT 売上.品番 AS 品番, 売上.数 AS 数, _2024_在庫.在庫 AS 在庫 FROM 売上 JOIN _2024_在庫 ON 売上.品番 = _2024_在庫.品番 ORDER BY 売上.品番'),
    );
    expect(r.columns).toEqual(['品番', '数', '在庫']);
    expect(r.rows).toEqual([
      ['A1', 3, 100],
      ['C3', 7, 30],
    ]);
  });

  it('🔴 どの file の行かは _note / _lid の列で分かる(csv / tsv の表)', () => {
    const r = duckDbTable(q('SELECT DISTINCT _note, _lid FROM _2024_在庫'));
    expect(r.rows).toEqual([['2024-在庫.tsv', 'b']]);
  });

  it('🔴 塞ぎは 2 件を並べた後でも効いている(外へは出られない / file を読み直せない)', () => {
    expect(() => q("SELECT * FROM read_csv_auto('source.csv')"), '塞いだのに file を読み直せる').toThrow();
    expect(() => q("SELECT * FROM read_csv_auto('source_2.tsv')"), '2 件目の file を読み直せる').toThrow();
    expect(() => q("SELECT * FROM read_csv_auto('https://example.com/a.csv')")).toThrow(/Permission|disabled/u);
  });

  it('作った表を JOIN に使える(書き込みと並べるが両立する)', () => {
    q('CREATE TABLE 結果 AS SELECT 売上.品番 AS 品番 FROM 売上 JOIN _2024_在庫 USING (品番)');
    expect(duckDbTable(q('SELECT count(*) AS n FROM 結果')).rows).toEqual([[2]]);
  });
});
