/**
 * 🔴 **可搬単一 HTML の器の「判定」**(#400 段③)。
 *
 * ⚠ IndexedDB の配管そのものは happy-dom に無いので、ここでは見ない
 * (`file://` の smoke が実物で通す ── そちらが正しい層である)。
 * 🔑 ここが見るのは**判定**である ── 変異試験 M18 が SURVIVED で教えた:
 * 器の中に置いたままの門は、**どの unit からも走らなかった**。
 */
import { describe, expect, it } from 'vitest';
import {
  assertWritableImage,
  decodeStoredImage,
} from '../../src/adapter/platform/storage/db-image-store';

const ok = {
  bundleId: 'pkcb-storetest0001',
  exportedAt: 10,
  savedAt: 20,
  image: new Uint8Array([1, 2, 3]),
};

describe('書く前に止める', () => {
  it('🔴 空の画像は器へ書かない(次の起動が「記録がある」と読んでしまう)', () => {
    expect(() => assertWritableImage(new Uint8Array(0))).toThrow(/空/);
  });

  it('⚠ 空振り防止 ── 中身があれば通る', () => {
    expect(() => assertWritableImage(new Uint8Array([1]))).not.toThrow();
  });
});

describe('読んだ記録を検める', () => {
  it('無い記録は null(それは「まだ書いていない」である)', () => {
    expect(decodeStoredImage(undefined)).toBeNull();
    expect(decodeStoredImage(null)).toBeNull();
  });

  it('正しい記録は、大きさを添えて返る', () => {
    expect(decodeStoredImage(ok)).toEqual({ ...ok, bytes: 3 });
  });

  it('🔴 壊れた記録は「無い」と読み替えず、投げる', () => {
    /**
     * ⚠ 「無い」に畳むと、呼び側は「器が空だから配られた画像を開く」へ進み、
     *   **user の編集を上書きする** ── だから黙って進ませてはいけない。
     */
    for (const [why, raw] of [
      ['画像が Uint8Array でない', { ...ok, image: 'これは文字列' }],
      ['画像が無い', { bundleId: ok.bundleId, exportedAt: 1, savedAt: 2 }],
      ['bundleId が無い', { ...ok, bundleId: undefined }],
      ['bundleId が空', { ...ok, bundleId: '' }],
      ['exportedAt が数でない', { ...ok, exportedAt: '10' }],
      ['savedAt が数でない', { ...ok, savedAt: null }],
      ['savedAt が NaN', { ...ok, savedAt: Number.NaN }],
    ] as const)
      expect(() => decodeStoredImage(raw), why).toThrow(/形が違います/);
  });

  it('⚠ どの欄が壊れているかを言う(「形が違います」だけにしない)', () => {
    expect(() => decodeStoredImage({ ...ok, savedAt: 'x' })).toThrow(/savedAt/);
    expect(() => decodeStoredImage({ ...ok, exportedAt: 'x' })).toThrow(/exportedAt/);
  });
});
