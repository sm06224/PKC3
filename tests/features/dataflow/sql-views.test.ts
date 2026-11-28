/**
 * 🔴 **ノート内データフロー:SQL の仮想ビューの定義**(#2115 PR-2)。
 *
 * 守る主張:
 * 1. ` ```sql view=x ` / ` ```sql view=x embed ` / ` ```sql embed view=x ` だけがビュー(通常の sql / sql embed には干渉しない)
 * 2. 中身は `checkReadOnlySql` を必ず通す(DROP / INSERT / 複数文はビューにしない・理由を出す)
 * 3. 名前の検査・衝突は診断に出す
 * 4. 既存の `isSqlEmbedInfo` の答えは変えない(PR-3 で描き方をそろえるまでの食い違いを pin)
 */
import { describe, expect, it } from 'vitest';
import { extractNoteSqlViews, parseSqlViewInfo } from '../../../src/features/dataflow';
import { isSqlEmbedInfo } from '../../../src/features/markdown/sql-embed';

const F = '```';
const body = (...lines: string[]): string => lines.join('\n');

describe('見出しの読み(parseSqlViewInfo)', () => {
  it.each([
    ['sql view=集計', { name: '集計', embed: false }],
    ['sql view=集計 embed', { name: '集計', embed: true }],
    ['sql embed view=集計', { name: '集計', embed: true }],
    ['SQL VIEW=集計 EMBED', { name: '集計', embed: true }],
    ['  sql   view=a  ', { name: 'a', embed: false }],
    ['sql view=a view=b', { name: 'a', embed: false }],
    ['sql view=', { name: '', embed: false }],
  ])('%s → %j', (info, want) => {
    expect(parseSqlViewInfo(info)).toEqual(want);
  });

  it.each(['sql', 'sql embed', 'sqlite view=a', 'js view=a', 'view=a sql', '', 'embed view=a'])(
    '%s はビューではない(null)',
    (info) => {
      expect(parseSqlViewInfo(info)).toBeNull();
    },
  );

  it('null / undefined は null', () => {
    expect(parseSqlViewInfo(null)).toBeNull();
    expect(parseSqlViewInfo(undefined)).toBeNull();
  });

  it('⚠ isSqlEmbedInfo の答えは変えていない(sql embed view=x は埋め込み / sql view=x embed はいまは色づけだけ)', () => {
    expect(isSqlEmbedInfo('sql embed')).toBe(true);
    expect(isSqlEmbedInfo('sql embed view=集計')).toBe(true);
    expect(isSqlEmbedInfo('sql view=集計 embed')).toBe(false);
    expect(isSqlEmbedInfo('sql view=集計')).toBe(false);
  });
});

describe('本文から拾う(extractNoteSqlViews)', () => {
  it('ビューだけを拾い、通常の sql / sql embed は無視する', () => {
    const r = extractNoteSqlViews(
      body(
        `${F}sql`,
        'SELECT 1',
        F,
        `${F}sql embed`,
        'SELECT 2',
        F,
        `${F}sql view=集計`,
        'SELECT 地域, sum(金額) FROM 売上 GROUP BY 地域;',
        F,
        `${F}sql embed view=上位`,
        'SELECT * FROM 集計 LIMIT 3',
        F,
      ),
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.views).toEqual([
      { name: '集計', line: 6, sql: 'SELECT 地域, sum(金額) FROM 売上 GROUP BY 地域', embed: false },
      { name: '上位', line: 9, sql: 'SELECT * FROM 集計 LIMIT 3', embed: true },
    ]);
  });

  it('全角で打った SQL は門が直した字を持つ', () => {
    const r = extractNoteSqlViews(body(`${F}sql view=z`, 'ＳＥＬＥＣＴ　１', F));
    expect(r.views[0]?.sql).toBe('SELECT 1');
  });

  it('末尾の ; は落とすが、注釈・文字列の中の ; は残す', () => {
    const r = extractNoteSqlViews(
      body(`${F}sql view=a`, "SELECT ';' AS x;", F, `${F}sql view=b`, 'SELECT 1 -- 終わり;', F),
    );
    expect(r.views.map((v) => v.sql)).toEqual(["SELECT ';' AS x", 'SELECT 1 -- 終わり;']);
  });

  it.each([
    ['DROP TABLE 売上', '読み取り専用'],
    ['INSERT INTO t VALUES (1)', '読み取り専用'],
    ['SELECT 1; SELECT 2', '1 文だけ'],
    ['WITH x AS (SELECT 1) DELETE FROM t', '読み取り専用'],
    ['', '空'],
  ])('🔴 %s はビューにしない(not-read-only・理由つき)', (sql, piece) => {
    const r = extractNoteSqlViews(body(`${F}sql view=v`, sql, F));
    expect(r.views).toEqual([]);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ kind: 'not-read-only', name: 'v', line: 0 });
    expect(r.diagnostics[0]?.why).toContain(piece);
  });

  it.each([
    ['entries', '中の仕組み'],
    ['', '空'],
    ['ａｂ', '全角'],
    ['a.b', '文字・数字・_'],
  ])('名前 %s は invalid-name', (name, piece) => {
    const r = extractNoteSqlViews(body(`${F}sql view=${name}`, 'SELECT 1', F));
    expect(r.views).toEqual([]);
    expect(r.diagnostics[0]).toMatchObject({ kind: 'invalid-name' });
    expect(r.diagnostics[0]?.why).toContain(piece);
  });

  it('ビュー同士の重なりは先を採る(ASCII の大小は畳む)', () => {
    const r = extractNoteSqlViews(body(`${F}sql view=Top`, 'SELECT 1', F, `${F}sql view=top`, 'SELECT 2', F));
    expect(r.views.map((v) => v.sql)).toEqual(['SELECT 1']);
    expect(r.diagnostics[0]).toMatchObject({ kind: 'duplicate-name', name: 'top', line: 3 });
  });

  it('データセットと同じ名前のビューは断る', () => {
    const r = extractNoteSqlViews(body(`${F}sql view=売上`, 'SELECT 1', F), ['売上']);
    expect(r.views).toEqual([]);
    expect(r.diagnostics[0]).toMatchObject({ kind: 'duplicate-name', name: '売上' });
    expect(r.diagnostics[0]?.why).toContain('データセット');
  });

  it('引用の中のビューも拾う', () => {
    const r = extractNoteSqlViews(body(`> ${F}sql view=q`, '> SELECT 1', `> ${F}`));
    expect(r.views.map((v) => v.name)).toEqual(['q']);
  });
});
