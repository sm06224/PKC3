/**
 * 🔴 **ノート内データフロー:SQL の参照の読み取り**(#2115 PR-2)。
 *
 * 守る主張:
 * 1. 文字列リテラル・注釈の中の語は参照に数えない(識別子の引用 "売上" / [売上] / `売上` は数える)
 * 2. `sqlReferenceText` は識別子の引用が無い SQL では `stripSqlNoise` と 1 字も違わない(規則を 2 本にしない)
 * 3. WITH の CTE 名は参照・未解決のどちらにも数えない
 * 4. 未解決は FROM / JOIN の素直な名前だけ(関数・所属つきは外す)
 */
import { describe, expect, it } from 'vitest';
import {
  cteNames,
  findMissingRefs,
  sqlFromTables,
  sqlMentions,
  sqlReferenceText,
} from '../../../src/features/dataflow';
import { stripSqlNoise } from '../../../src/features/query/sql-guard';

describe('sqlReferenceText', () => {
  it.each([
    "SELECT 'a' FROM t -- c\nWHERE x = 'it''s'",
    'SELECT /* 売上 */ 1',
    "SELECT '😀😀😀'; DROP TABLE t",
    'SELECT 1',
  ])('識別子の引用が無ければ stripSqlNoise と同じ: %s', (sql) => {
    expect(sqlReferenceText(sql)).toBe(stripSqlNoise(sql));
  });

  it('識別子の引用は中身を残し、記号だけ空白にする(長さは保つ)', () => {
    const sql = 'SELECT * FROM "売 上" JOIN [在庫] JOIN `x`';
    const ref = sqlReferenceText(sql);
    expect(ref).toHaveLength(sql.length);
    expect(ref).toBe('SELECT * FROM  売 上  JOIN  在庫  JOIN  x ');
  });

  it('文字列と識別子が隣り合っても区切る', () => {
    expect(sqlReferenceText(`'a'"b"`)).toBe('    b ');
  });
});

describe('sqlMentions(依存の候補)', () => {
  const names = ['売上', '在庫', 'Sales'];

  it('語として出てくる名前を拾う(ASCII の大小は畳む・綴りは候補のまま)', () => {
    expect(sqlMentions('SELECT * FROM 売上 JOIN sales USING (id)', names)).toEqual(['売上', 'Sales']);
  });

  it('🔴 文字列リテラル・注釈の中の語は拾わない', () => {
    expect(sqlMentions("SELECT '売上' AS x /* 在庫 */ -- Sales\nFROM t", names)).toEqual([]);
  });

  it('識別子の引用の中は拾う', () => {
    expect(sqlMentions('SELECT * FROM "売上"', names)).toEqual(['売上']);
  });

  it('語の一部(売上高)は拾わない', () => {
    expect(sqlMentions('SELECT * FROM 売上高', names)).toEqual([]);
  });

  it('🔴 WITH の CTE と同じ名前は拾わない(CTE が隠す)', () => {
    expect(sqlMentions('WITH 売上 AS (SELECT 1) SELECT * FROM 売上 JOIN 在庫', names)).toEqual(['在庫']);
  });
});

describe('cteNames', () => {
  it('WITH / RECURSIVE / 列つき / 複数を拾う', () => {
    const sql = sqlReferenceText(
      'WITH RECURSIVE a(n) AS (SELECT 1), b AS MATERIALIZED (SELECT 2), "c c" AS (SELECT 3) SELECT 1',
    );
    expect(cteNames(sql)).toEqual(['a', 'b', 'c']);
  });

  it('WITH が無ければ空・WINDOW の名前は CTE ではない', () => {
    expect(cteNames('SELECT x FROM t')).toEqual([]);
    expect(
      cteNames('WITH a AS (SELECT 1) SELECT sum(x) OVER w FROM a WINDOW w AS (ORDER BY x), v AS (PARTITION BY y)'),
    ).toEqual(['a']);
  });
});

describe('sqlFromTables / findMissingRefs', () => {
  it('FROM / JOIN / カンマ区切り / 別名つき / 引用を拾う', () => {
    expect(
      sqlFromTables('SELECT * FROM a x, b AS y, "c" LEFT JOIN d ON 1 WHERE e IN (SELECT 1 FROM f)'),
    ).toEqual(['a', 'b', 'c', 'd', 'f']);
  });

  it('関数の形・所属つき・FROM (SELECT…) は表の名前ではない', () => {
    expect(sqlFromTables("SELECT * FROM pragma_table_info('x') JOIN main.t JOIN (SELECT 1 FROM g)")).toEqual(['g']);
  });

  it('文字列と注釈の中の FROM は数えない', () => {
    expect(sqlFromTables("SELECT 'FROM x' -- FROM y\nFROM z")).toEqual(['z']);
  });

  it('ORDER BY a, b / GROUP BY の並びを表と取り違えない', () => {
    expect(sqlFromTables('SELECT a, b FROM t GROUP BY a, b ORDER BY a, b LIMIT 1, 2')).toEqual(['t']);
  });

  it('既知・CTE・ignore に無い名前だけが未解決(ASCII の大小は畳む)', () => {
    const sql = 'WITH w AS (SELECT 1) SELECT * FROM W JOIN 売上 JOIN 旧名 JOIN Entries';
    expect(findMissingRefs(sql, ['売上'], ['entries'])).toEqual(['旧名']);
  });
});
