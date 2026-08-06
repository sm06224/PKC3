/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import {
  extractDocumentGlobals,
  extractHeadingNumberConfig,
  globalsToDataAttrs,
  applyDocumentGlobals,
  DOCUMENT_GLOBAL_ATTRS,
} from '../../src/features/markdown/document-globals';

const body = (fm: string) => `---\n${fm}\n---\n本文`;

describe('extractDocumentGlobals', () => {
  it('extracts valid writing / direction / align / layout', () => {
    const g = extractDocumentGlobals(
      body('writing: vertical\ndirection: rtl\nalign: top\nlayout: a4-2col'),
    );
    expect(g).toMatchObject({
      writing: 'vertical',
      direction: 'rtl',
      align: 'top',
      layout: 'a4-2col',
    });
    expect(g.warnings).toEqual([]);
  });

  it('invalid values produce structured warnings, not silent fail', () => {
    const g = extractDocumentGlobals(body('writing: diagonal\ndirection: down'));
    expect(g.writing).toBeUndefined();
    expect(g.direction).toBeUndefined();
    expect(g.warnings.map((w) => w.kind)).toEqual(['invalid_value', 'invalid_value']);
  });

  it('invalid writing×align combo falls back with invalid_combo warning', () => {
    const g = extractDocumentGlobals(body('align: top')); // horizontal(default)に top は不正
    expect(g.align).toBeUndefined();
    expect(g.warnings[0]?.kind).toBe('invalid_combo');
    // vertical なら top は valid
    expect(extractDocumentGlobals(body('writing: vertical\nalign: top')).align).toBe(
      'top',
    );
  });

  it('no frontmatter → all undefined, no warnings', () => {
    expect(extractDocumentGlobals('# 見出しだけ')).toEqual({ warnings: [] });
  });
});

describe('applyDocumentGlobals', () => {
  it('sets data-pkc-* AND dir in one place (PKC2 の 4-surface 重複の畳み込み)', () => {
    const el = document.createElement('div');
    const g = extractDocumentGlobals(body('writing: vertical\ndirection: rtl'));
    applyDocumentGlobals(el, g);
    expect(el.getAttribute('data-pkc-writing')).toBe('vertical');
    expect(el.getAttribute('data-pkc-direction')).toBe('rtl');
    expect(el.getAttribute('dir')).toBe('rtl'); // dir は helper の責務(付け漏れ防止)
    // globalsToDataAttrs 単体は dir を含まない(HTML attr は apply 側)
    expect(globalsToDataAttrs(g)['dir']).toBeUndefined();
  });

  /**
   * 🔴 **前のノートの書字方向が残らない**(2026-08-06)。読む面の器は
   * `bodyKind === 'md'` の間ずっと同じ要素を使い回すので、付けるだけだと
   * `align: right` のノートを見た後に宣言の無いノートを開いても右寄せのままになる
   * (縦書き・`dir` も同じ)。直す前は `removeAttribute` がどこにも無かった。
   */
  it('🔴 当てる前に全部消す(器を使い回しても前の文書の宣言が残らない)', () => {
    const el = document.createElement('div');
    applyDocumentGlobals(
      el,
      extractDocumentGlobals(body('writing: vertical\ndirection: rtl\nalign: bottom\nlayout: a4-2col')),
    );
    expect(el.getAttribute('data-pkc-doc-align')).toBe('bottom');
    // 宣言の無いノートへ切り替える
    applyDocumentGlobals(el, extractDocumentGlobals('宣言の無い本文'));
    for (const k of DOCUMENT_GLOBAL_ATTRS) {
      expect(el.hasAttribute(k), `${k} が残っている(前の文書の見え方で描かれる)`).toBe(false);
    }
  });

  /**
   * ⚠ **出せる key は全部消せること**。`globalsToDataAttrs` に key を足して
   * `DOCUMENT_GLOBAL_ATTRS` に足し忘れると、その 1 つだけが残り続ける
   * (しかも「消す処理は在る」ので目で見て気づけない)。
   */
  it('⚠ 出せる属性の全部が消す一覧に入っている(片方だけ足す事故を止める)', () => {
    const all = globalsToDataAttrs(
      extractDocumentGlobals(
        body('writing: vertical\ndirection: rtl\nalign: bottom\nlayout: a4-2col'),
      ),
    );
    // fixture 自身が「全 key 網羅」であることを assert(ゼロ件の次元を作らない)
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(4);
    for (const k of Object.keys(all)) expect(DOCUMENT_GLOBAL_ATTRS).toContain(k);
    expect(DOCUMENT_GLOBAL_ATTRS).toContain('dir');
  });
});

describe('extractHeadingNumberConfig', () => {
  it('true / on / 数値 opt-in、それ以外 null', () => {
    expect(extractHeadingNumberConfig(body('heading-number: true'))).toEqual({ start: 1 });
    expect(extractHeadingNumberConfig(body('heading-number: on'))).toEqual({ start: 1 });
    expect(extractHeadingNumberConfig(body('heading-number: 3'))).toEqual({ start: 3 });
    expect(extractHeadingNumberConfig(body('heading-number: false'))).toBeNull();
    expect(extractHeadingNumberConfig(body('heading-number: 0'))).toBeNull();
    expect(extractHeadingNumberConfig('本文のみ')).toBeNull();
  });
});
