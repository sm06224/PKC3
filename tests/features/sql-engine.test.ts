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
  SQL_ENGINES,
  sqlEngineHint,
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

describe('🔴 選べない側に添える「どうすれば使えるか」(#682 段③c)', () => {
  /**
   * 🔴 **等値で並べる** ── 「理由が付く」だけを見ると、**どの相手にも同じ字を返す**
   *   変異が生き延びる(user は前の相手の理由を読むことになる)。
   */
  it('相手ごとに、選べない理由の字が決まっている', () => {
    const table: Array<[string | null, string | null, string | null]> = [
      // 相手, sqlite の理由, duckdb の理由 ── `null` = 選べる
      [null, null, '取り込んだ .csv / .tsv を選ぶと使えます'],
      ['売上.csv', null, null],
      ['ログ.TSV', null, null],
      ['家計.sqlite', null, '.csv / .tsv のときだけ使えます'],
      ['家計.db', null, '.csv / .tsv のときだけ使えます'],
      ['表.xlsx', null, '.csv / .tsv のときだけ使えます'],
      ['memo.txt', null, '.csv / .tsv のときだけ使えます'],
    ];
    for (const [name, wantSqlite, wantDuck] of table) {
      expect(sqlEngineHint('sqlite', name), `sqlite 相手=${String(name)}`).toBe(wantSqlite);
      expect(sqlEngineHint('duckdb', name), `duckdb 相手=${String(name)}`).toBe(wantDuck);
    }
  });

  /**
   * 🔴 **一覧と理由が食い違わない**(§7「同じ問いに答える口を 2 つ作らない」)。
   * ⚠ ここが破れると、**選び所には薄い字で出ているのに引ける**(あるいは逆)になる。
   */
  it('理由が付かないものだけが、選べる一覧に入る', () => {
    for (const name of [null, '売上.csv', 'ログ.TSV', '家計.sqlite', '表.xlsx', 'memo.txt', 'a.zzz']) {
      const byHint = SQL_ENGINES.filter((e) => sqlEngineHint(e, name) === null);
      expect(enginesForSource(name), `相手=${String(name)}`).toEqual(byHint);
    }
  });

  it('⚠ 空振り防止 ── 理由が 1 件も付かない、が全部では成り立たない', () => {
    const hints = SQL_ENGINES.map((e) => sqlEngineHint(e, null));
    expect(hints.filter((h) => h !== null).length).toBeGreaterThan(0);
    expect(hints.filter((h) => h === null).length).toBeGreaterThan(0);
  });
});
