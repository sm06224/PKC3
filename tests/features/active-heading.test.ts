import { describe, expect, it } from 'vitest';
import {
  ACTIVE_HEADING_TOLERANCE,
  activeHeadingIndex,
} from '../../src/features/markdown/active-heading';

describe('activeHeadingIndex (#1168)', () => {
  const P = [100, 400, 900, 1500];

  it('見出しが 1 つも無ければ -1', () => {
    expect(activeHeadingIndex([], 0)).toBe(-1);
    expect(activeHeadingIndex([], 9999)).toBe(-1);
  });

  it('最初の見出しの手前では -1(許容も越えない)', () => {
    expect(activeHeadingIndex(P, 0)).toBe(-1);
    expect(activeHeadingIndex(P, 100 - ACTIVE_HEADING_TOLERANCE - 1)).toBe(-1);
  });

  it('ちょうど線の上に居る見出しは「読み始めた」側(許容の境目も)', () => {
    expect(activeHeadingIndex(P, 100)).toBe(0);
    expect(activeHeadingIndex(P, 400)).toBe(1);
    expect(activeHeadingIndex(P, 1500)).toBe(3);
    // 許容ぴったりは入り、1 越えると入らない
    expect(activeHeadingIndex(P, 400 - ACTIVE_HEADING_TOLERANCE)).toBe(1);
    expect(activeHeadingIndex(P, 400 - ACTIVE_HEADING_TOLERANCE - 1)).toBe(0);
  });

  it('見出しの間では、手前の見出し', () => {
    expect(activeHeadingIndex(P, 250)).toBe(0);
    expect(activeHeadingIndex(P, 650)).toBe(1);
    expect(activeHeadingIndex(P, 1200)).toBe(2);
  });

  it('最後の見出しより先では、最後の見出し', () => {
    expect(activeHeadingIndex(P, 99999)).toBe(3);
  });

  it('見出し 1 つ・同じ位置が並んでも最後を返す', () => {
    expect(activeHeadingIndex([50], 50)).toBe(0);
    expect(activeHeadingIndex([50], 10)).toBe(-1);
    expect(activeHeadingIndex([10, 10, 10], 10)).toBe(2);
  });

  it('全探索と一致する(総当たり)', () => {
    const pos = [0, 30, 30, 75, 200, 201, 1000];
    for (let probe = -5; probe <= 1100; probe++) {
      let want = -1;
      pos.forEach((p, i) => {
        if (p <= probe + ACTIVE_HEADING_TOLERANCE) want = i;
      });
      expect(activeHeadingIndex(pos, probe)).toBe(want);
    }
  });
});
