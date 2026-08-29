import { describe, expect, it } from 'vitest';
import {
  collectKeys,
  groupByKey,
  QUERY_LIMITS,
  TAGS_KEY,
  UNSET,
  type QueryRow,
} from '@features/query/group-by';

/** 本文を組み立てる小道具(frontmatter は**本文の先頭**にしか置けない)。 */
const fm = (lines: string[], body = '本文'): string => `---\n${lines.join('\n')}\n---\n\n${body}\n`;

const rows = (...pairs: Array<[string, string]>): QueryRow[] =>
  pairs.map(([lid, head]) => ({ lid, head }));

describe('query: frontmatter で束ねる(#184)', () => {
  it('key の目録は件数の多い順、同数は字順', () => {
    const r = rows(
      ['a', fm(['author: 佐藤', 'status: 済'])],
      ['b', fm(['author: 田中', 'status: 未'])],
      ['c', fm(['author: 佐藤'])],
      ['d', fm(['zzz: 1', 'aaa: 1'])],
    );
    const out = collectKeys(r);
    expect(out.scanned).toBe(4);
    expect(out.keys.map((k) => `${k.key}:${k.count}`)).toEqual([
      'author:3',
      'status:2',
      'aaa:1',
      'zzz:1',
    ]);
    expect(out.omittedKeys).toBe(0);
  });

  it('値を持たない key は目録に出ない(束ねられないので)', () => {
    const out = collectKeys(rows(['a', fm(['author:', 'tags: []'])]));
    expect(out.keys).toEqual([]);
  });

  it('束ねる: 件数の多い順、未設定は必ず最後', () => {
    const r = rows(
      ['a', fm(['author: 佐藤'])],
      ['b', fm(['author: 佐藤'])],
      ['c', fm(['author: 田中'])],
      ['d', '前置きの無い本文'],
    );
    const out = groupByKey(r, 'author');
    expect(out.groups.map((g) => [g.value, g.total])).toEqual([
      ['佐藤', 2],
      ['田中', 1],
      [UNSET, 1],
    ]);
    // 組の中の lid は**呼び側の並び**を保つ(一覧と同じ順)
    expect(out.groups[0]!.lids).toEqual(['a', 'b']);
  });

  it('配列は 1 件が複数の組に属する(タグで束ねるのに要る)', () => {
    const out = groupByKey(rows(['a', fm(['tags: [設計, 実装]']), ]), 'tags');
    expect(out.groups.map((g) => g.value).sort()).toEqual(['実装', '設計']);
    expect(out.groups.every((g) => g.lids.includes('a'))).toBe(true);
  });

  it('同じ値が 2 回書いてあっても 1 件として数える', () => {
    const out = groupByKey(rows(['a', fm(['tags: [x, x]'])]), 'tags');
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]).toMatchObject({ value: 'x', total: 1, lids: ['a'] });
  });

  it('null と空文字は未設定と同じ扱い', () => {
    const out = groupByKey(
      rows(['a', fm(['author: null'])], ['b', fm(['author: ""'])], ['c', fm(['x: 1'])]),
      'author',
    );
    expect(out.groups).toEqual([{ value: UNSET, total: 3, lids: ['a', 'b', 'c'] }]);
  });

  it('数と真偽も束ねられる(字にして扱う)', () => {
    const out = groupByKey(rows(['a', fm(['done: true'])], ['b', fm(['done: false'])]), 'done');
    expect(out.groups.map((g) => g.value).sort()).toEqual(['false', 'true']);
  });

  it('長い値は丸めるが、丸めたことが判る', () => {
    const long = 'あ'.repeat(QUERY_LIMITS.valueChars + 20);
    const out = groupByKey(rows(['a', fm([`k: ${long}`])]), 'k');
    const v = out.groups[0]!.value;
    expect(v.length).toBe(QUERY_LIMITS.valueChars + 1);
    expect(v.endsWith('…')).toBe(true);
  });

  it('🔴 組の上限を超えたら、捨てた数を返す(黙って切らない)', () => {
    const many = Array.from({ length: QUERY_LIMITS.groups + 7 }, (_, i): [string, string] => [
      `l${i}`,
      fm([`k: v${String(i).padStart(4, '0')}`]),
    ]);
    const out = groupByKey(rows(...many), 'k');
    expect(out.groups).toHaveLength(QUERY_LIMITS.groups);
    expect(out.omittedGroups).toBe(7);
    expect(out.scanned).toBe(QUERY_LIMITS.groups + 7);
  });

  it('🔴 1 組の lid が上限を超えても、件数は数え続ける(N 件中 M 件と言えるように)', () => {
    const many = Array.from({ length: QUERY_LIMITS.lidsPerGroup + 3 }, (_, i): [string, string] => [
      `l${i}`,
      fm(['k: 同じ']),
    ]);
    const out = groupByKey(rows(...many), 'k');
    expect(out.groups[0]!.total).toBe(QUERY_LIMITS.lidsPerGroup + 3);
    expect(out.groups[0]!.lids).toHaveLength(QUERY_LIMITS.lidsPerGroup);
  });

  it('🔑 空振り検出: 1 件も渡さなければ scanned は 0(「束ねた」と言わせない)', () => {
    expect(groupByKey([], 'k').scanned).toBe(0);
    expect(collectKeys([]).scanned).toBe(0);
  });

  it('frontmatter が無い本文だけでも落ちない', () => {
    const out = groupByKey(rows(['a', '# 見出し\n\n本文'], ['b', '']), 'author');
    expect(out.groups).toEqual([{ value: UNSET, total: 2, lids: ['a', 'b'] }]);
  });

  it('key の目録の上限でも、捨てた数を返す', () => {
    const head = fm(
      Array.from({ length: QUERY_LIMITS.keys + 4 }, (_, i) => `k${String(i).padStart(3, '0')}: v`),
    );
    const out = collectKeys(rows(['a', head]));
    expect(out.keys).toHaveLength(QUERY_LIMITS.keys);
    expect(out.omittedKeys).toBe(4);
  });
});

