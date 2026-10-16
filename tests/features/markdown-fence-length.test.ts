/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { renderMarkdown, stripComments } from '../../src/features/markdown/markdown-render';
import { stripDialect } from '../../src/features/markdown/strip-dialect';
import { sectionEmbedKeys } from '../../src/features/markdown/section-embed';

/**
 * #1087: fence の閉じは「開きと同じ種類で、同じ長さ以上」。
 * 直す前は種類しか見ず、4 つの ``` の中の ``` で閉じたことになり、
 * その後ろの `%%%` / `:::comment` / 見出し が生きた(隠れる / 番号が付く)。
 */
const OUTER = [
  '````md',
  '```',
  '%%%',
  'KEEP-A',
  '%%%',
  ':::comment',
  'KEEP-B',
  ':::',
  '```',
  '````',
].join('\n');

describe('fence の閉じは長さも見る #1087', () => {
  it('stripComments: 4 つの fence の中の ``` で閉じず、%%% / :::comment は素通し', () => {
    expect(stripComments(OUTER).transformed).toBe(OUTER);
  });

  it('対照: fence の外の %%% は今までどおり隠す', () => {
    const t = stripComments('%%%\nSECRET\n%%%\nVISIBLE').transformed;
    expect(t).not.toContain('SECRET');
    expect(t).toContain('VISIBLE');
  });

  it('renderMarkdown: 中身は <pre><code> の中に残る / 外の %%% は隠れる', () => {
    const html = renderMarkdown(OUTER + '\n\n%%%\nSECRET\n%%%\n\nVISIBLE');
    const pre = /<pre[\s\S]*?<\/pre>/.exec(html);
    expect(pre).not.toBeNull();
    expect(pre![0]).toContain('KEEP-A');
    expect(pre![0]).toContain('KEEP-B');
    expect(pre![0]).toContain('%%%');
    expect(html).not.toContain('SECRET');
    expect(html).toContain('VISIBLE');
  });

  it('~~~ の中の ``` / ``` の中の ~~~ では閉じない', () => {
    const src = ['~~~', '```', '%%%', 'KEEP', '%%%', '```', '~~~'].join('\n');
    expect(stripComments(src).transformed).toBe(src);
    const src2 = ['```', '~~~', '%%%', 'KEEP', '%%%', '~~~', '```'].join('\n');
    expect(stripComments(src2).transformed).toBe(src2);
  });

  it('見出し番号: 4 つの fence の中の # は見出しではない', () => {
    const src = ['````', '```', '# IN', '```', '````', '', '# OUT'].join('\n');
    const html = renderMarkdown(src, { headingNumber: { start: 1 } });
    expect(html).toMatch(/1\.\s*OUT/);
    expect(html).not.toMatch(/\d\.\s*IN/);
  });

  it('stripDialect: 4 つの fence の中の %%% / :::comment は触らない', () => {
    expect(stripDialect(OUTER)).toBe(OUTER);
    expect(stripDialect('%%%\nSECRET\n%%%\nVISIBLE')).not.toContain('SECRET');
  });

  it('sectionEmbedKeys: 4 つの fence の中の埋め込みは数えない', () => {
    const ref = '![x](entry:abc#h/sec)';
    const inside = ['````', '```', ref, '```', '````'].join('\n');
    expect(sectionEmbedKeys(inside)).toEqual([]);
    expect(sectionEmbedKeys(ref)).toHaveLength(1);
  });
});
