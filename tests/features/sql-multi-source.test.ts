/**
 * 🔴 **複数の file を並べて引く ── 判断の部分**(#918 段⑦a。Gemini 裁定 2026-10-01)。
 *
 * ここが見るのは**純粋な規則**(表の名前 / 足せるか / engine / 案内文)。画面と配線は
 * `tests/adapter/sql-pane.test.ts`、器は `tests/adapter/duckdb-runner.test.ts`、
 * 実物の engine は `tests/duckdb-write.test.ts` が見る。
 */
import { describe, expect, it } from 'vitest';
import {
  checkAddSource,
  duckDbTableGroupsOf,
  duckDbTableNamesOf,
  duckDbTableNamesOfNames,
  SQL_MAX_SOURCES,
  SQLITE_INNER_PLACEHOLDER,
  sqlMultiNote,
} from '../../src/features/query/sql-multi-source';
import { duckDbReadableSourceOf, type DuckDbReadableGuestSource } from '../../src/features/query/sql-guest-source';
import { enginesForSource, resolveSqlEngine, sqlEngineHint, sqlEngineOf } from '../../src/features/query/sql-engine';
import { sqlExampleText, sqlPlaceholder, sqlRulesText, sqlTipText } from '../../src/features/query/sql-tip';
import { DUCKDB_TABLE_RESET } from '../../src/features/query/duckdb-write';

function srcs(...names: string[]): DuckDbReadableGuestSource[] {
  return names.map((n, i) => {
    const s = duckDbReadableSourceOf(`l${String(i)}`, n);
    if (s === null) throw new Error(`前提が崩れている(${n} が DuckDB へ渡せる形にならない)`);
    return s;
  });
}

describe('🔴 表の名前(設問 3 = A)', () => {
  it('1 件のときは今までどおり(csv / json / parquet)', () => {
    expect(duckDbTableNamesOf(srcs('売上.csv'))).toEqual(['csv']);
    expect(duckDbTableNamesOf(srcs('売上.tsv'))).toEqual(['csv']);
    expect(duckDbTableNamesOf(srcs('a.parquet'))).toEqual(['parquet']);
    expect(duckDbTableNamesOf(srcs('a.json'))).toEqual(['json']);
    expect(duckDbTableNamesOf(srcs('a.ndjson'))).toEqual(['json']);
  });

  it('🔴 2 件以上は、1 件目も含めて全部を file 名から(1 件目が csv のままではない)', () => {
    const t = duckDbTableNamesOf(srcs('売上.csv', '在庫.csv'));
    expect(t).toEqual(['売上', '在庫']);
    // 対照群:1 件のときの `csv` が 2 件でも残っていたら、ここで落ちる
    expect(t).not.toContain('csv');
  });

  it('数字で始まる名前 / 記号は規則どおり(2024-sales.csv → _2024_sales)', () => {
    expect(duckDbTableNamesOf(srcs('2024-sales.csv', 'b.parquet'))).toEqual(['_2024_sales', 'b']);
  });

  it('🔴 同名は _2 / _3(別の場所に在る同じ名前の file)', () => {
    expect(duckDbTableNamesOf(srcs('売上.csv', '売上.csv', '売上.parquet'))).toEqual(['売上', '売上_2', '売上_3']);
    // 大文字小文字は同じ名前として扱う(DuckDB も区別しない)
    expect(duckDbTableNamesOf(srcs('Sales.csv', 'sales.csv'))).toEqual(['Sales', 'sales_2']);
  });

  it('予約語は後ろに _ を付ける(select.csv → select_)── 並べたときも引ける名前になる', () => {
    expect(duckDbTableNamesOf(srcs('select.csv', 'order.csv'))).toEqual(['select_', 'order_']);
  });

  it('PKC の表の名前と同じ file 名は避ける(entries.csv を並べても、ノートの表と取り違えない)', () => {
    const t = duckDbTableNamesOf(srcs('entries.csv', 'a.csv'));
    expect(t[0]).not.toBe('entries');
  });

  it('名前から(画面用)も同じ答え。読めない名前は飛ばす', () => {
    expect(duckDbTableNamesOfNames(['売上.csv', '在庫.csv'])).toEqual(['売上', '在庫']);
    expect(duckDbTableNamesOfNames(['売上.csv', '帳簿.xlsx', '在庫.csv'])).toEqual(['売上', '在庫']);
  });
});

