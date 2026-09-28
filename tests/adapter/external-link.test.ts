/**
 * 🔴 **Markdown プレビュー内の外部リンク識別機能のテスト**(#1152)。
 */
import { describe, expect, it } from 'vitest';
import {
  applyExternalLinks,
  extractHostname,
  isDecoratableExternalLink,
} from '../../src/adapter/ui/render/external-link';

describe('external-link: extractHostname', () => {
  it('https および http の URL からホスト名を抽出する', () => {
    expect(extractHostname('https://github.com/sm06224/PKC3')).toBe('github.com');
    expect(extractHostname('http://sub.example.com:8080/path?q=1')).toBe('sub.example.com');
  });

  it('内部リンクスキームや不正な URL では null を返す', () => {
    expect(extractHostname('entry:12345')).toBeNull();
    expect(extractHostname('asset:key-abc')).toBeNull();
    expect(extractHostname('#section-heading')).toBeNull();
    expect(extractHostname('mailto:info@example.com')).toBeNull();
    expect(extractHostname('not a url')).toBeNull();
  });
});

describe('external-link: isDecoratableExternalLink', () => {
  it('テキストを含む外部リンクを装飾対象と判定する', () => {
    const a = document.createElement('a');
    a.href = 'https://example.com';
    a.textContent = 'Example サイト';
    expect(isDecoratableExternalLink(a)).toBe(true);
  });

  it('画像のみを含みテキストを持たないリンクは除外する', () => {
    const a = document.createElement('a');
    a.href = 'https://example.com';
    const img = document.createElement('img');
    img.src = 'banner.png';
    a.appendChild(img);
    expect(isDecoratableExternalLink(a)).toBe(false);
  });

  it('画像とテキストの両方を含むリンクは装飾対象とする', () => {
    const a = document.createElement('a');
    a.href = 'https://example.com';
    const img = document.createElement('img');
    img.src = 'icon.png';
    a.appendChild(img);
    a.append(' 公式サイト');
    expect(isDecoratableExternalLink(a)).toBe(true);
  });

  it('内部リンクやアンカーは除外する', () => {
    const aEntry = document.createElement('a');
    aEntry.setAttribute('href', 'entry:lid-1');
    aEntry.textContent = 'ノートA';
    expect(isDecoratableExternalLink(aEntry)).toBe(false);

    const aHash = document.createElement('a');
    aHash.setAttribute('href', '#heading-1');
    aHash.textContent = '見出し1';
    expect(isDecoratableExternalLink(aHash)).toBe(false);
  });
});

describe('external-link: applyExternalLinks', () => {
  function createSampleContent(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'pkc-md-rendered';
    container.innerHTML = `
      <p>
        参照: <a href="https://github.com/sm06224/PKC3">GitHub リポジトリ</a>
        公式: <a href="https://nodejs.org/en" title="Node.js 公式">Node.js</a>
        内部: <a href="entry:note-123">関連ノート</a>
        目次: <a href="#heading-1">第1章</a>
        バナー: <a href="https://example.com/banner"><img src="banner.jpg" /></a>
      </p>
    `;
    return container;
  }

  it('外部リンクにアイコンと title を付与する', () => {
    const container = createSampleContent();
    applyExternalLinks(container);

    const ghLink = container.querySelector<HTMLAnchorElement>('a[href^="https://github.com"]')!;
    expect(ghLink.getAttribute('data-pkc-external-link')).toBe('true');
    expect(ghLink.getAttribute('title')).toBe('外部サイトを開く: github.com');

    const icon = ghLink.querySelector('.pkc-external-link-icon');
    expect(icon).not.toBeNull();
    expect(icon?.textContent).toBe('↗');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('既存の明示的な title を保持する', () => {
    const container = createSampleContent();
    applyExternalLinks(container);

    const nodeLink = container.querySelector<HTMLAnchorElement>('a[href^="https://nodejs.org"]')!;
    expect(nodeLink.getAttribute('title')).toBe('Node.js 公式');
    expect(nodeLink.querySelector('.pkc-external-link-icon')).not.toBeNull();
  });

  it('内部リンクや画像単体リンクにはアイコンを付与しない', () => {
    const container = createSampleContent();
    applyExternalLinks(container);

    const entryLink = container.querySelector<HTMLAnchorElement>('a[href^="entry:"]')!;
    expect(entryLink.hasAttribute('data-pkc-external-link')).toBe(false);
    expect(entryLink.querySelector('.pkc-external-link-icon')).toBeNull();

    const hashLink = container.querySelector<HTMLAnchorElement>('a[href^="#"]')!;
    expect(hashLink.hasAttribute('data-pkc-external-link')).toBe(false);
    expect(hashLink.querySelector('.pkc-external-link-icon')).toBeNull();

    const bannerLink = container.querySelector<HTMLAnchorElement>('a[href*="banner"]')!;
    expect(bannerLink.hasAttribute('data-pkc-external-link')).toBe(false);
    expect(bannerLink.querySelector('.pkc-external-link-icon')).toBeNull();
  });

  it('applyExternalLinks は冪等であり二重にアイコンを追加しない', () => {
    const container = createSampleContent();
    applyExternalLinks(container);
    applyExternalLinks(container);

    const ghLink = container.querySelector<HTMLAnchorElement>('a[href^="https://github.com"]')!;
    const icons = ghLink.querySelectorAll('.pkc-external-link-icon');
    expect(icons.length).toBe(1);
  });
});
