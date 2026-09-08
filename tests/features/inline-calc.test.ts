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
  calcLineAction,
  detectInlineCalcRequest,
  evaluateCalcExpression,
  explainCalcMiss,
  formatCalcResult,
} from '../../src/features/markdown/inline-calc';

/**
 * user が `…=` まで打って `Enter` を押した形を通し、**本文に足される字**を返す。
 * 発火しなければ `null`(= `Enter` がそのまま通る)。
 */
const typed = (text: string, caret = text.length): string | null => {
  const req = detectInlineCalcRequest(text, caret);
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

  /**
   * 🔴 **桁区切りは「読める」ようになった**(2026-09-08、#766 B-2)。
   *
   * ⚠ 2026-09-07 までは `,` で走査が止まり、`1,200+800=` は**何も起きなかった**
   *   ── 日本語で数を書く人の 1 行は `1,200 円` なので、3 回試して 3 回とも無音だと
   *   「この機能は効かない」と思ってやめる(#766 の出どころ)。
   * 🔴 ただし**危険なのは「無音」ではなく「それらしい間違い」**である ──
   *   PKC2 は `1,000=` に `0` を、門の無い実装は `1,200+800=` に **`1000`**
   *   (正しくは 2000)を書き込んでいた。
   * 🔑 だから受けるのは**桁区切りだけ**:数の直後で、3 桁が続き、その先が数でない `,`。
   *   ⚠ それ以外の `,` が 1 つでも残ったら**式ではない**(打った覚えのない答えを出さない)。
   */
  it('🔴 桁区切りは読む / 桁区切りでない `,` は読まない (#766 B-2)', () => {
    // ⚠ 演算子が無いので、これは今までどおり発火しない(`1,000=1000` を作らない)
    expect(typed('1,000=')).toBeNull();
    // 🔑 **本題** ── 区切りの後ろにも式が続く形。門が無いと `200+800` = 1000 になる
    expect(typed('1,200+800=')).toBe('2000');
    expect(typed('1,234,567+1=')).toBe('1234568');
    // 🔴 桁区切りでない `,` は**式ではない**(`12+3` = 15 と読まない)
    expect(typed('1,2+3=')).toBeNull();
    expect(typed('1,23+1=')).toBeNull();
    expect(typed('1,2345+1=')).toBeNull();
    // ⚠ 対照群 ── `,` を跨いだ先の式は、今までどおり読める
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

describe('🔴 語や数を途中で切らない(2026-09-07、着地前の動線レビューが実測)', () => {
  /**
   * ⚠ **1 稿目はここが抜けていた** ── 門①が `[0-9,.]` しか見ておらず、
   *   `md5=` → `md5=5` / `A1+B1=` → `A1+B1=1` を通していた。
   *   🔴 これは この PR が「PKC2 から直した」と書いている `1,000=0` と**同じ型**
   *   である(数だけ見て、語を見ていなかった ── CLAUDE.md §7「片側を直したら、
   *   対称の反対側を必ず疑う」)。
   */
  it('🔴 ASCII の語から切り出した数を式にしない', () => {
    expect(typed('md5=')).toBeNull();
    expect(typed('A1+B1=')).toBeNull();
    expect(typed('Windows10=')).toBeNull();
    expect(typed('v1.2=')).toBeNull();
    expect(typed('1e3+1=')).toBeNull();
    // ⚠ 対照群 ── **日本語の直後は通す**(空白を置かない書き方が普通である)
    expect(typed('結果は3*4=')).toBe('12');
  });

  it('🔴 数を 1 つ書いただけのものは式ではない(`2^3=3` を出さない)', () => {
    // ⚠ `^` で走査が止まるので式が `3` になり、**8 でない答え**が本文へ入っていた
    expect(typed('2^3=')).toBeNull();
    expect(typed('10^2=')).toBeNull();
    // ⚠ 日本語の直後なので門①では止まらない ── 止めるのは「計算する所が無い」門
    expect(typed('第2=')).toBeNull();
    expect(typed('1200=')).toBeNull();
    // ⚠ 対照群 ── 計算する所が 1 つでもあれば通す
    expect(typed('第2+3=')).toBe('5');
  });

  it('🔴 行の終わりでなければ撃たない(答えが 2 つにならない)', () => {
    // ⚠ 既にある `1200*1.1=1320` の `=` の直後で行を割ろうとした形
    const line = '1200*1.1=1320';
    expect(detectInlineCalcRequest(line, line.indexOf('=') + 1)).toBeNull();
    // ⚠ 対照群 ── 次が改行なら行末である(打っている最中は必ずこちら)
    expect(typed('2+3=\nつぎ', 4)).toBe('5');
  });
});

/**
 * 🔴 **全角で打っても計算する**(user 報告 2026-09-07
 * 「全文編集やインライン編集で数式評価が発火していない気がする」)。
 *
 * ⚠ **日本語入力のまま打つと全角になる** ── 実ブラウザで再現した:
 *   `２＋３＝` + `Enter` は**何も起きなかった**。日本語で書く人にとっては
 *   これが**既定の打ち方**なので、「効かない機能」に見える。
 * 🔑 読み替えるのは**読むときだけ** ── 打った式は全角のまま残し、
 *   答えだけ半角で挿す(`２＋３＝5`)。
 */
describe('🔴 全角で打っても計算する(#764、user 報告 2026-09-07)', () => {
  /**
   * 🔴 **打った式ごと半角に直す**(#773。user 裁定 2026-09-07
   * 「**全角入力時は計算式を含めて半角化して欲しい**」)。
   *
   * ⚠ これは 2026-09-07 に配った姿(#766 案 C-2「式は全角のまま」)を**覆す裁定**である。
   * ⚠ 直すのは**式と `＝` だけ** ── 前に書いた文と全角の空白は user の字なので触らない。
   */
  it('🔴 全角で打ったら、式と `＝` を半角へ直す範囲を返す', () => {
    const req = detectInlineCalcRequest('合計\u3000２＋３＝', 7)!;
    expect(req.halfWidth).not.toBeNull();
    // ⚠ 直すのは式の 1 字目から ── `合計` と全角の空白(添字 0〜2)は範囲の外
    expect(req.halfWidth).toEqual({ from: 3, to: 7, text: '2+3=' });
  });

  it('⚠ 半角で打っていたら、直す所は無い', () => {
    expect(detectInlineCalcRequest('合計 2+3=', 7)?.halfWidth).toBeNull();
  });

  it('⚠ 全角と半角が混ざっていたら、混ざった所だけ直る', () => {
    const req = detectInlineCalcRequest('1200*1.1＝', 9)!;
    expect(req.halfWidth).toEqual({ from: 0, to: 9, text: '1200*1.1=' });
  });

  it('🔴 全角と半角は 1 字 → 1 字(直しても後ろの位置が動かない)', () => {
    const req = detectInlineCalcRequest('２＋３＝', 4)!;
    expect(req.halfWidth!.text.length).toBe(req.halfWidth!.to - req.halfWidth!.from);
  });

  it('🔴 計算にならないものは、半角にも直さない', () => {
    // ⚠ 「打った字は 1 文字も変えない」の側 ── 発火しない以上、直す口も出ない
    expect(detectInlineCalcRequest('１，０００＝', 6)).toBeNull();
    expect(detectInlineCalcRequest('１２００＝', 5)).toBeNull();
  });

  it('🔴 全角の式と全角の `＝` で発火する', () => {
    expect(typed('２＋３＝')).toBe('5');
    expect(typed('１２００＊１．１＝')).toBe('1320');
    expect(typed('（２＋３）＊４＝')).toBe('20');
    // ⚠ 全角の空白も区切りとして通る
    expect(typed('合計\u3000２＋３＝')).toBe('5');
    // ⚠ 半角と全角が混ざっても読む(IME を途中で戻した形)
    expect(typed('2+3＝')).toBe('5');
    expect(typed('２＋３=')).toBe('5');
  });

  it('🔴 門は全角でもそのまま効く(打っていない字を書き込まない)', () => {
    // ⚠ 全角を受けたぶん、**同じ門を全角の形でも通す**必要がある
    //    ── 半角だけ塞いで全角に穴を空けたら、直した意味が無い(CLAUDE.md §7)
    expect(typed('１，０００＝')).toBeNull();
    // 🔑 **全角の桁区切りも読む**(#766 B-2)── 半角だけ受けて全角を落とすと、
    //    日本語入力のまま打つ人にだけ効かない機能になる(CLAUDE.md §7)
    expect(typed('１，２００＋８００＝')).toBe('2000');
    expect(typed('１，２＋３＝'), '桁区切りでない全角の `，` を読んでいる').toBeNull();
    expect(typed('ｍｄ５＝')).toBeNull();
    expect(typed('１２００＝')).toBeNull();
  });

  it('🔴 日本語の箇条書きの印 `（１）` を計算しない', () => {
    // ⚠ 全角を受けたときに気づいた ── 括弧を「計算する所」に数えると
    //    `（１）＝` が `（１）＝1` になる(打っていない字が入る)
    expect(typed('（１）＝')).toBeNull();
    expect(typed('(1)=')).toBeNull();
    // ⚠ 対照群 ── 括弧の中に演算子があれば計算する
    expect(typed('（２＋３）＝')).toBe('5');
  });

  it('🔴 全角で打った箇条書きの印も式から外す', () => {
    // ⚠ 日本語入力のまま番号を打つと `１．` になる ── 半角の印だけ外していると、
    //    式が `1.<全角の空白>2+3` になって**読めずに黙る**(変異試験 F6 が SURVIVED で教えた)
    expect(typed('１．\u3000２＋３＝')).toBe('5');
    expect(typed('１． ２＋３＝')).toBe('5');
    expect(typed('－\u3000１＋２＝')).toBe('3');
    expect(typed('- １＋２＝')).toBe('3');
    // ⚠ 対照群 ── 空白が続かなければ印ではなく**小数**である
    expect(typed('１．２＋３＝')).toBe('4.2');
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

/**
 * 🔴 **計算にならなかったときの 1 行**(#766 A-2、2026-09-08)。
 *
 * ⚠ 直す前は**発火したときしか痕跡が無かった** ── user が自分の数字で 3 回試して
 *   3 回とも無音だと「この機能は効かない」と思ってやめる(#766 の出どころ)。
 * 🔑 だから**出す条件を絞る**のが仕事の半分である ── 普通の文で口を出すと、
 *   ただの雑音になって user は帯を読まなくなる。
 */
describe('計算にならなかった理由を 1 行で出す(#766 A-2)', () => {
  /** カーソルは末尾(打ち終わった直後)。 */
  const why = (text: string): string | null => explainCalcMiss(text, text.length);

  it('🔴 数と記号だけの行では、理由が出る', () => {
    expect(why('1,2+3=')).toContain('桁区切り');
    expect(why('2^3=')).toContain('^');
    expect(why('50%=')).toContain('余り');
    expect(why('1200=')).toContain('足し算');
    expect(why('1/0=')).toContain('0 で割れません');
  });

  it('🔴 普通の文では、1 度も出さない', () => {
    // ⚠ 言葉が混ざる行 ── user は計算を頼んでいない
    expect(why('締切=')).toBeNull();
    expect(why('md5=')).toBeNull();
    expect(why('A1+B1=')).toBeNull();
    expect(why('ｍｄ５＝'), '全角の英字を見落としている').toBeNull();
    expect(why('見積もり 3 件=')).toBeNull();
    // ⚠ 数が 1 つも無い行 ── 打ち間違いに口を出さない
    expect(why('(=')).toBeNull();
    expect(why('=')).toBeNull();
  });

  it('🔴 計算できた回は黙る(成功に注釈を付けない)', () => {
    expect(why('2+3=')).toBeNull();
    expect(why('1,200+800='), '桁区切りが読めるのに理由を出している').toBeNull();
    expect(why('（２＋３）＊４＝')).toBeNull();
  });

  it('⚠ 合図が無い / 行の終わりでないときは出さない', () => {
    expect(why('1+2'), '`=` が無いのに出た').toBeNull();
    // ⚠ 行の途中(既にある答えの `=` の直後で改行しようとした形)
    expect(explainCalcMiss('1+2=3', 4), '行の終わりでないのに出た').toBeNull();
  });

  it('⚠ 箇条書きの印は理由の判定から外す', () => {
    // ⚠ 印を外さないと `- ` の `-` が「使えない字」に見えて、別の理由が出る
    expect(why('- 1200=')).toContain('足し算');
    expect(why('1. 2^3=')).toContain('^');
  });

  it('🔴 全角で打っても、同じ理由が出る', () => {
    expect(why('１，２＋３＝')).toContain('桁区切り');
    expect(why('１２００＝')).toContain('足し算');
  });
});

/**
 * 🔴 **「操作を探す」から計算する**(#766 D-2、2026-09-08)。
 *
 * ⚠ 入口が**本文に打つことだけ**だったので、打ち方を忘れた人には**無い機能**だった。
 * 🔑 打っている最中と**同じ規則**を通す ── 別の判定を作ると、`Enter` で計算できる式と
 *   パレットで計算できる式が食い違う(CLAUDE.md §7)。
 */
describe('行を計算する(#766 D-2)', () => {
  /** カーソルは行のどこでもよい ── 行を見るので、末尾に寄せない。 */
  const act = (text: string, caret = text.length) => calcLineAction(text, caret);

  it('🔴 `=` が無い行でも、足して計算する', () => {
    expect(act('2+3')).toEqual({ kind: 'insert', at: 3, text: '=5' });
    // ⚠ カーソルが行の**途中**でも同じ(行を見るので)
    expect(act('2+3', 1)).toEqual({ kind: 'insert', at: 3, text: '=5' });
  });

  it('🔴 `=` が在る行では、答えだけを足す', () => {
    expect(act('2+3=')).toEqual({ kind: 'insert', at: 4, text: '5' });
  });

  it('🔴 複数行でも、いる行だけを見る', () => {
    const text = 'まえ\n2+3\nうしろ';
    // カーソルは 2 行目
    expect(act(text, 5)).toEqual({ kind: 'insert', at: 6, text: '=5' });
  });

  it('🔴 計算にならない行では、理由を返す(打ったときと同じ字)', () => {
    const r = act('2^3');
    expect(r?.kind).toBe('why');
    expect(r?.kind === 'why' ? r.text : '').toContain('^');
  });

  it('⚠ 普通の文の行では、何も言わない', () => {
    expect(act('締切'), '言葉の行に口を出している').toBeNull();
    expect(act('打合せ 9/7 に決めた'), '言葉の行に口を出している').toBeNull();
    expect(act(''), '空の行に口を出している').toBeNull();
    expect(act('   '), '空白だけの行に口を出している').toBeNull();
  });

  it('🔴 全角で打った行も計算する', () => {
    expect(act('２＋３')).toEqual({ kind: 'insert', at: 3, text: '=5' });
  });

  it('🔴 桁区切りも読む(打ったときと同じ規則)', () => {
    expect(act('1,200+800')).toEqual({ kind: 'insert', at: 9, text: '=2000' });
  });
});
