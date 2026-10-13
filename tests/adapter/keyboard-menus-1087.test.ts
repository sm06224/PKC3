/** @vitest-environment happy-dom */
/**
 * #1087 キーボードだけで使う人の道:右クリックのメニュー(焦点が戻る / ↑↓ で移れる)と
 * 画像の拡大(開くと ✕ に移る / Tab が外へ出ない / 閉じると戻る)。
 * 焦点は `document.activeElement` で見る(属性ではなく、実際に誰が持っているか)。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { initialState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { openContextMenu, closeContextMenu } from '../../src/adapter/ui/render/context-menu';
import { openLightbox, closeLightbox } from '../../src/adapter/ui/render/lightbox';

const MENU = '[data-pkc-region="context-menu"]';

function mk(): { root: HTMLElement; opener: HTMLButtonElement } {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  const opener = document.createElement('button');
  opener.textContent = 'opener';
  const other = document.createElement('button');
  other.id = 'other';
  root.append(opener, other);
  document.body.append(root);
  opener.focus();
  return { root, opener };
}

const key = (target: Element, k: string, extra: KeyboardEventInit = {}): KeyboardEvent => {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra });
  target.dispatchEvent(ev);
  return ev;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('右クリックのメニュー: 閉じたら焦点が戻る(A1)', () => {
  const items = [
    { action: 'a1', label: 'A' },
    { action: 'a2', label: 'B' },
  ];

  it('closeContextMenu で、開く前の要素が焦点を取り戻す', () => {
    const { root, opener } = mk();
    openContextMenu(root, { x: 1, y: 1 }, items, opener);
    expect(document.activeElement).not.toBe(opener);
    expect(document.activeElement?.closest(MENU)).not.toBeNull();
    closeContextMenu(root);
    expect(document.activeElement).toBe(opener);
  });

  it('別の所へ焦点を移していたら奪わない', () => {
    const { root, opener } = mk();
    openContextMenu(root, { x: 1, y: 1 }, items, opener);
    const other = root.querySelector<HTMLElement>('#other')!;
    other.focus();
    closeContextMenu(root);
    expect(document.activeElement).toBe(other);
  });

  it('開き直す(置き換える)ときは古い戻り先へ焦点を返さない', () => {
    const { root, opener } = mk();
    openContextMenu(root, { x: 1, y: 1 }, items, opener);
    openContextMenu(root, { x: 1, y: 1 }, items, root.querySelector<HTMLElement>('#other'));
    expect(document.activeElement?.closest(MENU)).not.toBeNull();
    closeContextMenu(root);
    expect(document.activeElement).toBe(root.querySelector('#other'));
  });
});

describe('右クリックのメニュー: ↑↓ / Home / End(A2)', () => {
  function bound() {
    const { root, opener } = mk();
    bindActions(root, new Dispatcher(initialState), {});
    openContextMenu(
      root,
      { x: 1, y: 1 },
      [
        { action: 'a1', label: 'A' },
        { action: 'a2', label: 'B', disabled: true },
        { action: 'a3', label: 'C' },
        { action: 'a4', label: 'D' },
      ],
      opener,
    );
    const btn = (a: string): HTMLElement => root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${a}"]`)!;
    return { root, opener, btn };
  }

  it('↓ で次へ・押せない項目は飛ばす・端で回る', () => {
    const { btn } = bound();
    expect(document.activeElement).toBe(btn('a1'));
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(btn('a3'));
    key(document.activeElement!, 'ArrowDown');
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(btn('a1'));
    key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(btn('a4'));
  });

  it('Home / End で先頭・末尾', () => {
    const { btn } = bound();
    key(document.activeElement!, 'End');
    expect(document.activeElement).toBe(btn('a4'));
    key(document.activeElement!, 'Home');
    expect(document.activeElement).toBe(btn('a1'));
  });

  it('Esc で閉じて、焦点が開く前の要素へ戻る', () => {
    const { root, opener } = bound();
    key(document.activeElement!, 'Escape');
    expect(root.querySelector(MENU)).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('画像の拡大(A3)', () => {
  it('開くと ✕ に焦点が移り、閉じると開く前の要素へ戻る', () => {
    const { root, opener } = mk();
    openLightbox(root, { src: 'x.png', alt: 'a' });
    expect((document.activeElement as HTMLElement).classList.contains('pkc-lightbox-close-btn')).toBe(true);
    closeLightbox(root);
    expect(document.activeElement).toBe(opener);
  });

  it('Tab / Shift+Tab は拡大の中で回る', () => {
    const { root } = mk();
    openLightbox(root, { src: 'x.png', alt: 'a' }, { viewBig: () => {} } as never);
    const btns = root.querySelectorAll<HTMLElement>('[data-pkc-region="lightbox"] button');
    expect(btns.length).toBe(2);
    // 末尾(✕)で Tab → 先頭へ
    expect(document.activeElement).toBe(btns[1]);
    const ev = key(document.activeElement!, 'Tab');
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(btns[0]);
    // 先頭で Shift+Tab → 末尾へ
    key(document.activeElement!, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(btns[1]);
  });
});
