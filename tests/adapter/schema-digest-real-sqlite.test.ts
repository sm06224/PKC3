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
  NOT_SQLITE_INTERNAL_SQL,
  SCHEMA_COLUMNS_SQL,
  SCHEMA_FK_SQL,
  countsSql,
  renderSchemaDigest,
  type Cell,
} from '../../src/features/query/schema-digest';
import { checkReadOnlySql } from '../../src/features/query/sql-guard';
import { SCHEMA_DDL } from '../../src/adapter/platform/storage/schema';

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
  db.exec({ sql: "insert into 親(id, 名前) values (1, 'ゐ'), (2, 'ゑ')" });
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
    expect(out, '中身が混ざっている').not.toContain('ゐ');
  });
});

/**
 * 🔴 **本文検索の影の表を、図から外す**(#967。user ではなく Gemini の裁定 2026-10-01 = 答え B)。
 *
 * ⚠ 実物の DDL(`SCHEMA_DDL`)をそのまま流す ── 自前の表で「影が 5 つ」と言っても、
 *   本物の FTS5 がいくつ作るかは別の話である(数えたら 13 → 8 になる)。
 * 🔑 **字面で外していないこと**は、`sales_data`(user が csv から作る表の名前)が
 *   残ることで見る ── `_data` で終わる名前を外す実装は、ここで落ちる。
 */
describe('本文検索の影の表は図に出さない(#967)', () => {
  let app: Db;
  const tablesOf = (d: Db): string[] => {
    const rows: unknown[][] = [];
    d.exec({ sql: SCHEMA_COLUMNS_SQL, rowMode: 'array', callback: (r) => rows.push(r) });
    return [...new Set(rows.map((r) => String(r[1])))];
  };
  beforeAll(async () => {
    const api = (await sqlite3InitModule()) as unknown as Sqlite3;
    app = new api.oo1.DB(':memory:', 'c');
    for (const ddl of SCHEMA_DDL) app.exec({ sql: ddl });
  });

  it('⚠ 前提 ── 実物の DB に、影の表が 5 つ在る(外さなければ 13 個出る)', () => {
    const names: string[] = [];
    app.exec({
      sql: "select name from sqlite_master where type = 'table' and name like 'entries_fts%'",
      rowMode: 'array',
      callback: (r) => names.push(String(r[0])),
    });
    expect(names.sort(), '影の表が 5 つ無い(前提が崩れている)').toEqual([
      'entries_fts',
      'entries_fts_config',
      'entries_fts_data',
      'entries_fts_docsize',
      'entries_fts_idx',
    ]);
  });

  it('🔴 図の箱は 13 から 8 になる(この PKC 自身の表だけ)', () => {
    expect(tablesOf(app).sort()).toEqual([
      'assets',
      'containers',
      'entries',
      'flags',
      'relations',
      'revisions',
      'settings',
      'workspaces',
    ]);
  });

  it('🔴 `_data` で終わる user の表(sales_data)は巻き込まない(字面で外していない対照群)', () => {
    app.exec({ sql: 'create table sales_data(id integer primary key, v text)' });
    app.exec({ sql: 'create table entries_fts_data_memo(a)' });
    try {
      const t = tablesOf(app);
      expect(t, '字面で外している ── user の表まで消えた').toContain('sales_data');
      // ⚠ 影の名前に**前方一致するだけ**の別物も残る(導く名前は完全一致)
      expect(t, '前方一致で外している').toContain('entries_fts_data_memo');
      expect(t, '影の表が図に出ている').not.toContain('entries_fts_data');
    } finally {
      app.exec({ sql: 'drop table sales_data' });
      app.exec({ sql: 'drop table entries_fts_data_memo' });
    }
  });

  it('🔴 別の名前の本文検索(FTS5)でも、影を名前から導いて外す', () => {
    app.exec({ sql: 'create virtual table memo using fts5(body)' });
    try {
      const t = tablesOf(app);
      for (const x of ['memo', 'memo_data', 'memo_idx', 'memo_docsize', 'memo_config']) {
        expect(t, `${x} が図に出ている`).not.toContain(x);
      }
    } finally {
      app.exec({ sql: 'drop table memo' });
    }
  });

  it('🔴 外すのは図だけ ── `select` では引き続き打てる', () => {
    const rows: unknown[][] = [];
    expect(() =>
      app.exec({ sql: 'select count(*) from entries_fts_data', rowMode: 'array', callback: (r) => rows.push(r) }),
    ).not.toThrow();
    expect(rows).toHaveLength(1);
    // ⚠ 打つ前の門(白名簿)も通る ── 外したのは図の問い合わせで、門ではない
    expect(checkReadOnlySql('select count(*) from entries_fts_data').ok, '門が断っている').toBe(true);
    // ⚠ 打てる側の対照群 ── 仮想表そのものも引ける
    expect(() => app.exec({ sql: 'select count(*) from entries_fts', rowMode: 'array', callback: () => {} })).not.toThrow();
  });
});

