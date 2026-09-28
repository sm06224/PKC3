/**
 * Back to Top Floating Button (Issue #1121).
 *
 * 長文ノート閲覧時、本文を一定量（既定 300px）スクロールした際に右下に現れ、
 * ワンクリックで先頭までスムーズに戻れるフローティングボタン。
 */

export const BACK_TO_TOP_SCROLL_THRESHOLD = 300;

export interface BackToTopHandle {
  readonly element: HTMLElement;
  readonly button: HTMLButtonElement;
  dispose: () => void;
  update: () => void;
}

export function installBackToTop(
  scroller: HTMLElement,
  container: HTMLElement,
  options?: {
    threshold?: number;
    behavior?: ScrollBehavior;
  },
): BackToTopHandle {
  const threshold = options?.threshold ?? BACK_TO_TOP_SCROLL_THRESHOLD;
  const behavior = options?.behavior ?? 'smooth';
  const doc = container.ownerDocument;

  const wrapper = doc.createElement('div');
  wrapper.className = 'pkc-back-to-top-container';

  const button = doc.createElement('button');
  button.className = 'pkc-back-to-top';
  button.setAttribute('type', 'button');
  button.setAttribute('aria-label', 'ページ先頭へ戻る');
  button.setAttribute('title', 'ページ先頭へ戻る');

  const icon = doc.createElement('span');
  icon.className = 'pkc-back-to-top-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '↑';
  button.append(icon);
  wrapper.append(button);

  container.append(wrapper);

  const update = (): void => {
    const top = scroller.scrollTop ?? 0;
    const left = scroller.scrollLeft ?? 0;
    if (top >= threshold || left >= threshold) {
      button.classList.add('pkc-visible');
    } else {
      button.classList.remove('pkc-visible');
    }
  };

  const onClick = (ev: MouseEvent): void => {
    ev.preventDefault();
    scroller.scrollTo({ top: 0, left: 0, behavior });
  };

  button.addEventListener('click', onClick);
  scroller.addEventListener('scroll', update, { passive: true });

  update();

  const dispose = (): void => {
    button.removeEventListener('click', onClick);
    scroller.removeEventListener('scroll', update);
    wrapper.remove();
  };

  return {
    element: wrapper,
    button,
    dispose,
    update,
  };
}
