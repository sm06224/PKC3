/**
 * 🔴 **行 → 文字位置**(#596 C)。
 *
 * ⚠ ここが外すと、「ここから編集する」が**別の行**を開く ── しかも
 *   **開いてはいる**ので、user は「ずれた」ではなく「効いていない」と読む。
 */
import { describe, expect, it } from 'vitest';
import { lineStartOffset, scrollTopForLine } from '../../src/features/markdown/line-offset';

const BODY = ['# 題', '', '本文 1', '## 章', '本文 2'].join('\n');

describe('行 → 文字位置(#596 C)', () => {
  it('🔴 その行の先頭を返す', () => {
    // ⚠ 位置ではなく**その行の字**で確かめる(数を数え直す test にしない)
    for (const [line, head] of [
      [0, '# 題'],
      [1, ''],
      [2, '本文 1'],
      [3, '## 章'],
      [4, '本文 2'],
    ] as const)
      expect(BODY.slice(lineStartOffset(BODY, line)).split('\n')[0], `${line} 行目`).toBe(head);
  });

  it('⚠ 範囲外は端へ丸める(投げない ── 編集に入れなくなるより先頭のほうがまし)', () => {
    expect(lineStartOffset(BODY, -3)).toBe(0);
    expect(lineStartOffset(BODY, 0)).toBe(0);
    // 🔴 行が足りないときは**最後の行の先頭**(末尾ではない)
    expect(BODY.slice(lineStartOffset(BODY, 99))).toBe('本文 2');
    expect(lineStartOffset(BODY, Number.NaN)).toBe(0);
  });

  it('⚠ 末尾が改行で終わる本文でも、最後の空行の先頭を指す', () => {
    const b = 'a\nb\n';
    expect(lineStartOffset(b, 2)).toBe(4);
    expect(b.slice(lineStartOffset(b, 2))).toBe('');
  });

  it('🔴 送りは 1/3 上に置く(折り返しで下へずれても画面に残る)', () => {
    // 行 30 / 行送り 20 / 器 300 → 600 - 100 = 500
    expect(scrollTopForLine(30, 20, 300)).toBe(500);
    // ⚠ **上へは行き過ぎない**(負にしない)
    expect(scrollTopForLine(1, 20, 300)).toBe(0);
    // ⚠ 行送りが読めない(`normal`)ときは動かさない ── 当てずっぽうで飛ばさない
    expect(scrollTopForLine(30, Number.NaN, 300)).toBe(0);
    expect(scrollTopForLine(30, 0, 300)).toBe(0);
  });
});
