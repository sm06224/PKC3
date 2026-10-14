/** @vitest-environment happy-dom */
/**
 * 🔴 **別のウィンドウで選んだ配色・文字の大きさが、開いたままの窓にも届く**(#1087 S2)。
 *
 * 直す前は、予定のウィンドウや付箋などの別ウィンドウは読み込み直すまで古いままだった。
 * 観測点は `<html>` の属性(= 画面に当たっている値)。保存だけ見ない。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyTheme,
  THEME_STORAGE_KEY,
  watchThemeFromOtherWindows,
} from '../../src/adapter/ui/render/theme';
import {
  applyTextScale,
  TEXT_SCALE_ATTR,
  TEXT_SCALE_STORAGE_KEY,
  watchTextScaleFromOtherWindows,
} from '../../src/adapter/ui/render/text-scale';

const html = (): HTMLElement => document.documentElement;
const fire = (key: string | null): void => {
  window.dispatchEvent(new StorageEvent('storage', { key }));
};

beforeEach(() => {
  localStorage.clear();
  html().removeAttribute('data-pkc-theme');
  html().removeAttribute(TEXT_SCALE_ATTR);
});
afterEach(() => localStorage.clear());

describe('配色: 別のウィンドウの変更を拾う', () => {
  it('🔴 鍵が変わると、開いたままの窓の配色が替わる / 関係ない鍵では動かない / 外せる', () => {
    applyTheme(html(), 'light');
    const stop = watchThemeFromOtherWindows(html(), window);
    // 別ウィンドウが書いた(storage event は書いた側には来ない)
    localStorage.setItem(THEME_STORAGE_KEY, 'dracula');
    fire('pkc3.something-else');
    expect(html().getAttribute('data-pkc-theme'), '関係ない鍵で当て直した').toBe('light');
    fire(THEME_STORAGE_KEY);
    expect(html().getAttribute('data-pkc-theme'), '届いていない').toBe('dracula');
    // 全消し(key === null)は既定へ戻る側で読み直す
    localStorage.removeItem(THEME_STORAGE_KEY);
    fire(null);
    expect(['light', 'dark']).toContain(html().getAttribute('data-pkc-theme'));
    stop();
    localStorage.setItem(THEME_STORAGE_KEY, 'nord');
    fire(THEME_STORAGE_KEY);
    expect(html().getAttribute('data-pkc-theme'), '外した後も聞いている').not.toBe('nord');
  });
});

describe('文字の大きさ: 別のウィンドウの変更を拾う', () => {
  it('🔴 鍵が変わると当て直す / 「標準」(鍵が消える)なら既定へ戻る / 外せる', () => {
    applyTextScale(html(), 'standard');
    const stop = watchTextScaleFromOtherWindows(html(), window);
    localStorage.setItem(TEXT_SCALE_STORAGE_KEY, 'large');
    fire('pkc3.something-else');
    expect(html().getAttribute(TEXT_SCALE_ATTR), '関係ない鍵で当て直した').toBe('standard');
    fire(TEXT_SCALE_STORAGE_KEY);
    expect(html().getAttribute(TEXT_SCALE_ATTR), '届いていない').toBe('large');
    expect(html().style.getPropertyValue('--pkc-text-size'), '大きさの変数が替わっていない').not.toBe('');
    localStorage.removeItem(TEXT_SCALE_STORAGE_KEY);
    fire(TEXT_SCALE_STORAGE_KEY);
    expect(html().getAttribute(TEXT_SCALE_ATTR), '標準へ戻っていない').toBe('standard');
    stop();
    localStorage.setItem(TEXT_SCALE_STORAGE_KEY, 'large');
    fire(TEXT_SCALE_STORAGE_KEY);
    expect(html().getAttribute(TEXT_SCALE_ATTR), '外した後も聞いている').toBe('standard');
  });
});
