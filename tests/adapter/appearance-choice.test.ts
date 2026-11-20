// @vitest-environment happy-dom
/** #1982 段 4: アクセント・字体の適用・保存・既定へ戻す。 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyAccent,
  applyFont,
  chooseAccent,
  chooseFont,
  currentAccent,
  currentFont,
  initialAccent,
  initialFont,
  watchAppearanceChoiceFromOtherWindows,
} from '../../src/adapter/ui/render/appearance-choice';
import { applyTheme } from '../../src/adapter/ui/render/theme';
import { FONTS } from '../../src/features/appearance-choice';

beforeEach(() => {
  localStorage.clear();
  const h = document.documentElement;
  h.removeAttribute('data-pkc-accent');
  h.removeAttribute('data-pkc-font');
  h.removeAttribute('style');
});

describe('字体', () => {
  it('選ぶと --font / --font-mono が当たり、保存される', () => {
    const h = document.documentElement;
    chooseFont(h, 'biz-ud');
    expect(h.style.getPropertyValue('--font')).toContain('BIZ UDGothic');
    expect(h.style.getPropertyValue('--font-mono')).toContain('monospace');
    expect(localStorage.getItem('pkc3.font')).toBe('biz-ud');
    expect(currentFont(h)).toBe('biz-ud');
    expect(initialFont()).toBe('biz-ud');
  });
  it('標準へ戻すと上書きと鍵が消える(両方向)', () => {
    const h = document.documentElement;
    chooseFont(h, 'mincho');
    chooseFont(h, 'standard');
    expect(h.style.getPropertyValue('--font')).toBe('');
    expect(localStorage.getItem('pkc3.font')).toBeNull();
  });
  it('壊れた保存は標準へ落ちる / 標準の表は tokens.css の既定と同じ', () => {
    localStorage.setItem('pkc3.font', 'zzz');
    expect(initialFont()).toBe('standard');
    expect(FONTS[0]!.id).toBe('standard');
  });
  it('apply は保存しない', () => {
    applyFont(document.documentElement, 'mono');
    expect(localStorage.getItem('pkc3.font')).toBeNull();
  });
});

describe('アクセント', () => {
  it('選ぶと属性が立ち保存され、配色どおりへ戻すと外れる', () => {
    const h = document.documentElement;
    chooseAccent(h, 'blue');
    expect(h.getAttribute('data-pkc-accent')).toBe('blue');
    expect(localStorage.getItem('pkc3.accent')).toBe('blue');
    expect(initialAccent()).toBe('blue');
    chooseAccent(h, 'theme');
    expect(h.hasAttribute('data-pkc-accent')).toBe(false);
    expect(localStorage.getItem('pkc3.accent')).toBeNull();
    expect(currentAccent(h)).toBe('theme');
  });
  it('配色を当てると明暗(data-pkc-tone)が立つ', () => {
    const h = document.documentElement;
    applyTheme(h, 'paper');
    expect(h.getAttribute('data-pkc-tone')).toBe('light');
    applyTheme(h, 'paper-dark');
    expect(h.getAttribute('data-pkc-tone')).toBe('dark');
  });
  it('別のウィンドウの選択に付いていく', () => {
    const h = document.documentElement;
    const un = watchAppearanceChoiceFromOtherWindows(h, window);
    localStorage.setItem('pkc3.accent', 'purple');
    window.dispatchEvent(new StorageEvent('storage', { key: 'pkc3.accent' }));
    expect(h.getAttribute('data-pkc-accent')).toBe('purple');
    un();
    applyAccent(h, 'theme');
  });
});
