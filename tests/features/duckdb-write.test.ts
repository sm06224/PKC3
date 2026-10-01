/**
 * 🔴 **DuckDB のときだけ「書く」文を通す門**(#918 段⑧)。
 *
 * ⚠ 見たいのは 4 方向で、**どれか 1 つでも欠けると門は空振りする**:
 * ① DuckDB で書き込みの 5 形が**通る**(通らないと user の動線が減る)
 * ② 🔴 **sqlite の門は 1 バイトも変わっていない**(同じ字を sqlite で打つと**今までどおり断る**)
 * ③ DuckDB でも**白名簿の外は断る**(`CREATE VIEW` / `UPDATE EXTENSIONS` / `ATTACH` …)
 * ④ 読むだけの門(`checkDuckDbSql`)の規律が**そのまま生きている**
 */
import { describe, expect, it } from 'vitest';
import {
  DUCKDB_TABLE_LIFETIME,
  DUCKDB_TABLE_RESET,
  DUCKDB_WRITE_FORMS,
  checkDuckDbRunSql,
  duckDbWriteKind,
  duckDbWriteNote,
} from '../../src/features/query/duckdb-write';
import { checkDuckDbSql } from '../../src/features/query/duckdb-guard';
import { checkReadOnlySql } from '../../src/features/query/sql-guard';

/** 命令 × engine の表(画面の約束)。 */
const WRITES: ReadonlyArray<readonly [string, string]> = [
  ['create', 'CREATE TABLE t (a INT)'],
  ['create', 'CREATE TABLE t AS SELECT * FROM csv'],
  ['create', 'CREATE OR REPLACE TABLE t AS SELECT 1 AS x'],
  ['create', 'CREATE TEMP TABLE t AS SELECT 1'],
  ['create', 'CREATE TABLE IF NOT EXISTS t (a INT);'],
  ['insert', 'INSERT INTO t VALUES (1), (2)'],
  ['insert', 'INSERT INTO t SELECT * FROM csv'],
  ['insert', 'INSERT OR REPLACE INTO t VALUES (1)'],
  ['update', 'UPDATE t SET a = 5 WHERE a = 1'],
  ['update', "UPDATE csv SET _note = 'x'"],
  ['delete', 'DELETE FROM t WHERE a = 2'],
  ['drop', 'DROP TABLE t'],
  ['drop', 'DROP TABLE IF EXISTS t'],
];

describe('🔴 DuckDB では、書き込みの 5 形が通る', () => {
  it('① 通る ── 種類まで言い当てる', () => {
    for (const [kind, sql] of WRITES) {
      expect(checkDuckDbRunSql(sql), sql).toMatchObject({ ok: true });
      expect(duckDbWriteKind(sql), sql).toBe(kind);
    }
  });

  it('⚠ 小文字・注釈・改行・全角の空白が混じっても通る(日本語入力のまま打つ)', () => {
    expect(checkDuckDbRunSql('create table t (a int)')).toMatchObject({ ok: true });
    expect(checkDuckDbRunSql('-- 表を作る\nCREATE TABLE t (a INT)')).toMatchObject({ ok: true });
    expect(checkDuckDbRunSql('/* x */ INSERT /* y */ INTO t VALUES (1)')).toMatchObject({ ok: true });
    const r = checkDuckDbRunSql('ＣＲＥＡＴＥ　ＴＡＢＬＥ　t　(a　int)');
    expect(r.ok).toBe(true);
    // 🔑 直した字を返す(実際に打つのはこちら)
    expect(r.sql).toBe('CREATE TABLE t (a int)');
  });

  it('🔑 列の名前に `comment` / `load` / `set` を使っても通る(語の走査を当てていない)', () => {
    // ⚠ 読むだけの門は `comment` / `load` を語として断る ── 書き込みの文には当てない
    expect(checkDuckDbRunSql('CREATE TABLE t (comment TEXT, load INT)')).toMatchObject({ ok: true });
    expect(checkDuckDbRunSql('UPDATE t SET load = 1, "set" = 2')).toMatchObject({ ok: true });
    // 🔑 文字列の中の語は元から数えない
    expect(checkDuckDbRunSql("INSERT INTO t VALUES ('INSTALL x; DROP TABLE y')")).toMatchObject({ ok: true });
  });
});

describe('🔴 sqlite の門は変わっていない(対照群)', () => {
  /**
   * ⚠ **同じ字を sqlite の門へ渡すと、今までどおり断る** ── この PKC のノートの DB に
   *   書く道を作らないことの、唯一の直接の観測点である。
   *   (`RUN_SQL` が engine で門を選ぶ配線は `tests/adapter/sql-pane.test.ts` が見る)
   */
  it('🔴 書き込みは、sqlite の門では全部断られる', () => {
    for (const [, sql] of WRITES) {
      const r = checkReadOnlySql(sql);
      expect(r.ok, `sqlite の門が通している: ${sql}`).toBe(false);
      expect(r.why, sql).toContain('読み取り専用です');
    }
  });

  it('⚠ 断り文は今までの字のまま', () => {
    expect(checkReadOnlySql('CREATE TABLE t (a INT)').why).toBe('読み取り専用です ── CREATE は打てません(ここは読むだけです)');
    expect(checkReadOnlySql('DROP TABLE entries').why).toBe('読み取り専用です ── DROP は打てません(ここは読むだけです)');
  });

  it('⚠ 読むだけの DuckDB の門(`checkDuckDbSql`)も、書き込みを断ったまま', () => {
    // 🔑 新しい門は別に置いた ── 読む側の門を緩めていない
    for (const [, sql] of WRITES) {
      expect(checkDuckDbSql(sql).ok, `読むだけの門が通している: ${sql}`).toBe(false);
    }
  });
});

