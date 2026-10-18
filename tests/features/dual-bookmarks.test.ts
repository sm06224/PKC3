/** @vitest-environment node */
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
  placeBookmarkKey,
  placeBookmarkIn,
  placeRefOf,
  bookmarkTargetLid,
  bookmarkRefusal,
  MAX_BOOKMARKS_STORED,
  toggleBookmark,
} from '../../src/features/relation/dual-bookmarks';

describe('留めた場所(#273 残件)', () => {
  it('🔴 同じ口が留めと外しの二役をする', () => {
    const once = toggleBookmark([], 'f1');
    expect(once).toEqual(['f1']);
    expect(isBookmarked(once, 'f1', 'c1')).toBe(true);
    expect(toggleBookmark(once, 'f1'), '2 度押しても外れない').toEqual([]);
  });

  it('⚠ ルート(null)は留まっていないと答える', () => {
    expect(isBookmarked(['f1'], null, 'c1')).toBe(false);
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
    expect(isBookmarked(once, k, 'c1')).toBe(true);
    expect(toggleBookmark(once, k), '2 度押しても外れない').toEqual(['f1']);
    expect(decodeBookmarks(JSON.stringify([k, k]))).toEqual([k]);
  });

  it('🔴 生きている分: 場所(新しい綴り)は消えていても残し、ノートはこのコレクションのいま在るものだけ', () => {
    const list = [
      placeBookmarkKey('c1', 'gone-folder'), // このコレクションの場所 ── 消えていても帯に残す(外せるように)
      noteBookmarkKey('c1', 'alive'),
      noteBookmarkKey('c1', 'gone'),
      noteBookmarkKey('c2', 'alive'), // 別のコレクションの、同じ lid
      'note:alive', // 開発中の綴り
    ];
    const live = liveBookmarks(list, 'c1', (lid) => lid === 'alive');
    expect(live, '開発中の綴りが帯 / 上限に出ている').toEqual([
      placeBookmarkKey('c1', 'gone-folder'),
      noteBookmarkKey('c1', 'alive'),
    ]);
    expect(list, '引数を書き換えた').toHaveLength(5);
    // コレクションが決まっていない間は、ノートも場所も 1 件も出さない
    expect(liveBookmarks(list, null, () => true)).toEqual([]);
  });

  /**
   * 🔴 **場所のブックマークはコレクションごと**(台帳 #1852 N1 / 依頼 328 A)。
   * 直す前は場所の綴りが素の lid で、コレクション A の 20 件が、B を開くと「(消えた場所 …)」の押せないボタンとして並び、B で足せなくなった。
   */
  it('🔴 別のコレクションの場所は、帯にも上限の数にも出ない(20 件ためた A を離れて B を開く)', () => {
    const inA = Array.from({ length: MAX_BOOKMARKS }, (_, i) => placeBookmarkKey('A', `f${String(i)}`));
    expect(liveBookmarks(inA, 'A', () => true), 'A では 20 件とも出る').toHaveLength(MAX_BOOKMARKS);
    const inB = liveBookmarks(inA, 'B', () => false);
    expect(inB, 'B の帯に A の場所が並んでいる').toEqual([]);
    expect(bookmarkRefusal(inA, inB, placeBookmarkKey('B', 'g1')), 'B で足せない(A の分を数えている)').toBeNull();
    expect(bookmarkRefusal(inA, liveBookmarks(inA, 'A', () => true), placeBookmarkKey('A', 'g1')), 'A では満杯').toContain('20 件まで');
  });

  it('🔴 古い綴り(素の lid)はそのまま読める ── いまのコレクションに在るときだけ、そのコレクションの物として出る', () => {
    const legacy = ['f-here', 'f-elsewhere'];
    expect(liveBookmarks(legacy, 'c1', (lid) => lid === 'f-here'), '在る分が読めない').toEqual(['f-here']);
    // 別のコレクションを開いたら出ない(lid はコレクションをまたいで重ならない)
    expect(liveBookmarks(legacy, 'c2', () => false)).toEqual([]);
  });

  it('🔴 留めてあるかと外す相手は、入っている綴りのほう(新しい綴りでも古い綴りでも)', () => {
    const k = placeBookmarkKey('c1', 'f1');
    expect(placeBookmarkIn([k], 'c1', 'f1')).toBe(k);
    expect(placeBookmarkIn(['f1'], 'c1', 'f1'), '古い綴りで入っている物が見つからない').toBe('f1');
    expect(placeBookmarkIn([placeBookmarkKey('c2', 'f1')], 'c1', 'f1'), '別のコレクションの物を自分の物と読んだ').toBeNull();
    expect(placeBookmarkIn([k], null, 'f1'), 'コレクションが決まらないのに新しい綴りを引いた').toBeNull();
    expect(placeBookmarkIn([k], 'c1', null)).toBeNull();
  });

  it('場所の綴りの読み方 / 指す先の lid は 3 つの綴りで 1 本', () => {
    expect(placeRefOf(placeBookmarkKey('c1', 'f1'))).toEqual({ cid: 'c1', lid: 'f1' });
    expect(placeRefOf('f1'), '古い綴りが新しい綴りに化けた').toBeNull();
    expect(placeRefOf('place:/f1'), '空のコレクション id が通った').toBeNull();
    expect(placeRefOf(noteBookmarkKey('c1', 'n1')), 'ノートの綴りが場所に化けた').toBeNull();
    expect(bookmarkTargetLid(placeBookmarkKey('c1', 'f1'))).toBe('f1');
    expect(bookmarkTargetLid(noteBookmarkKey('c1', 'n1'))).toBe('n1');
    expect(bookmarkTargetLid('f1')).toBe('f1');
  });

  it('🔴 保存がいっぱいの断りは、バーに出ていない分も数えていると言う(依頼 97-4 A)', () => {
    const stored = Array.from({ length: MAX_BOOKMARKS_STORED }, (_, i) => noteBookmarkKey('c2', `o${String(i)}`));
    const why = bookmarkRefusal(stored, [], noteBookmarkKey('c1', 'new'));
    expect(why).toContain('バーに出ていない分');
    expect(why, '外す手がかり(ほかのコレクション・消したノート)を言っていない').toContain('ほかのコレクション');
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
