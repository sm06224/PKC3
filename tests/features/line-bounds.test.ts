import { describe, expect, it } from 'vitest';
import { boxOfRects, currentLineRange } from '../../src/features/markdown/line-bounds';

describe('currentLineRange(#2001 段 4)', () => {
  const v = 'abc\n\nlast one\nend';
  it('論理行の [from, to)。to は行末(\\n を含まない)', () => {
    expect(currentLineRange(v, 0)).toEqual({ from: 0, to: 3 });
    expect(currentLineRange(v, 3)).toEqual({ from: 0, to: 3 }); // 行末の caret は同じ行
    expect(currentLineRange(v, 4)).toEqual({ from: 4, to: 4 }); // 空の行
    expect(currentLineRange(v, 8)).toEqual({ from: 5, to: 13 });
    expect(currentLineRange(v, v.length)).toEqual({ from: 14, to: v.length }); // 最後の行
  });
  it('空の本文・末尾の改行のあと・範囲外の caret', () => {
    expect(currentLineRange('', 0)).toEqual({ from: 0, to: 0 });
    expect(currentLineRange('a\n', 2)).toEqual({ from: 2, to: 2 });
    expect(currentLineRange('a\nb', 99)).toEqual({ from: 2, to: 3 });
    expect(currentLineRange('a\nb', -5)).toEqual({ from: 0, to: 1 });
    // 先頭が空行 ── lineStart の `pos === 0` の罠(from が 1 にならない)
    expect(currentLineRange('\nx', 0)).toEqual({ from: 0, to: 0 });
  });
});

describe('boxOfRects(#2001 段 4)', () => {
  it('折り返した行(複数の矩形)は 1 本の箱: 上端の最小〜下端の最大', () => {
    expect(boxOfRects([{ top: 40, bottom: 56 }, { top: 60, bottom: 76 }, { top: 40, bottom: 56 }])).toEqual({ top: 40, height: 36 });
  });
  it('高さ 0 の矩形は無いものとして扱い、全部そうなら null / 空の集まりも null', () => {
    expect(boxOfRects([{ top: 0, bottom: 0 }, { top: 20, bottom: 36 }])).toEqual({ top: 20, height: 16 });
    expect(boxOfRects([{ top: 5, bottom: 5 }])).toBeNull();
    expect(boxOfRects([])).toBeNull();
  });
});
