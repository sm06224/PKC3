/** @vitest-environment happy-dom */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { installQuickToc } from '../../src/adapter/ui/render/quick-toc';

describe('quick table of contents (ToC) popover (Issue #1130)', () => {
  let container: HTMLElement;
  let bodyHost: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    bodyHost = document.createElement('div');
    document.body.append(container, bodyHost);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders quick toc button and remains hidden when there are no headings', () => {
    const handle = installQuickToc(container, bodyHost);

    const wrapper = container.querySelector<HTMLElement>('.pkc-quick-toc');
    const btn = container.querySelector<HTMLButtonElement>('.pkc-quick-toc-btn');

    expect(wrapper).not.toBeNull();
    expect(btn).not.toBeNull();
    expect(wrapper?.hidden).toBe(true);

    handle.dispose();
  });

  it('becomes visible and builds toc list when headings are present', () => {
    bodyHost.innerHTML = `
      <h2 id="chapter-1">第一章 概要</h2>
      <p>本文</p>
      <h3 id="section-1-1">1.1 詳細</h3>
      <p>詳細内容</p>
    `;

    const handle = installQuickToc(container, bodyHost);

    const wrapper = container.querySelector<HTMLElement>('.pkc-quick-toc');
    expect(wrapper?.hidden).toBe(false);

    const items = container.querySelectorAll<HTMLElement>('.pkc-quick-toc-item');
    expect(items).toHaveLength(2);

    expect(items[0]?.getAttribute('data-pkc-toc-level')).toBe('2');
    const link1 = items[0]?.querySelector<HTMLButtonElement>('.pkc-quick-toc-link');
    expect(link1?.textContent).toBe('第一章 概要');
    expect(link1?.getAttribute('data-pkc-action')).toBe('toc-jump');
    expect(link1?.getAttribute('data-pkc-toc-slug')).toBe('chapter-1');

    expect(items[1]?.getAttribute('data-pkc-toc-level')).toBe('3');
    const link2 = items[1]?.querySelector<HTMLButtonElement>('.pkc-quick-toc-link');
    expect(link2?.textContent).toBe('1.1 詳細');
    expect(link2?.getAttribute('data-pkc-action')).toBe('toc-jump');
    expect(link2?.getAttribute('data-pkc-toc-slug')).toBe('section-1-1');

    handle.dispose();
  });

  it('toggles popover visibility on button click', () => {
    bodyHost.innerHTML = '<h2 id="chap-1">章 1</h2>';
    const handle = installQuickToc(container, bodyHost);

    const btn = container.querySelector<HTMLButtonElement>('.pkc-quick-toc-btn')!;
    const popover = container.querySelector<HTMLElement>('.pkc-quick-toc-popover')!;

    expect(popover.hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    // Click to open
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    // Click to close
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    handle.dispose();
  });

  it('closes popover on close button, outside click, escape key, and link click', () => {
    bodyHost.innerHTML = '<h2 id="chap-1">章 1</h2>';
    const handle = installQuickToc(container, bodyHost);

    const btn = container.querySelector<HTMLButtonElement>('.pkc-quick-toc-btn')!;
    const popover = container.querySelector<HTMLElement>('.pkc-quick-toc-popover')!;
    const closeBtn = container.querySelector<HTMLButtonElement>('.pkc-quick-toc-close')!;
    const link = container.querySelector<HTMLButtonElement>('.pkc-quick-toc-link')!;

    // 1. Close button
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(false);
    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(true);

    // 2. Outside click
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(false);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(true);

    // 3. Escape key
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popover.hidden).toBe(true);

    // 4. Link click
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(false);
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(popover.hidden).toBe(true);

    handle.dispose();
  });

  it('removes elements and unbinds listeners on dispose', () => {
    const handle = installQuickToc(container, bodyHost);
    expect(container.querySelector('.pkc-quick-toc')).not.toBeNull();

    handle.dispose();
    expect(container.querySelector('.pkc-quick-toc')).toBeNull();
  });
});
