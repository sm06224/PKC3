/** @vitest-environment happy-dom */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  applyCodeLangBadges,
  extractLanguageName,
} from '../../src/adapter/ui/render/code-lang';

describe('code block language badge (Issue #1128)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.append(host);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('adds language badge to code block with language class', () => {
    host.innerHTML = `
      <div class="pkc-md-block" data-pkc-md-block-kind="code">
        <button class="pkc-md-copy-btn" type="button">⧉</button>
        <pre><code class="language-typescript">const a: number = 42;</code></pre>
      </div>
    `;

    applyCodeLangBadges(host);

    const badge = host.querySelector<HTMLElement>('.pkc-code-lang');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('typescript');
    expect(badge?.getAttribute('aria-hidden')).toBe('true');
  });

  it('skips code block without language class or with ignored generic names', () => {
    host.innerHTML = `
      <div class="pkc-md-block" data-pkc-md-block-kind="code" id="block-none">
        <pre><code>no language</code></pre>
      </div>
      <div class="pkc-md-block" data-pkc-md-block-kind="code" id="block-text">
        <pre><code class="language-text">some text</code></pre>
      </div>
      <div class="pkc-md-block" data-pkc-md-block-kind="code" id="block-plain">
        <pre><code class="language-plain">some plain text</code></pre>
      </div>
    `;

    applyCodeLangBadges(host);

    expect(host.querySelectorAll('.pkc-code-lang')).toHaveLength(0);
  });

  it('is idempotent and does not create duplicate badges', () => {
    host.innerHTML = `
      <div class="pkc-md-block" data-pkc-md-block-kind="code">
        <pre><code class="language-python">print("hello")</code></pre>
      </div>
    `;

    applyCodeLangBadges(host);
    expect(host.querySelectorAll('.pkc-code-lang')).toHaveLength(1);

    applyCodeLangBadges(host);
    expect(host.querySelectorAll('.pkc-code-lang')).toHaveLength(1);
  });

  it('extracts language name correctly with extractLanguageName', () => {
    expect(extractLanguageName('language-javascript')).toBe('javascript');
    expect(extractLanguageName('language-python')).toBe('python');
    expect(extractLanguageName('hljs language-rust other')).toBe('rust');
    expect(extractLanguageName('language-c++')).toBe('c++');
    expect(extractLanguageName('language-c#')).toBe('c#');
    expect(extractLanguageName('language-dockerfile')).toBe('dockerfile');
    expect(extractLanguageName('no-lang-class')).toBeNull();
    expect(extractLanguageName('')).toBeNull();
  });
});
