/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { extractHeadingsFromMarkdown } from '../../src/features/markdown/markdown-toc';
import { renderMarkdown, preprocessHeadingNumbers } from '../../src/features/markdown/markdown-render';
import { parseFrontmatter } from '../../src/features/markdown/frontmatter';
import { extractHeadingNumberConfig } from '../../src/features/markdown/document-globals';

describe('見出し番号(heading-number)と目次の slug', () => {
  it('本文の id は番号つきの字から作られる ── 目次の slug も同じ id になる(重複見出しを含む)', () => {
    const body = '---\nheading-number: true\n---\n# 概要\n## 背景\n## 目的\n# 方法\n## 背景\n## 背景';
    const cfg = extractHeadingNumberConfig(body);
    expect(cfg).not.toBeNull();
    const html = renderMarkdown(parseFrontmatter(body).body, { headingNumber: cfg } as never);
    const el = document.createElement('div');
    el.innerHTML = html;
    const ids = [...el.querySelectorAll('h1[id],h2[id],h3[id]')].map((h) => h.id);
    expect(ids.length).toBe(6);
    const toc = extractHeadingsFromMarkdown(body, {
      numberHeadings: (s) => preprocessHeadingNumbers(s, cfg!.start),
    });
    expect(toc.map((h) => h.slug)).toEqual(ids);
    // 目次に出す字は番号なしのまま
    expect(toc.map((h) => h.text)).toEqual(['概要', '背景', '目的', '方法', '背景', '背景']);
    // 対照群: 注入しなければ従来どおり(番号なしの slug)
    expect(extractHeadingsFromMarkdown(body).map((h) => h.slug)[0]).toBe('概要');
  });
});
