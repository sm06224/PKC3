/**
 * 🔴 **file の名前から表の名前を作る**(#918 段⑦の下地)。
 *
 * ⚠ 呼び側はまだ繋がっていない(段⑦の本体は別 PR)── だからこの test が
 *   **規則そのもの**の唯一の守り手である。1 規則ごとに、その規則だけが鳴る場面を持つ。
 */
import { describe, expect, it } from 'vitest';
import {
  TABLE_NAME_FALLBACK,
  TABLE_NAME_MAX,
  tableNameFromFile,
  tableNameFromFileTable,
} from '../../src/features/query/sql-table-name';

const none = new Set<string>();

describe('表の名前の作り方', () => {
  it('拡張子を落とす', () => {
    expect(tableNameFromFile('sales_2026.csv', none)).toBe('sales_2026');
    expect(tableNameFromFile('売上.parquet', none)).toBe('売上');
  });

  it('場所を落とす(`/` も `\\` も)', () => {
    expect(tableNameFromFile('data/2026/sales.csv', none)).toBe('sales');
    expect(tableNameFromFile('C:\\data\\sales.csv', none)).toBe('sales');
  });

  it('落とすのは最後の拡張子 1 つだけ ── 途中の `.` は `_` になる', () => {
    expect(tableNameFromFile('売上.2026.csv', none)).toBe('売上_2026');
    expect(tableNameFromFile('a.b.json', none)).toBe('a_b');
  });

  it('拡張子の無い名前は、そのまま本体になる', () => {
    expect(tableNameFromFile('sales', none)).toBe('sales');
  });

  it('🔴 使えない字は `_` ── 続く分は 1 つに畳み、両端は落とす', () => {
    expect(tableNameFromFile('売上 (最終) 2026.csv', none)).toBe('売上_最終_2026');
    expect(tableNameFromFile('a--b  c.csv', none)).toBe('a_b_c');
    expect(tableNameFromFile('(final).csv', none)).toBe('final');
    // 🔑 元から在る `_` は触らない
    expect(tableNameFromFile('__a__b.csv', none)).toBe('__a__b');
  });

  it('🔴 全角の英数字は半角へ直す ── 打った SQL は半角へ直るので、全角の名前は引けない', () => {
    expect(tableNameFromFile('ｓａｌｅｓ２０２６.csv', none)).toBe('sales2026');
    // 🔑 日本語の文字は残す(引用符なしで書ける)
    expect(tableNameFromFile('ｓａｌｅｓ売上.csv', none)).toBe('sales売上');
  });

  it('🔴 先頭が数字なら `_` を前置する', () => {
    expect(tableNameFromFile('2026.csv', none)).toBe('_2026');
    expect(tableNameFromFile('2026_sales.csv', none)).toBe('_2026_sales');
    // ⚠ 数字で始まらなければ前置しない(対照群)
    expect(tableNameFromFile('s2026.csv', none)).toBe('s2026');
  });

  it('🔴 予約語は `_` を後置する(DuckDB の語も sqlite の語も)', () => {
    // DuckDB 側
    expect(tableNameFromFile('select.csv', none)).toBe('select_');
    expect(tableNameFromFile('table.csv', none)).toBe('table_');
    expect(tableNameFromFile('PIVOT.csv', none)).toBe('PIVOT_');
    // sqlite 側(DuckDB に無い語)
    expect(tableNameFromFile('pragma.csv', none)).toBe('pragma_');
    expect(tableNameFromFile('vacuum.csv', none)).toBe('vacuum_');
    // ⚠ 対照群:予約語を含むだけの名前は触らない
    expect(tableNameFromFile('select_all.csv', none)).toBe('select_all');
    expect(tableNameFromFile('tables.csv', none)).toBe('tables');
  });

  it('🔴 `sqlite_` で始まる名前と、この PKC の表の名前は取らない', () => {
    expect(tableNameFromFile('sqlite_master.csv', none)).toBe('_sqlite_master');
    expect(tableNameFromFile('entries.csv', none)).toBe('entries_');
    expect(tableNameFromFile('csv_tables.csv', none)).toBe('csv_tables_');
  });

  it('🔴 取られていれば `_2` `_3` …(大文字小文字は同じ名前)', () => {
    expect(tableNameFromFile('a.csv', new Set(['a']))).toBe('a_2');
    expect(tableNameFromFile('a.csv', new Set(['a', 'a_2']))).toBe('a_3');
    expect(tableNameFromFile('a.csv', new Set(['A']))).toBe('a_2');
    expect(tableNameFromFile('Sales.csv', new Set(['sales', 'SALES_2']))).toBe('Sales_3');
    // ⚠ 対照群:取られていなければ付けない
    expect(tableNameFromFile('a.csv', new Set(['b']))).toBe('a');
  });

  it('⚠ 予約語を逃がした名前が取られていれば、そこへ `_2` が付く', () => {
    expect(tableNameFromFile('select.csv', new Set(['select_']))).toBe('select__2');
  });

  it('⚠ 取られた名前の集合は書き換えない(純粋関数)', () => {
    const taken = new Set(['a']);
    tableNameFromFile('a.csv', taken);
    expect([...taken]).toEqual(['a']);
  });

  it('作れなかったら既定の名前になる(拡張子しか無い・記号しか無い)', () => {
    expect(tableNameFromFile('.csv', none)).toBe(TABLE_NAME_FALLBACK);
    expect(tableNameFromFile('---.csv', none)).toBe(TABLE_NAME_FALLBACK);
    expect(tableNameFromFile('', none)).toBe(TABLE_NAME_FALLBACK);
    // 🔑 既定の名前も取られていれば `_2`
    expect(tableNameFromFile('.csv', new Set([TABLE_NAME_FALLBACK]))).toBe(`${TABLE_NAME_FALLBACK}_2`);
  });

  it('🔴 長すぎる名前は切る ── 重複の接尾辞を足しても上限を超えない', () => {
    const long = `${'x'.repeat(100)}.csv`;
    const first = tableNameFromFile(long, none);
    expect([...first]).toHaveLength(TABLE_NAME_MAX);
    const second = tableNameFromFile(long, new Set([first]));
    expect([...second], '接尾辞を足して上限を超えている').toHaveLength(TABLE_NAME_MAX);
    expect(second.endsWith('_2')).toBe(true);
    expect(second).not.toBe(first);
  });

  it('🔴 出てきた名前は、どれも SQL の裸の名前として安全である(総当たりの形)', () => {
    const names = [
      'sales_2026.csv', '売上 (最終).csv', '2026.csv', 'select.csv', 'a b.csv', '--.csv', 'ｓａｌｅｓ.csv',
      '😀絵文字.csv', 'a"b.csv', "a'b.csv", 'a;drop table x.csv', 'a/b\\c.csv', 'x.tar.gz', 'Ünï.csv',
    ];
    for (const n of names) {
      const t = tableNameFromFile(n, none);
      expect(t, `${n} → ${t}`).toMatch(/^[\p{L}_][\p{L}\p{N}_]*$/u);
      expect(t.startsWith('sqlite_'), n).toBe(false);
    }
  });
});

