/** @vitest-environment happy-dom */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  installBackToTop,
  BACK_TO_TOP_SCROLL_THRESHOLD,
} from '../../src/adapter/ui/render/back-to-top';

describe('back-to-top floating button (Issue #1121)', () => {
  let scroller: HTMLElement;
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    scroller = document.createElement('div');
    container = document.createElement('div');
    scroller.append(container);
    document.body.append(scroller);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders button inside container and starts invisible at top', () => {
    expect(BACK_TO_TOP_SCROLL_THRESHOLD).toBe(300);
    const handle = installBackToTop(scroller, container);

    const btn = container.querySelector<HTMLButtonElement>('.pkc-back-to-top');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-label')).toBe('ページ先頭へ戻る');
    expect(btn?.getAttribute('title')).toBe('ページ先頭へ戻る');
    expect(btn?.classList.contains('pkc-visible')).toBe(false);

    handle.dispose();
  });

  it('becomes visible when scroller is scrolled past threshold', () => {
    const handle = installBackToTop(scroller, container, { threshold: 300 });
    const btn = container.querySelector<HTMLButtonElement>('.pkc-back-to-top')!;

    // Below threshold
    scroller.scrollTop = 200;
    scroller.dispatchEvent(new Event('scroll'));
    expect(btn.classList.contains('pkc-visible')).toBe(false);

    // Past threshold
    scroller.scrollTop = 350;
    scroller.dispatchEvent(new Event('scroll'));
    expect(btn.classList.contains('pkc-visible')).toBe(true);

    // Back to top
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    expect(btn.classList.contains('pkc-visible')).toBe(false);

    handle.dispose();
  });

  it('supports horizontal scroll past threshold', () => {
    const handle = installBackToTop(scroller, container, { threshold: 300 });
    const btn = container.querySelector<HTMLButtonElement>('.pkc-back-to-top')!;

    scroller.scrollLeft = 400;
    scroller.dispatchEvent(new Event('scroll'));
    expect(btn.classList.contains('pkc-visible')).toBe(true);

    handle.dispose();
  });

  it('scrolls scroller to top on click', () => {
    const handle = installBackToTop(scroller, container);
    const btn = container.querySelector<HTMLButtonElement>('.pkc-back-to-top')!;

    const scrollToSpy = vi.fn();
    scroller.scrollTo = scrollToSpy;

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'smooth' });

    handle.dispose();
  });

  it('removes elements and unbinds listeners on dispose', () => {
    const handle = installBackToTop(scroller, container);
    expect(container.querySelector('.pkc-back-to-top')).not.toBeNull();

    handle.dispose();
    expect(container.querySelector('.pkc-back-to-top')).toBeNull();
  });
});
