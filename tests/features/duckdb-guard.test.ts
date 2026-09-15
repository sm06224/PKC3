/**
 * 🔴 **DuckDB へ打つ字の門**(#682 段②)。
 *
 * ⚠ 見たいのは 3 方向で、**どれか 1 つでも欠けると門は空振りする**:
 * ① DuckDB でだけ読める書き方が**通る**(通らないと user の動線が減る)
 * ② 外へ出る書き方が**断られる**(`INSTALL` / `LOAD` / `SET`)
 * ③ sqlite 側と**同じ規律**が生きている(1 文だけ / `WITH … INSERT` / 全角)
 */
import { describe, expect, it } from 'vitest';
import { checkDuckDbSql, stripDollarQuotes } from '@features/query/duckdb-guard';

describe('DuckDB の字の門', () => {
  it('DuckDB でだけ読める書き方が通る', () => {
    for (const sql of [
      'FROM csv SELECT _note, count(*) GROUP BY 1',
      'FROM csv',
      "PIVOT csv ON 名前 USING sum(数)",
      'UNPIVOT csv ON a, b',
      'DESCRIBE csv',
      'SUMMARIZE csv',
      'TABLE csv',
      // sqlite 側の白名簿もそのまま通る
      'SELECT 1',
      'WITH t AS (SELECT 1) SELECT * FROM t',
      // DuckDB の文法(user の動機そのもの)
      'SELECT * EXCLUDE (_lid) FROM csv QUALIFY row_number() OVER (PARTITION BY 名前) = 1',
    ]) {
      expect(checkDuckDbSql(sql), sql).toMatchObject({ ok: true });
    }
  });

  it('🔴 外へ取りに行く書き方が断られ、理由が「外」に触れている', () => {
    for (const sql of ['INSTALL parquet', 'LOAD httpfs', 'install spatial']) {
      const r = checkDuckDbSql(sql);
      expect(r.ok, sql).toBe(false);
      expect(r.why, sql).toContain('外から');
    }
  });

  it('🔴 SET で門を打ち直せない ── 断り、理由がそう言う', () => {
    for (const sql of ['SET autoload_known_extensions=true', 'RESET enable_external_access']) {
      const r = checkDuckDbSql(sql);
      expect(r.ok, sql).toBe(false);
      expect(r.why, sql).toContain('打ち直せません');
    }
  });

  it('書き込む書き方が断られる', () => {
    for (const sql of [
      'CREATE TABLE t (a int)',
      'INSERT INTO t VALUES (1)',
      'COPY csv TO \'out.csv\'',
      'EXPORT DATABASE \'d\'',
      'ATTACH \'x.db\'',
      'CALL dbgen(sf=1)',
      'CHECKPOINT',
      'USE memory',
      // 🔴 先頭だけ読むと読み取りに見える形
      'WITH t AS (SELECT 1) INSERT INTO u SELECT * FROM t',
      // 🔴 DuckDB の FROM 先行でも、中に書き込みが混じれば断る
      'FROM t INSERT INTO u SELECT 1',
    ]) {
      expect(checkDuckDbSql(sql), sql).toMatchObject({ ok: false });
    }
  });

  it('1 度に打てるのは 1 文だけ(DuckDB の先頭語でも同じ)', () => {
    const r = checkDuckDbSql('FROM csv SELECT 1; DROP TABLE csv');
    expect(r.ok).toBe(false);
    expect(r.why).toContain('1 文');
  });

  it('関数として使う語は止めない', () => {
    // ⚠ `list_value` などは普通の関数。語だけ見て止めると打てなくなる
    expect(checkDuckDbSql("SELECT replace(名前,'a','b') FROM csv")).toMatchObject({ ok: true });
  });

  it('日本語入力のまま打った字を直す(DuckDB の先頭語でも)', () => {
    const r = checkDuckDbSql('ＦＲＯＭ　csv');
    expect(r.ok).toBe(true);
    expect(r.sql).toBe('FROM csv');
  });

  it('🔴 ドル引用符の中身は語として数えない ── そして中の字は書き換えない', () => {
    // 塗り潰しそのもの(長さを保つ)
    const masked = stripDollarQuotes("SELECT $$a'b--c$$ AS x");
    expect(masked.length).toBe("SELECT $$a'b--c$$ AS x".length);
    expect(masked).not.toContain("'");
    expect(masked).toContain('SELECT');
    expect(masked).toContain('AS x');

    // ⚠ 中の全角は**直さない**(user が探したい字そのものである)
    const r = checkDuckDbSql('SELECT $$探すＡＢＣ$$ AS x');
    expect(r.ok).toBe(true);
    expect(r.sql).toContain('探すＡＢＣ');
  });

  it('閉じていないドル引用符は、そこから先を語に数えない', () => {
    const masked = stripDollarQuotes('SELECT $$ DROP TABLE t');
    expect(masked).not.toContain('DROP');
    expect(masked.length).toBe('SELECT $$ DROP TABLE t'.length);
  });

  it('空の字は断る', () => {
    expect(checkDuckDbSql('   ')).toMatchObject({ ok: false });
  });
});
