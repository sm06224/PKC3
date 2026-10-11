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
  liveBookmarks,
  noteBookmarkKey,
  noteRefOf,
  bookmarkRefusal,
  MAX_BOOKMARKS_STORED,
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
    // ⚠ 上限を超えた保存も、読む側で切る(2026-10-11 #1377: 切る数が 20 → 100。保存の総数の上限に動いた ──
    //   別のコレクションのノートも同じ保存に居るので、帯の 20 件で切ると他の分が消える)
    const many = JSON.stringify(Array.from({ length: MAX_BOOKMARKS_STORED + 5 }, (_, i) => `f${String(i)}`));
    expect(decodeBookmarks(many)).toHaveLength(MAX_BOOKMARKS_STORED);
  });
});

/**
 * 🔴 **ノートも同じ一覧に入る**(#1377)。一覧の形(文字列の配列)は変えず、
 * ノートは `note:` を前に付けた綴りで入る ── 旧い保存(場所だけ)はそのまま読める。
 */
describe('ノートのブックマーク(#1377)', () => {
  it('綴りは往復し、場所・読めない綴りはノートに化けない', () => {
    expect(noteRefOf(noteBookmarkKey('c1', 'n1'))).toEqual({ cid: 'c1', lid: 'n1' });
    // lid 側に `/` があっても最初の `/` で割る
    expect(noteRefOf(noteBookmarkKey('c1', 'a/b'))).toEqual({ cid: 'c1', lid: 'a/b' });
    expect(noteRefOf('f1'), '場所がノートに化けた').toBeNull();
    expect(noteRefOf('note:n1'), '開発中の綴り(コレクションの id 無し)を読んでしまった').toBeNull();
    expect(noteRefOf('note:c1/'), '空の lid が通った').toBeNull();
    expect(noteRefOf('note:/n1'), '空のコレクション id が通った').toBeNull();
  });

  it('🔴 同じ口が二役(足す / 外す)で、同じコレクションの同じノートは 2 度並ばない', () => {
    const k = noteBookmarkKey('c1', 'n1');
    const once = toggleBookmark(['f1'], k);
    expect(once).toEqual(['f1', k]);
    expect(isBookmarked(once, k)).toBe(true);
    expect(toggleBookmark(once, k), '2 度押しても外れない').toEqual(['f1']);
    expect(decodeBookmarks(JSON.stringify([k, k]))).toEqual([k]);
  });

  it('🔴 生きている分: 場所は残し、ノートはこのコレクションのいま在るものだけ', () => {
    const list = [
      'gone-folder',
      noteBookmarkKey('c1', 'alive'),
      noteBookmarkKey('c1', 'gone'),
      noteBookmarkKey('c2', 'alive'), // 別のコレクションの、同じ lid
      'note:alive', // 開発中の綴り
    ];
    const live = liveBookmarks(list, 'c1', (lid) => lid === 'alive');
    expect(live, '開発中の綴りが帯 / 上限に出ている').toEqual(['gone-folder', noteBookmarkKey('c1', 'alive')]);
    expect(list, '引数を書き換えた').toHaveLength(5);
    // コレクションが決まっていない間は、ノートを 1 件も出さない
    expect(liveBookmarks(list, null, () => true)).toEqual(['gone-folder']);
  });

  it('🔴 保存は総数 100 まで読める(帯の 20 件で切らない)', () => {
    const many = JSON.stringify(Array.from({ length: MAX_BOOKMARKS_STORED + 5 }, (_, i) => `f${String(i)}`));
    expect(decodeBookmarks(many)).toHaveLength(MAX_BOOKMARKS_STORED);
    const mid = JSON.stringify(Array.from({ length: MAX_BOOKMARKS + 5 }, (_, i) => `f${String(i)}`));
    expect(decodeBookmarks(mid), '20 件で保存を切っている(別のコレクションの分が消える)').toHaveLength(
      MAX_BOOKMARKS + 5,
    );
  });

  it('🔴 断る理由: 生きている 20 件 → 20 件まで / 保存 100 件 → 保存の上限 / 外すときは通る', () => {
    const k = noteBookmarkKey('c1', 'new');
    const live20 = Array.from({ length: MAX_BOOKMARKS }, (_, i) => `f${String(i)}`);
    expect(bookmarkRefusal(live20, live20, k)).toContain('20 件まで');
    const stored = Array.from({ length: MAX_BOOKMARKS_STORED }, (_, i) => noteBookmarkKey('c2', `o${String(i)}`));
    expect(bookmarkRefusal(stored, [], k)).toContain('100');
    expect(bookmarkRefusal([...live20, k], live20, k), '入っているものを外せない').toBeNull();
    expect(bookmarkRefusal(['f1'], ['f1'], k)).toBeNull();
  });
});
