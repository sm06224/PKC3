/** 🔴 #2018 1: ログを新しい順に並べる規則(1 件 = 段 1〜2 の見出しから次の段 1〜2 の手前まで)。 */
import { describe, expect, it } from 'vitest';
import { descRank, descRanks, logDepths, logSegments, orderValue, recordStampKey } from '../../src/features/textlog/log-order';

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

describe('recordStampKey / descRanks(見出しの日時で並べる ── #2018 実機)', () => {
  it('見出しの頭の日時を、字で比べられる形にそろえる(秒が無ければ :00)/ 日時でなければ null', () => {
    expect(recordStampKey('2026-11-22 06:18:53 ★')).toBe('2026-11-22 06:18:53');
    expect(recordStampKey('  2026-11-22T06:18 朝')).toBe('2026-11-22 06:18:00');
    expect(recordStampKey('朝の記録')).toBeNull();
    expect(recordStampKey('メモ 2026-11-22 06:18')).toBeNull();
    // 日の行と同じ判定: 実在しない日は日時として扱わない(並びだけ日時ありと読まない)
    expect(recordStampKey('2026-13-45 10:00')).toBeNull();
    expect(recordStampKey('2026-02-30 10:00')).toBeNull();
  });

  it('🔴 同じ日の中も日時の降順(本文の並び 15:25 → 06:18 → 22:47 でも 22:47 → 15:25 → 06:18)', () => {
    expect(descRanks(['2026-11-22 15:25:46', '2026-11-22 06:18:53', '2026-11-22 22:47:20'])).toEqual([2, 3, 1]);
  });

  it('日時の無い記録は直前の日時の記録のすぐ上(本文の後ろが新しい)/ 前に日時が無ければいちばん古い', () => {
    // 1: 日時なし(先頭)/ 2: 10:00 / 3: 日時なし(2 の後ろ)/ 4: 09:00
    expect(descRanks([null, '2026-01-01 10:00:00', null, '2026-01-01 09:00:00'])).toEqual([4, 2, 1, 3]);
  });

  it('同じ日時なら本文の後ろが上 / 日時の無いログは本文の並びを裏返すだけ(descRank と同じ)', () => {
    expect(descRanks(['2026-01-01 10:00:00', '2026-01-01 10:00:00'])).toEqual([2, 1]);
    expect(descRanks([null, null, null])).toEqual([1, 2, 3].map((s) => descRank(s, 3)));
  });
});