describe('🔴 `.sqlite` の中の表の名前(ファイル名_表名。#682 段④d)', () => {
  it('形は「ファイル名_表名」', () => {
    expect(tableNameFromFileTable('売上.sqlite', '注文', none)).toBe('売上_注文');
    expect(tableNameFromFileTable('家計.db', 'items', none)).toBe('家計_items');
  });

  it('規則は file 名だけのときと同じ(全角→半角 / 使えない字は _ / 数字始まり)', () => {
    expect(tableNameFromFileTable('ｓａｌｅｓ.sqlite', 'ｏｒｄｅｒ', none)).toBe('sales_order');
    expect(tableNameFromFileTable('a b.sqlite', 'c-d', none)).toBe('a_b_c_d');
    // 数字で始まる file 名 → `_` を前置(裸で書けない)
    expect(tableNameFromFileTable('2024.sqlite', 't', none)).toBe('_2024_t');
  });

  it('取られていれば _2(別の file の同じ名前の表どうし)', () => {
    const first = tableNameFromFileTable('売上.sqlite', '注文', none);
    expect(tableNameFromFileTable('売上.sqlite', '注文', new Set([first]))).toBe('売上_注文_2');
    // 大文字小文字は同じ名前
    expect(tableNameFromFileTable('A.sqlite', 'T', new Set(['a_t']))).toBe('A_T_2');
  });

  it('どちらかが空になるときは、残った側だけ(両方空は既定の名前)', () => {
    expect(tableNameFromFileTable('.sqlite', '注文', none)).toBe('注文');
    expect(tableNameFromFileTable('売上.sqlite', '---', none)).toBe('売上');
    expect(tableNameFromFileTable('.sqlite', '---', none)).toBe(TABLE_NAME_FALLBACK);
  });

  it('上限(字数)を超えない', () => {
    const t = tableNameFromFileTable('あ'.repeat(30) + '.sqlite', 'い'.repeat(30), none);
    expect([...t].length).toBeLessThanOrEqual(TABLE_NAME_MAX);
  });

  it('🔴 file 名だけの既存の規則は 1 文字も変わらない(共通の逃がし方へ寄せた後の対照群)', () => {
    expect(tableNameFromFile('select.csv', none)).toBe('select_');
    expect(tableNameFromFile('2026.csv', none)).toBe('_2026');
    expect(tableNameFromFile('a.csv', new Set(['a']))).toBe('a_2');
  });
});