/**
 * 🔴 **`sqlite_` で始まらない名前を、内部の表と取り違えない**(#682 段④d の着地後レビュー S)。
 *
 * ⚠ `LIKE` の `_` は**任意の 1 字**。素の `not like 'sqlite_%'` は `sqlitedata` / `sqlite1` のような
 *   **user の表を、構造にも図にも出さなかった**(表は在るのに、構造を見ても無い)。
 *   `.sqlite` を DuckDB へ写す側は同じ欠陥を直してあり、構造を採る側にだけ残っていた。
 */
describe('🔴 内部の表だけを外す(`sqlitedata` は出る / `sqlite_sequence` と `sqlite_stat1` は出ない)', () => {
  it('列を採る字も、繋がりを採る字も(本物の sqlite で)', async () => {
    const api = (await sqlite3InitModule()) as unknown as Sqlite3;
    const d = new api.oo1.DB(':memory:', 'c');
    d.exec({ sql: 'create table sqlitedata (n integer primary key)' });
    d.exec({ sql: 'create table sqlite1 (id integer primary key, ref integer references sqlitedata(n))' });
    // 内部の表(対照群):AUTOINCREMENT は sqlite_sequence を、ANALYZE は sqlite_stat1 を作る
    d.exec({ sql: 'create table seq (id integer primary key autoincrement, v text)' });
    d.exec({ sql: "insert into seq (v) values ('x')" });
    d.exec({ sql: 'create index seq_v on seq(v)' });
    d.exec({ sql: 'analyze' });
    // ⚠ 前提:内部の表が本当に在る(無いと「外れている」が空振りで緑になる)
    const internal: string[] = [];
    d.exec({
      sql: "select name from sqlite_master where name like 'sqlite\\_%' escape '\\'",
      rowMode: 'array',
      callback: (r) => internal.push(String(r[0])),
    });
    expect(internal, '前提が崩れている(内部の表が無い)').toEqual(
      expect.arrayContaining(['sqlite_sequence', 'sqlite_stat1']),
    );

    const cols: unknown[][] = [];
    d.exec({ sql: SCHEMA_COLUMNS_SQL, rowMode: 'array', callback: (r) => cols.push(r) });
    const names = [...new Set(cols.map((r) => String(r[1])))].sort();
    expect(names, 'sqlitedata / sqlite1 が黙って外れた').toEqual(['seq', 'sqlite1', 'sqlitedata']);
    const fks: unknown[][] = [];
    d.exec({ sql: SCHEMA_FK_SQL, rowMode: 'array', callback: (r) => fks.push(r) });
    expect(fks.map((r) => r.map(String)), 'sqlite1 の外部キーが外れた').toEqual([
      ['sqlite1', 'sqlitedata', 'ref', 'n'],
    ]);
  });

  it('字そのものも ESCAPE を宣言している(`_` を素で LIKE へ渡さない)', () => {
    expect(NOT_SQLITE_INTERNAL_SQL).toContain("escape '\\'");
    expect(SCHEMA_COLUMNS_SQL).toContain(NOT_SQLITE_INTERNAL_SQL);
    expect(SCHEMA_FK_SQL).toContain(NOT_SQLITE_INTERNAL_SQL);
    expect(SCHEMA_COLUMNS_SQL, '素の `_` が LIKE へ渡っている').not.toContain("'sqlite_%'");
    expect(SCHEMA_FK_SQL, '素の `_` が LIKE へ渡っている').not.toContain("'sqlite_%'");
  });
});
