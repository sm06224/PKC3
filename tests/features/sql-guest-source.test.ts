/**
 * 🔴 **「この添付は何の file か」の判定**(#854 段① / 段③、#682 段④c)。
 *
 * ## 何を守るのか
 *
 * ここが 1 つ答えを変えると、**3 つの面が一度に変わる**:
 * ①選び所に並ぶか(`duckDbOnlySourcesOf`)②どのエンジンを選べるか(`sqlEngineHint`)
 * ③どこへ開きに行くか(sqlite worker か、DuckDB か)。
 * 🔑 だから**判定そのもの**をここで総当たりし、面ごとの test は
 *   「この判定を通っているか」だけを見る。
 */
import { describe, expect, it } from 'vitest';
import {
  DUCKDB_READABLE_KINDS,
  SQLITE_READABLE_KINDS,
  SQL_GUEST_EXTS,
  duckDbOnlySourcesOf,
  duckDbReadableSourceOf,
  guestTableNameOf,
  isDuckDbOnlySource,
  isDuckDbReadableSource,
  looksLikeJsonName,
  looksLikeParquetName,
  sqlGuestSourceOf,
} from '../../src/features/query/sql-guest-source';

const att = (title: string) => ({ lid: `l-${title}`, title, archetype: 'attachment' });

describe('題名から開き方を決める', () => {
  /**
   * 🔴 **総当たりの表**。⚠ 大文字・前後の空白・**全角で書く人**も居るので、
   *   corpus に混ぜる(CLAUDE.md §2「打ち方の次元を fixture に持つ」)。
   */
  it('拡張子ごとに、開き方が 1 つに決まる', () => {
    const table: Array<[string, string | null]> = [
      ['客.csv', 'csv'],
      ['客.TSV', 'csv'],
      [' 空白つき.csv ', 'csv'],
      ['台帳.xlsx', 'xlsx'],
      ['売上.parquet', 'parquet'],
      ['売上.PARQUET', 'parquet'],
      ['明細.json', 'json'],
      ['ログ.ndjson', 'json'],
      ['ログ.jsonl', 'json'],
      // ⚠ 既定の道(`.sqlite` の image として開く)へ落ちる物
      ['家計.sqlite', null],
      ['家計.db', null],
      ['メモ.md', null],
      ['古い台帳.xls', null],
    ];
    for (const [name, want] of table) {
      expect(sqlGuestSourceOf('x', name)?.kind ?? null, `相手=${name}`).toBe(want);
    }
  });

  it('🔑 json は「1 行 1 件」かどうかまで見分ける', () => {
    expect(looksLikeJsonName('a.json')).toBe('json');
    expect(looksLikeJsonName('a.ndjson')).toBe('ndjson');
    expect(looksLikeJsonName('a.JSONL')).toBe('ndjson');
    expect(looksLikeJsonName('a.txt')).toBeNull();
    // ⚠ この差は SQL へ届く ── 器の中の file 名が `.json` / `.ndjson` に分かれる
    expect(sqlGuestSourceOf('x', 'a.ndjson')).toEqual({
      kind: 'json',
      lang: 'ndjson',
      lid: 'x',
      name: 'a.ndjson',
    });
  });

  it('⚠ parquet の見分けは拡張子だけ(中身を読まない)', () => {
    expect(looksLikeParquetName('a.parquet')).toBe(true);
    expect(looksLikeParquetName('a.parquet.gz')).toBe(false);
    expect(looksLikeParquetName('parquet')).toBe(false);
  });
});

