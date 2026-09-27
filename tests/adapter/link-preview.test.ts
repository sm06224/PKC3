/** @vitest-environment happy-dom */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  formatBodyPreview,
  renderPreviewCard,
  positionPreviewCard,
  setupLinkPreview,
  closeLinkPreview,
  linkPreviewOpen,
  LINK_PREVIEW_REGION,
  HOVER_DELAY_MS,
  CLOSE_DELAY_MS,
} from '../../src/adapter/ui/render/link-preview';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { AppState } from '../../src/adapter/state/app-state';

describe('link-preview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  describe('formatBodyPreview', () => {
    it('returns empty string for empty input', () => {
      expect(formatBodyPreview('')).toBe('');
    });

    it('strips frontmatter from preview', () => {
      const body = ['---', 'title: Foo', '---', 'This is content.'].join('\n');
      expect(formatBodyPreview(body)).toBe('This is content.');
    });

    it('removes markdown formatting like headings, lists, quotes, and links', () => {
      const body = [
        '# Heading 1',
        '> A wise quote',
        '- List item 1',
        'Check [my site](https://example.com) for details.',
        '![banner](img.png)',
      ].join('\n');

      const preview = formatBodyPreview(body);
      expect(preview).toBe('Heading 1 A wise quote List item 1 Check my site for details. [画像: banner]');
    });

    it('removes fenced code blocks', () => {
      const body = ['Intro text', '```ts', 'const x = 1;', '```', 'Outro text'].join('\n');
      expect(formatBodyPreview(body)).toBe('Intro text Outro text');
    });

    it('truncates text and appends ellipsis when exceeding maxChars', () => {
      const longText = 'a'.repeat(200);
      const preview = formatBodyPreview(longText, 50);
      expect(preview).toBe(`${'a'.repeat(50)}…`);
    });
  });

  describe('renderPreviewCard', () => {
    it('renders normal entry card with title, archetype, and date', () => {
      const card = renderPreviewCard(document, {
        kind: 'entry',
        lid: 'note-1',
        title: 'テストノート',
        archetype: 'text',
        date: '2026-09-28T12:00:00Z',
        bodyChars: 120,
        bodyPreview: '冒頭のプレビューです。',
      });

      expect(card.getAttribute('data-pkc-region')).toBe(LINK_PREVIEW_REGION);
      expect(card.querySelector('.pkc-link-preview-archetype')?.textContent).toBe('ノート');
      expect(card.querySelector('.pkc-link-preview-title')?.textContent).toBe('テストノート');
      expect(card.querySelector('.pkc-link-preview-date')?.textContent).toBe('2026-09-28');
      expect(card.querySelector('.pkc-link-preview-chars')?.textContent).toBe('120 文字');
      expect(card.querySelector('.pkc-link-preview-body')?.textContent).toBe('冒頭のプレビューです。');
    });

    it('renders not-found card', () => {
      const card = renderPreviewCard(document, { kind: 'not-found' });
      expect(card.classList.contains('pkc-link-preview-empty')).toBe(true);
      expect(card.querySelector('.pkc-link-preview-not-found')?.textContent).toContain(
        'このノートは存在しません',
      );
    });

    it('renders foreign card', () => {
      const card = renderPreviewCard(document, { kind: 'foreign' });
      expect(card.classList.contains('pkc-link-preview-foreign')).toBe(true);
      expect(card.querySelector('.pkc-link-preview-foreign-desc')?.textContent).toContain(
        '別の PKC のノート',
      );
    });

    it('renders loading state when loading is true', () => {
      const card = renderPreviewCard(document, {
        kind: 'entry',
        title: 'ロード中',
        loading: true,
      });
      expect(card.querySelector('.pkc-link-preview-loading')?.textContent).toContain(
        '本文を読み込み中…',
      );
    });

    it('closes card using closeLinkPreview', () => {
      const root = document.createElement('div');
      document.body.append(root);
      const card = renderPreviewCard(document, { kind: 'entry', title: 'Card' });
      root.append(card);
      expect(linkPreviewOpen(root)).toBe(true);
      closeLinkPreview(root);
      expect(linkPreviewOpen(root)).toBe(false);
    });
  });

  describe('positionPreviewCard', () => {
    it('positions card below anchor by default and clamps horizontally', () => {
      const root = document.createElement('div');
      document.body.append(root);

      const anchor = document.createElement('a');
      anchor.getBoundingClientRect = () =>
        ({ left: 100, top: 100, right: 150, bottom: 120, width: 50, height: 20 }) as DOMRect;
      root.append(anchor);

      const card = document.createElement('div');
      card.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
      root.append(card);

      positionPreviewCard(card, anchor, root);

      // bottom (120) + GAP (6) = 126
      expect(card.style.top).toBe('126px');
      // left (100) + width/2 (25) - cardWidth/2 (100) = 25
      expect(card.style.left).toBe('25px');
    });

    it('flips vertically when overflowing window bottom', () => {
      const root = document.createElement('div');
      document.body.append(root);

      Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });

      const anchor = document.createElement('a');
      // Near bottom: bottom is 550, height 20
      anchor.getBoundingClientRect = () =>
        ({ left: 100, top: 530, right: 150, bottom: 550, width: 50, height: 20 }) as DOMRect;
      root.append(anchor);

      const card = document.createElement('div');
      // card height is 100. 550 + 6 + 100 = 656 > 600 - 8 (592) -> overflows!
      // Alternative: top: 530 - 100 - 6 = 424
      card.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
      root.append(card);

      positionPreviewCard(card, anchor, root);

      expect(card.style.top).toBe('424px');
    });
  });

  describe('setupLinkPreview lifecycle', () => {
    function createMockDispatcher(stateOverrides: Partial<AppState> = {}): Dispatcher {
      const defaultState = {
        phase: 'ready',
        cid: 'c1',
        entryMetas: new Map([
          [
            'n1',
            {
              lid: 'n1',
              title: 'ノート1のタイトル',
              archetype: 'text',
              createdAt: '2026-09-28T00:00:00Z',
              updatedAt: '2026-09-28T10:00:00Z',
              entryOrder: 1,
              status: null,
              date: null,
              archived: false,
              bodyChars: 42,
            },
          ],
        ]),
        order: ['n1'],
        relations: [],
        openBody: null,
        selectedLid: null,
        scopeLid: null,
        renamingLid: null,
        selection: [],
        selectionAnchor: null,
        ...stateOverrides,
      } as unknown as AppState;

      return {
        getState: () => defaultState,
        dispatch: vi.fn(),
      } as unknown as Dispatcher;
    }

    it('shows preview card after hover delay and removes on mouseout after close delay', async () => {
      const root = document.createElement('div');
      document.body.append(root);

      const anchor = document.createElement('a');
      anchor.setAttribute('data-pkc-entry-ref', 'entry:n1');
      anchor.textContent = 'ノート1へのリンク';
      root.append(anchor);

      const dispatcher = createMockDispatcher();
      const teardown = setupLinkPreview(root, dispatcher);

      expect(linkPreviewOpen(root)).toBe(false);

      // Mouseover on anchor
      anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
      expect(linkPreviewOpen(root)).toBe(false);

      // Fast-forward 200ms (not yet 300ms)
      vi.advanceTimersByTime(200);
      expect(linkPreviewOpen(root)).toBe(false);

      // Fast-forward another 100ms -> 300ms total
      vi.advanceTimersByTime(100);
      expect(linkPreviewOpen(root)).toBe(true);

      const card = root.querySelector<HTMLElement>(`[data-pkc-region="${LINK_PREVIEW_REGION}"]`);
      expect(card).not.toBeNull();
      expect(card?.querySelector('.pkc-link-preview-title')?.textContent).toBe('ノート1のタイトル');

      // Mouseout from anchor
      anchor.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true }));
      // Not closed immediately
      expect(linkPreviewOpen(root)).toBe(true);

      // Advance by CLOSE_DELAY_MS (150ms)
      vi.advanceTimersByTime(CLOSE_DELAY_MS);
      expect(linkPreviewOpen(root)).toBe(false);

      teardown();
    });

    it('cancels hover if mouse leaves before hover delay expires', () => {
      const root = document.createElement('div');
      document.body.append(root);

      const anchor = document.createElement('a');
      anchor.setAttribute('data-pkc-entry-ref', 'entry:n1');
      root.append(anchor);

      const dispatcher = createMockDispatcher();
      const teardown = setupLinkPreview(root, dispatcher);

      anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(150); // halfway

      anchor.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      vi.advanceTimersByTime(200); // would have triggered hover

      expect(linkPreviewOpen(root)).toBe(false);
      teardown();
    });

    it('shows not-found card when lid does not exist in entryMetas', () => {
      const root = document.createElement('div');
      document.body.append(root);

      const anchor = document.createElement('a');
      anchor.setAttribute('data-pkc-entry-ref', 'entry:deleted-note');
      root.append(anchor);

      const dispatcher = createMockDispatcher();
      const teardown = setupLinkPreview(root, dispatcher);

      anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(HOVER_DELAY_MS);

      expect(linkPreviewOpen(root)).toBe(true);
      const card = root.querySelector(`[data-pkc-region="${LINK_PREVIEW_REGION}"]`);
      expect(card?.querySelector('.pkc-link-preview-not-found')?.textContent).toContain(
        'このノートは存在しません',
      );

      teardown();
    });

    it('loads body preview asynchronously via readBodies', async () => {
      const root = document.createElement('div');
      document.body.append(root);

      const anchor = document.createElement('a');
      anchor.setAttribute('data-pkc-entry-ref', 'entry:n1');
      root.append(anchor);

      const dispatcher = createMockDispatcher();
      let resolveBodies: (map: Map<string, string>) => void;
      const readBodiesPromise = new Promise<Map<string, string>>((resolve) => {
        resolveBodies = resolve;
      });
      const readBodies = vi.fn().mockReturnValue(readBodiesPromise);

      const teardown = setupLinkPreview(root, dispatcher, { readBodies });

      anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(HOVER_DELAY_MS);

      expect(linkPreviewOpen(root)).toBe(true);
      const card = root.querySelector(`[data-pkc-region="${LINK_PREVIEW_REGION}"]`);
      expect(card?.querySelector('.pkc-link-preview-loading')).not.toBeNull();
      expect(readBodies).toHaveBeenCalledWith(['n1']);

      // Resolve async body
      resolveBodies!(new Map([['n1', '# 見出し\n非同期で取得した本文です。']]));
      await Promise.resolve(); // microtask

      expect(card?.querySelector('.pkc-link-preview-loading')).toBeNull();
      expect(card?.querySelector('.pkc-link-preview-body')?.textContent).toContain(
        '見出し 非同期で取得した本文です。',
      );

      teardown();
    });

    it('immediately uses openBody when target is the currently open note', () => {
      const root = document.createElement('div');
      document.body.append(root);

      const anchor = document.createElement('a');
      anchor.setAttribute('data-pkc-entry-ref', 'entry:n1');
      root.append(anchor);

      const dispatcher = createMockDispatcher({
        openBody: {
          lid: 'n1',
          body: '現在開いているノートの本文です。',
          rawDraft: null,
          title: 'ノート1',
          savedRevId: 'r1',
          updatedAt: '2026-09-28T10:00:00Z',
        },
      } as unknown as Partial<AppState>);

      const teardown = setupLinkPreview(root, dispatcher);

      anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(HOVER_DELAY_MS);

      const card = root.querySelector(`[data-pkc-region="${LINK_PREVIEW_REGION}"]`);
      expect(card?.querySelector('.pkc-link-preview-body')?.textContent).toBe(
        '現在開いているノートの本文です。',
      );

      teardown();
    });

    it('closes immediately on click or Escape', () => {
      const root = document.createElement('div');
      document.body.append(root);

      const anchor = document.createElement('a');
      anchor.setAttribute('data-pkc-entry-ref', 'entry:n1');
      root.append(anchor);

      const dispatcher = createMockDispatcher();
      const teardown = setupLinkPreview(root, dispatcher);

      anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(HOVER_DELAY_MS);
      expect(linkPreviewOpen(root)).toBe(true);

      // Escape
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(linkPreviewOpen(root)).toBe(false);

      // Open again
      anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(HOVER_DELAY_MS);
      expect(linkPreviewOpen(root)).toBe(true);

      // Click
      root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(linkPreviewOpen(root)).toBe(false);

      teardown();
    });
  });
});
