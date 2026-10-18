/** @vitest-environment happy-dom */
/**
 * 台帳 #1852 束 R1(依頼 255 / 279 / 351): 見出しの飛び先の名前は「画面に見えている字」から作り、
 * 見出し番号つきの文書では番号を除いた字から作る。古い名前でも飛べる。
 */
import { describe, it, expect } from 'vitest';
import {
  slugifyHeading,
  legacySlugifyHeading,
  makeSlugCounter,
  visibleHeadingText,
  extractHeadingsFromMarkdown,
} from '../../src/features/markdown/markdown-toc';
import { renderMarkdown, preprocessHeadingNumbers } from '../../src/features/markdown/markdown-render';
import { sectionRange, listAppendTargets } from '../../src/features/markdown/append-target';

function host(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('依頼 255: 見えている字から名前を作る', () => {
  it.each([
    ['[Docs](http://a.com)', 'docs'],
    ['![図](a.png) まとめ', '図-まとめ'],
    ['`code` と **太字**', 'code-と-太字'],
    ['[[ruby:漢字|かんじ]]の話', '漢字の話'],
    ['snake_case', 'snake_case'],
    ['snake\\_case', 'snake_case'],
    ['_強調_ だけ', '強調-だけ'],
    ['`a_b` と c', 'a_b-と-c'],
    ['Hello World!', 'hello-world'],
  ])('%s → #%s', (raw, want) => {
    expect(slugifyHeading(raw)).toBe(want);
  });

  it('対照群: 古い名前は従来のまま(`#docshttpacom` / `snakecase`)', () => {
    expect(legacySlugifyHeading('[Docs](http://a.com)')).toBe('docshttpacom');
    expect(legacySlugifyHeading('snake_case')).toBe('snakecase');
    expect(visibleHeadingText('[Docs](http://a.com)')).toBe('Docs');
  });

  it('描画: 新しい名前が id、古い名前は見出しの中の空の別名。同じなら別名を置かない', () => {
    const el = host(renderMarkdown('# [Docs](http://a.com)\n\n## 普通の見出し\n\n## snake_case'));
    const h1 = el.querySelector('h1')!;
    expect(h1.id).toBe('docs');
    const alias = h1.querySelector('span[id]')!;
    expect(alias.id).toBe('docshttpacom');
    expect(alias.textContent).toBe('');
    expect(h1.textContent).toBe('Docs');
    const h2s = [...el.querySelectorAll('h2')];
    expect(h2s[0]!.id).toBe('普通の見出し');
    expect(h2s[0]!.querySelector('span[id]')).toBeNull();
    expect(h2s[1]!.id).toBe('snake_case');
    expect(h2s[1]!.querySelector('span[id]')!.id).toBe('snakecase');
  });

  it('目次の名前は本文の id と同じ', () => {
    const md = '# [Docs](http://a.com)\n\n## `x_y`\n';
    const toc = extractHeadingsFromMarkdown(md).map((h) => h.slug);
    const ids = [...host(renderMarkdown(md)).querySelectorAll('h1, h2')].map((h) => h.id);
    expect(toc).toEqual(ids);
  });

  it('章の範囲: 新しい名前でも古い名前でも同じ章が引ける', () => {
    const body = '# [Docs](http://a.com)\n本文A\n\n# 次\n本文B\n';
    const a = sectionRange(body, 'docs');
    expect(a).not.toBeNull();
    expect(sectionRange(body, 'docshttpacom')).toEqual(a);
    expect(sectionRange(body, 'ない名前')).toBeNull();
  });
});

describe('依頼 279 / 351: 見出し番号つきの文書', () => {
  const FM = '---\nheading-number: true\n---\n';
  const inner = '# 第一章 概要\n本文\n\n## 背景\n詳細\n\n# 第二章\n';
  const body = FM + inner;

  it('描画: id は番号を除いた字、番号つきの古い名前は別名で残る', () => {
    const el = host(renderMarkdown(inner, { headingNumber: { start: 1 } }));
    const h = [...el.querySelectorAll('h1, h2')];
    expect(h.map((x) => x.id)).toEqual(['第一章-概要', '背景', '第二章']);
    // 古い名前 = 番号を前置した後の字から作った綴り(これまで配られていたリンクの名前)
    const numbered = preprocessHeadingNumbers('# 第一章 概要', 1);
    expect(numbered).toContain('1.');
    expect(h[0]!.querySelector('span[id]')!.id).toBe(legacySlugifyHeading('1. 第一章 概要'));
  });

  it('章を足して番号がずれても、番号なしの名前は同じ章を指す', () => {
    const before = renderMarkdown(inner, { headingNumber: { start: 1 } });
    const after = renderMarkdown(inner.replace('# 第一章 概要', '# 序\n\n# 第一章 概要'), { headingNumber: { start: 1 } });
    expect(host(before).querySelector('h1#第一章-概要')).not.toBeNull();
    expect(host(after).querySelector('h1#第一章-概要')).not.toBeNull();
  });

  it('目次の名前は番号なし(本文の id と同じ)', () => {
    const slugs = extractHeadingsFromMarkdown(body, {
      numberHeadings: (s) => preprocessHeadingNumbers(s, 1),
    }).map((x) => x.slug);
    expect(slugs).toEqual(['第一章-概要', '背景', '第二章']);
  });

  it('章の範囲(埋め込み・追記): 番号なしの名前も、番号つきの古い名前も引ける', () => {
    const plain = sectionRange(body, '第一章-概要');
    expect(plain).not.toBeNull();
    const legacy = legacySlugifyHeading('1. 第一章 概要');
    expect(sectionRange(body, legacy)).toEqual(plain);
    expect(listAppendTargets(body).map((t) => t.slug)).toEqual(['第一章-概要', '背景', '第二章']);
  });

  it('対照群: 見出し番号の無い文書は、手書きの番号も名前に残る', () => {
    const c = makeSlugCounter();
    expect(c('1. 概要')).toBe('1-概要');
    const el = host(renderMarkdown('# 1. 概要'));
    expect(el.querySelector('h1')!.id).toBe('1-概要');
  });
});
