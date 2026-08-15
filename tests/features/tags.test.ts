/**
 * タグ(#182 / 台帳 #180 の A-2)。
 *
 * 🔴 **新しい概念を足さない**設計なので、守るのは「読み取りの規則」と
 * 「押したら探せること」の 2 つ。
 */
import { describe, expect, it } from 'vitest';
import {
  readTags,
  encodeTags,
  decodeTags,
  sameTag,
  MAX_TAGS,
  MAX_TAG_CHARS,
} from '../../src/features/flavor/tags';

const fm = (yaml: string) => `---\n${yaml}\n---\n本文\n`;

describe('タグの読み取り', () => {
  it('配列で書ける', () => {
    expect(readTags(fm('tags: [買い物, 家事]'))).toEqual(['買い物', '家事']);
  });

  it('🔴 カンマ区切りの文字列でも書ける(記法を減らさない)', () => {
    expect(readTags(fm('tags: 買い物, 家事'))).toEqual(['買い物', '家事']);
  });

  it('1 つだけでも読める', () => {
    expect(readTags(fm('tags: 買い物'))).toEqual(['買い物']);
  });

  it('frontmatter が無ければ空', () => {
    expect(readTags('ただの本文\n')).toEqual([]);
    expect(readTags(fm('title: x'))).toEqual([]);
  });

  it('前後の空白を落とし、内部の連続空白は 1 つに畳む', () => {
    expect(readTags(fm('tags: [  買い  物  ,  家事 ]'))).toEqual(['買い 物', '家事']);
  });

  it('空のタグは落とす', () => {
    expect(readTags(fm('tags: [買い物, , 家事]'))).toEqual(['買い物', '家事']);
  });

  it('🔴 重複は 1 つに(大小無視で突き合わせる)', () => {
    expect(readTags(fm('tags: [Work, work, WORK]'))).toEqual(['Work']);
  });

  it('順序は書いた順を保つ(並べ替えない)', () => {
    expect(readTags(fm('tags: [ん, あ, か]'))).toEqual(['ん', 'あ', 'か']);
  });

  it('長すぎるタグは落とす(事故った本文が一覧を埋めない)', () => {
    const long = 'あ'.repeat(MAX_TAG_CHARS + 1);
    expect(readTags(fm(`tags: [${long}, ok]`))).toEqual(['ok']);
  });

  it('数が多すぎたら上限で切る', () => {
    const many = Array.from({ length: MAX_TAGS + 10 }, (_, i) => `t${i}`);
    expect(readTags(fm(`tags: [${many.join(', ')}]`))).toHaveLength(MAX_TAGS);
  });

  it('sameTag は大小を無視する(表示は原文のまま)', () => {
    expect(sameTag('Work', 'work')).toBe(true);
    expect(sameTag('買い物', '買物')).toBe(false);
  });
});

describe('抽出列への符号化', () => {
  it('🔴 区切りで囲むので、部分一致が誤爆しない', () => {
    const enc = encodeTags(['買い物', '家事']);
    expect(enc).toBe('|買い物|家事|');
    // 「買い物リスト」というタグに「買い物」の丸ごと一致は当たらない
    expect(encodeTags(['買い物リスト']).includes('|買い物|')).toBe(false);
  });

  it('空なら空文字(区切りだけの文字列にしない)', () => {
    expect(encodeTags([])).toBe('');
    expect(decodeTags('')).toEqual([]);
    expect(decodeTags(null)).toEqual([]);
  });

  it('往復する', () => {
    expect(decodeTags(encodeTags(['a', 'b', '日本語']))).toEqual(['a', 'b', '日本語']);
  });

  it('タグに区切り文字が入っていても壊れない', () => {
    expect(decodeTags(encodeTags(['a|b']))).toEqual(['a b']);
  });
});
