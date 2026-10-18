/** @vitest-environment node */
/**
 * 🔴 **「探す」で当たった語の、本文の中での位置**(#1102 段①)の規則。
 *
 * 守るもの:
 * ① 語の割り方は「探す」(`parseSearchTerms`)と**同じ 1 本** ── 空白で AND / `"…"` はフレーズ /
 *    `-語` は除外(塗らない)。⚠ 別の割り方をすると、探すで当たった行を開いても塗られない
 * ② 大小は区別しない・**全角と半角・半角カナ・濁点の持ち方は同じ字**(台帳 #1852 の束 B2 ── 探す自身がそう引く)
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
  jumpTerms,
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

describe('jumpTerms: 塗る語は、始めた場所の割り方で決まる(#1087)', () => {
  it.each(['-1', '-メモ'])('🔴 欄の起点は、`-` を除外と読まない(打った字のまま): %s', (q) => {
    expect(jumpTerms(q, 'filter')).toEqual([q]);
  });

  it('🔴 欄の起点は、空白(全角も)で区切った語を全部(依頼 194・260・115-1)── 引用符は剥がさない', () => {
    expect(jumpTerms('会議 来週', 'filter')).toEqual(['会議', '来週']);
    expect(jumpTerms('会議　来週', 'filter')).toEqual(['会議', '来週']);
    expect(jumpTerms('"a b"', 'filter')).toEqual(['"a', 'b"']);
  });

  it('欄の起点は前後の空白だけ落とす / 空白だけなら 0 語', () => {
    expect(jumpTerms('  -1  ', 'filter')).toEqual(['-1']);
    expect(jumpTerms('   ', 'filter')).toEqual([]);
  });

  it('🔴 対照群: 「探す」の起点は今までどおり(除外は塗らない・引用符は解く・空白で AND)', () => {
    expect(jumpTerms('-1', 'find')).toEqual([]);
    expect(jumpTerms('"a b"', 'find')).toEqual(['a b']);
    expect(jumpTerms('会議 来週', 'find')).toEqual(['会議', '来週']);
    expect(jumpTerms('会議 -中止', 'find')).toEqual(findTerms('会議 -中止'));
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

  it('🔴 全角と半角は同じ字(台帳 #1852 の束 B2、依頼 258・335)── 位置は書いた字のまま返る', () => {
    expect(findHitSpans('ＡＢＣ abc', ['abc'])).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
    expect(findHitSpans('ＡＢＣ abc', ['ＡＢＣ'])).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
    // 対照群: ひらがなとカタカナは別の字のまま
    expect(findHitSpans('りんご リンゴ', ['りんご'])).toEqual([{ start: 0, end: 3 }]);
  });

  it('🔴 長さが変わる揃え(か+濁点 → が / 半角カナ)でも、位置は書いた字を指す', () => {
    const text = 'xがy ﾊﾝｶｸ';
    // 「か」+「゛」(2 字)を「が」で探す
    expect(findHitSpans(text, ['が'])).toEqual([{ start: 1, end: 3 }]);
    // 半角カナ(濁点つきは 2 字 → 1 字)を全角カナで探す
    expect(findHitSpans('ﾊﾞｯｸ', ['バッ'])).toEqual([{ start: 0, end: 3 }]);
    expect(findHitSpans(text, ['ハンカク'])).toEqual([{ start: 5, end: 9 }]);
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

describe('🔴 #1087: 整形された字(typographer)と打った字の差を吸う', () => {
  it('曲がった引用符は、まっすぐな語で当たる(長さは同じ)', () => {
    expect(findHitSpans('don’t', ["don't"])).toEqual([{ start: 0, end: 5 }]);
    expect(findHitSpans('“hi”', ['"hi"'])).toEqual([{ start: 0, end: 4 }]);
  });

  it.each(['Wait...', 'a -- b', 'a --- b', '(c)', '(r)', '(TM)', '+-'])(
    '打った記号は、置き換えられずに本文に残るので、打ったまま当たる(依頼 254)%s',
    (typed) => {
      expect(findHitSpans(typed, [typed])).toEqual([{ start: 0, end: typed.length }]);
    },
  );

  it.each([
    ['©', '(c)'],
    ['–', '--'],
  ])('置き換えは止めたので、別の記号 %s は打った %s では当たらない', (shown, typed) => {
    expect(findHitSpans(shown, [typed])).toEqual([]);
  });

  it('🔑 「…」は揃えると「...」になる(NFKC)ので、題名の絞りと同じく同じ字として当たる(束 B2)', () => {
    expect(findHitSpans('Wait…', ['Wait...'])).toEqual([{ start: 0, end: 5 }]);
  });

  it('対照群: 整形されない字は 1 件 / 無関係は 0 件', () => {
    expect(findHitSpans('A&B', ['A&B'])).toHaveLength(1);
    expect(findHitSpans('a<b', ['a<b'])).toHaveLength(1);
    expect(findHitSpans('example.com', ['example.com'])).toHaveLength(1);
    expect(findHitSpans('Wait…', ['Hold...'])).toEqual([]);
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
