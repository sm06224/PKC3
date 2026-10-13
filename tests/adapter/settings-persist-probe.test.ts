/** @vitest-environment happy-dom */
/**
 * 🔴 **設定を保存できないブラウザでは、システムの画面で 1 度だけ言う**(#1087)。
 * ⚠ 直す前は 20 を超える設定の store が、どれも保存の失敗を黙っていた(「この端末で覚えます」が黙って破れる)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsRenderer } from '../../src/adapter/ui/render/settings';
import { initialState } from '../../src/adapter/state/app-state';
import { canPersistSettings } from '../../src/adapter/ui/render/settings-persist-probe';

const paint = (): HTMLElement => {
  const host = document.createElement('div');
  document.body.append(host);
  new SettingsRenderer(host).render(initialState);
  return host;
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('canPersistSettings(#1087)', () => {
  it('保存先が無い / 書くと例外 → false、書けて消せる → true', () => {
    expect(canPersistSettings(() => null)).toBe(false);
    const throwing = { setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} } as unknown as Storage;
    expect(canPersistSettings(() => throwing)).toBe(false);
    expect(canPersistSettings(() => localStorage)).toBe(true);
    // ⚠ 試しに書いた鍵を残さない
    expect(localStorage.getItem('pkc3.settings-probe')).toBeNull();
  });
});

describe('システムの画面の「設定」(#1087)', () => {
  it('🔴 保存できないときだけ、閉じると元に戻ることを言う', () => {
    // 対照群: 保存できる
    expect(paint().querySelector('[data-pkc-field="settings-not-persisted"]'), '保存できるのに出た').toBeNull();
    // ⚠ 本物の `localStorage` の書込を例外にする(グローバルを丸ごと差し替えない)
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const note = paint().querySelector('[data-pkc-field="settings-not-persisted"]');
    expect(note?.textContent ?? '').toContain('PKC3 を閉じると元に戻ります');
  });
});
