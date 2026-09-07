/**
 * 🔴 **その場で計算**(#764。user 裁定 2026-09-06「PKC2 と同じで」)。
 *
 * ⚠ この test の主役は「計算が合うこと」ではなく、**打っていない字を本文へ
 *   書き込まないこと**である ── PKC2 は**評価器しか test していなかった**ので、
 *   検出器を通すと壊れる 3 件(`1,000=` / `foo+1=` / `{{vars.a}}+1=`)を
 *   出荷したまま気づけなかった(CLAUDE.md §2「経路が一度も通っていない」)。
 *
 * 🔑 だからここでは **`detectInlineCalcRequest` を通した形**で全部見る
 *   ── 評価器だけを呼ぶ test は、この 3 件を原理的に拾えない。
 */
import { describe, expect, it } from 'vitest';
import {
  detectInlineCalcRequest,
  evaluateCalcExpression,
  formatCalcResult,
} from '../../src/features/markdown/inline-calc';

/**
 * user が `…=` まで打って `Enter` を押した形を通し、**本文に足される字**を返す。
 * 発火しなければ `null`(= `Enter` がそのまま通る)。
 */
const typed = (text: string): string | null => {
  const req = detectInlineCalcRequest(text, text.length);
  if (req === null) return null;
  const v = evaluateCalcExpression(req.expression);
  if (v === null) return null;
  return formatCalcResult(v);
};

describe('打った式に答えを足す(#764)', () => {
  it('🔴 PKC2 と同じ答えが出る', () => {
    // ⚠ PKC2(`src/features/math/inline-calc.ts`)の test にあった形をそのまま通す
    expect(typed('2+3=')).toBe('5');
    expect(typed('2+3*4=')).toBe('14');
    expect(typed('(2+3)*4=')).toBe('20');
    expect(typed('50*1.08=')).toBe('54');
    expect(typed('10%3=')).toBe('1'); // ⚠ `%` は剰余(パーセントではない)
    expect(typed('-3+10=')).toBe('7');
  });

  it('🔴 浮動小数のゴミを見せない', () => {
    // ⚠ 素の JS は 0.30000000000000004 を返す ── それを本文へ書き込まない
    expect(typed('0.1+0.2=')).toBe('0.3');
  });

  it('🔴 日本語や語の後ろでも、空白があれば読む', () => {
    expect(typed('Total: 1+2=')).toBe('3');
    expect(typed('結果は 3*4=')).toBe('12');
    // ⚠ 日本語は空白を置かない書き方が普通なので、直後でも読む
    expect(typed('結果は3*4=')).toBe('12');
  });

  it('🔴 箇条書きの印は式に入れない', () => {
    expect(typed('- 1+2=')).toBe('3');
    expect(typed('* 1+2=')).toBe('3');
    expect(typed('1. 2+3=')).toBe('5');
    expect(typed('  - 10/4=')).toBe('2.5');
  });

  it('🔴 前の行は式に入れない', () => {
    expect(typed('買い物メモ\n2+3=')).toBe('5');
    /**
     * 🔴 **前の行が数で終わっている形**(2026-09-07、変異試験 M10 が SURVIVED で教えた)。
     *
     * ⚠ 上の 1 行は**行またぎの門を外しても通る** ── 「モ」が計算に使えない字なので、
     *   走査はどのみちそこで止まる(門は素通りしていた)。
     * 🔑 門でしか止まらないのは、**改行の手前まで全部が計算に使える字**のときである
     *   ── 改行は空白の仲間なので、門が無いと `10\n2+3` を 1 つの式として読み、
     *   読み切れずに**計算そのものが起きなくなる**(打った人には無反応に見える)。
     */
    expect(typed('見積 10\n2+3=')).toBe('5');
  });

  it('⚠ 式でないものでは発火しない(Enter がそのまま通る)', () => {
    expect(typed('foo=')).toBeNull();
    expect(typed('10px=')).toBeNull();
    expect(typed('a =')).toBeNull();
    expect(typed('=')).toBeNull();
    expect(typed('2+3')).toBeNull(); // ⚠ `=` を打っていない
  });

  it('⚠ 0 で割る・0 で余りを取るときは黙って何もしない', () => {
    expect(typed('1/0=')).toBeNull();
    expect(typed('1%0=')).toBeNull();
    /**
     * 🔴 **門が本当に効いている場面**(2026-09-07、変異試験 M6 が SURVIVED で教えた)。
     *
     * ⚠ 上の 2 行は**門を外しても通る** ── `1/0` は `Infinity`、`1%0` は `NaN` で、
     *   どちらも最後の `Number.isFinite` が落とすからである(門は素通りしていた)。
     * 🔑 門でしか止まらないのは、**0 割りの答えを更に使って有限に戻る形**である
     *   ── `1/(1/0)` は `1/Infinity = 0` なので、門が無いと `0` が本文へ入る。
     */
    expect(typed('1/(1/0)=')).toBeNull();
    // ⚠ 対照群 ── 同じ形でも 0 割りでなければ計算する(門が広すぎないこと)
    expect(typed('1/(1/2)=')).toBe('2');
  });

  it('⚠ 括弧が閉じていない式は読まない', () => {
    expect(typed('(1+2=')).toBeNull();
    expect(typed('1+2)=')).toBeNull();
  });
});

describe('🔴 PKC2 が本文を壊していた 3 件(#764 で塞いだ)', () => {
  // 🔑 3 件とも「途中で止まって、切れ端を式として読む」形である。
  //    ⚠ 評価器だけを呼ぶ test では**原理的に拾えない**(切るのは検出器)。

  it('🔴 桁区切りの数を途中で切らない(PKC2 は `1,000=0` と書き込んだ)', () => {
    expect(typed('1,000=')).toBeNull();
    // ⚠ 対照群 ── 門が「数の直後」だけを見ていることを示す
    //    (門を無条件にすると、この行も落ちて動線が 1 つ消える)
    expect(typed('1,000 と 2+3=')).toBe('5');
  });

  it('🔴 語にくっついた切れ端を式にしない(PKC2 は `foo+1=1` と書き込んだ)', () => {
    expect(typed('foo+1=')).toBeNull();
    expect(typed('PATH+1=')).toBeNull();
    // ⚠ 対照群 ── 空白が 1 つあれば、それは切れ端ではない
    expect(typed('foo +1=')).toBe('1');
  });

  it('🔴 差し込みの記法の後ろを式にしない(PKC2 は `{{vars.a}}+1=1` と書き込んだ)', () => {
    expect(typed('{{vars.a}}+1=')).toBeNull();
    expect(typed('${HOME}+1=')).toBeNull();
  });
});

describe('答えの字にする', () => {
  it('整数は小数点を付けない', () => {
    expect(formatCalcResult(5)).toBe('5');
    expect(formatCalcResult(-3)).toBe('-3');
    expect(formatCalcResult(0)).toBe('0');
  });

  it('⚠ 端数は 12 桁で丸める(見せるのは user が読める字である)', () => {
    expect(formatCalcResult(0.1 + 0.2)).toBe('0.3');
    expect(formatCalcResult(1 / 3)).toBe('0.333333333333');
  });
});
