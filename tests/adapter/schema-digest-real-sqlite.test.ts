/**
 * 🔴 **組む字が、本物の sqlite で通るか**(#918 段①)。
 *
 * ## ⚠ これが無いと、緑のまま壊れる
 *
 * `tests/features/schema-digest.test.ts` は**組んだ字を字として**見るだけで、
 * `tests/adapter/sql-pane.test.ts` の worker は**偽物**である
 * (打たれた字の一部を見て、決めた答えを返すだけ)。
 * 🔴 **つまり、組んだ 3 本が sqlite の構文として通るかを、どこも見ていなかった。**
 * ⚠ 通らなければ機能は丸ごと動かないのに、**test は全部緑**である
 * (CLAUDE.md §2「経路が一度も通っていない」)。
 *
 * 🔑 だから**本物の sqlite に打つ** ── `sqlite-capabilities.test.ts` と同じ呼び方で、
 *   同梱の実物を `:memory:` で開く。
 *
 * ## 🔴 いちばん確かめたいこと
 *
 * この設計の肝は「**門にも worker にも 1 行も足さずに構造を採る**」ことで、
 * その土台は **`pragma_table_info(...)` が表の形で引ける**という 1 点に乗っている。
 * ⚠ そこが成り立たなければ、設計ごと崩れる ── だから
 * **`PRAGMA query_only = 1` を立てた下でも通る**ことまで見る。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  SCHEMA_COLUMNS_SQL,
  SCHEMA_FK_SQL,
  countsSql,
  renderSchemaDigest,
  type Cell,
} from '../../src/features/query/schema-digest';

interface Db {
  selectValue: (sql: string) => unknown;
  exec: (opts: { sql: string; callback?: (row: unknown[]) => void; rowMode?: 'array' }) => void;
}
interface Sqlite3 {
  oo1: { DB: new (file: string, mode: string) => Db };
}

let db: Db;

beforeAll(async () => {
  // ⚠ 引数を渡さない ── 実装(`storage-worker.ts`)と**同じ呼び方**にする
  const api = (await sqlite3InitModule()) as unknown as Sqlite3;
  db = new api.oo1.DB(':memory:', 'c');
  db.exec({ sql: 'create table 親(id integer primary key, 名前 text not null)' });
  db.exec({
    sql: 'create table 子(id integer primary key, 親id integer references 親(id), 数 int)',
  });
  db.exec({ sql: 'create view 見え as select 名前 from 親' });
  db.exec({ sql: "insert into 親(id, 名前) values (1, 'あ'), (2, 'い')" });
});

describe('組む 3 本が、本物の sqlite で通る(#918 段①)', () => {
  /** ⚠ **空振り防止** ── DB が開けていないと、下の主張は全部「通った」に見える。 */
  it('⚠ まず DB が開いていて、ふつうの select が動く', () => {
    expect(db.selectValue('select count(*) from 親')).toBe(2);
  });

  it('🔴 列を採る字が通り、表もビューも拾う', () => {
    const rows: unknown[][] = [];
    db.exec({ sql: SCHEMA_COLUMNS_SQL, rowMode: 'array', callback: (r) => rows.push(r) });
    const tbls = new Set(rows.map((r) => String(r[1])));
    expect(tbls, '表を拾えていない').toContain('親');
    expect(tbls, 'ビューを拾えていない').toContain('見え');
    // 🔴 sqlite 自身の作業表は**出さない**(user の構造ではない)
    for (const t of tbls) expect(t.startsWith('sqlite_'), `${t} は出してはいけない`).toBe(false);
    // ⚠ 主キーと「空を許すか」が本当に採れている(0/1 が返る)
    const pk = rows.find((r) => String(r[1]) === '親' && String(r[3]) === 'id');
    expect(pk?.[6], '主キーの印が採れていない').toBe(1);
    const nn = rows.find((r) => String(r[1]) === '親' && String(r[3]) === '名前');
    expect(nn?.[5], '「空を許さない」が採れていない').toBe(1);
  });

  it('🔴 繋がりを採る字が通り、外部キーが出る', () => {
    const rows: unknown[][] = [];
    db.exec({ sql: SCHEMA_FK_SQL, rowMode: 'array', callback: (r) => rows.push(r) });
    expect(rows.map((r) => r.map(String)), '外部キーが採れていない').toContainEqual([
      '子',
      '親',
      '親id',
      'id',
    ]);
  });

  it('🔴 行数を採る字が通る(日本語の名前でも壊れない)', () => {
    const sql = countsSql(['親', '子'])!;
    const rows: unknown[][] = [];
    db.exec({ sql, rowMode: 'array', callback: (r) => rows.push(r) });
    expect(rows.map((r) => [String(r[0]), r[1]])).toEqual([
      ['子', 0],
      ['親', 2],
    ]);
  });

  /**
   * 🔴 **この設計の肝**(ここが落ちたら、設計ごと崩れる)。
   * ⚠ 実物の worker は `PRAGMA query_only = 1` を立ててから打つので、
   *   **その下で通らなければ意味が無い**。
   */
  it('🔴 `PRAGMA query_only = 1` の下でも 3 本とも通る(門を緩めずに採れる)', () => {
    db.exec({ sql: 'pragma query_only = 1' });
    try {
      for (const [name, sql] of [
        ['列', SCHEMA_COLUMNS_SQL],
        ['繋がり', SCHEMA_FK_SQL],
        ['行数', countsSql(['親'])!],
      ] as const) {
        expect(() => db.exec({ sql, rowMode: 'array', callback: () => {} }), `${name}が通らない`).not.toThrow();
      }
      // ⚠ **対照群** ── 同じ状態で書き込みは断られる(境が本当に立っている)
      expect(() => db.exec({ sql: 'create table z(a)' }), '境が立っていない').toThrow();
    } finally {
      db.exec({ sql: 'pragma query_only = 0' });
    }
  });

  /**
   * 🔴 **端から端まで** ── 本物の答えを、そのまま組み立てへ流す。
   * ⚠ 途中の形(列名の綴り)が食い違っていたら、ここで出ない字が出る。
   */
  it('🔴 本物の答えから組んだ 1 枚が、ちゃんと読める', () => {
    const cols = { columns: ['kind', 'tbl', 'cid', 'col', 'typ', 'nn', 'pk'], rows: [] as Cell[][] };
    db.exec({
      sql: SCHEMA_COLUMNS_SQL,
      rowMode: 'array',
      callback: (r) => cols.rows.push(r.map((v) => (v as Cell) ?? null)),
    });
    const fks = { columns: ['tbl', 'ref', 'col', 'refcol'], rows: [] as Cell[][] };
    db.exec({
      sql: SCHEMA_FK_SQL,
      rowMode: 'array',
      callback: (r) => fks.rows.push(r.map((v) => (v as Cell) ?? null)),
    });
    const counts = { columns: ['tbl', 'n'], rows: [] as Cell[][] };
    db.exec({
      sql: countsSql(['親', '子'])!,
      rowMode: 'array',
      callback: (r) => counts.rows.push(r.map((v) => (v as Cell) ?? null)),
    });
    const out = renderSchemaDigest({ source: 'ためし', columns: cols, fks, counts });
    expect(out, '表と行数が出ていない').toContain('## 親(表・2 行)');
    expect(out, 'ビューだと分からない').toContain('## 見え(ビュー)');
    expect(out, '主キーが出ていない').toContain('| id | INTEGER | 可 | 主キー |');
    expect(out, '繋がりが出ていない').toContain('- 子.親id → 親.id');
    expect(out, '中身を出していないと言っていない').toContain('中身は 1 行も含まれていません');
    // 🔴 **中身は 1 文字も出ない**(入れた値そのもので見る)
    expect(out, '中身が混ざっている').not.toContain('あ');
  });
});
