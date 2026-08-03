/** @vitest-environment happy-dom */
/**
 * P7b review M-7 / L-1: 配色。
 *
 * 🔴 初版は**適用のたびに保存**していたので、起動時の
 * `applyTheme(…, initialTheme())` が **OS の設定をそのまま保存**し、
 * 「一度も選んでいないのに初回起動時の OS 設定で固定される」状態だった。
 * 実測: OS=dark で初回起動 → `stored:'dark'` → OS を light に戻しても dark のまま。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyTheme,
  chooseTheme,
  initialTheme,
  otherTheme,
} from '../../src/adapter/ui/render/theme';

const KEY = 'pkc3.theme';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-pkc-theme');
});

describe('配色', () => {
  it('🔴 起動時の適用は **保存しない**', () => {
    applyTheme(document.documentElement, 'dark');
    expect(document.documentElement.getAttribute('data-pkc-theme')).toBe('dark');
    // ⚠ ここが保存されると、次の起動で OS 設定が無視される
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('🔴 user が選んだときだけ保存する', () => {
    chooseTheme(document.documentElement, 'light');
    expect(document.documentElement.getAttribute('data-pkc-theme')).toBe('light');
    expect(localStorage.getItem(KEY)).toBe('light');
  });

  it('選んでいなければ OS に従い、選んだ後はそちらが優先される', () => {
    expect(initialTheme(true)).toBe('dark');
    expect(initialTheme(false)).toBe('light');
    chooseTheme(document.documentElement, 'dark');
    expect(initialTheme(false)).toBe('dark'); // 選んだほうが勝つ
  });

  it('逆の配色', () => {
    expect(otherTheme('dark')).toBe('light');
    expect(otherTheme('light')).toBe('dark');
  });
});
