/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyInlineCodeCopy, INLINE_CODE_ATTR } from '../../src/adapter/ui/render/inline-code-copy';
import * as clipboard from '../../src/adapter/platform/clipboard';

describe('インラインコード（code）のワンクリックコピー(#1148)', () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    root.className = 'pkc-md-rendered';
    document.body.append(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('🔴 プレーンなインラインコードに属性と title が付与される', () => {
    root.innerHTML = '<p>コマンドは <code>npm test</code> を実行します。</p>';
    applyInlineCodeCopy(root);

    const code = root.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.getAttribute(INLINE_CODE_ATTR)).toBe('true');
    expect(code!.getAttribute('title')).toBe('クリックでコピー');
  });

  it('🔴 コードブロック(pre > code)やリンク内(a > code)は除外される', () => {
    root.innerHTML = `
      <pre><code>const a = 1;</code></pre>
      <p><a href="https://example.com"><code>https://example.com</code></a></p>
      <p>通常の <code>git status</code> です。</p>
    `;
    applyInlineCodeCopy(root);

    const blockCode = root.querySelector('pre code');
    expect(blockCode!.hasAttribute(INLINE_CODE_ATTR), 'pre > code に属性が付いている').toBe(false);

    const linkCode = root.querySelector('a code');
    expect(linkCode!.hasAttribute(INLINE_CODE_ATTR), 'a > code に属性が付いている').toBe(false);

    const inlineCode = root.querySelector('p:last-child code');
    expect(inlineCode!.getAttribute(INLINE_CODE_ATTR)).toBe('true');
  });

  it('🔴 クリックするとクリップボードにコピーされ、flashCopied が作動する', async () => {
    root.innerHTML = '<p><code>npm install vitest</code></p>';
    applyInlineCodeCopy(root);

    const copySpy = vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(true);
    const code = root.querySelector('code')!;

    code.click();
    expect(copySpy).toHaveBeenCalledWith('npm install vitest');

    // 解決後に data-pkc-flash 属性が付与される
    await Promise.resolve();
    expect(code.getAttribute('data-pkc-flash')).toBe('true');
  });

  it('🔴 テキスト選択中のクリックではコピーが抑止される(誤爆防止)', () => {
    root.innerHTML = '<p><code>selected text</code></p>';
    applyInlineCodeCopy(root);

    const copySpy = vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(true);
    const code = root.querySelector('code')!;

    // window.getSelection をモックして選択文字列がある状態にする
    const mockSelection = {
      toString: () => 'selected',
    } as unknown as Selection;
    vi.spyOn(window, 'getSelection').mockReturnValue(mockSelection);

    code.click();
    expect(copySpy).not.toHaveBeenCalled();
  });

  it('🔴 複数回呼び出しても二重にリスナーが張られない(冪等性)', async () => {
    root.innerHTML = '<p><code>idempotent</code></p>';
    applyInlineCodeCopy(root);
    applyInlineCodeCopy(root);

    const copySpy = vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(true);
    const code = root.querySelector('code')!;

    code.click();
    expect(copySpy).toHaveBeenCalledTimes(1);
  });
});
