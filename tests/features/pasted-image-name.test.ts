/** @vitest-environment node */
/**
 * 🔴 **貼った画像に名前を付ける**(#250)。⚠ 付けないと一覧に「名前なし」が並び、
 * あとから探せない ── クリップボードの画像は名前を持っていない。
 */
import { describe, expect, it } from 'vitest';
import { createNameDeduper, pastedFileName, pastedImageName } from '../../src/features/asset/pasted-image-name';

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

  it('🔴 本物の名前を持つ file はその名前を使う(#1087)', () => {
    expect(pastedFileName({ type: 'image/jpeg', name: '旅行の写真.jpg' }, AT)).toBe('旅行の写真.jpg');
  });

  it('🔴 名前が空 / ブラウザの既定名(image.png など)なら貼った日時の名前', () => {
    const stamped = 'スクリーンショット-2026-08-18-043209';
    expect(pastedFileName({ type: 'image/png', name: '' }, AT)).toBe(`${stamped}.png`);
    expect(pastedFileName({ type: 'image/png', name: 'image.png' }, AT)).toBe(`${stamped}.png`);
    expect(pastedFileName({ type: 'image/jpeg', name: 'Image.JPG' }, AT)).toBe(`${stamped}.jpg`);
    expect(pastedFileName({ type: 'image/png' }, AT)).toBe(`${stamped}.png`);
    // 対照群: image で始まるだけの本物の名前は残す
    expect(pastedFileName({ type: 'image/png', name: 'image-01.png' }, AT)).toBe('image-01.png');
  });
});

describe('createNameDeduper(同じ秒に貼った複数枚)', () => {
  it('🔴 重なった名前は拡張子の前に -2、-3 を付ける(最初の 1 枚はそのまま)', () => {
    const u = createNameDeduper();
    const n = pastedImageName({ type: 'image/png' }, AT);
    expect([u(n), u(n), u(n)]).toEqual([
      'スクリーンショット-2026-08-18-043209.png',
      'スクリーンショット-2026-08-18-043209-2.png',
      'スクリーンショット-2026-08-18-043209-3.png',
    ]);
  });

  it('別の名前は触らない / 先に在る -2 とも重ならない / 回ごとに独立', () => {
    const u = createNameDeduper();
    expect(u('a.png')).toBe('a.png');
    expect(u('b.png')).toBe('b.png');
    expect(u('a-2.png')).toBe('a-2.png');
    expect(u('a.png'), '先に使われた a-2.png と重なった').toBe('a-3.png');
    expect(createNameDeduper()('a.png'), '別の回に前の回が混ざった').toBe('a.png');
    expect(createNameDeduper()('noext')).toBe('noext');
    const v = createNameDeduper();
    v('noext');
    expect(v('noext')).toBe('noext-2');
  });
});
