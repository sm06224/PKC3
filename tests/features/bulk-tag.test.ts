/**
 * #402 ①: **まとめてタグを付ける / 外す**(規則の側)。
 *
 * > user の物語: フォルダで 12 件選んだ。全部に `#請求済` を付けたい。
 * > いま一括でできるのは「ゴミ箱へ」だけで、**12 回開いて 12 回書く**。
 *
 * 🔴 **双方向**(user 指示 2026-08-23)── 付けられるなら外せる必要がある。
 * 付けるだけだと、12 件に間違えて付けたものを **12 回開いて消す**ことになる。
 */
import { describe, expect, it } from 'vitest';
import { MAX_TAGS, normalizeTag, readTags, withTag } from '../../src/features/flavor/tags';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';

const doc = (tags: string): string => `---\n${tags}\n---\n本文\n`;

describe('タグを 1 つ足す / 外す', () => {
  it('足す ── 書いた順は保つ(user が意味のある順に書いている)', () => {
    expect(withTag(['家事', '買い物'], '請求済', 'add')).toEqual(['家事', '買い物', '請求済']);
  });

  it('🔴 既に在れば null(同じタグを 2 つ並べない)', () => {
    expect(withTag(['請求済'], '請求済', 'add')).toBeNull();
  });

  it('🔴 突き合わせは大小無視(`Tag` と `tag` を 2 つにしない)', () => {
    expect(withTag(['Tag'], 'tag', 'add')).toBeNull();
    expect(withTag(['Tag'], 'tag', 'remove')).toEqual([]);
  });

  it('外す ── 他のタグは残る', () => {
    expect(withTag(['家事', '請求済', '買い物'], '請求済', 'remove')).toEqual(['家事', '買い物']);
  });

  it('🔴 元から無ければ null(書かない材料になる)', () => {
    expect(withTag(['家事'], '請求済', 'remove')).toBeNull();
  });

  it('⚠ 空・空白だけのタグは null(空のタグを作らない)', () => {
    expect(withTag([], '   ', 'add')).toBeNull();
    expect(withTag([], '', 'add')).toBeNull();
  });

  it('🔴 上限を超えたら足さない(黙って古い方を落とさない)', () => {
    const full = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
    expect(withTag(full, 'あふれる', 'add')).toBeNull();
  });

  it('⚠ 長すぎるタグは足さない', () => {
    expect(withTag([], 'あ'.repeat(41), 'add')).toBeNull();
  });

  it('正規化は読む側と同じ規則(前後の空白・連続空白)', () => {
    expect(normalizeTag('  請求  済  ')).toBe('請求 済');
  });
});

describe('本文への当て方(書換の 1 本を通る)', () => {
  const add = (body: string, tag: string): string | null =>
    applyBodyRewrite(body, { kind: 'tag', tag, mode: 'add' });
  const off = (body: string, tag: string): string | null =>
    applyBodyRewrite(body, { kind: 'tag', tag, mode: 'remove' });

  it('🔴 frontmatter が無い本文にも付く(器から作る)', () => {
    const out = add('ただの本文\n', '請求済')!;
    expect(readTags(out)).toEqual(['請求済']);
    expect(out, '本文が消えた').toContain('ただの本文');
  });

  it('既にある配列へ足す', () => {
    expect(readTags(add(doc('tags: [家事]'), '請求済')!)).toEqual(['家事', '請求済']);
  });

  it('⚠ カンマ区切りで書いてあっても読めて足せる(記法を減らさない)', () => {
    expect(readTags(add(doc('tags: 家事, 買い物'), '請求済')!)).toEqual([
      '家事',
      '買い物',
      '請求済',
    ]);
  });

  it('🔴 最後の 1 つを外したら鍵ごと消す(空のタグが 1 つ在るように見せない)', () => {
    const out = off(doc('tags: [請求済]'), '請求済')!;
    expect(readTags(out)).toEqual([]);
    expect(out, 'tags: [] が残っている').not.toContain('tags:');
  });

  it('🔴 変わらないときは null(同じ本文を書き直して更新日時を動かさない)', () => {
    expect(add(doc('tags: [請求済]'), '請求済')).toBeNull();
    expect(off(doc('tags: [家事]'), '請求済')).toBeNull();
  });

  it('⚠ 本文は 1 バイトも変わらない(frontmatter だけ触る)', () => {
    const body = doc('tags: [家事]') + '2 行目\n';
    const out = add(body, '請求済')!;
    expect(out.split('---\n')[2], '本文が書き換わった').toBe(body.split('---\n')[2]);
  });
});