describe('🔴 どのエンジンが読めるか(2 つの一覧)', () => {
  /**
   * 🔴 **一覧は 2 本あり、両方を足しても全部にならない**(#682 段④c)。
   * ⚠ `.sqlite`(= `null`)はどちらの一覧にも居ない ── 「両方の和が全種類」と
   *   書くと、`null` の道を数え落とす。
   */
  it('一覧が重なっていない(同じ相手を両方が読めると言わない)', () => {
    const both = SQLITE_READABLE_KINDS.filter((k) =>
      (DUCKDB_READABLE_KINDS as readonly string[]).includes(k),
    );
    expect(both, '両方が読めると言っている種類が在る').toEqual(['csv']);
    // ⚠ 空振り防止 ── どちらの一覧も空ではない
    expect(SQLITE_READABLE_KINDS.length).toBeGreaterThan(1);
    expect(DUCKDB_READABLE_KINDS.length).toBeGreaterThan(1);
  });

  it('🔴 DuckDB でしか読めない相手が、正しく分かれる', () => {
    const only = ['売上.parquet', '明細.json', 'ログ.ndjson'];
    const not = ['客.csv', '台帳.xlsx', '家計.sqlite', 'メモ.md'];
    for (const n of only) {
      expect(isDuckDbOnlySource(sqlGuestSourceOf('x', n)), `${n} が DuckDB 専用に見えていない`).toBe(true);
    }
    for (const n of not) {
      expect(isDuckDbOnlySource(sqlGuestSourceOf('x', n)), `${n} を DuckDB 専用にしている`).toBe(false);
    }
  });

  it('🔴 DuckDB へ渡せる相手だけが、渡せる形で返る', () => {
    expect(duckDbReadableSourceOf('x', '客.csv')?.kind).toBe('csv');
    expect(duckDbReadableSourceOf('x', '売上.parquet')?.kind).toBe('parquet');
    expect(duckDbReadableSourceOf('x', '明細.json')?.kind).toBe('json');
    // ⚠ 読めない相手は `null`(呼び側は既に在る「引けません」へ畳む)
    expect(duckDbReadableSourceOf('x', '台帳.xlsx'), '.xlsx を DuckDB へ渡そうとしている').toBeNull();
    expect(duckDbReadableSourceOf('x', '家計.sqlite'), '.sqlite を DuckDB へ渡そうとしている').toBeNull();
    expect(isDuckDbReadableSource(null)).toBe(false);
  });
});

describe('🔴 表の名前', () => {
  it('1 file = 1 表の相手は、表の名前が決まっている', () => {
    const want: Array<[string, string]> = [
      ['客.csv', 'csv'],
      ['売上.parquet', 'parquet'],
      ['明細.json', 'json'],
      ['ログ.ndjson', 'json'],
    ];
    for (const [name, table] of want) {
      const src = duckDbReadableSourceOf('x', name);
      expect(src, `${name}: DuckDB へ渡せる形にならない`).not.toBeNull();
      expect(guestTableNameOf(src!), `${name}: 表の名前が違う`).toBe(table);
    }
  });

  /**
   * ⚠ **表の名前は SQL に打てる字でなければならない**(`csv-attachment.ts` が
   *   固定名にしている理由と同じ)── 全角や記号が混じると、user が打てない。
   */
  it('⚠ 表の名前は、そのまま打てる字である', () => {
    for (const name of ['客.csv', '売上.parquet', '明細.json']) {
      const src = duckDbReadableSourceOf('x', name)!;
      expect(guestTableNameOf(src), `${name}: 打てない字が混じっている`).toMatch(/^[a-z_][a-z0-9_]*$/u);
    }
  });
});

describe('🔴 選び所へ並べる', () => {
  it('DuckDB でしか読めない添付だけを、題名順に拾う', () => {
    const got = duckDbOnlySourcesOf([
      att('b.parquet'),
      att('a.json'),
      att('客.csv'),
      att('台帳.xlsx'),
      att('家計.sqlite'),
      att('ねこ.png'),
      // ⚠ 添付でないノートは拾わない
      { lid: 'note', title: 'x.parquet', archetype: 'text' },
    ]);
    expect(got.map((s) => s.name), '拾い方か並びが違う').toEqual(['a.json', 'b.parquet']);
  });

  it('⚠ 空振り防止 ── 拾う物が無ければ空で返る', () => {
    expect(duckDbOnlySourcesOf([att('客.csv'), att('家計.sqlite')])).toEqual([]);
  });
});

describe('file 選択画面に出す拡張子', () => {
  it('🔑 DuckDB でしか読めない 4 つが入っている', () => {
    for (const ext of ['.parquet', '.json', '.ndjson', '.jsonl']) {
      expect(SQL_GUEST_EXTS, `${ext} が accept に無い`).toContain(ext);
    }
  });
});
