/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { foldSpans, hiddenByFolds } from '../../src/features/markdown/heading-fold';

/** `# / ## / 本文` を読みやすく書くための小道具。0 = 見出しでない塊。 */
const L = (s: string): number[] => [...s].map((c) => (c === '.' ? 0 : Number(c)));

describe('見出しで畳む(範囲の計算) #396', () => {
  it('見出しの節は「次の同段以上の見出しの手前」まで', () => {
    //  0:# 1:本文 2:本文 3:# 4:本文
    expect(foldSpans(L('1..1.'))).toEqual([
      { heading: 0, from: 1, to: 3 },
      { heading: 3, from: 4, to: 5 },
    ]);
  });

  /** ⚠ **同じ段でも閉じる** ── `##` の次の `##` は別の節である。 */
  it('同じ段の見出しで閉じる', () => {
    expect(foldSpans(L('2.2.'))).toEqual([
      { heading: 0, from: 1, to: 2 },
      { heading: 2, from: 3, to: 4 },
    ]);
  });

  it('深い見出しは外側の節に入る(範囲が重なる)', () => {
    //  0:# 1:本文 2:## 3:本文
    expect(foldSpans(L('1.2.'))).toEqual([
      { heading: 0, from: 1, to: 4 },
      { heading: 2, from: 3, to: 4 },
    ]);
  });

  /** ⚠ 配下が無い見出しは畳む物が無い ── 器が押す口を出さないで済む。 */
  it('配下が無い見出しは出さない', () => {
    expect(foldSpans(L('11.'))).toEqual([{ heading: 1, from: 2, to: 3 }]);
  });

  it('見出しが 1 つも無ければ空', () => {
    expect(foldSpans(L('...'))).toEqual([]);
  });
});

describe('見出しで畳む(見える / 隠れるの計算) #396', () => {
  it('畳んだ見出しの配下だけ隠れる', () => {
    expect([...hiddenByFolds(L('1..1.'), new Set([0]))].sort()).toEqual([1, 2]);
  });

  /**
   * 🔴 **入れ子で壊れないこと**(この計算が在る理由)。
   * ⚠ 「押したら `hidden` を反転する」形だと、外側を開いた瞬間に
   *   **内側の畳みまで開いてしまう**。
   */
  it('🔴 外側を開いても、内側の畳みは残る', () => {
    const levels = L('1.2..'); // 0:# 1:本文 2:## 3:本文 4:本文
    const both = hiddenByFolds(levels, new Set([0, 2]));
    expect([...both].sort((a, b) => a - b), '外を畳んだら全部隠れる').toEqual([1, 2, 3, 4]);
    const innerOnly = hiddenByFolds(levels, new Set([2]));
    expect(
      [...innerOnly].sort((a, b) => a - b),
      '外を開いたら、内側の配下だけが隠れているはず',
    ).toEqual([3, 4]);
  });

  it('何も畳んでいなければ何も隠れない', () => {
    expect(hiddenByFolds(L('1.2.'), new Set()).size).toBe(0);
  });
});
