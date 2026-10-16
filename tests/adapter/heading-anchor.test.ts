/** @vitest-environment happy-dom */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as clipboard from '@adapter/platform/clipboard';
import {
  applyHeadingAnchors,
  extractHeadingText,
  buildHeadingLink,
  HEADING_ANCHOR_FIELD,
  HEADING_ANCHOR_COPY_FAILED_EVENT,
} from '../../src/adapter/ui/render/heading-anchor';
import { formatSectionLink } from '../../src/features/entry-ref/entry-ref-format';
import { parseEntryRef } from '../../src/features/entry-ref/entry-ref';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

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
    it('builds the canonical section link (#h/<id>), same formatter as copy-section-ref', () => {
      expect(buildHeadingLink('note-1', 'section-1', '第一章')).toBe('[第一章](entry:note-1#h/section-1)');
      expect(buildHeadingLink('note-1', '概要', '概要')).toBe(formatSectionLink('概要', 'note-1', '概要'));
    });

    it('falls back to the id when text is empty', () => {
      expect(buildHeadingLink('note-1', 'section-1', '')).toBe('[section-1](entry:note-1#h/section-1)');
    });

    it('escapes a label containing ] so the link does not break, and the result resolves', () => {
      const link = buildHeadingLink('n1', 'a-b-c', 'A [b] c');
      expect(link).toBe('[A \\[b\\] c](entry:n1#h/a-b-c)');
      const html = renderMarkdown(link, { currentContainerId: 'c' } as never);
      expect(html).toContain('data-pkc-entry-ref="entry:n1#h/a-b-c"');
      expect(html).toContain('>A [b] c</a>');
    });

    it('a Japanese heading link parses as a section ref (the old #slug form was invalid)', () => {
      const link = buildHeadingLink('n1', '概要', '概要');
      const target = /\((entry:[^)]*)\)/.exec(link)![1]!;
      expect(parseEntryRef(target)).toEqual({ kind: 'section', lid: 'n1', id: '概要' });
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
      expect(btn1?.getAttribute('aria-label')).toBe('「大見出し」への参照をコピー');
      // ボタン自身に textContent を置かず見出し文字列を汚さない（CSS ::before で表示）
      expect(btn1?.textContent).toBe('');
      expect(h1.textContent).toBe('大見出し');

      const btn2 = h2.querySelector<HTMLButtonElement>(`[data-pkc-field="${HEADING_ANCHOR_FIELD}"]`);
      expect(btn2).not.toBeNull();
      expect(btn2?.getAttribute('aria-label')).toBe('「中見出し」への参照をコピー');
      expect(btn2?.textContent).toBe('');
    });

    it('does not attach a button to headings without an id (h4-h6 get no id from rendering)', () => {
      const h4 = document.createElement('h4');
      h4.textContent = '小見出し';
      root.append(h4);
      applyHeadingAnchors(root, 'n1');
      expect(h4.querySelector(`[data-pkc-field="${HEADING_ANCHOR_FIELD}"]`)).toBeNull();
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

      expect(copiedText).toBe('[インストール手順](entry:n1#h/install)');
      expect(btn.classList.contains('pkc-copied')).toBe(true);
      expect(btn.getAttribute('title')).toBe('参照をコピーしました');

      // Fast forward 1500ms
      vi.advanceTimersByTime(1500);
      expect(btn.classList.contains('pkc-copied')).toBe(false);
      expect(btn.getAttribute('title')).toBe('見出しの参照をコピー(本文に貼ります)');
    });

    it('🔴 コピーに失敗したら、上へ合図を伝える(黙らない)', async () => {
      const h2 = document.createElement('h2');
      h2.id = 'x';
      h2.textContent = '失敗';
      root.append(h2);
      applyHeadingAnchors(root, 'n1');
      const btn = h2.querySelector<HTMLButtonElement>(`[data-pkc-field="${HEADING_ANCHOR_FIELD}"]`)!;
      vi.spyOn(clipboard, 'copyPlainText').mockImplementation(async () => false);
      let failed = 0;
      root.addEventListener(HEADING_ANCHOR_COPY_FAILED_EVENT, () => failed++);
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
      expect(failed).toBe(1);
      expect(btn.classList.contains('pkc-copied')).toBe(false);
    });
  });
});
