/** @vitest-environment node */
/**
 * P7b review M-1 / M-3: 絞り込みの**唯一の規則**。
 *
 * 🔴 規則が 2 か所に生えると、面ごとに答えがずれる ── 実際、一覧は絞られて
 * いるのに後継選択と中央ペインは絞られていなかった。
 */
import { describe, expect, it } from 'vitest';
import {
  matchesEntry,
  matchesTitle,
  normalizeQuery,
  visibleOrder,
} from '../../src/features/filter/title-filter';

describe('絞り込みの規則', () => {
  it('空の絞り込みは全部通す', () => {
    expect(normalizeQuery('   ')).toBe('');
    expect(matchesTitle('なんでも', '')).toBe(true);
  });

  it('大小・前後の空白を無視して部分一致', () => {
    expect(normalizeQuery('  ABC ')).toBe('abc');
    expect(matchesTitle('xxABCxx', normalizeQuery(' abc '))).toBe(true);
    expect(matchesTitle('xxxx', normalizeQuery('abc'))).toBe(false);
  });

  it('並びは**元のまま**(絞り込みで順番が入れ替わらない)', () => {
    const titles: Record<string, string> = { a: 'りんご', b: 'ひみつ', c: 'りんご園' };
    expect(visibleOrder(['a', 'b', 'c'], (l) => titles[l], 'りんご')).toEqual(['a', 'c']);
  });

  it('題名の取れない lid は落ちる(一覧に無いものを混ぜない)', () => {
    expect(visibleOrder(['a', 'zz'], (l) => (l === 'a' ? 'x' : undefined), '')).toEqual([
      'a',
    ]);
  });
});

/**
 * 🔴 **一覧と後継選択が同じ答えを返す**(2026-08-15。#181 の穴)。
 * ⚠ ここが食い違うと、**本文だけが当たっているノートを消したときに選択が消える**
 *   ── 一覧には行が見えているのに中央が空になる、という気づきにくい壊れ方をする。
 */
describe('本文の当たりも「見えている」に数える', () => {
  const titles: Record<string, string> = { a: 'りんご', b: 'みかん', c: 'ぶどう' };
  const hits = new Set(['b']);

  it('題名が当たらなくても、本文が当たれば見えている', () => {
    expect(visibleOrder(['a', 'b', 'c'], (l) => titles[l], 'りんご', hits)).toEqual(['a', 'b']);
  });

  it('🔴 一覧の規則(matchesEntry)と答えが一致する', () => {
    const q = normalizeQuery('りんご');
    const byList = ['a', 'b', 'c'].filter((l) => matchesEntry(l, titles[l]!, q, hits));
    expect(visibleOrder(['a', 'b', 'c'], (l) => titles[l], 'りんご', hits)).toEqual(byList);
  });

  it('当たりがまだ返っていない(null)なら題名だけ', () => {
    expect(visibleOrder(['a', 'b'], (l) => titles[l], 'りんご', null)).toEqual(['a']);
  });
});
