/**
 * Reading Progress Indicator (Issue #1125).
 *
 * 長文ノート閲覧時、本文プレビュー画面上部にスクロール進行度に応じた
 * 極細（2px）のプログレスバーをリアルタイム表示する。
 */

export interface ReadingProgressHandle {
  readonly element: HTMLElement;
  readonly bar: HTMLElement;
  dispose: () => void;
  update: () => void;
}

export function installReadingProgress(
  scroller: HTMLElement,
  container: HTMLElement,
): ReadingProgressHandle {
  const doc = container.ownerDocument;

  const wrapper = doc.createElement('div');
  wrapper.className = 'pkc-reading-progress';
  wrapper.setAttribute('role', 'progressbar');
  wrapper.setAttribute('aria-label', '読書進捗');
  wrapper.setAttribute('aria-valuemin', '0');
  wrapper.setAttribute('aria-valuemax', '100');
  wrapper.setAttribute('aria-valuenow', '0');

  const bar = doc.createElement('div');
  bar.className = 'pkc-reading-progress-bar';
  wrapper.append(bar);

  container.prepend(wrapper);

  let rafId: number | null = null;

  const cancelFrame =
    typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : (id: number) => clearTimeout(id);

  const requestFrame =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 0) as unknown as number;

  const update = (): void => {
    const maxScrollTop = (scroller.scrollHeight ?? 0) - (scroller.clientHeight ?? 0);
    const maxScrollLeft = (scroller.scrollWidth ?? 0) - (scroller.clientWidth ?? 0);

    let progress = 0;
    let isScrollable = false;

    if (maxScrollTop > 10) {
      isScrollable = true;
      progress = Math.min(1, Math.max(0, (scroller.scrollTop ?? 0) / maxScrollTop));
    } else if (maxScrollLeft > 10) {
      isScrollable = true;
      progress = Math.min(1, Math.max(0, (scroller.scrollLeft ?? 0) / maxScrollLeft));
    }

    if (isScrollable && progress > 0) {
      wrapper.classList.add('pkc-visible');
      const percent = Math.round(progress * 100);
      wrapper.setAttribute('aria-valuenow', String(percent));
      bar.style.width = `${(progress * 100).toFixed(1)}%`;
    } else {
      wrapper.classList.remove('pkc-visible');
      wrapper.setAttribute('aria-valuenow', '0');
      bar.style.width = '0%';
    }
  };

  const scheduleUpdate = (): void => {
    if (rafId !== null) return;
    rafId = requestFrame(() => {
      rafId = null;
      update();
    });
  };

  scroller.addEventListener('scroll', scheduleUpdate, { passive: true });

  update();

  const dispose = (): void => {
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
    scroller.removeEventListener('scroll', scheduleUpdate);
    wrapper.remove();
  };

  return {
    element: wrapper,
    bar,
    dispose,
    update,
  };
}
