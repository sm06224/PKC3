/**
 * 🔴 **留めた場所**(#273 残件)。
 *
 * 守る主張:
 * 1. **同じ口が二役** ── 留める / 外すを分けない(押し間違いで 2 度並ばない)
 * 2. **上限で断る**(黙って古いものを捨てない ── 「留めたのに無い」を作らない)
 * 3. **どんな壊れ方でも空へ落ちる**(留めが読めないだけで面が死なない)
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_BOOKMARKS,
  decodeBookmarks,
  encodeBookmarks,
  isBookmarked,
  toggleBookmark,
} from '../../src/features/relation/dual-bookmarks';

describe('留めた場所(#273 残件)', () => {
  it('🔴 同じ口が留めと外しの二役をする', () => {
    const once = toggleBookmark([], 'f1');
    expect(once).toEqual(['f1']);
    expect(isBookmarked(once, 'f1')).toBe(true);
    expect(toggleBookmark(once, 'f1'), '2 度押しても外れない').toEqual([]);
  });

  it('⚠ ルート(null)は留まっていないと答える', () => {
    expect(isBookmarked(['f1'], null)).toBe(false);
  });

  /**
   * 🔴 **上限は「断る」で守る** ── 古いほうから捨てると、user から見ると
   * 「留めたはずのものが無い」になる(黙って消える側へ倒れる)。
   */
  it('🔴 上限を超えたら足さない(古いものを黙って捨てない)', () => {
    const full = Array.from({ length: MAX_BOOKMARKS }, (_, i) => `f${String(i)}`);
    const after = toggleBookmark(full, 'new');
    expect(after, '上限を超えて足している').toHaveLength(MAX_BOOKMARKS);
    expect(after, '古いものが捨てられている').toContain('f0');
    expect(after, '断っていない').not.toContain('new');
    // ⚠ 満杯でも**外す**ほうは通る(でないと詰んで動かせない)
    expect(toggleBookmark(full, 'f0'), '満杯だと外せない').not.toContain('f0');
  });

  it('往復しても同じ(保存 → 読み直し)', () => {
    const list = ['a', 'b', 'c'];
    expect(decodeBookmarks(encodeBookmarks(list))).toEqual(list);
  });

  it('🔴 壊れた保存でも空へ落ちる(面を殺さない)', () => {
    for (const raw of ['', 'null', '{}', '[1,2]', 'not json', '[""]'])
      expect(decodeBookmarks(raw), `${raw} で落ちている`).toEqual([]);
    expect(decodeBookmarks(null)).toEqual([]);
    // ⚠ 同じ lid が 2 度書いてあっても 1 度しか出さない(帯に同じ札が 2 枚並ばない)
    expect(decodeBookmarks('["a","a","b"]')).toEqual(['a', 'b']);
    // ⚠ 上限を超えた保存も、読む側で切る
    const many = JSON.stringify(Array.from({ length: MAX_BOOKMARKS + 5 }, (_, i) => `f${String(i)}`));
    expect(decodeBookmarks(many)).toHaveLength(MAX_BOOKMARKS);
  });
});
