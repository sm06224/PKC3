import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../src/features/sync/sha256';

describe('sync/sha256(同期の指紋)', () => {
  it('Node の SHA-256 と、ブロック境界(55/56/63/64/65/119/120 バイト)・日本語・空文字で一致する', () => {
    const cases = ['', 'abc', '日本語のノート'.repeat(50), ...[55, 56, 63, 64, 65, 119, 120, 1000].map((n) => 'a'.repeat(n))];
    for (const s of cases) {
      expect(sha256Hex(s), `len=${Buffer.byteLength(s)}`).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });
  it('1 字違えば別の値(取りこぼしの元)', () => {
    expect(sha256Hex('あ')).not.toBe(sha256Hex('い'));
  });
});
