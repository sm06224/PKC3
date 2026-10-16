/** @vitest-environment happy-dom */
/**
 * 背の低い画面・狭い画面(電話)で届かなくなる物の直し。
 *   ①右クリック / ⋯ メニューが画面の高さからはみ出さず、中で送れて、中で送っても閉じない
 *   ②SQL 画面の上の帯が折り返す(「SQL を実行」が画面の外へ出ない)
 *   ③画像の別窓・描き込み窓が viewport を宣言する(無いと 980px で描いて縮む)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { contextMenuOpen, openContextMenu } from '../../src/adapter/ui/render/context-menu';
import { BODY_MENU_ACTIONS } from '../../src/features/entry-actions';
import { openAssetWindow } from '../../src/adapter/platform/asset-window';
import { openImageDrawWindow } from '../../src/adapter/platform/image-draw-window';

const css = stripComments(readFileSync('src/styles/app.css', 'utf-8'));

afterEach(() => {
  vi.restoreAllMocks();
});

function menuRig(innerHeight: number) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(innerHeight);
  bindActions(root, new Dispatcher(), { showStatus: () => undefined });
  openContextMenu(root, { x: 0, y: 0 }, [...BODY_MENU_ACTIONS], null, {});
  const menu = root.querySelector<HTMLElement>('[data-pkc-region="context-menu"]')!;
  return { root, menu };
}

describe('背の低い画面のメニュー', () => {
  it('🔴 高さを画面の高さまでに抑える(inline の max-height)', () => {
    const { menu } = menuRig(300);
    expect(menu.style.maxHeight).toBe('284px');
  });

  it('🔴 CSS が中で送れる形(overflow-y: auto / overscroll-behavior: contain / max-height)', () => {
    const body = blocksFor(withoutMedia(css), "[data-pkc-region='context-menu']").join(';');
    expect(body).toMatch(/max-height:\s*calc\(100dvh/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/overscroll-behavior:\s*contain/);
  });

  it('🔴 メニューの中の scroll では閉じない / 外の scroll では閉じる', () => {
    const { root, menu } = menuRig(300);
    expect(contextMenuOpen(root)).toBe(true);
    menu.dispatchEvent(new Event('scroll'));
    expect(contextMenuOpen(root), 'メニューの中で送っただけで閉じた').toBe(true);
    // 対照群: 外の scroll は従来どおり閉じる(緩めすぎていない)
    const outer = document.createElement('div');
    root.append(outer);
    outer.dispatchEvent(new Event('scroll'));
    expect(contextMenuOpen(root), '外の scroll で閉じなくなった').toBe(false);
  });
});

describe('SQL 画面の上の帯', () => {
  it('🔴 折り返す(素の規則で flex-wrap: wrap)', () => {
    const body = blocksFor(withoutMedia(css), "[data-pkc-field='sql-bar']").join(';');
    expect(body).toMatch(/flex-wrap:\s*wrap/);
  });
});

describe('別窓の viewport', () => {
  const VIEWPORT = 'meta[name="viewport"][content="width=device-width, initial-scale=1"]';
  it('🔴 画像の別窓', async () => {
    const doc = document.implementation.createHTMLDocument('');
    const win = { closed: false, document: doc, close: () => undefined } as unknown as Window;
    await openAssetWindow({
      kind: 'image',
      lent: { url: 'blob:x', dispose: vi.fn() },
      title: 'a.png',
      open: () => win,
      waitClose: () => new Promise(() => undefined),
    });
    expect(doc.head.querySelector(VIEWPORT)).not.toBeNull();
  });

  it('🔴 描き込み窓', () => {
    const doc = document.implementation.createHTMLDocument('');
    const win = { closed: false, document: doc, opener: {}, close: () => undefined, focus: () => undefined };
    openImageDrawWindow({
      title: 'p.png',
      windowName: 'w',
      onClosed: () => undefined,
      open: () => win as unknown as Window,
      waitClose: () => new Promise(() => undefined),
    });
    expect(doc.head.querySelector(VIEWPORT)).not.toBeNull();
  });
});
