/** @vitest-environment happy-dom */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as clipboard from '@adapter/platform/clipboard';
import {
  applyHeadingAnchors,
  extractHeadingText,
  buildHeadingLink,
  HEADING_ANCHOR_FIELD,
} from '../../src/adapter/ui/render/heading-anchor';

describe('heading-anchor link copy (Issue #1124)', () => {
  let root: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  describe('extractHeadingText', () => {
    it('extracts plain heading text', () => {
      const h = document.createElement('h2');
      h.textContent = '見出しのタイトル';
      expect(extractHeadingText(h)).toBe('見出しのタイトル');
    });

    it('removes internal button contents from extracted text', () => {
      const h = document.createElement('h2');
      const foldBtn = document.createElement('button');
      foldBtn.textContent = '▾';
      h.append(foldBtn, document.createTextNode(' 折りたたみ見出し'));
      expect(extractHeadingText(h)).toBe('折りたたみ見出し');
    });
  });

  describe('buildHeadingLink', () => {
    it('builds standard PKC markdown internal link with slug fragment', () => {
      expect(buildHeadingLink('note-1', 'section-1', '第一章')).toBe('[第一章](entry:note-1#section-1)');
    });

    it('falls back to slug when text is empty', () => {
      expect(buildHeadingLink('note-1', 'section-1', '')).toBe('[section-1](entry:note-1#section-1)');
    });
  });

  describe('applyHeadingAnchors', () => {
    it('does nothing when lid is null', () => {
      const h2 = document.createElement('h2');
      h2.id = 'sec1';
      h2.textContent = '節1';
      root.append(h2);

      applyHeadingAnchors(root, null);
      expect(root.querySelector(`[data-pkc-field="${HEADING_ANCHOR_FIELD}"]`)).toBeNull();
    });

    it('appends anchor button to headings with id and keeps button textContent empty', () => {
      const h1 = document.createElement('h1');
      h1.id = 'title-1';
      h1.textContent = '大見出し';

      const h2 = document.createElement('h2');
      h2.id = 'sub-title';
      h2.textContent = '中見出し';

      root.append(h1, h2);

      applyHeadingAnchors(root, 'n1');

      const btn1 = h1.querySelector<HTMLButtonElement>(`[data-pkc-field="${HEADING_ANCHOR_FIELD}"]`);
      expect(btn1).not.toBeNull();
      expect(btn1?.getAttribute('aria-label')).toBe('「大見出し」への参照リンクをコピー');
      // ボタン自身に textContent を置かず見出し文字列を汚さない（CSS ::before で表示）
      expect(btn1?.textContent).toBe('');
      expect(h1.textContent).toBe('大見出し');

      const btn2 = h2.querySelector<HTMLButtonElement>(`[data-pkc-field="${HEADING_ANCHOR_FIELD}"]`);
      expect(btn2).not.toBeNull();
      expect(btn2?.getAttribute('aria-label')).toBe('「中見出し」への参照リンクをコピー');
      expect(btn2?.textContent).toBe('');
    });

    it('is idempotent across multiple calls', () => {
      const h2 = document.createElement('h2');
      h2.id = 'topic';
      h2.textContent = 'トピック';
      root.append(h2);

      applyHeadingAnchors(root, 'n1');
      applyHeadingAnchors(root, 'n1');

      expect(h2.querySelectorAll(`[data-pkc-field="${HEADING_ANCHOR_FIELD}"]`).length).toBe(1);
    });

    it('copies link to clipboard and flashes copied state on click', async () => {
      const h2 = document.createElement('h2');
      h2.id = 'install';
      h2.textContent = 'インストール手順';
      root.append(h2);

      applyHeadingAnchors(root, 'n1');
      const btn = h2.querySelector<HTMLButtonElement>(`[data-pkc-field="${HEADING_ANCHOR_FIELD}"]`)!;

      let copiedText = '';
      vi.spyOn(clipboard, 'copyPlainText').mockImplementation(async (text: string) => {
        copiedText = text;
        return true;
      });

      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      // Wait for promise resolution
      await Promise.resolve();

      expect(copiedText).toBe('[インストール手順](entry:n1#install)');
      expect(btn.classList.contains('pkc-copied')).toBe(true);
      expect(btn.getAttribute('title')).toBe('リンクをコピーしました！');

      // Fast forward 1500ms
      vi.advanceTimersByTime(1500);
      expect(btn.classList.contains('pkc-copied')).toBe(false);
      expect(btn.getAttribute('title')).toBe('見出しの参照リンクをコピー');
    });
  });
});