describe('🔴 `.sqlite` の表の名前(#682 段④d。🟣 Gemini 裁定 2026-10-02)', () => {
  const inner: Record<number, string[]> = { 0: ['売上', '客'], 1: ['売上'] };
  const innerOf = (i: number): string[] => inner[i] ?? [];

  it('🔴 1 件だけなら、中の表は元の名前のまま(csv などへ潰さない)', () => {
    expect(duckDbTableGroupsOf(srcs('家計.sqlite'), innerOf)).toEqual([['売上', '客']]);
    // 空の DB(表が 1 枚も無い)も落ちない
    expect(duckDbTableGroupsOf(srcs('家計.sqlite'), () => [])).toEqual([[]]);
    // ⚠ `csv` という名前に写さない(1 つに潰せない)
    expect(duckDbTableGroupsOf(srcs('家計.sqlite'), innerOf).flat()).not.toContain('csv');
  });

  it('🔴 2 件以上なら「ファイル名_表名」(sqlite 側の全部)、csv は file 名のまま', () => {
    expect(duckDbTableGroupsOf(srcs('家計.sqlite', '在庫.csv'), innerOf)).toEqual([
      ['家計_売上', '家計_客'],
      ['在庫'],
    ]);
  });

  it('🔴 2 つの .sqlite に同じ名前の表が在っても、ぶつからない', () => {
    const g = duckDbTableGroupsOf(srcs('a.sqlite', 'b.sqlite'), innerOf);
    expect(g).toEqual([['a_売上', 'a_客'], ['b_売上']]);
    // 同じ file 名 2 つ(別の場所)でも _2 が付く
    const same = duckDbTableGroupsOf(srcs('a.sqlite', 'a.sqlite'), () => ['t']);
    expect(same).toEqual([['a_t'], ['a_t_2']]);
  });

  it('🔴 file 名 + 表名が、別の file の名前とぶつかったら _2(取られた名前を黙って上書きしない)', () => {
    // `a_t.csv` → `a_t`、`a.sqlite` の表 `t` → `a_t` が取られているので `a_t_2`
    expect(duckDbTableGroupsOf(srcs('a_t.csv', 'a.sqlite'), () => ['t'])).toEqual([['a_t'], ['a_t_2']]);
  });

  it('画面用(名前だけ)は「ファイル名_表の名前」という形で言う ── 中身は読んでいない', () => {
    expect(duckDbTableNamesOfNames(['家計.sqlite', '在庫.csv'])).toEqual([
      `家計_${SQLITE_INNER_PLACEHOLDER}`,
      '在庫',
    ]);
    // 1 相手 = 1 つ(添字が相手と揃う ── 画面が `[i + 1]` で引く)
    expect(duckDbTableNamesOfNames(['a.sqlite', 'b.sqlite', 'c.csv'])).toHaveLength(3);
  });

  it('🔴 `.sqlite` を含むときの案内は、表の数を言わない(中に何枚在るか分からない)', () => {
    const note = sqlMultiNote(['家計_表の名前', '在庫'], ['家計.sqlite']);
    expect(note).not.toContain('2 つの表');
    expect(note).toContain('家計.sqlite の表は');
    expect(note).toContain('ファイル名_表の名前');
    // 対照群:`.sqlite` が無ければ今までどおり
    expect(sqlMultiNote(['売上', '在庫'], [])).toBe('いま調べているのは 売上 / 在庫 の 2 つの表です。');
  });
});

describe('🔴 足せるか(上限 4 / xlsx は足せない / 重複)', () => {
  const primary = { lid: 'p', name: '売上.csv' };

  it('csv / tsv / parquet / json 系 / sqlite は足せる', () => {
    for (const n of ['a.csv', 'a.tsv', 'a.parquet', 'a.json', 'a.ndjson', 'a.jsonl', 'a.sqlite', 'a.db']) {
      expect(checkAddSource(primary, [], { lid: 'x', name: n }).ok, n).toBe(true);
    }
  });

  it('🔴 .xlsx は足せない ── 理由に名前と、足せる拡張子(.sqlite を含む)を言う', () => {
    for (const n of ['帳簿.xlsx']) {
      const r = checkAddSource(primary, [], { lid: 'x', name: n });
      expect(r.ok, n).toBe(false);
      if (!r.ok) {
        expect(r.why).toContain(n);
        expect(r.why).toContain('DuckDB で読めない');
        expect(r.why).toContain('.csv');
        // 🔴 足せる拡張子の案内に `.sqlite` が入っている(#682 段④d。入っていないと「足せるのに案内に無い」)
        expect(r.why).toContain('.sqlite');
      }
    }
  });

  it('🔴 上限 4(1 件目を含む)── 4 件目までは足せて、5 件目は断る', () => {
    expect(SQL_MAX_SOURCES).toBe(4);
    const e1 = [{ lid: 'e1', name: 'b.csv' }];
    const e2 = [...e1, { lid: 'e2', name: 'c.csv' }];
    const e3 = [...e2, { lid: 'e3', name: 'd.csv' }];
    expect(checkAddSource(primary, [], { lid: 'x', name: 'x.csv' }).ok).toBe(true);
    expect(checkAddSource(primary, e1, { lid: 'x', name: 'x.csv' }).ok).toBe(true);
    expect(checkAddSource(primary, e2, { lid: 'x', name: 'x.csv' }).ok, '4 件目が足せない').toBe(true);
    const r = checkAddSource(primary, e3, { lid: 'x', name: 'x.csv' });
    expect(r.ok, '5 件目を足せてしまう').toBe(false);
    if (!r.ok) expect(r.why).toContain('4 つまで');
  });

  it('同じ file をもう一度は足せない(1 件目でも、足した相手でも)', () => {
    const e = [{ lid: 'e1', name: 'b.csv' }];
    expect(checkAddSource(primary, e, { lid: 'p', name: '売上.csv' }).ok).toBe(false);
    expect(checkAddSource(primary, e, { lid: 'e1', name: 'b.csv' }).ok).toBe(false);
  });

  it('1 件目が DuckDB で読めない相手(または開いていない)なら、足せない', () => {
    expect(checkAddSource(null, [], { lid: 'x', name: 'a.csv' }).ok).toBe(false);
    expect(checkAddSource({ lid: 'p', name: '帳簿.xlsx' }, [], { lid: 'x', name: 'a.csv' }).ok).toBe(false);
    // 🟢 1 件目が `.sqlite` なら足せる(#682 段④d)
    expect(checkAddSource({ lid: 'p', name: '売上.sqlite' }, [], { lid: 'x', name: 'a.csv' }).ok).toBe(true);
  });
});

