/** @vitest-environment node */
/**
 * 🔴 **貼った画像に名前を付ける**(#250)。⚠ 付けないと一覧に「名前なし」が並び、
 * あとから探せない ── クリップボードの画像は名前を持っていない。
 */
import { describe, expect, it } from 'vitest';
import { pastedImageName } from '../../src/features/asset/pasted-image-name';

const AT = new Date(2026, 7, 18, 4, 32, 9); // 2026-08-18 04:32:09(現地時刻)

describe('pastedImageName', () => {
  it('貼った日時から名前を作る(秒まで)', () => {
    expect(pastedImageName({ type: 'image/png' }, AT)).toBe('スクリーンショット-2026-08-18-043209.png');
  });

  it('🔴 拡張子は **mime から**引く(名前からではない)', () => {
    expect(pastedImageName({ type: 'image/jpeg' }, AT)).toMatch(/\.jpg$/);
    expect(pastedImageName({ type: 'image/webp' }, AT)).toMatch(/\.webp$/);
    expect(pastedImageName({ type: 'IMAGE/PNG' }, AT)).toMatch(/\.png$/);
  });

  it('⚠ 知らない型は png に倒す(拡張子なしで出さない)', () => {
    expect(pastedImageName({ type: 'image/heic' }, AT)).toMatch(/\.png$/);
    expect(pastedImageName({ type: '' }, AT)).toMatch(/\.png$/);
  });

  it('同じ分でも秒が違えば別の名前(2 枚続けて貼れる)', () => {
    const a = pastedImageName({ type: 'image/png' }, new Date(2026, 7, 18, 4, 32, 9));
    const b = pastedImageName({ type: 'image/png' }, new Date(2026, 7, 18, 4, 32, 41));
    expect(a).not.toBe(b);
  });
});
