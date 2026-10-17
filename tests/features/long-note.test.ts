/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { LONG_NOTE_LINES, isLongNote } from '../../src/features/markdown/long-note';

/**
 * 🔴 **長大なノートのしきい値**(#1467、裁定 21 = A)。
 *
 * ⚠ 守るのは「**5,000 行以下は 1 ピクセルも変えない**」の境目 ── ちょうど 5,000 行は含めず、5,001 行から。
 * 末尾の改行 1 つで境目が動かないこと(`.md` の取り込みは末尾が改行の本文が多い)も見る。
 */
const lines = (n: number, tail = ''): string => Array.from({ length: n }, (_, i) => `行 ${i}`).join('\n') + tail;

describe('isLongNote', () => {
  it('しきい値は 5,000 行(定数が動いたら気づく)', () => {
    expect(LONG_NOTE_LINES).toBe(5000);
  });

  it('ちょうど 5,000 行は長大ではない / 5,001 行から長大', () => {
    expect(isLongNote(lines(LONG_NOTE_LINES))).toBe(false);
    expect(isLongNote(lines(LONG_NOTE_LINES + 1))).toBe(true);
  });

  it('末尾の改行は 1 行に数えない(5,000 行の file は 5,000 行)', () => {
    expect(isLongNote(lines(LONG_NOTE_LINES, '\n'))).toBe(false);
    // 対照群: 改行で終わる 5,001 行は長大
    expect(isLongNote(lines(LONG_NOTE_LINES + 1, '\n'))).toBe(true);
    // 末尾の空行(改行 2 つ)は 1 行として数える
    expect(isLongNote(lines(LONG_NOTE_LINES, '\n\n'))).toBe(true);
  });

  it('空・短い本文は長大ではない', () => {
    expect(isLongNote('')).toBe(false);
    expect(isLongNote('1 行')).toBe(false);
    expect(isLongNote(lines(2000))).toBe(false);
  });

  it('20,000 行は長大', () => {
    expect(isLongNote(lines(20000))).toBe(true);
  });
});
