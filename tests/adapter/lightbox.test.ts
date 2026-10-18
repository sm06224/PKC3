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
import { markViewBig } from '../../src/adapter/ui/render/view-big';
import { readFileSync } from 'node:fs';
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

    /**
     * 🔴 ⧉ を押して別のウィンドウが開けたときだけ、その場の拡大を閉じる(台帳 #1852 束 T1、依頼 99-2 C)。
     * 直す前は、開けても開けなくても暗い拡大が本文を覆ったままだった。
     */
    describe('⧉ で別のウィンドウが開けたとき(依頼 99-2 C)', () => {
      const opened = async (result: boolean | undefined): Promise<{ closed: number }> => {
        const out = { closed: 0 };
        const viewBig = vi.fn(() => (result === undefined ? undefined : Promise.resolve(result)));
        const root = document.createElement('div');
        document.body.append(root);
        openLightbox(root, { src: 'a.png', alt: '図' }, { viewBig } as never);
        const btn = root.querySelector<HTMLButtonElement>('.pkc-lightbox-open-win-btn')!;
        btn.click();
        await Promise.resolve();
        await Promise.resolve();
        out.closed = lightboxOpen(root) ? 0 : 1;
        return out;
      };
      it('🔴 開けたら、拡大を閉じる', async () => {
        expect((await opened(true)).closed, '別のウィンドウが開いたのに拡大が本文を覆ったまま').toBe(1);
      });
      it('対照群: 開けなかったら(ポップアップが止められた等)閉じない ── 理由を読め、拡大のまま使える', async () => {
        expect((await opened(false)).closed, '開けなかったのに閉じた(何も見えなくなる)').toBe(0);
      });
      it('対照群: 開けたか分からない呼び手(何も返さない)でも閉じない', async () => {
        expect((await opened(undefined)).closed).toBe(0);
      });
      it('待っている間に user が閉じた / 別の拡大を開いたなら、後から来た「開けた」で触らない', async () => {
        const root = document.createElement('div');
        document.body.append(root);
        let resolve!: (v: boolean) => void;
        const viewBig = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
        openLightbox(root, { src: 'a.png', alt: '図' }, { viewBig } as never);
        root.querySelector<HTMLButtonElement>('.pkc-lightbox-open-win-btn')!.click();
        // 待っている間に別の拡大を開き直す(最初の拡大は消える)
        openLightbox(root, { src: 'b.png', alt: '別の図' }, { viewBig } as never);
        resolve(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(lightboxOpen(root), '別の拡大を巻き添えで閉じた').toBe(true);
      });
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

  describe('Tab の見張り(焦点が <body> に落ちていても外へ抜けない)', () => {
    const tab = (shiftKey = false): KeyboardEvent =>
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });

    it('🔴 焦点が body のとき Tab は中の最初のボタンへ、Shift+Tab は最後へ戻す', () => {
      const root = document.createElement('div');
      document.body.append(root);
      openLightbox(root, { src: 'pic.jpg', alt: '風景' });
      const btns = [...root.querySelectorAll<HTMLElement>('button:not(:disabled)')];
      expect(btns.length).toBeGreaterThan(0);

      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement).toBe(document.body);
      const ev = tab();
      document.body.dispatchEvent(ev);
      expect(ev.defaultPrevented, 'Tab が外へ抜ける').toBe(true);
      expect(document.activeElement).toBe(btns[0]);

      (document.activeElement as HTMLElement).blur();
      const ev2 = tab(true);
      document.body.dispatchEvent(ev2);
      expect(ev2.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(btns[btns.length - 1]);
      closeLightbox(root);
    });

    it('🔴 閉じたら見張りは外れる(Tab を奪わない)', () => {
      const root = document.createElement('div');
      document.body.append(root);
      openLightbox(root, { src: 'pic.jpg', alt: '風景' });
      closeLightbox(root);
      (document.activeElement as HTMLElement | null)?.blur();
      const ev = tab();
      document.body.dispatchEvent(ev);
      expect(ev.defaultPrevented, '閉じたのに Tab を奪っている').toBe(false);
    });

    it('開き直しても見張りは 1 つ(二重に張らない)', () => {
      const root = document.createElement('div');
      document.body.append(root);
      const spy = vi.spyOn(document, 'addEventListener');
      const off = vi.spyOn(document, 'removeEventListener');
      openLightbox(root, { src: 'a.jpg', alt: 'a' });
      openLightbox(root, { src: 'b.jpg', alt: 'b' });
      const added = spy.mock.calls.filter((c) => c[0] === 'keydown').length;
      const removed = off.mock.calls.filter((c) => c[0] === 'keydown').length;
      expect(added - removed).toBe(1);
      closeLightbox(root);
      spy.mockRestore();
      off.mockRestore();
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

    /**
     * 🔴 依頼 79-3 C: キーボードだけで画像・図を大きく表示できる(Tab で止まり、Enter / Space で開く)。
     * 直す前は画像を押すしか道が無く、Tab で画像に止まれなかった。
     */
    it('🔴 読む面の画像は Tab で止まれて、Enter で大きく表示され、閉じると画像へ焦点が戻る', () => {
      const root = document.createElement('div');
      document.body.append(root);
      const img = document.createElement('img');
      img.src = 'https://example.com/test.png';
      img.alt = '図A';
      root.append(img);
      markViewBig(img); // 読む面なので印が付く
      expect(img.tabIndex, 'Tab で止まれない').toBe(0);
      expect(img.getAttribute('role')).toBe('button');
      const unbind = bindActions(root, createMockDispatcher());
      img.focus();
      expect(document.activeElement, '前提: 画像に焦点が乗らない').toBe(img);
      img.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      expect(lightboxOpen(root), 'Enter で開かない').toBe(true);
      expect(root.querySelector('.pkc-lightbox-title')?.textContent).toBe('図A');
      // 焦点は中(✕)へ移り、閉じると画像に戻る(キーボードの位置が失われない)
      expect(document.activeElement?.classList.contains('pkc-lightbox-close-btn')).toBe(true);
      closeLightbox(root);
      expect(document.activeElement, '閉じても画像に戻らない').toBe(img);
      // Space でも開く
      img.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
      expect(lightboxOpen(root), 'Space で開かない').toBe(true);
      unbind();
    });

    it('⚠ 対照群: 編集の面(editor-live)の画像には印を付けない ── Tab の止まり先も増えず、押すと原文が開く道を奪わない', () => {
      const root = document.createElement('div');
      const live = document.createElement('div');
      live.setAttribute('data-pkc-region', 'editor-live');
      const img = document.createElement('img');
      live.append(img);
      root.append(live);
      document.body.append(root);
      markViewBig(img);
      expect(img.hasAttribute('tabindex')).toBe(false);
      expect(img.hasAttribute('data-pkc-action')).toBe(false);
    });

    it('止まった画像に枠が出る規則がある(印だけ付けて見た目が無い、を防ぐ)', () => {
      const css = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(css).toMatch(/img\[data-pkc-action='view-big'\]:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
    });
  });
});
