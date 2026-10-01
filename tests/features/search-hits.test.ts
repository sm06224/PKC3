/**
 * 🔴 **「探す」で当たった語の、本文の中での位置**(#1102 段①)の規則。
 *
 * 守るもの:
 * ① 語の割り方は「探す」(`parseSearchTerms`)と**同じ 1 本** ── 空白で AND / `"…"` はフレーズ /
 *    `-語` は除外(塗らない)。⚠ 別の割り方をすると、探すで当たった行を開いても塗られない
 * ② 大小は区別しない・**全角と半角は同じ字にしない**(探す自身が引かない字を、ここだけ当たりと数えない)
 * ③ 重なる当たりは 1 つに束ねる / 昇順
 * ④ 送りは**端で回る**(`wrapHitIndex`)
 * ⑤ 運ぶ語は上限で切る(住所に載せるので)
 */
import { describe, expect, it } from 'vitest';
import {
  FIND_QUERY_MAX,
  findHitSpans,
  findTerms,
  foldCase,
  normalizeFindQuery,
  wrapHitIndex,
} from '../../src/features/filter/search-hits';
import { parseSearchTerms } from '../../src/features/filter/search-query';

describe('findTerms: 当たるべき語(探すと同じ割り方)', () => {
  it('🔴 `parseSearchTerms` の include そのもの(除外は含めない・重複は 1 つ)', () => {
    const q = '会議 "来週 の" -中止 会議';
    expect(findTerms(q)).toEqual(['会議', '来週 の']);
    // 割り方の正本は別の 1 本 ── ここで書き直していないこと(include と同じ集合)
    expect(new Set(findTerms(q))).toEqual(new Set(parseSearchTerms(q).include));
  });

  it('除外だけ / 空は 0 語(何も塗らない)', () => {
    expect(findTerms('-中止')).toEqual([]);
    expect(findTerms('   ')).toEqual([]);
  });
});

describe('findHitSpans: 1 つの字の並びの中の位置', () => {
  it('当たりの位置を昇順で返す(UTF-16 の添字)', () => {
    expect(findHitSpans('りんごとみかんとりんご', ['りんご'])).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
  });

  it('🔴 大小は区別しない(探すの抜粋と同じ)', () => {
    expect(findHitSpans('Hello hello HELLO', ['hello'])).toHaveLength(3);
  });

  it('🔴 全角と半角は同じ字にしない(探す自身が引かない)── 対照群は同じ綴りで当たる', () => {
    expect(findHitSpans('ＡＢＣ abc', ['abc'])).toEqual([{ start: 4, end: 7 }]);
    expect(findHitSpans('ＡＢＣ abc', ['ＡＢＣ'])).toEqual([{ start: 0, end: 3 }]);
  });

  it('重なる当たりは 1 つに束ねる(2 語が重なる所を二重に塗らない / 数えない)', () => {
    expect(findHitSpans('りんごジュース', ['りんご', 'んごジ'])).toEqual([{ start: 0, end: 4 }]);
    // 隣り合う(重ならない)ものは別々のまま
    expect(findHitSpans('あいうえ', ['あい', 'うえ'])).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it('語が無い / 本文が空 / 空の語は 0 件(無限に当たらない)', () => {
    expect(findHitSpans('abc', [])).toEqual([]);
    expect(findHitSpans('', ['a'])).toEqual([]);
    expect(findHitSpans('abc', [''])).toEqual([]);
  });

  it('🔴 大小を畳んでも長さが変わらない(添字がずれない)── `İ`(畳むと 2 字になる字)', () => {
    const text = 'İabc';
    expect(foldCase(text).length).toBe(text.length);
    // 先頭の `İ` で添字がずれると、abc の位置が 1 つ後ろへ行く
    expect(findHitSpans(text, ['abc'])).toEqual([{ start: 1, end: 4 }]);
  });
});

describe('wrapHitIndex: 送りは端で回る', () => {
  it('進む / 戻る / 端で回る', () => {
    expect([0, 1, 2, 3, 4].map((s) => wrapHitIndex(s, 4))).toEqual([0, 1, 2, 3, 0]);
    expect([-1, -2, -4, -5].map((s) => wrapHitIndex(s, 4))).toEqual([3, 2, 0, 3]);
  });

  it('当たりが 0 件のときは 0(割り算で落ちない)', () => {
    expect(wrapHitIndex(5, 0)).toBe(0);
    expect(wrapHitIndex(Number.NaN, 3)).toBe(0);
  });
});

describe('normalizeFindQuery: 運ぶ語', () => {
  it('前後の空白を落とす / 空は空', () => {
    expect(normalizeFindQuery('  会議 ')).toBe('会議');
    expect(normalizeFindQuery('   ')).toBe('');
  });

  it('🔴 上限で切る(コードポイントで数える ── 絵文字を半分に割らない)', () => {
    const long = '😀'.repeat(FIND_QUERY_MAX + 50);
    const out = normalizeFindQuery(long);
    expect([...out]).toHaveLength(FIND_QUERY_MAX);
    expect(out).toBe('😀'.repeat(FIND_QUERY_MAX));
  });
});
