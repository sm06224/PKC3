/** @vitest-environment node */
/**
 * 🔴 その場の計算 ── 台帳 #1852 束 I2(Gemini 回答 = 推薦どおり。依頼 78-3・308 / 114-5 / 78-2・114-6)。
 *
 * - 日本語入力の `×` `÷` と、数の間の長音 `ー`(`5ー3` = 5−3)で計算する。**打った字は書き換えず**、答えだけ足す
 * - 桁が多すぎる答えは挿さずに理由を言う
 * - 1 面の編集の行は、その行より上の本文(`above`)も読む
 */
import { describe, expect, it } from 'vitest';
import {
  CALC_TOO_MANY_DIGITS,
  calcAnswerTooLong,
  calcLineAction,
  explainCalcMiss,
  resolveInlineCalc,
} from '../../src/features/markdown/inline-calc';

/** 打った行(末尾が `=`)に Enter を押したとき、本文へ足される字。計算しなければ null。 */
const answer = (text: string, above = ''): string | null => {
  const r = resolveInlineCalc(text, text.length, above);
  return r === null || r.tooManyDigits ? null : String(r.value);
};

describe('× ÷ ー(日本語入力の記号。依頼 78-3・308)', () => {
  it('300×3= は 900、500÷2= は 250(半角・全角の数と＝のどれでも)', () => {
    expect(answer('300×3=')).toBe('900');
    expect(answer('500÷2=')).toBe('250');
    expect(answer('３００×３＝')).toBe('900');
    expect(answer('５００÷２＝')).toBe('250');
    expect(answer('３００　×　３　＝')).toBe('900'); // 全角の空白
  });
  it('言葉が混ざる行でも、式の部分だけを計算する(牛乳 300×3=)', () => {
    expect(answer('牛乳 300×3=')).toBe('900');
    expect(answer('牛乳　３００×３＝')).toBe('900');
  });
  it('数の間の長音は引き算(5ー3= は 2。１０ー４＝ も)', () => {
    expect(answer('5ー3=')).toBe('2');
    expect(answer('１０ー４＝')).toBe('6');
    expect(answer('10 ー 4 =')).toBe('6');
  });
  it('🔴 数の間でない長音は言葉のまま(コーヒー 5ー3= は 5−3 だけ。式の切れ端にしない)', () => {
    expect(answer('コーヒー 5ー3=')).toBe('2');
    // 日本語の直後は今までどおり許す(`結果は3*4=` と同じ向き)── 長音は式に入らず、`3+1` だけを読む
    expect(answer('ー3+1=')).toBe('4');
    expect(answer('コーヒー=')).toBeNull();
  });
  it('🔴 打った字は書き換えない:全角の数は半角へ直すが、× ÷ ー はそのまま(直す範囲に入らない)', () => {
    const t = '３００×３＝';
    expect(resolveInlineCalc(t, t.length)!.halfWidth).toEqual({ from: 0, to: t.length, text: '300×3=' });
    const t2 = '300×3=';
    expect(resolveInlineCalc(t2, t2.length)!.halfWidth).toBeNull();
    const t3 = '５ー３＝';
    expect(resolveInlineCalc(t3, t3.length)!.halfWidth).toEqual({ from: 0, to: 4, text: '5ー3=' });
  });
  it('「計算できませんでした(× は計算に使えません)」は出ない / 0 で割る ÷ は理由を言う', () => {
    expect(explainCalcMiss('300×3=', 6)).toBeNull();
    expect(explainCalcMiss('5÷0=', 4)).toBe('計算できませんでした(0 で割れません)');
  });
  it('単位の付いた式は今までどおり計算しない(100円*3= / 3個×100=)', () => {
    expect(answer('100円*3=')).toBeNull();
    expect(answer('3個×100=')).toBeNull();
  });
  it('日付の引き算は長音でも計算しない(2026ー10ー17=)', () => {
    expect(answer('2026ー10ー17=')).toBeNull();
  });
});

describe('桁が多すぎる答えは挿さない(依頼 114-5)', () => {
  it('17 桁の数の 2 倍・小数の丸め・22 桁を超える答えは tooManyDigits', () => {
    const cases = ['12345678901234567*2=', '100000000.123456*2=', '99999999999999999999999*1=', '10000000000*10000000000*100='];
    for (const c of cases) {
      const r = resolveInlineCalc(c, c.length);
      expect(r, c).not.toBeNull();
      expect(r!.tooManyDigits, c).toBe(true);
    }
  });
  it('対照群:これまで正しく入っていた答えは今までどおり(1/3 → 丸め、0.1+0.2 → 0.3、123456789012345*1)', () => {
    for (const c of ['1/3=', '0.1+0.2=', '123456789012345*1=', '1200*1.1=']) {
      const r = resolveInlineCalc(c, c.length);
      expect(r, c).not.toBeNull();
      expect(r!.tooManyDigits, c).toBe(false);
    }
  });
  it('境目:15 桁の整数は正確、1e15 は不可。小数は 12 桁に収まれば可', () => {
    expect(calcAnswerTooLong(999999999999999, '')).toBe(false);
    expect(calcAnswerTooLong(1e15, '')).toBe(true);
    expect(calcAnswerTooLong(1234567.5, '')).toBe(false);
    expect(calcAnswerTooLong(200000000.246912, '')).toBe(true);
    expect(calcAnswerTooLong(1 / 3, '')).toBe(false);
  });
  it('理由は画面の下に言う(explainCalcMiss / calcLineAction。どちらも同じ字)', () => {
    const t = '100000000.123456*2=';
    expect(explainCalcMiss(t, t.length)).toBe(CALC_TOO_MANY_DIGITS);
    expect(calcLineAction(t, t.length)).toEqual({ kind: 'why', text: CALC_TOO_MANY_DIGITS });
    expect(CALC_TOO_MANY_DIGITS).toBe('桁が多すぎて正しく計算できません');
  });
  it('合計= の合計が大きすぎても挿さない', () => {
    const t = '999999999999999\n999999999999999\n合計=';
    const r = resolveInlineCalc(t, t.length)!;
    expect(r.value).toBe(1999999999999998);
    expect(r.tooManyDigits).toBe(true);
  });
});

describe('1 面の編集の行は、上の本文も読む(依頼 78-2・114-6)', () => {
  const above = '基本単価 = 3200\n\n';
  it('別の段落の 基本単価 を使える(上が無いと何も起きない = 対照群)', () => {
    expect(answer('基本単価*8=')).toBeNull();
    expect(answer('基本単価*8=', above)).toBe('25600');
    expect(answer('基本単価＊８＝', above)).toBe('25600');
  });
  it('合計= は上の塊の末尾の数を足す', () => {
    const up = 'りんご 300\nバナナ 150\n';
    expect(answer('合計=', up)).toBe('450');
    expect(answer('合計=')).toBeNull();
  });
  it('直す位置(halfWidth)は欄の座標で返る(上の長さを引いてある)', () => {
    const t = '基本単価＊８＝';
    const r = resolveInlineCalc(t, t.length, above)!;
    // 名前も式の一部として直す範囲に入る(全角の記号だけが半角になる)。上の 17 字ぶんは引いてある(0 始まり)
    expect(r.halfWidth).toEqual({ from: 0, to: 7, text: '基本単価*8=' });
  });
  it('calcLineAction の挿す位置も欄の座標', () => {
    const t = '基本単価*8';
    expect(calcLineAction(t, t.length, above)).toEqual({ kind: 'insert', at: t.length, text: '=25600' });
  });
});
