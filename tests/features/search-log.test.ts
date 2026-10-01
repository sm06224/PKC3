/**
 * 🔴 **最近探した語の記録**(#1172)── 規則そのもの。
 *
 * ⚠ 置き場(localStorage)と配線(欄 → 候補)は別の test が見る ── ここは純関数だけ。
 */
import { describe, expect, it } from 'vitest';
import {
  pushSearchTerm,
  SEARCH_HISTORY_MAX,
  SEARCH_TERM_MIN,
} from '../../src/features/history/search-log';

describe('最近探した語(#1172)', () => {
  it('件数の上限は 8、字数の下限は 2', () => {
    // ⚠ 数は裁定(Gemini との合意)── 動かすなら理由を添えて直す
    expect(SEARCH_HISTORY_MAX).toBe(8);
    expect(SEARCH_TERM_MIN).toBe(2);
  });

  it('新しい順に積む', () => {
    expect(pushSearchTerm(pushSearchTerm([], 'あいう'), 'かきく')).toEqual(['かきく', 'あいう']);
  });

  /** ⚠ 同じ語を 2 行にしない ── 候補に同じ字が並ぶ。 */
  it('🔴 同じ語を打ち直すと、行は増えず先頭へ動く', () => {
    const list = ['bbb', 'aaa', 'ccc'];
    expect(pushSearchTerm(list, 'ccc')).toEqual(['ccc', 'bbb', 'aaa']);
  });

  it('前後の空白は落として積む(空白違いで 2 行にしない)', () => {
    expect(pushSearchTerm(['foo'], '  foo  ')).toEqual(['foo']);
    expect(pushSearchTerm([], '  foo  ')).toEqual(['foo']);
  });

  it('🔴 2 字未満は積まない(空・空白・1 字)', () => {
    const list = ['keep'];
    expect(pushSearchTerm(list, '')).toEqual(['keep']);
    expect(pushSearchTerm(list, '   ')).toEqual(['keep']);
    expect(pushSearchTerm(list, 'a')).toEqual(['keep']);
    // ⚠ 境界の内側は積む ── 「2 字」を数え違えていない(日本語は 1 字 = 1 要素)
    expect(pushSearchTerm(list, 'ab')).toEqual(['ab', 'keep']);
    expect(pushSearchTerm(list, '本文')).toEqual(['本文', 'keep']);
  });

  it('🔴 9 件目を積むと、いちばん古い 1 件が落ちる', () => {
    let list: string[] = [];
    for (let i = 1; i <= 9; i++) list = pushSearchTerm(list, `語${i}`);
    expect(list).toHaveLength(8);
    expect(list[0]).toBe('語9');
    expect(list.includes('語1'), '古い語が残っている(上限が効いていない)').toBe(false);
    expect(list.includes('語2')).toBe(true);
  });

  it('元の配列を壊さない', () => {
    const list = Object.freeze(['aa', 'bb']);
    const next = pushSearchTerm(list, 'cc');
    expect(list).toEqual(['aa', 'bb']);
    expect(next).not.toBe(list);
  });
});
