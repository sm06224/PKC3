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

import { watchAppearanceFromOtherWindows } from '../../src/adapter/ui/render/appearance-follow';
import { applyPageFormat, PAGE_FORMAT_STORAGE_KEY } from '../../src/adapter/ui/render/page-format';
import { applyProseAlign, PROSE_ALIGN_STORAGE_KEY } from '../../src/adapter/ui/render/prose-align';
import {
  applyReadColumns,
  READ_COLUMNS_ATTR,
  READ_COLUMNS_STORAGE_KEY,
} from '../../src/adapter/ui/render/read-columns';
import {
  applyColumnRule,
  COLUMN_RULE_ATTR,
  COLUMN_RULE_STORAGE_KEY,
} from '../../src/adapter/ui/render/column-rule';
import {
  applyTagBadge,
  TAG_BADGE_ATTR,
  TAG_BADGE_STORAGE_KEY,
} from '../../src/adapter/ui/render/tag-badge';
import { PAGE_FORMAT_ATTR } from '../../src/features/page-format';
import { PROSE_ALIGN_ATTR } from '../../src/features/prose-align';

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

describe('紙面・置き場所・段数・段の境界線・タグの見せ方: 別のウィンドウの変更を拾う', () => {
  // 観測点は <html> の属性(画面に当たっている値)。start = 既定、other = 既定でない有効な値。
  const cases = [
    { name: '紙面', key: PAGE_FORMAT_STORAGE_KEY, attr: PAGE_FORMAT_ATTR, start: 'a4-portrait', other: 'a3-landscape',
      apply: () => applyPageFormat(html(), 'a4-portrait') },
    { name: '本文の置き場所', key: PROSE_ALIGN_STORAGE_KEY, attr: PROSE_ALIGN_ATTR, start: 'center', other: 'start',
      apply: () => applyProseAlign(html(), 'center') },
    { name: '段数', key: READ_COLUMNS_STORAGE_KEY, attr: READ_COLUMNS_ATTR, start: '1', other: '3',
      apply: () => applyReadColumns(html(), '1') },
    { name: '段の境界線', key: COLUMN_RULE_STORAGE_KEY, attr: COLUMN_RULE_ATTR, start: 'thin', other: 'clear',
      apply: () => applyColumnRule(html(), 'thin') },
    { name: 'タグの見せ方', key: TAG_BADGE_STORAGE_KEY, attr: TAG_BADGE_ATTR, start: 'chip', other: 'plain',
      apply: () => applyTagBadge(html(), 'chip') },
  ] as const;

  it('5 つ全部が対象(鍵が重ならない)', () => {
    expect(new Set(cases.map((c) => c.key)).size).toBe(5);
  });

  for (const c of cases) {
    it(`🔴 ${c.name}: 鍵が変わると当て直す / 関係ない鍵では動かない / 全消しで既定へ / 外せる`, () => {
      for (const d of cases) d.apply();
      const stop = watchAppearanceFromOtherWindows(html(), window);
      localStorage.setItem(c.key, c.other);
      fire('pkc3.something-else');
      expect(html().getAttribute(c.attr), '関係ない鍵で当て直した').toBe(c.start);
      // 他の 4 つの鍵では、この項目は動かない
      for (const d of cases) if (d.key !== c.key) {
        fire(d.key);
        expect(html().getAttribute(c.attr), `${d.name}の鍵で ${c.name} が動いた`).toBe(c.start);
      }
      fire(c.key);
      expect(html().getAttribute(c.attr), '届いていない').toBe(c.other);
      localStorage.removeItem(c.key);
      fire(null);
      expect(html().getAttribute(c.attr), '全消しで既定へ戻らない').toBe(c.start);
      stop();
      localStorage.setItem(c.key, c.other);
      fire(c.key);
      expect(html().getAttribute(c.attr), '外した後も聞いている').toBe(c.start);
    });
  }
});
