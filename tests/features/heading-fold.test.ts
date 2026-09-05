/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { chapterSpan, foldSpans, hiddenByFolds } from '../../src/features/markdown/heading-fold';

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

/**
 * 🔴 **章の原文の行範囲**(#677。右クリック「この章をコピー」の材料)。
 *
 * ⚠ 終端を「配下の塊の `-end` の最大」で取る実装は、**章末が `:::` の囲み**のとき
 *   中身と閉じを丸ごと落とす(`:::` の刻印は開き行にしか無い)── その形を**対照群**として
 *   必ず持つ。⚠ これが無いと `-end` 方式へ書き換える変異が全部の assert を素通りする。
 */
describe('章の原文の行範囲(chapterSpan) #677', () => {
  it('終端は「次の同段以上の見出しの行 − 1」', () => {
    //  塊: 0:## (行0) 1:p (行2) 2:## (行4) 3:p (行6)
    expect(chapterSpan(L('2.2.'), [0, 2, 4, 6], 0, 8)).toEqual({ start: 0, end: 3 });
  });

  it('🔴 章末が `:::` の囲みでも、閉じの `:::` まで含む(-end の最大では落ちる形)', () => {
    //  行: 0:## 章 / 1: / 2::::note / 3:中 / 4:::: / 5: / 6:## つぎ / 7:中身
    //  塊: 0:h2(行0) 1:section(行2 ── 刻印は開き行だけ) 2:h2(行6) 3:p(行7)
    const span = chapterSpan(L('2.2.'), [0, 2, 6, 7], 0, 8);
    expect(span, '章の範囲が引けない').not.toBeNull();
    // ⚠ `-end` の最大(= 2)で切ると `end: 2` になり、行 3(中)と行 4(閉じ)が落ちる
    expect(span!.end, '閉じの ::: が落ちている(終端を刻印の最大で取っている)').toBe(5);
    expect(span!.start).toBe(0);
  });

  it('末尾の章は本文の末尾まで', () => {
    expect(chapterSpan(L('2.2.'), [0, 2, 4, 6], 2, 9)).toEqual({ start: 4, end: 8 });
  });

  it('深い見出しは章を閉じない(`##` の中の `###` は同じ章)', () => {
    //  塊: 0:## 1:### 2:p 3:##
    expect(chapterSpan(L('23.2'), [0, 2, 4, 6], 0, 8)).toEqual({ start: 0, end: 5 });
    // 対照群: `###` 自身の章は次の `##` まで
    expect(chapterSpan(L('23.2'), [0, 2, 4, 6], 1, 8)).toEqual({ start: 2, end: 5 });
  });

  it('setext 見出し(`===` は -end 側に居る)でも壊れない ── 開き行だけを使う', () => {
    //  行: 0:題 / 1:=== / 2: / 3:中身 / 4: / 5:次 / 6:=== / 7:中身
    expect(chapterSpan(L('1.1.'), [0, 3, 5, 7], 0, 8)).toEqual({ start: 0, end: 4 });
    expect(chapterSpan(L('1.1.'), [0, 3, 5, 7], 2, 8)).toEqual({ start: 5, end: 7 });
  });

  it('見出しでない位置 / 刻印の無い見出しは null(当てずっぽうで写さない)', () => {
    expect(chapterSpan(L('2.2.'), [0, 2, 4, 6], 1, 8)).toBeNull();
    expect(chapterSpan(L('2.2.'), [null, 2, 4, 6], 0, 8)).toBeNull();
    // 次の見出しの刻印が無ければ終端が決まらない ── 短く写すより断る
    expect(chapterSpan(L('2.2.'), [0, 2, null, 6], 0, 8)).toBeNull();
  });

  it('🔴 畳み(foldSpans)と同じ終端を使う ── 畳んだ範囲と写す範囲が食い違わない', () => {
    const levels = L('1.2..1.');
    const lines = [0, 1, 2, 3, 4, 5, 6];
    for (const s of foldSpans(levels)) {
      const c = chapterSpan(levels, lines, s.heading, 7);
      expect(c, `見出し ${s.heading} の章が引けない`).not.toBeNull();
      // 畳む範囲の終端(含まない)の塊の行 − 1 = 章の終端
      const want = s.to < levels.length ? lines[s.to]! - 1 : 6;
      expect(c!.end, `見出し ${s.heading}: 畳みと章の終端が違う`).toBe(want);
    }
  });
});
