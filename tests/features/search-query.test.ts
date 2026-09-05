/**
 * 探す面の書き方(#680)── `features/filter/search-query.ts` の `query` 側。
 *
 * 🔴 守る主張:
 * 1. 空白 = AND / `"…"` = フレーズ / `-語` = 除外、が FTS5 の式になる
 * 2. **全項が引用に閉じる** ── `AND` / `*` / `(` を含む語が構文に届かない
 * 3. 正の項が 0 なら引かない(`null` / `none`)
 * 4. 3 字未満の項が 1 つでも混じれば LIKE 側(`like-terms`)── 除外側も含めて
 * 5. 🔴 **対照群: 左の列の欄(`toFtsMatch` / 既定の `planSearch`)は 1 byte も変わっていない**
 */
import { describe, expect, it } from 'vitest';
import {
  parseSearchTerms,
  planSearch,
  quoteFtsTerm,
  toFtsMatch,
  toFtsQuery,
} from '../../src/features/filter/search-query';

describe('toFtsQuery ── 探す面の書き方', () => {
  it('空白で区切ると AND', () => {
    expect(toFtsQuery('a b')).toBe('"a" AND "b"');
    expect(toFtsQuery('  a   b  ')).toBe('"a" AND "b"');
  });

  it('全角空白でも区切る(日本語の入力)', () => {
    expect(toFtsQuery('会議　メモ')).toBe('"会議" AND "メモ"');
  });

  it('"…" はフレーズ、-語 は除外', () => {
    expect(toFtsQuery('"a b" -c')).toBe('("a b") NOT "c"');
    expect(toFtsQuery('a -"b c" -d')).toBe('("a") NOT "b c" NOT "d"');
  });

  it('🔴 正の項が 0 なら null(「全部から除く」は引かない)', () => {
    expect(toFtsQuery('-c')).toBeNull();
    expect(toFtsQuery('')).toBeNull();
    expect(toFtsQuery('   ')).toBeNull();
    expect(toFtsQuery('-')).toBeNull();
  });

  it('🔴 演算子・括弧・* を含む語は引用に閉じる(構文に届かない)', () => {
    expect(toFtsQuery('AND OR')).toBe('"AND" AND "OR"');
    expect(toFtsQuery('x* (y) NOT')).toBe('"x*" AND "(y)" AND "NOT"');
    expect(toFtsQuery('a:b -NEAR')).toBe('("a:b") NOT "NEAR"');
  });

  it('閉じていない " は末尾までフレーズ(打っている途中でも壊れない)', () => {
    expect(toFtsQuery('"a b')).toBe('"a b"');
    expect(parseSearchTerms('a "b c')).toEqual({ include: ['a', 'b c'], exclude: [] });
  });

  it('語の途中の - は除外にしない(ハイフンつきの語)', () => {
    expect(toFtsQuery('foo-bar')).toBe('"foo-bar"');
    expect(parseSearchTerms('a-b -c')).toEqual({ include: ['a-b'], exclude: ['c'] });
  });

  it('引用符は 2 つ重ねて escape する(句を閉じられない)', () => {
    expect(quoteFtsTerm('a"b')).toBe('"a""b"');
  });
});

describe('planSearch(syntax: query)', () => {
  it('全項が 3 字以上なら FTS', () => {
    expect(planSearch('全文検索 -りんご', { syntax: 'query' })).toEqual({
      kind: 'fts',
      match: '("全文検索") NOT "りんご"',
    });
  });

  it('🔴 3 字未満の項が正の側に混じれば LIKE 側(項の並び)', () => {
    expect(planSearch('全文検索 晴れ', { syntax: 'query' })).toEqual({
      kind: 'like-terms',
      include: ['全文検索', '晴れ'],
      exclude: [],
    });
  });

  it('🔴 除外側が 3 字未満でも LIKE 側(trigram は 2 字を当てられず、除外が黙って効かない)', () => {
    expect(planSearch('全文検索 -林', { syntax: 'query' })).toEqual({
      kind: 'like-terms',
      include: ['全文検索'],
      exclude: ['林'],
    });
  });

  it('正の項が 0 なら none', () => {
    expect(planSearch('-c', { syntax: 'query' })).toEqual({ kind: 'none' });
    expect(planSearch('   ', { syntax: 'query' })).toEqual({ kind: 'none' });
  });
});

/**
 * 🔴 **対照群 ── 左の列の欄は変わっていない**。一覧の意味論は外向きの変更なので、
 * 探す面に書き方を足しても**あちらは丸ごと 1 句のまま**でなければならない。
 * ⚠ 期待値は**字面で pin**(実装と同じ文法で組まない ── CLAUDE.md §1)。
 */
describe('対照群: 左の列の欄(toFtsMatch / 既定の planSearch)は変わっていない', () => {
  it('空白も - も " も、丸ごと 1 句として引く', () => {
    expect(toFtsMatch('a b')).toBe('"a b"');
    expect(toFtsMatch('全文検索 -りんご')).toBe('"全文検索 -りんご"');
    expect(toFtsMatch('AND OR "x*')).toBe('"AND OR ""x*"');
    expect(toFtsMatch('  りんご  ')).toBe('"りんご"');
  });

  it('既定の planSearch は plain(探す面の書き方が漏れていない)', () => {
    expect(planSearch('全文検索 -りんご')).toEqual({ kind: 'fts', match: '"全文検索 -りんご"' });
    expect(planSearch('全文検索 -りんご', { syntax: 'plain' })).toEqual({
      kind: 'fts',
      match: '"全文検索 -りんご"',
    });
    expect(planSearch('会議')).toEqual({ kind: 'like', pattern: '%会議%' });
    expect(planSearch('%_')).toEqual({ kind: 'like', pattern: '%\\%\\_%' });
    expect(planSearch('')).toEqual({ kind: 'none' });
  });
});
