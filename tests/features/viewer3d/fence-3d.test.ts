/** @vitest-environment happy-dom */
/**
 * ` ```3d ` の囲み(v4.0 PR-12)── 標準の規約(無印 = both / -render / -norender)・器の形・参照の走査。
 */
import { describe, expect, it } from 'vitest';
import { RENDERABLE_FENCE_LANGS, parseRenderableFence, renderMarkdown } from '@features/markdown/markdown-render';
import { assetRefsIn } from '@features/asset/asset-ref-scan';

const SRC = '{"objects":[{"type":"box","label":"<b>x</b>"}]}';

function dom(md: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = renderMarkdown(md);
  return d;
}

describe('` ```3d ` の囲み', () => {
  it('描画できる言語に 3d が在り、4 つの書き方を読む', () => {
    expect(RENDERABLE_FENCE_LANGS.has('3d')).toBe(true);
    expect(parseRenderableFence('3d')).toMatchObject({ lang: '3d', mode: 'both' });
    expect(parseRenderableFence('3d-both')).toMatchObject({ lang: '3d', mode: 'both' });
    expect(parseRenderableFence('3d-render')).toMatchObject({ lang: '3d', mode: 'render' });
    expect(parseRenderableFence('3d-norender')).toMatchObject({ lang: '3d', mode: 'norender' });
    expect(parseRenderableFence('3D')).toMatchObject({ lang: '3d' });
  });

  it('🔴 器は原文を属性に持ち、受け皿の原文は JSON として彩色する(script を作らない)', () => {
    const d = dom(`\`\`\`3d\n${SRC}\n\`\`\`\n`);
    const ph = d.querySelector('.pkc-3d-placeholder')!;
    expect(ph).not.toBeNull();
    expect(ph.getAttribute('data-pkc-3d-src')?.trim()).toBe(SRC);
    expect(ph.getAttribute('data-pkc-md-block-kind')).toBe('3d');
    expect(ph.querySelector('pre.pkc-3d-source code.language-json')).not.toBeNull();
    expect(d.querySelector('b')).toBeNull(); // label の HTML は字のまま
    // both: 切替がある
    expect(d.querySelector('.pkc-render-toggle-input')).not.toBeNull();
  });

  it('-render は切替なし・-norender は器を作らずコードだけ', () => {
    const r = dom(`\`\`\`3d-render\n${SRC}\n\`\`\`\n`);
    expect(r.querySelector('.pkc-3d-placeholder')).not.toBeNull();
    expect(r.querySelector('.pkc-render-toggle-input')).toBeNull();
    const n = dom(`\`\`\`3d-norender\n${SRC}\n\`\`\`\n`);
    expect(n.querySelector('.pkc-3d-placeholder')).toBeNull();
    expect(n.querySelector('[data-pkc-3d-src]')).toBeNull();
    expect(n.querySelector('code')!.textContent).toContain('"objects"');
  });

  it('🔴 同じ塊の HTML は無関係な段落を足しても変わらない(動いているビューアを作り直さない)', () => {
    const block = `\`\`\`3d\n${SRC}\n\`\`\`\n`;
    const a = dom(block).querySelector('.pkc-3d-placeholder')!.outerHTML;
    const b = dom(`前の段落\n\n${block}`).querySelector('.pkc-3d-placeholder')!.outerHTML;
    expect(b).toBe(a);
  });

  it('🔴 ` ```3d ` の中の asset:鍵 は参照の走査(assetRefsIn)に拾われる', () => {
    const body = '# 部屋\n\n```3d\n{"model":"asset:ast-chair01","objects":[{"type":"plane"}]}\n```\n';
    expect(assetRefsIn(body, ['ast-chair01', 'ast-other'])).toEqual(['ast-chair01']);
  });
});
