/**
 * 🔴 **書き出しの選び所に Parquet が並ぶ条件**(#918 段⑥)。
 *
 * ⚠ 押せる印があるのに何も起きない口を作らない ── sqlite の道・書き込みの答え・EXPLAIN の答えには並べない。
 */
import { describe, expect, it } from 'vitest';
import {
  asSqlExportChoice,
  asSqlExportKind,
  SQL_EXPORT_KINDS,
  sqlExportChoices,
  sqlExportFileName,
  sqlExportLabel,
  sqlExportMime,
} from '../../src/features/query/sql-export';

describe('🔴 Parquet が並ぶ条件', () => {
  it('DuckDB で引いた読む SQL の答えには、CSV / TSV / JSON の後ろに並ぶ', () => {
    expect(sqlExportChoices('duckdb', 'SELECT * FROM csv')).toEqual([...SQL_EXPORT_KINDS, 'parquet']);
  });

  it('🔴 sqlite の道には並べない(対照群: 同じ SQL でも)', () => {
    expect(sqlExportChoices('sqlite', 'SELECT * FROM csv')).toEqual(SQL_EXPORT_KINDS);
  });

  it('🔴 DuckDB でも、書き込みの答え・EXPLAIN の答え・空には並べない', () => {
    for (const sql of ['CREATE TABLE t AS SELECT 1', 'DELETE FROM t', 'EXPLAIN SELECT 1', '']) {
      expect(sqlExportChoices('duckdb', sql), sql).toEqual(SQL_EXPORT_KINDS);
    }
  });
});

describe('Parquet の字・種別・名前', () => {
  it('受け口は Parquet を読み、見知らぬ字は捨てる。⚠ 字に組む形(asSqlExportKind)には混ぜない', () => {
    expect(asSqlExportChoice('parquet')).toBe('parquet');
    expect(asSqlExportChoice('xlsx')).toBeNull();
    expect(asSqlExportChoice(null)).toBeNull();
    for (const k of SQL_EXPORT_KINDS) expect(asSqlExportChoice(k)).toBe(k);
    expect(asSqlExportKind('parquet')).toBeNull();
  });

  it('画面の字は用語集の語で、種別は parquet 専用', () => {
    expect(sqlExportLabel('parquet')).toBe('Parquet(列の型を保って渡す)');
    expect(sqlExportMime('parquet')).toBe('application/vnd.apache.parquet');
  });

  it('file の名前は他の形と同じ作りで、拡張子が .parquet', () => {
    const name = sqlExportFileName(new Date(2026, 9, 12, 22, 30), '売上.csv', 'parquet');
    expect(name).toBe('SQL の結果 売上.csv 2026-10-12 2230.parquet');
  });
});
