/** @vitest-environment happy-dom */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  renderLightboxOverlay,
  openLightbox,
  closeLightbox,
  lightboxOpen,
  setupLightbox,
  LIGHTBOX_REGION,
} from '../../src/adapter/ui/render/lightbox';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { AppState } from '../../src/adapter/state/app-state';

describe('lightbox', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('renderLightboxOverlay', () => {
    it('renders overlay with title and image', () => {
      const onClose = vi.fn();
      const overlay = renderLightboxOverlay(
        document,
        {
          src: 'test-image.png',
          alt: 'テスト図面',
        },
        undefined,
        onClose,
      );

      expect(overlay.getAttribute('data-pkc-region')).toBe(LIGHTBOX_REGION);
      expect(overlay.querySelector('.pkc-lightbox-title')?.textContent).toBe('テスト図面');

      const img = overlay.querySelector<HTMLImageElement>('.pkc-lightbox-img');
      expect(img?.src).toContain('test-image.png');
      expect(img?.alt).toBe('テスト図面');

      // Click close button
      const closeBtn = overlay.querySelector<HTMLButtonElement>('.pkc-lightbox-close-btn');
      closeBtn?.click();
      expect(onClose).toHaveBeenCalledTimes(1);

      // Click backdrop
      const backdrop = overlay.querySelector<HTMLElement>('.pkc-lightbox-backdrop');
      backdrop?.click();
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('renders open-window button when services.viewBig is provided', () => {
      const viewBig = vi.fn();
      const overlay = renderLightboxOverlay(
        document,
        {
          src: 'test-image.png',
          alt: '図',
          diagram: { kind: 'mermaid', source: 'graph TD; A-->B;' },
        },
        { viewBig },
      );

      const openWinBtn = overlay.querySelector<HTMLButtonElement>('.pkc-lightbox-open-win-btn');
      expect(openWinBtn).not.toBeNull();

      openWinBtn?.click();
      expect(viewBig).toHaveBeenCalledWith(
        'test-image.png',
        '図',
        { kind: 'mermaid', source: 'graph TD; A-->B;' },
        undefined,
      );
    });
  });

  describe('openLightbox and closeLightbox lifecycle', () => {
    it('opens and closes lightbox correctly', () => {
      const root = document.createElement('div');
      document.body.append(root);

      expect(lightboxOpen(root)).toBe(false);

      openLightbox(root, { src: 'pic.jpg', alt: '風景' });
      expect(lightboxOpen(root)).toBe(true);
      expect(root.querySelector('.pkc-lightbox-title')?.textContent).toBe('風景');

      closeLightbox(root);
      expect(lightboxOpen(root)).toBe(false);
    });

    it('closes on Escape key when setupLightbox is active', () => {
      const root = document.createElement('div');
      document.body.append(root);

      const teardown = setupLightbox(root);
      openLightbox(root, { src: 'pic.jpg', alt: '風景' });
      expect(lightboxOpen(root)).toBe(true);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(lightboxOpen(root)).toBe(false);

      teardown();
    });
  });

  describe('binder integration with view-big', () => {
    function createMockDispatcher(): Dispatcher {
      const defaultState = {
        phase: 'ready',
        cid: 'c1',
        entryMetas: new Map(),
        order: [],
        relations: [],
        openBody: null,
        selectedLid: null,
      } as unknown as AppState;

      return {
        getState: () => defaultState,
        dispatch: vi.fn(),
      } as unknown as Dispatcher;
    }

    it('opens lightbox when clicking img with data-pkc-action="view-big"', () => {
      const root = document.createElement('div');
      document.body.append(root);

      const img = document.createElement('img');
      img.src = 'https://example.com/test.png';
      img.alt = 'クリックで拡大';
      img.setAttribute('data-pkc-action', 'view-big');
      root.append(img);

      const dispatcher = createMockDispatcher();
      const unbind = bindActions(root, dispatcher);

      expect(lightboxOpen(root)).toBe(false);

      img.click();
      expect(lightboxOpen(root)).toBe(true);

      const overlay = root.querySelector(`[data-pkc-region="${LIGHTBOX_REGION}"]`);
      expect(overlay?.querySelector('.pkc-lightbox-title')?.textContent).toBe('クリックで拡大');

      // Click close button inside lightbox
      const closeBtn = overlay?.querySelector<HTMLElement>('[data-pkc-action="close-lightbox"]');
      closeBtn?.click();
      expect(lightboxOpen(root)).toBe(false);

      unbind();
    });
  });
});
