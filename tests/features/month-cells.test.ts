/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { MONTH_CELL_LIMIT, moreLabel, pickCellItems } from '../../src/features/schedule/month-cells';

/**
 * 予定の「月」の 1 日の升 ── 題名 3 件 + 4 件目からは「ほか N 件」(#855。Gemini 裁定 = #1163 の依頼 30 の Q1)。
 */
describe('pickCellItems', () => {
  const items = (n: number): string[] => Array.from({ length: n }, (_, i) => `予定${i + 1}`);

  it('上限は 3 件', () => {
    expect(MONTH_CELL_LIMIT).toBe(3);
  });

  it('0 件・1 件・ちょうど 3 件は「ほか」が出ない(more = 0)', () => {
    for (const n of [0, 1, 3]) {
      const p = pickCellItems(items(n));
      expect(p.shown, `${n} 件`).toEqual(items(n));
      expect(p.more, `${n} 件`).toBe(0);
    }
  });

  it('🔴 4 件目から出さずに数える ── 4 件 = 3 件 + ほか 1 件 / 10 件 = 3 件 + ほか 7 件', () => {
    expect(pickCellItems(items(4))).toEqual({ shown: ['予定1', '予定2', '予定3'], more: 1 });
    const ten = pickCellItems(items(10));
    expect(ten.shown).toEqual(['予定1', '予定2', '予定3']);
    expect(ten.more).toBe(7);
  });

  it('🔴 並びは渡された順のまま(並べ直さない ── 「日」「週」と同じ並びで見える)', () => {
    const p = pickCellItems(['c', 'a', 'b', 'z', 'y']);
    expect(p.shown).toEqual(['c', 'a', 'b']);
    expect(p.more).toBe(2);
  });

  it('上限を渡せる(0 件なら全部「ほか」)', () => {
    expect(pickCellItems(items(2), 0)).toEqual({ shown: [], more: 2 });
    expect(pickCellItems(items(5), 2).more).toBe(3);
  });
});

describe('moreLabel', () => {
  it('「ほか N 件」', () => {
    expect(moreLabel(1)).toBe('ほか 1 件');
    expect(moreLabel(12)).toBe('ほか 12 件');
  });
});
