/** @vitest-environment node */
/**
 * 🔴 **Parquet の書き出しの SQL を組む門**(#918 段⑥)。
 *
 * ⚠ 守るのは 2 つ:①user の `COPY` は**今までどおり断る**(書き先を打たせる口を作らない)
 *   ②書き出しが打つ 1 文は**こちらが組んだ形だけ**で、書き先は固定の 1 つ。
 *   実物の engine で書けるか・読み戻せるかは `tests/duckdb-parquet-export.test.ts` が見る。
 */
import { describe, expect, it } from 'vitest';
import {
  canExportParquet,
  DUCKDB_ALLOW_EXPORT_SQL,
  DUCKDB_EXPORT_FILE,
  DUCKDB_EXPORT_TMP,
  parquetCopyOf,
} from '../../src/features/query/duckdb-export';
import { checkDuckDbSql } from '../../src/features/query/duckdb-guard';
import { checkDuckDbRunSql } from '../../src/features/query/duckdb-write';

const statementOf = (sql: string): string => {
  const c = parquetCopyOf(sql);
  if (!c.ok) throw new Error('組めない: ' + c.why);
  return c.statement;
};

describe('🔴 user の COPY は、書き出しを足しても断る', () => {
  it('COPY … TO は読む SQL でも書き込みの SQL でも通らない', () => {
    for (const sql of [
      "COPY (SELECT 1) TO 'x.parquet' (FORMAT PARQUET)",
      "COPY csv TO 'x.csv'",
      "COPY csv FROM 'x.csv'",
      "EXPORT DATABASE 'd'",
    ]) {
      expect(checkDuckDbSql(sql).ok, sql).toBe(false);
      expect(checkDuckDbRunSql(sql).ok, sql).toBe(false);
    }
  });

  it('🔴 書き出しの口も、COPY を含む字は包まずに断る(包み方で COPY が通る穴を作らない)', () => {
    for (const sql of ["COPY csv TO 'x'", "SELECT 1) TO 'evil.csv' (FORMAT CSV); COPY (SELECT 1"]) {
      expect(parquetCopyOf(sql).ok, sql).toBe(false);
    }
  });
});

describe('🔴 書き出しが打つ 1 文', () => {
  it('書き先は固定の 1 つで、(FORMAT PARQUET)を付ける', () => {
    expect(statementOf('SELECT * FROM csv')).toBe(
      `COPY (SELECT * FROM (SELECT * FROM csv\n)) TO '${DUCKDB_EXPORT_FILE}' (FORMAT PARQUET)`,
    );
    expect(DUCKDB_EXPORT_FILE).toBe('pkc-export.parquet');
  });

  it('🔑 末尾の ; は外す(括弧の中に ; が残ると 2 文目になる)', () => {
    expect(statementOf('SELECT 1;')).toContain('(SELECT 1 \n)');
    expect(statementOf('SELECT 1 ;  ')).not.toContain(';');
  });

  it('🔑 末尾が -- 注釈でも閉じ括弧が呑まれない(改行を入れてある)', () => {
    const s = statementOf('SELECT 1 -- メモ');
    expect(s).toContain('-- メモ\n))');
  });

  it("🔑 文字列の中の ; は触らない(末尾の ; だけ外す)", () => {
    expect(statementOf("SELECT 'a;b'")).toContain("'a;b'");
  });

  it('DuckDB の書き方(FROM 先行 / DESCRIBE / PIVOT / WITH)も包める', () => {
    for (const sql of ['FROM csv', 'DESCRIBE csv', 'SUMMARIZE csv', 'PIVOT csv ON a USING sum(b)', 'WITH x AS (SELECT 1) SELECT * FROM x', 'VALUES (1)', 'TABLE csv']) {
      expect(parquetCopyOf(sql).ok, sql).toBe(true);
    }
  });

  it('🔴 書き込みの SQL・EXPLAIN・空は断る(理由つき)', () => {
    for (const sql of ['CREATE TABLE t AS SELECT 1', 'INSERT INTO t VALUES (1)', 'DROP TABLE t', 'EXPLAIN SELECT 1', '', '  ']) {
      const c = parquetCopyOf(sql);
      expect(c.ok, sql).toBe(false);
      if (!c.ok) expect(c.why, sql).not.toBe('');
      expect(canExportParquet(sql), sql).toBe(false);
    }
    expect(canExportParquet('SELECT 1')).toBe(true);
  });
});

describe('🔴 書いてよい path は 2 つだけ', () => {
  it('許可の 1 文が、書き先と上流の一時名の 2 つだけを名指しする', () => {
    expect(DUCKDB_EXPORT_TMP).toBe('tmp_' + DUCKDB_EXPORT_FILE);
    expect(DUCKDB_ALLOW_EXPORT_SQL).toBe(
      "SET allowed_paths=['pkc-export.parquet','tmp_pkc-export.parquet']",
    );
  });
});
