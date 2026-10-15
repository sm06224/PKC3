/** @vitest-environment happy-dom */
/**
 * 🔴 **縮める前の復号は EXIF の向きを反映する**(#1087)。
 * ⚠ 渡さないと、スマホの写真が横倒しのまま縮められる。
 */
import { describe, expect, it } from 'vitest';
import { shrinkImage } from '../../src/adapter/platform/asset/asset-codec';

describe('shrinkImage の復号', () => {
  it('createImageBitmap に imageOrientation: from-image を渡す', async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const prev = g.createImageBitmap;
    const prevOc = g.OffscreenCanvas;
    const seen: unknown[] = [];
    g.createImageBitmap = async (_b: Blob, o?: unknown) => {
      seen.push(o);
      return { width: 10, height: 10, close: () => undefined };
    };
    g.OffscreenCanvas = class {};
    try {
      await shrinkImage({ blob: new Blob(['x']), mime: 'image/jpeg' } as never);
    } finally {
      g.createImageBitmap = prev;
      g.OffscreenCanvas = prevOc;
    }
    expect(seen).toEqual([{ imageOrientation: 'from-image' }]);
  });
});
