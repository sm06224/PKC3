/**
 * 🔴 **本文の画像の大きさ・寄せ**(#1640 ③)── 読む側(描画)と書く側(行の書き換え)が同じ 1 本の綴りを使う。
 */
import { describe, expect, it } from 'vitest';
import {
  findImageRef,
  formatImageAttrs,
  imageAttrsStyle,
  parseImageAttrs,
  writeImageAttrs,
} from '../../src/features/markdown/image-attrs';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

describe('parseImageAttrs / formatImageAttrs', () => {
  it('w と align を読み、同じ綴りに書き戻せる', () => {
    const p = parseImageAttrs('{w=50% align=center} 後ろ');
    expect(p).toEqual({ attrs: { w: 50, align: 'center' }, length: '{w=50% align=center}'.length });
    expect(formatImageAttrs(p!.attrs)).toBe('{w=50% align=center}');
    expect(formatImageAttrs({ w: null, align: 'right' })).toBe('{align=right}');
    expect(formatImageAttrs({ w: null, align: null })).toBe('');
  });
  it('読めない {...} は null(字のまま残す)', () => {
    for (const bad of ['{}', '{w=0%}', '{w=101%}', '{w=50}', '{foo=1}', '{w=50% w=60%}', '{align=up}', 'w=50%', '{w=50% x}']) {
      expect(parseImageAttrs(bad), bad).toBeNull();
    }
  });
  it('style は寄せのときだけ行にする', () => {
    expect(imageAttrsStyle({ w: 50, align: null })).toBe('width:50%;');
    expect(imageAttrsStyle({ w: null, align: 'center' })).toContain('margin-left:auto;margin-right:auto');
    expect(imageAttrsStyle({ w: null, align: 'left' })).toContain('margin-right:auto');
    expect(imageAttrsStyle({ w: null, align: null })).toBe('');
  });
});

describe('writeImageAttrs', () => {
  it('鍵の合う画像だけを書き換え、渡さなかった札は保つ・null は外す', () => {
    const line = 'まえ ![図](asset:k1){w=50%} と ![別](asset:k2) あと';
    expect(writeImageAttrs(line, 'k1', { align: 'right' })).toBe('まえ ![図](asset:k1){w=50% align=right} と ![別](asset:k2) あと');
    expect(writeImageAttrs(line, 'k1', { w: null })).toBe('まえ ![図](asset:k1) と ![別](asset:k2) あと');
    expect(writeImageAttrs(line, 'k2', { w: 25 })).toBe('まえ ![図](asset:k1){w=50%} と ![別](asset:k2){w=25%} あと');
    expect(writeImageAttrs(line, 'k3', { w: 25 }), '無い鍵').toBeNull();
    // 鍵の前方一致で別の画像を書き換えない
    expect(writeImageAttrs('![a](asset:k10)', 'k1', { w: 25 })).toBeNull();
  });
  it('読めない {...} が付いていても、その字は壊さない', () => {
    const line = '![a](asset:k1){foo}';
    expect(findImageRef(line, 'k1')!.attrEnd).toBe('![a](asset:k1)'.length);
    expect(writeImageAttrs(line, 'k1', { w: 50 })).toBe('![a](asset:k1){w=50%}{foo}');
  });
});

describe('描画', () => {
  it('🔴 大きさ・寄せが画像の属性と style に出て、{...} は字として残らない', () => {
    const html = renderMarkdown('![図](asset:k1){w=50% align=center}');
    expect(html).toContain('data-pkc-img-w="50"');
    expect(html).toContain('data-pkc-img-align="center"');
    expect(html).toContain('width:50%');
    expect(html).not.toContain('{w=');
  });
  it('🔴 属性が無い画像は今までどおり(属性も style も出ない)', () => {
    const html = renderMarkdown('![図](asset:k1)');
    expect(html).not.toContain('data-pkc-img-w');
    expect(html).not.toContain('style=');
  });
  it('読めない {...} は字のまま残る', () => {
    const html = renderMarkdown('![図](asset:k1){w=500%}');
    expect(html).toContain('{w=500%}');
    expect(html).not.toContain('data-pkc-img-w');
  });
});
