/**
 * 🔴 **図から組んだ字が、本物の sqlite で本当に動くか**(#918 段⑤b/⑤c)。
 *
 * ## ⚠ これが無いと、緑のまま壊れる
 *
 * `tests/features/er-sql.test.ts` は**組んだ字を字として**見るだけである ──
 * 引用符の当て方・`join` の綴り・列の修飾を 1 文字間違えても、
 * **字の比較は合っていれば緑**になる。
 * 🔑 だから**本物の sqlite に打って、返ってきた行まで見る**
 * (`schema-digest-real-sqlite.test.ts` と同じ呼び方)。
 *
 * ## 🔑 もう 1 つ ── 構造は「本物から採った物」を使う
 *
 * ⚠ 手で組んだ `SchemaModel` で試すと、**採る側(段①)と組む側(段⑤)の
 *   食い違い**が見えない(CLAUDE.md §7「両端が相手を模した stub と話している」)。
 * だから **`pragma_table_info` / `pragma_foreign_key_list` で実際に採った物**を
 * `schemaModel()` に通し、その値から図を組む。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  SCHEMA_COLUMNS_SQL,
  SCHEMA_FK_SQL,
  schemaModel,
  type Cell,
  type Grid,
  type SchemaModel,
} from '../../src/features/query/schema-digest';
import { erLayout } from '../../src/features/query/er-layout';
import { erSql, type ErAction } from '../../src/features/query/er-sql';
import { checkReadOnlySql } from '../../src/features/query/sql-guard';

interface Db {
  selectValue: (sql: string) => unknown;
  exec: (opts: { sql: string; callback?: (row: unknown[]) => void; rowMode?: 'array' }) => void;
}
interface Sqlite3 {
  oo1: { DB: new (file: string, mode: string) => Db };
}

let db: Db;
let model: SchemaModel;

/**
 * 打って、**列名つき**で採る。
 * ⚠ 列名は `db.exec` からは返らないので、こちらで名指しする ──
 *   `schemaModel` は列の順に依らず**名前で**読むので、ここが正本になる。
 */
function grid(sql: string, columns: string[]): Grid {
  const rows: Cell[][] = [];
  db.exec({
    sql,
    rowMode: 'array',
    callback: (r) => {
      rows.push(r as Cell[]);
    },
  });
  return { columns, rows };
}

beforeAll(async () => {
  const api = (await sqlite3InitModule()) as unknown as Sqlite3;
  db = new api.oo1.DB(':memory:', 'c');
  db.exec({ sql: 'create table 客(id integer primary key, 名前 text not null)' });
  db.exec({
    sql: 'create table 売上(id integer primary key, 客id integer references 客(id), 金額 int)',
  });
  db.exec({ sql: "insert into 客(id, 名前) values (1, 'あや'), (2, 'いと')" });
  db.exec({ sql: 'insert into 売上(id, 客id, 金額) values (1, 1, 300), (2, 2, 500), (3, 1, 120)' });
  model = schemaModel({
    source: 'ためし',
    columns: grid(SCHEMA_COLUMNS_SQL, ['kind', 'tbl', 'cid', 'col', 'typ', 'nn', 'pk']),
    fks: grid(SCHEMA_FK_SQL, ['tbl', 'ref', 'col', 'refcol']),
  });
});

/** 図から押した所を順に当てて、最後の字を返す。⚠ 途中で足せなければそこで落とす。 */
function press(actions: readonly ErAction[]): string {
  let s = '';
  for (const a of actions) {
    const r = erSql(s, a);
    if (!r.ok) throw new Error(`足せなかった(${JSON.stringify(a)}): ${r.why}`);
    s = r.sql;
  }
  return s;
}

/** 打った答えの行。 */
function run(sql: string): Cell[][] {
  const rows: Cell[][] = [];
  db.exec({
    sql,
    rowMode: 'array',
    callback: (r) => {
      rows.push(r as Cell[]);
    },
  });
  return rows;
}

describe('図から組んだ字が、本物の sqlite で動く(#918 段⑤)', () => {
  /** ⚠ **空振り防止** ── 構造が採れていないと、下の主張は全部「通った」に見える。 */
  it('⚠ まず、本物から採った構造に 2 つの表と 1 本の繋がりが在る', () => {
    expect(model.tables.map((t) => t.name).sort()).toEqual(['売上', '客']);
    expect(model.links, '外部キーが採れていない').toEqual([
      { from: '売上', fromColumn: '客id', to: '客', toColumn: 'id' },
    ]);
  });

  it('🔴 その構造から図を組むと、線が 1 本引ける(落ちた物は 0)', () => {
    const d = erLayout(model);
    expect(d.boxes.length).toBe(2);
    expect(d.lines.length, '線が引けていない').toBe(1);
    expect(d.dropped, '引けなかった繋がりがある').toEqual([]);
    // 🔑 指されている表(客)が先頭 = 左上へ来る
    expect(d.boxes[0]!.table.name).toBe('客');
  });

  it('🔴 表を押す → 走る(打った字が sqlite の構文として通る)', () => {
    const s = press([{ kind: 'table', table: '売上' }]);
    expect(s).toBe('select * from 売上');
    expect(run(s).length, '3 行返らない').toBe(3);
  });

  it('🔴 表 → 列 → 線 → 列 と押した字が、狙った答えを返す', () => {
    const d = erLayout(model);
    const link = d.lines[0]!.link;
    const s = press([
      { kind: 'table', table: '売上' },
      { kind: 'column', table: '売上', column: '金額' },
      { kind: 'link', link },
      { kind: 'column', table: '客', column: '名前' },
    ]);
    // ⚠ 門も通ること(走らせる前に断られない)
    expect(checkReadOnlySql(s).ok, `組んだ字が門で断られた: ${s}`).toBe(true);
    const rows = run(s);
    // 🔑 ここが本題 ── **返ってきた行**まで見る(字が合っているだけでは足りない)
    expect(rows.length, '3 行の売上が返らない').toBe(3);
    expect([...rows].sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [120, 'あや'],
      [300, 'あや'],
      [500, 'いと'],
    ]);
  });

  it('🔴 予約語や記号を含む名前でも動く(引用符の当て方が正しい)', () => {
    db.exec({ sql: 'create table "order"("group" integer, "a b" text)' });
    db.exec({ sql: `insert into "order"("group", "a b") values (7, 'x')` });
    const s = press([
      { kind: 'table', table: 'order' },
      { kind: 'column', table: 'order', column: 'group' },
      { kind: 'column', table: 'order', column: 'a b' },
    ]);
    expect(s).toBe('select "group", "a b" from "order"');
    expect(run(s)).toEqual([[7, 'x']]);
  });

  it('⚠ 対照群 ── 引用符を外すと、同じ字は sqlite に断られる', () => {
    // 🔑 上の test が「囲っているから通った」ことの裏取り(囲わない字は本当に落ちる)
    expect(() => {
      db.exec({ sql: 'select group from order' });
    }).toThrow();
  });
});
