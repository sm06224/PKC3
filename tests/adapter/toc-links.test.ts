/** @vitest-environment happy-dom */
/**
 * 台帳 #1852 束 R1(依頼 86-2 B): 本文の `:::toc` の行は、右のペインの目次と同じ飛び方(アドレスを変えない)。
 * 期待値の HTML は実物の `renderMarkdown` から採る(手で書くと焼く側の綴りが変わった日に両方そのままで緑になる)。
 */
import { describe, expect, it } from 'vitest';
import { applyBodyTocLinks } from '../../src/adapter/ui/render/toc-links';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

function hostOf(md: string): HTMLElement {
  const host = document.createElement('div');
  host.className = 'pkc-md-rendered';
  host.innerHTML = renderMarkdown(md);
  return host;
}

const BODY = ':::toc\n\n# 第一章\n\n## 背景\n\n# [Docs](http://a.com)\n';

describe('applyBodyTocLinks', () => {
  it('🔴 前提: 実物の描画が `:::toc` の行を素のページ内リンクとして焼いている(空振り防止)', () => {
    const host = hostOf(BODY);
    const links = [...host.querySelectorAll<HTMLAnchorElement>('.pkc-toc-formal a.pkc-toc-link')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['#第一章', '#背景', '#docs']);
    expect(links.every((a) => !a.hasAttribute('data-pkc-action'))).toBe(true);
  });

  it('🔴 当てると、行が toc-jump になり、飛び先の名前は本文の見出しの id と同じ', () => {
    const host = hostOf(BODY);
    applyBodyTocLinks(host);
    const links = [...host.querySelectorAll<HTMLAnchorElement>('.pkc-toc-formal a.pkc-toc-link')];
    expect(links.map((a) => a.getAttribute('data-pkc-action'))).toEqual(['toc-jump', 'toc-jump', 'toc-jump']);
    const ids = new Set([...host.querySelectorAll('h1[id], h2[id]')].map((h) => h.id));
    for (const a of links) expect(ids.has(a.getAttribute('data-pkc-toc-slug')!), a.outerHTML).toBe(true);
    // href は残す(書き出し・印刷・ブラウザの「リンクのコピー」のため)
    expect(links[0]!.getAttribute('href')).toBe('#第一章');
  });

  it('冪等 / 目次の外のページ内リンクは触らない', () => {
    const host = hostOf(`${BODY}\n[ここ](#第一章)\n`);
    applyBodyTocLinks(host);
    applyBodyTocLinks(host);
    const plain = [...host.querySelectorAll('p a')].find((a) => a.textContent === 'ここ')!;
    expect(plain.hasAttribute('data-pkc-action')).toBe(false);
    expect(host.querySelectorAll('[data-pkc-action="toc-jump"]')).toHaveLength(3);
  });

  it('日本語の名前は % のまま来ても元の字で渡す', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<nav class="pkc-toc-formal"><ul><li><a class="pkc-toc-link" href="#%E7%AC%AC%E4%B8%80%E7%AB%A0">x</a></li></ul></nav>';
    applyBodyTocLinks(host);
    expect(host.querySelector('a')!.getAttribute('data-pkc-toc-slug')).toBe('第一章');
  });
});
