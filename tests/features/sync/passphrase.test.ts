import { describe, expect, it } from 'vitest';
import { formatRecoveryKey } from '../../../src/features/sync/e2e-crypto';
import { PASSPHRASE_HINT, PASSPHRASE_MIN_LENGTH, passphraseProblem, passphraseStrength, sameRecoveryKey } from '../../../src/features/sync/passphrase';

describe('パスフレーズの検査(段 4b-B)', () => {
  it('10 文字未満は断る / 2 つが違えば断る / 通れば null(境界の両側)', () => {
    expect(PASSPHRASE_MIN_LENGTH).toBe(10);
    expect(passphraseProblem('123456789', '123456789')).toContain('10 文字以上');
    expect(passphraseProblem('1234567890', '1234567890')).toBeNull();
    expect(passphraseProblem('1234567890', '1234567891')).toContain('一致しません');
    expect(passphraseProblem('あいうえおかきくけこ', 'あいうえおかきくけこ'), '字数は文字(コードポイント)で数える').toBeNull();
    expect(passphraseProblem('あいうえおかきくけ', 'あいうえおかきくけ')).toContain('10 文字以上');
  });

  it('強さの目安: 短い < 弱い < まあまあ < 十分(入れた字は返さない)', () => {
    expect(passphraseStrength('abc')).toBe('short');
    expect(passphraseStrength('aaaaaaaaaaaa')).toBe('weak');
    expect(passphraseStrength('abcdefghij')).toBe('weak');
    expect(passphraseStrength('abcdefghijkl')).toBe('fair');
    expect(passphraseStrength('Abcdefg123xyz')).toBe('strong');
    expect(passphraseStrength('a-very-long-passphrase-here')).toBe('strong');
    for (const h of Object.values(PASSPHRASE_HINT)) expect(h).not.toContain('abcdefghij');
  });

  it('回復キーの打ち直し: 大文字小文字・ハイフン・空白を問わず合う / 1 字違い・短い・読めないは合わない', () => {
    const bytes = new Uint8Array(20).map((_, i) => (i * 37 + 11) & 255);
    const key = formatRecoveryKey(bytes);
    expect(sameRecoveryKey(key, key)).toBe(true);
    expect(sameRecoveryKey(key, key.toLowerCase())).toBe(true);
    expect(sameRecoveryKey(key, key.replace(/-/g, ' '))).toBe(true);
    expect(sameRecoveryKey(key, key.replace(/-/g, ''))).toBe(true);
    const other = formatRecoveryKey(new Uint8Array(20).map((_, i) => (i * 37 + 12) & 255));
    expect(sameRecoveryKey(key, other)).toBe(false);
    expect(sameRecoveryKey(key, key.slice(0, -1))).toBe(false);
    expect(sameRecoveryKey(key, '')).toBe(false);
    expect(sameRecoveryKey(key, '!!!!-????')).toBe(false);
  });
});
