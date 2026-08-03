/** @vitest-environment node */
/**
 * P7b review M-1 / M-3: 絞り込みの**唯一の規則**。
 *
 * 🔴 規則が 2 か所に生えると、面ごとに答えがずれる ── 実際、一覧は絞られて
 * いるのに後継選択と中央ペインは絞られていなかった。
 */
import { describe, expect, it } from 'vitest';
import {
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
