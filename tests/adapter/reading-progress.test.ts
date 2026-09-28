/** @vitest-environment happy-dom */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { installReadingProgress } from '../../src/adapter/ui/render/reading-progress';

describe('reading progress indicator (Issue #1125)', () => {
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

  it('renders progressbar inside container at top and starts hidden (0% progress)', () => {
    const handle = installReadingProgress(scroller, container);

    const wrapper = container.querySelector<HTMLElement>('.pkc-reading-progress');
    const bar = container.querySelector<HTMLElement>('.pkc-reading-progress-bar');

    expect(wrapper).not.toBeNull();
    expect(bar).not.toBeNull();
    expect(wrapper?.getAttribute('role')).toBe('progressbar');
    expect(wrapper?.getAttribute('aria-label')).toBe('読書進捗');
    expect(wrapper?.getAttribute('aria-valuenow')).toBe('0');
    expect(wrapper?.classList.contains('pkc-visible')).toBe(false);
    expect(bar?.style.width).toBe('0%');

    handle.dispose();
  });

  it('becomes visible and updates progress width on scroll', async () => {
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true });

    const handle = installReadingProgress(scroller, container);
    const wrapper = container.querySelector<HTMLElement>('.pkc-reading-progress')!;
    const bar = container.querySelector<HTMLElement>('.pkc-reading-progress-bar')!;

    // 50% scroll
    scroller.scrollTop = 250;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(wrapper.classList.contains('pkc-visible')).toBe(true);
    expect(bar.style.width).toBe('50.0%');
    expect(wrapper.getAttribute('aria-valuenow')).toBe('50');

    // 100% scroll
    scroller.scrollTop = 500;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(wrapper.classList.contains('pkc-visible')).toBe(true);
    expect(bar.style.width).toBe('100.0%');
    expect(wrapper.getAttribute('aria-valuenow')).toBe('100');

    // Scrolled back to top
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(wrapper.classList.contains('pkc-visible')).toBe(false);
    expect(bar.style.width).toBe('0%');
    expect(wrapper.getAttribute('aria-valuenow')).toBe('0');

    handle.dispose();
  });

  it('supports horizontal scroll progress', async () => {
    Object.defineProperty(scroller, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(scroller, 'scrollWidth', { value: 1000, configurable: true });
    Object.defineProperty(scroller, 'clientWidth', { value: 500, configurable: true });

    const handle = installReadingProgress(scroller, container);
    const wrapper = container.querySelector<HTMLElement>('.pkc-reading-progress')!;
    const bar = container.querySelector<HTMLElement>('.pkc-reading-progress-bar')!;

    scroller.scrollLeft = 250;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(wrapper.classList.contains('pkc-visible')).toBe(true);
    expect(bar.style.width).toBe('50.0%');
    expect(wrapper.getAttribute('aria-valuenow')).toBe('50');

    handle.dispose();
  });

  it('removes elements and unbinds listeners on dispose', () => {
    const handle = installReadingProgress(scroller, container);
    expect(container.querySelector('.pkc-reading-progress')).not.toBeNull();

    handle.dispose();
    expect(container.querySelector('.pkc-reading-progress')).toBeNull();
  });
});
