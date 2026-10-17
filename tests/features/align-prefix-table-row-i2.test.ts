/** @vitest-environment node */
/**
 * 🔴 **表の中の行は、`||` で始まっても表の行**(台帳 #1852 I2 / 依頼 309。Gemini 回答 = 推薦 A)。
 *
 * 直す前は、最初の升を空にして `|` を詰めた行(`||x|y`。行末の `|` が無い)が中央寄せの印と読まれ、表から外れて
 * 表が途中で切れていた(「表の整形」を押すと表の行に直った)。表の外の `||中央寄せ` は変えない(対照群)。
 */
import { describe, expect, it } from 'vitest';
import { preprocessAlignPrefix } from '../../src/features/markdown/markdown-render';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const rows = (html: string): number => (html.match(/<tr>/g) ?? []).length;

describe('表の中の `||` で始まる行', () => {
  it('🔴 見出し行が `||x|y`(次が区切りの行)── 表になり、中央寄せの印として食われない', () => {
    // ⚠ `||x|y` の升は 3 つ(空・x・y)── 区切りの行も 3 列
    const src = '||x|y\n|---|---|---|\n| 1 | 2 | 3 |\n';
    const pre = preprocessAlignPrefix(src, [0, 1, 2]);
    expect(pre.alignMap.size, '中央寄せの印として食われた').toBe(0);
    expect(pre.stripped).toBe('||x|y\n|---|---|---|\n| 1 | 2 | 3 |\n');
    const html = renderMarkdown(src);
    expect(html).toContain('<table');
    expect(rows(html)).toBe(2); // 見出し行 + 本体 1 行
  });

  it('🔴 表の途中の行が `||x|y`(直前が表の行)── 表の行のまま', () => {
    const src = '| a | b | c |\n|---|---|---|\n||x|y\n| 3 | 4 | 5 |\n';
    const pre = preprocessAlignPrefix(src, [0, 1, 2, 3]);
    expect(pre.alignMap.size).toBe(0);
    const html = renderMarkdown(src);
    expect(html).toContain('<table');
    expect(rows(html)).toBe(3); // 見出し + `||x|y` + `| 3 | 4 |`
    expect(html).toContain('>x<');
  });

  it('⚠ 対照群 ── 表の外の `||中央寄せ` は、これまでどおり中央寄せ(直前が空行 / 段落、次が表の区切りでない)', () => {
    for (const src of ['||中央\n', '文章\n||中央\n| a | b |\n|---|---|\n| 1 | 2 |\n', '\n||x|y\n\n文']) {
      expect(preprocessAlignPrefix(src, src.split('\n').map((_, i) => i)).alignMap.size, JSON.stringify(src)).toBe(1);
    }
  });

  it('⚠ 対照群 ── 次の行が水平線(`---`)だけなら表の見出しではない(`|` を含まない)', () => {
    const src = '||x|y\n---\n';
    expect(preprocessAlignPrefix(src, [0, 1]).alignMap.size).toBe(1);
  });

  it('⚠ 対照群 ── 中央寄せの印の連続(`||a|b` の次に `||c|d`)は、どれも表の外の中央寄せのまま', () => {
    const src = '||a|b\n\n||c|d\n';
    expect(preprocessAlignPrefix(src, [0, 1, 2]).alignMap.size).toBe(2);
  });

  it('行末が `|` の行は、これまでどおり表の行(`|| A | B |`)', () => {
    const src = '|| A | B |\n|---|---|\n| 1 | 2 |\n';
    expect(preprocessAlignPrefix(src, [0, 1, 2]).alignMap.size).toBe(0);
  });
});
