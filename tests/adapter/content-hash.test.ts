/**
 * revision 同一内容 skip(P5)の hash pin。決定性と「1 文字差で変わる」だけを
 * 固定する(暗号強度は要求しない ── 衝突の帰結は revision 1 件の skip)。
 */
import { describe, expect, it } from 'vitest';
import { contentHash64Hex } from '../../src/adapter/platform/storage/content-hash';

describe('contentHash64Hex (P5)', () => {
  it('決定的で 16 桁 hex', () => {
    const h = contentHash64Hex('# 本文\n\nテスト');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(contentHash64Hex('# 本文\n\nテスト')).toBe(h);
  });

  it('1 文字差・空文字・改行差で変わる', () => {
    const base = contentHash64Hex('abc');
    expect(contentHash64Hex('abd')).not.toBe(base);
    expect(contentHash64Hex('abc ')).not.toBe(base);
    expect(contentHash64Hex('')).not.toBe(base);
    expect(contentHash64Hex('a\nbc')).not.toBe(contentHash64Hex('a\r\nbc'));
  });
});
