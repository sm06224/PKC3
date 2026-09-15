/**
 * 🔴 **相手ごとに選べるエンジンを、等値で pin する**(#682 段②。設計 doc §8)。
 *
 * ⚠ 「DuckDB が出る」だけを見ると、**全部の相手で出す**変異が生き延びる ──
 *   守りたいのは「**成り立たない組み合わせが画面に出ない**」ことなので、
 *   出る側と出ない側を**両方**、等値で並べる。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SQL_ENGINE,
  enginesForSource,
  resolveSqlEngine,
  SQL_ENGINE_LABEL,
  type SqlEngine,
} from '@features/query/sql-engine';

describe('どのエンジンで引くか', () => {
  it('相手ごとに選べるエンジンが等値で決まっている', () => {
    const table: Array<[string | null, SqlEngine[]]> = [
      // この PKC のノート ── 正本は sqlite の中に在る
      [null, ['sqlite']],
      // 🟢 csv / tsv は両方(bytes をどちらの道でも読むので、写しが増えない)
      ['売上.csv', ['sqlite', 'duckdb']],
      ['ログ.TSV', ['sqlite', 'duckdb']],
      // .sqlite / .xlsx は sqlite だけ(DuckDB から読むには外の拡張が要る)
      ['家計.sqlite', ['sqlite']],
      ['家計.db', ['sqlite']],
      ['表.xlsx', ['sqlite']],
      // 知らない拡張子も sqlite だけ(白名簿の向き)
      ['memo.txt', ['sqlite']],
    ];
    for (const [name, want] of table) {
      expect(enginesForSource(name), `相手=${String(name)}`).toEqual(want);
    }
  });

  it('どの相手でも、選べるエンジンは 1 つ以上ある', () => {
    for (const name of [null, 'a.csv', 'a.sqlite', 'a.xlsx', 'a.zzz']) {
      expect(enginesForSource(name).length, `相手=${String(name)}`).toBeGreaterThan(0);
    }
  });

  it('既定は sqlite で、どの相手でも必ず選べる', () => {
    expect(DEFAULT_SQL_ENGINE).toBe('sqlite');
    for (const name of [null, 'a.csv', 'a.sqlite', 'a.xlsx']) {
      expect(enginesForSource(name)).toContain(DEFAULT_SQL_ENGINE);
    }
  });

  it('相手を選び直して選べなくなったら、既定へ落ちる', () => {
    // csv では DuckDB が選べる
    expect(resolveSqlEngine('duckdb', '売上.csv')).toBe('duckdb');
    // 🔴 .sqlite へ選び直したら sqlite へ落ちる(画面に無い値で引かせない)
    expect(resolveSqlEngine('duckdb', '家計.sqlite')).toBe('sqlite');
    expect(resolveSqlEngine('duckdb', null)).toBe('sqlite');
    // sqlite はどこでもそのまま
    expect(resolveSqlEngine('sqlite', '売上.csv')).toBe('sqlite');
  });

  it('画面に出す字が両方にあり、空でない', () => {
    for (const e of ['sqlite', 'duckdb'] as const) {
      expect(SQL_ENGINE_LABEL[e].length).toBeGreaterThan(0);
    }
    // ⚠ 2 つが同じ字だと、選び所で見分けられない
    expect(SQL_ENGINE_LABEL.sqlite).not.toBe(SQL_ENGINE_LABEL.duckdb);
  });
});
