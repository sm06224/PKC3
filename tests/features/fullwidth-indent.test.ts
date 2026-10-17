/** @vitest-environment node */
/**
 * 🔴 行頭の全角の空白で字下げした箇条書きを、入れ子として描く(#1163 依頼 136。Gemini 回答は案どおり)。
 *
 * 直す前は `- a` の次の `(全角の空白)- b` が入れ子にならず、`a  - b` と 1 行目の続きの字になっていた。
 * ⚠ 本文は書き換えない(描く前の字だけを揃える)/ 行数は変えない / コードの中と普通の段落は触らない。
 */
import { describe, expect, it } from 'vitest';
import { foldIdeographicIndent } from '../../src/features/markdown/fullwidth-indent';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

/** 描いた HTML の中の `<ul>` の入れ子の深さの最大。 */
function listDepth(html: string): number {
  let depth = 0;
  let max = 0;
  for (const m of html.matchAll(/<(\/?)[uo]l[\s>]/g)) {
    depth += m[1] === '/' ? -1 : 1;
    max = Math.max(max, depth);
  }
  return max;
}

describe('描画 ── 全角の空白の字下げが入れ子になる', () => {
  it('半角の空白 2 つと同じ入れ子になる(対照群を同じ表に置く)', () => {
    for (const indent of ['  ', '\t', '　']) {
      const html = renderMarkdown(`- a\n${indent}- b`);
      expect(listDepth(html), JSON.stringify(indent)).toBe(2);
    }
  });

  it('直す前の症状 ── 1 行目の続きの字(`a  - b`)になっていない', () => {
    const html = renderMarkdown('- a\n　- b');
    expect(html).not.toMatch(/a\s*-\s*b/);
    expect(html).toContain('<li>b</li>');
  });

  it('番号付き・2 段(全角の空白 2 つ)・記号の後ろの全角の空白も読む', () => {
    // ⚠ 番号付きは中身の位置(3 字)まで字下げしないと入れ子にならない ── 半角の空白 2 つでも同じ(Markdown の決まり)。全角 2 つ = 半角 4 つなら入れ子
    expect(listDepth(renderMarkdown('1. あ\n  1. い'))).toBe(1);
    expect(listDepth(renderMarkdown('1. あ\n　　1. い'))).toBe(2);
    expect(listDepth(renderMarkdown('- a\n　- b\n　　- c'))).toBe(3);
    expect(listDepth(renderMarkdown('- あ\n　-　い'))).toBe(2);
  });

  it('日本語の項目(全角の括弧・読点を含む)でも壊れない', () => {
    const html = renderMarkdown('- 買い物（週末）、まとめて\n　- 牛乳　2 本\n　- 卵');
    expect(listDepth(html)).toBe(2);
    expect(html).toContain('牛乳　2 本');
  });
});

describe('foldIdeographicIndent ── 直す所と直さない所', () => {
  it('全角の空白 1 つ = 半角の空白 2 つ。行数は変わらない', () => {
    const src = '- a\n　- b\n　　- c';
    const out = foldIdeographicIndent(src);
    expect(out).toBe('- a\n  - b\n    - c');
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });

  it('全角の空白が無い本文は、同じ字をそのまま返す', () => {
    const src = '- a\n  - b';
    expect(foldIdeographicIndent(src)).toBe(src);
  });

  it('⚠ 印が続かない行(全角の空白で字下げしただけの段落)は直さない', () => {
    const src = '　吾輩は猫である。\n　-名前はまだ無い。';
    expect(foldIdeographicIndent(src)).toBe(src);
  });

  it('⚠ 囲みコードの中は直さない(閉じた後は直す)', () => {
    const src = '```\n　- コード\n```\n　- 外';
    expect(foldIdeographicIndent(src)).toBe('```\n　- コード\n```\n  - 外');
  });

  it('⚠ 水平線(`- - -`)は項目にしない', () => {
    const src = '　- - -';
    expect(foldIdeographicIndent(src)).toBe(src);
  });
});
