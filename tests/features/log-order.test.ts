/** 🔴 #2018 1: ログを新しい順に並べる規則(1 件 = 段 1〜2 の見出しから次の段 1〜2 の手前まで)。 */
import { describe, expect, it } from 'vitest';
import { descRank, logDepths, logSegments, orderValue } from '../../src/features/textlog/log-order';

describe('logSegments', () => {
  it('🔴 前置き(0)/ 段 1〜2 の見出しごとに 1 件 / 入れ子の ### は親の件に入る', () => {
    // 前置き p, ## a, p, ### a1, p, ## b, p, #### b1, ## c
    const { seg, count } = logSegments([0, 2, 0, 3, 0, 2, 0, 4, 2]);
    expect(seg).toEqual([0, 1, 1, 1, 1, 2, 2, 2, 3]);
    expect(count).toBe(3);
  });
  it('段 1 の見出しも件を切る / 見出しが無ければ全部前置き', () => {
    expect(logSegments([1, 0, 2, 0]).seg).toEqual([1, 1, 2, 2]);
    expect(logSegments([0, 0]).count).toBe(0);
  });
});

describe('descRank / orderValue', () => {
  it('🔴 前置きは 0(先頭)、いちばん後ろの件が 1、最初の件が最後', () => {
    expect([0, 1, 2, 3].map((s) => descRank(s, 3))).toEqual([0, 3, 2, 1]);
  });
  it('件の中の位置は順位をまたがない', () => {
    expect(orderValue(1, 99_999)).toBeLessThan(orderValue(2, 0));
  });
});

describe('logDepths(#2018 8)', () => {
  it('🔴 親の記録は 0、### は 1・#### は 2 …、中身は見出しと同じ深さ、## で 0 に戻る', () => {
    // ## p ### p #### p ## p
    expect(logDepths([2, 0, 3, 0, 4, 0, 2, 0])).toEqual([0, 0, 1, 1, 2, 2, 0, 0]);
  });
  it('###### は 4 / 浅い入れ子へ戻ると深さも戻る', () => {
    expect(logDepths([2, 6, 0, 3, 0])).toEqual([0, 4, 4, 1, 1]);
  });
  it('⚠ 前置き(最初の ## より前)の ### は記録の外なので 0', () => {
    expect(logDepths([3, 0, 2, 0, 3])).toEqual([0, 0, 0, 0, 1]);
  });
});
