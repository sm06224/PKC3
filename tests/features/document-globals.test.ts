/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import {
  extractDocumentGlobals,
  extractHeadingNumberConfig,
  globalsToDataAttrs,
  applyDocumentGlobals,
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