/**
 * 🔴 **タグだけは「本文の中」も数える**(#550 段④、user 要望 2026-08-29
 *   「タグのみで集計された表示が必要」)。
 *
 * ⚠ **対照群を同じ describe に置く** ── 索引を渡さない行が今までどおり
 *   未設定へ落ちること / タグ以外の key は本文中タグに影響されないこと。
 *   置かないと「索引を混ぜた」ではなく「**常に当たる**」に化けても気づけない。
 */
describe('query: タグは本文の中も数える(#550 段④)', () => {
  it('🔴 frontmatter に tags: が無くても、本文中タグで組ができる', () => {
    const out = groupByKey(
      [{ lid: 'a', head: '# 買い物メモ\n', bodyTags: ['買い物', '家事'] }],
      'tags',
    );
    expect(out.groups.map((g) => g.value).sort()).toEqual(['家事', '買い物']);
    expect(out.groups.every((g) => g.lids.includes('a'))).toBe(true);
  });

  it('🔴 frontmatter に tags: が無くても、目録に tags が出る(picker に出ないと選べない)', () => {
    const out = collectKeys([{ lid: 'a', head: '本文だけ\n', bodyTags: ['買い物'] }]);
    expect(out.keys.map((k) => k.key)).toContain('tags');
    expect(out.keys.find((k) => k.key === 'tags')?.count).toBe(1);
  });

  it('🔴 文書タグと本文中タグは 1 つに畳む(同じノートを 2 回数えない)', () => {
    const out = collectKeys([
      { lid: 'a', head: fm(['tags: [買い物]']), bodyTags: ['買い物', '家事'] },
    ]);
    // ⚠ **1 件**である ── frontmatter と本文の両方に在っても、ノートは 1 つ
    expect(out.keys.find((k) => k.key === 'tags')?.count).toBe(1);
    const g = groupByKey(
      [{ lid: 'a', head: fm(['tags: [買い物]']), bodyTags: ['買い物', '家事'] }],
      'tags',
    );
    // ⚠ 同じ名前は 1 組(`sameTag` で畳む ── 走査と同じ規則)
    expect(g.groups.map((x) => x.value).sort()).toEqual(['家事', '買い物']);
    expect(g.groups.find((x) => x.value === '買い物')?.total).toBe(1);
  });

  it('⚠ 対照群: 索引を渡さない行は、これまでどおり frontmatter だけで決まる', () => {
    const out = groupByKey(rows(['a', '# 見出しだけ\n\n#買い物 #家事\n']), 'tags');
    // ⚠ 本文にタグ行が**書いてあっても**、索引(bodyTags)が無ければ当てない
    //    ── 走査の契約(`tagsForMatch` の `indexed: null`)と同じ。埋め戻しで揃う
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]).toMatchObject({ value: UNSET, lids: ['a'] });
  });

  it('⚠ 対照群: タグ以外の key は本文中タグに影響されない', () => {
    const out = collectKeys([
      { lid: 'a', head: fm(['author: 佐藤']), bodyTags: ['買い物'] },
    ]);
    expect(out.keys.find((k) => k.key === 'author')?.count).toBe(1);
    expect(out.keys.find((k) => k.key === 'tags')?.count).toBe(1);
  });

  it('🔑 綴りは 1 か所(TAGS_KEY)── 直書きが 2 か所目を作らないように', () => {
    expect(TAGS_KEY).toBe('tags');
  });
});