describe('🔴 2 件以上のときの engine は DuckDB 固定', () => {
  it('並べていなければ今までどおり(csv は両方選べる)', () => {
    expect(enginesForSource('a.csv')).toEqual(['sqlite', 'duckdb']);
    expect(sqlEngineOf({ engine: 'sqlite', guest: { name: 'a.csv' }, extraGuests: [] })).toBe('sqlite');
    expect(sqlEngineOf({ engine: 'sqlite', guest: { name: 'a.csv' } })).toBe('sqlite');
  });

  it('並べたら、user が sqlite を選んでいても DuckDB で引く(画面と実体を食い違わせない)', () => {
    expect(enginesForSource('a.csv', true)).toEqual(['duckdb']);
    expect(sqlEngineOf({ engine: 'sqlite', guest: { name: 'a.csv' }, extraGuests: [{}] })).toBe('duckdb');
    expect(resolveSqlEngine('sqlite', 'a.csv', true)).toBe('duckdb');
  });

  it('sqlite の選び所には理由が付く(消さずに薄い字にする)', () => {
    expect(sqlEngineHint('sqlite', 'a.csv', true)).toContain('DuckDB だけ');
    expect(sqlEngineHint('duckdb', 'a.csv', true)).toBeNull();
  });
});

describe('🔴 案内文・手本(名前を並べて出す)', () => {
  it('裁定の字:「いま調べているのは 売上 / 在庫 の 2 つの表です」', () => {
    expect(sqlMultiNote(['売上', '在庫'])).toBe('いま調べているのは 売上 / 在庫 の 2 つの表です。');
    const tip = sqlTipText({ name: '売上.csv', tables: ['csv'] }, 'duckdb', ['在庫.csv']);
    expect(tip).toContain('いま調べているのは 売上 / 在庫 の 2 つの表です');
    // 打てない名前を出さない ── 1 件のときの `csv` は出ない
    expect(tip).not.toContain('表 csv');
  });

  it('file 名 → 表の名前の対応を言う(想像の付かない名前を打たせない)', () => {
    const tip = sqlTipText({ name: '2024-sales.csv', tables: ['csv'] }, 'duckdb', ['b.parquet']);
    expect(tip).toContain('2024-sales.csv → _2024_sales');
    expect(tip).toContain('b.parquet → b');
  });

  it('1 件のときの案内は 1 バイトも変わらない', () => {
    expect(sqlTipText({ name: '売上.csv', tables: ['csv'] }, 'duckdb')).toBe(
      sqlTipText({ name: '売上.csv', tables: ['csv'] }, 'duckdb', []),
    );
    expect(sqlTipText({ name: '売上.csv', tables: ['csv'] }, 'duckdb')).toContain('表 csv です');
  });

  it('手本は 1 つ目の表の名前で出る(csv 固定ではない)。消えない手本も同じ', () => {
    expect(sqlPlaceholder({ name: '売上.csv', tables: ['csv'] }, 'duckdb', ['在庫.csv'])).toBe(
      'FROM 売上 SELECT * LIMIT 20',
    );
    expect(sqlExampleText({ name: '売上.csv', tables: ['csv'] }, 'duckdb', ['在庫.csv'])).toBe(
      '例: FROM 売上 SELECT * LIMIT 20',
    );
  });

  it('🔴 作った表が消える扱い(設問 2 = B)── 打つ前の約束にも書いてある', () => {
    expect(sqlRulesText('duckdb')).toContain(DUCKDB_TABLE_RESET);
    expect(DUCKDB_TABLE_RESET).toContain('増やしたり減らしたり');
  });
});