describe('🔴 DuckDB でも、白名簿の外は断る', () => {
  it('③ 形が合わない書き込み・外へ出る書き方は断る', () => {
    for (const sql of [
      'CREATE VIEW v AS SELECT 1',
      'CREATE MACRO m() AS 1',
      'CREATE SCHEMA s',
      'CREATE SECRET s (TYPE s3)',
      'CREATE INDEX i ON t (a)',
      'DROP VIEW v',
      'DROP SCHEMA s',
      'DROP DATABASE d',
      'UPDATE EXTENSIONS',
      'UPDATE EXTENSIONS (httpfs)',
      'DELETE t',
      'INSERT t VALUES (1)',
      'ALTER TABLE t ADD COLUMN b INT',
      'TRUNCATE t',
      'ATTACH \'x.db\'',
      'COPY t TO \'out.csv\'',
      'EXPORT DATABASE \'d\'',
      'INSTALL httpfs',
      'LOAD httpfs',
      'SET enable_external_access=true',
      'RESET enable_external_access',
      'CALL dbgen(sf=1)',
      'PRAGMA table_info(t)',
      'CHECKPOINT',
      'USE memory',
    ]) {
      const r = checkDuckDbRunSql(sql);
      expect(r.ok, `通している: ${sql}`).toBe(false);
      expect(r.why, `断り文が空: ${sql}`).not.toBe('');
    }
  });

  it('🔴 1 文だけ ── 書き込みの後ろに 2 文目を足せない(sqlite の断り文と同じ字)', () => {
    const r = checkDuckDbRunSql('INSERT INTO t VALUES (1); DROP TABLE csv');
    expect(r.ok).toBe(false);
    // ⚠ 字は `sql-guard.ts` と同じ物を言う(2 つの門で食い違わない)
    expect(r.why).toBe(checkReadOnlySql('SELECT 1; SELECT 2').why);
    // 末尾の `;` だけなら通る
    expect(checkDuckDbRunSql('INSERT INTO t VALUES (1);')).toMatchObject({ ok: true });
    // 🔑 文字列の中の `;` は数えない
    expect(checkDuckDbRunSql("INSERT INTO t VALUES ('a;b')")).toMatchObject({ ok: true });
    // 🔑 書き込みでない先頭でも同じ(読む側の規律 ── `checkDuckDbSql` が持つ)
    expect(checkDuckDbRunSql('SELECT 1; DROP TABLE csv').ok).toBe(false);
  });

  it('🔴 `WITH … INSERT` は通らない ── 文の頭でだけ打てる、と理由が言う', () => {
    const r = checkDuckDbRunSql('WITH t AS (SELECT 1) INSERT INTO u SELECT * FROM t');
    expect(r.ok).toBe(false);
    expect(r.why).toContain('INSERT は文の頭でだけ打てます');
    // ⚠ 「読むだけです」とは言わない(DuckDB では嘘になる)
    expect(r.why).not.toContain('読むだけ');
    // `FROM t INSERT …` も同じ
    expect(checkDuckDbRunSql('FROM t INSERT INTO u SELECT 1').ok).toBe(false);
  });

  it('🔴 断り文は「ここは読むだけ」と言わず、書き込める形を挙げる', () => {
    for (const sql of ['ALTER TABLE t ADD COLUMN b INT', 'ATTACH \'x.db\'', "COPY t TO 'o.csv'"]) {
      const r = checkDuckDbRunSql(sql);
      expect(r.why, sql).not.toContain('読むだけ');
      expect(r.why, sql).toContain(DUCKDB_WRITE_FORMS);
    }
    // 書き込みの語で始まるが形が違う回
    const r = checkDuckDbRunSql('CREATE VIEW v AS SELECT 1');
    expect(r.why).toContain('CREATE はこの書き方では打てません');
    expect(r.why).toContain(DUCKDB_WRITE_FORMS);
  });

  it('🔴 読む側の断りは、書き込みの形も挙げ直す(「どの語で始めればよいか」)', () => {
    const r = checkDuckDbRunSql('SHOW TABLES');
    expect(r.ok).toBe(false);
    expect(r.why).toContain('SHOW では始められません');
    for (const word of ['SELECT', 'FROM', 'PIVOT', 'CREATE TABLE', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'DROP TABLE']) {
      expect(r.why, `${word} を挙げていない`).toContain(word);
    }
  });

  it('⚠ 外へ取りに行く書き方の断りは今までの字(「外から」「打ち直せません」)', () => {
    expect(checkDuckDbRunSql('INSTALL parquet').why).toContain('外から');
    expect(checkDuckDbRunSql('SET autoload_known_extensions=true').why).toContain('打ち直せません');
  });

  it('⚠ 空の字は断る', () => {
    expect(checkDuckDbRunSql('   ')).toMatchObject({ ok: false });
  });
});

