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
  normalizeTag,
  withTag,
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

/**
 * 🔴 **見えている字をそのまま打てば、同じタグになる**(2026-08-29 の動線レビュー)。
 *
 * ⚠ 本文では `#買い物` という札で見えるのに、情報ペインとスマートフォルダの条件では
 *   `買い物` で出る ── そのまま `#買い物` と打つと**別のタグ**が作られていた
 *   (集計では別の組、条件には入らない。書けてしまうので理由も出ない)。
 */
describe('打つ側は井桁を受け止める(#550)', () => {
  it('🔴 「#買い物」と打っても「買い物」と同じタグになる', () => {
    expect(normalizeTag('#買い物')).toBe('買い物');
    expect(sameTag(normalizeTag('#買い物'), '買い物')).toBe(true);
  });

  it('⚠ 対照群: 井桁の無い字はこれまでどおり', () => {
    expect(normalizeTag('  買い物  ')).toBe('買い物');
  });

  it('⚠ 井桁と空白が混じっても同じ', () => {
    expect(normalizeTag('# 買い物')).toBe('買い物');
    expect(normalizeTag('##買い物')).toBe('買い物');
  });

  it('⚠ 途中の井桁は落とさない(名前の一部である)', () => {
    expect(normalizeTag('C#')).toBe('C#');
    expect(normalizeTag('買い物#2')).toBe('買い物#2');
  });

  it('🔑 足すときにも効く(打った字が別のタグにならない)', () => {
    expect(withTag(['買い物'], '#買い物', 'add'), '同じタグを 2 つ作った').toBeNull();
    expect(withTag(['買い物'], '#買い物', 'remove'), '打った字で外せない').toEqual([]);
  });
});
