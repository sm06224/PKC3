/**
 * Quick Table of Contents (ToC) Popover (Issue #1130).
 *
 * 長文ノート閲覧時、本文プレビュー画面に目次ポップオーバーボタンを配置し、
 * インスペクターを開かずにワンタップで目的の見出しへジャンプできるようにする。
 */
import { extractHeadingText } from './heading-anchor';

export interface QuickTocItem {
  readonly id: string;
  readonly text: string;
  readonly level: number;
}

export interface QuickTocHandle {
  readonly element: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly popover: HTMLElement;
  dispose: () => void;
  update: () => void;
}

export function installQuickToc(
  container: HTMLElement,
  bodyHost: HTMLElement,
): QuickTocHandle {
  const doc = container.ownerDocument;

  const wrapper = doc.createElement('div');
  wrapper.className = 'pkc-quick-toc';
  wrapper.hidden = true;

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'pkc-quick-toc-btn';
  button.setAttribute('aria-label', '目次を開く');
  button.setAttribute('title', '目次を開く');
  button.setAttribute('aria-expanded', 'false');

  const icon = doc.createElement('span');
  icon.className = 'pkc-quick-toc-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '≡';

  const label = doc.createElement('span');
  label.className = 'pkc-quick-toc-label';
  label.textContent = '目次';

  button.append(icon, label);

  const popover = doc.createElement('div');
  popover.className = 'pkc-quick-toc-popover';
  popover.hidden = true;

  const header = doc.createElement('div');
  header.className = 'pkc-quick-toc-header';

  const title = doc.createElement('span');
  title.className = 'pkc-quick-toc-title';
  title.textContent = '目次';

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pkc-quick-toc-close';
  closeBtn.setAttribute('aria-label', '目次を閉じる');
  closeBtn.textContent = '×';

  header.append(title, closeBtn);

  const list = doc.createElement('ul');
  list.className = 'pkc-quick-toc-list';

  popover.append(header, list);
  wrapper.append(button, popover);

  container.append(wrapper);

  const closePopover = (): void => {
    if (!popover.hidden) {
      popover.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    }
  };

  const togglePopover = (ev: MouseEvent): void => {
    ev.stopPropagation();
    const willOpen = popover.hidden;
    popover.hidden = !willOpen;
    button.setAttribute('aria-expanded', String(willOpen));
  };

  const onDocClick = (ev: MouseEvent): void => {
    if (!wrapper.contains(ev.target as Node)) {
      closePopover();
    }
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      closePopover();
    }
  };

  button.addEventListener('click', togglePopover);
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closePopover();
  });
  doc.addEventListener('click', onDocClick);
  doc.addEventListener('keydown', onKeyDown);

  const update = (): void => {
    const headings = bodyHost.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
    const items: QuickTocItem[] = [];

    for (const h of headings) {
      const id = h.id.trim();
      if (!id) continue;
      const text = extractHeadingText(h);
      if (!text) continue;
      const level = parseInt(h.tagName.slice(1), 10) || 1;
      items.push({ id, text, level });
    }

    list.textContent = '';

    if (items.length === 0) {
      wrapper.hidden = true;
      closePopover();
      return;
    }

    wrapper.hidden = false;

    for (const item of items) {
      const li = doc.createElement('li');
      li.className = 'pkc-quick-toc-item';
      li.setAttribute('data-pkc-toc-level', String(item.level));

      const link = doc.createElement('button');
      link.type = 'button';
      link.className = 'pkc-quick-toc-link';
      link.setAttribute('data-pkc-action', 'toc-jump');
      link.setAttribute('data-pkc-toc-slug', item.id);
      link.textContent = item.text;
      link.title = item.text;

      link.addEventListener('click', () => {
        closePopover();
      });

      li.append(link);
      list.append(li);
    }
  };

  update();

  const dispose = (): void => {
    button.removeEventListener('click', togglePopover);
    doc.removeEventListener('click', onDocClick);
    doc.removeEventListener('keydown', onKeyDown);
    wrapper.remove();
  };

  return {
    element: wrapper,
    button,
    popover,
    dispose,
    update,
  };
}