describe('④ 読む側は、読むだけの門と同じ答えを返す', () => {
  it('通る / 通らない が一致する(書き込みでない字の総当たり)', () => {
    for (const sql of [
      'SELECT 1',
      'FROM csv SELECT *',
      'WITH t AS (SELECT 1) SELECT * FROM t',
      'DESCRIBE csv',
      'SUMMARIZE csv',
      'PIVOT csv ON a USING sum(b)',
      'ＦＲＯＭ　csv',
      'EXPLAIN SELECT 1',
      "SELECT replace(a, 'x', 'y') FROM csv",
      'SELECT $$DROP TABLE x$$',
    ]) {
      expect(checkDuckDbRunSql(sql).ok, sql).toBe(checkDuckDbSql(sql).ok);
      expect(checkDuckDbRunSql(sql).sql, sql).toBe(checkDuckDbSql(sql).sql);
    }
    expect(checkDuckDbRunSql('SELECT 1')).toMatchObject({ ok: true });
  });

  it('🔴 `$$…$$` の中に書き込みの語があっても、書き込みとは数えない(塗り潰す)', () => {
    expect(duckDbWriteKind('SELECT $$CREATE TABLE x (a int)$$ AS s')).toBeNull();
    expect(duckDbWriteKind("SELECT 'DROP TABLE t'")).toBeNull();
    expect(duckDbWriteKind('-- DROP TABLE t\nSELECT 1')).toBeNull();
    expect(duckDbWriteKind('SELECT 1')).toBeNull();
    // ⚠ 形が合わなければ書き込みと言わない(`CREATE VIEW` は表を作らない)
    expect(duckDbWriteKind('CREATE VIEW v AS SELECT 1')).toBeNull();
  });
});

describe('🔴 通った直後に言う 1 行(件数と寿命)', () => {
  const count = (n: number): [string[], Array<Array<number>>] => [['Count'], [[n]]];

  it('🔑 件数は DuckDB が返した値から言う', () => {
    const [c, r] = count(3);
    expect(duckDbWriteNote('insert', c, r)).toContain('3 行に効きました');
    expect(duckDbWriteNote('update', c, [[0]])).toContain('0 行に効きました');
    expect(duckDbWriteNote('delete', c, [[12]])).toContain('12 行に効きました');
  });

  it('🔑 返す値が無ければ「実行しました」(CREATE TABLE の AS 無し / DROP TABLE)', () => {
    // 実測:`CREATE TABLE t (a INT)` は `Count` の列で 0 行、`DROP TABLE` は `Success` の列
    expect(duckDbWriteNote('create', ['Count'], [])).toContain('実行しました');
    expect(duckDbWriteNote('drop', ['Success'], [])).toBe('実行しました');
    // ⚠ 列の形が違うなら、数を読み取らない(別の値を件数と言わない)
    expect(duckDbWriteNote('insert', ['Success'], [[true as unknown as number]])).toContain('実行しました');
    expect(duckDbWriteNote('insert', ['Count'], [['x']])).toContain('実行しました');
    // 🔴 数が入っていても、`Count` の列でなければ件数と読まない(別の列の数を件数と言わない)
    expect(duckDbWriteNote('insert', ['Success'], [[1]])).toContain('実行しました');
    expect(duckDbWriteNote('insert', ['Success'], [[1]])).not.toContain('行に効きました');
  });

  it('🔴 CREATE TABLE には、作った表の寿命を添える(閉じると消える)', () => {
    const [c, r] = count(2);
    // 🔴 #918 段⑦(Gemini 裁定 2026-10-01 = 設問 2 は B):相手を足す / 外すと器を作り直す = 作った表も消える
    expect(duckDbWriteNote('create', c, r)).toBe(
      `2 行に効きました ── ${DUCKDB_TABLE_LIFETIME}。${DUCKDB_TABLE_RESET}`,
    );
    expect(DUCKDB_TABLE_LIFETIME).toBe('作った表はウィンドウを閉じると消えます');
    expect(DUCKDB_TABLE_RESET).toBe('相手を足したり外したりすると、作った表は消えます');
    // 🔑 対照群:表を作らない命令には寿命を言わない / 元の file の注意は行を書き換える命令だけ
    expect(duckDbWriteNote('insert', c, r)).not.toContain('消えます');
    expect(duckDbWriteNote('drop', ['Success'], [])).not.toContain('消えます');
    expect(duckDbWriteNote('update', c, r)).toContain('元の file は書き換わりません');
    expect(duckDbWriteNote('delete', c, r)).toContain('元の file は書き換わりません');
    expect(duckDbWriteNote('create', c, r)).not.toContain('元の file');
  });
});
