/** @vitest-environment node */
/**
 * 🔴 行末の `=` + Enter の計算は、電話番号と URL の形の行では働かない(#1163 依頼 151。Gemini 回答は案どおり)。
 *
 * 直す前は `TEL 03-1234-5678=` が `-6909`、`https://a.example/?a=1+2=` が `3` になっていた。
 * 日付(`2026-10-16=`)は #1087 で止めてあり、コードの中は binder の門(`insideCodeOrMath`)が止める。
 * ⚠ 普通の計算(`2+3=` / `10-3-2=` / `結果は 3*4=`)は 1 つも変えない ── 対照群を同じ表に置く。
 */
import { describe, expect, it } from 'vitest';
import { explainCalcMiss, resolveInlineCalc } from '../../src/features/markdown/inline-calc';

const calc = (v: string): number | null => resolveInlineCalc(v, v.length)?.value ?? null;

describe('計算しない行', () => {
  it.each([
    ['電話番号', 'TEL 03-1234-5678='],
    ['携帯', '090-1234-5678='],
    ['フリーダイヤル', '0120-123-456='],
    ['国番号つき', '+81-3-1234-5678='],
    ['行頭から', '03-1234-5678='],
    ['全角で打った電話番号', '０３－１２３４－５６７８＝'],
    ['URL のクエリ', 'https://a.example/?a=1+2='],
    ['URL のクエリ(複数)', 'https://a.example/?a=1&b=2+3='],
    ['スキームなしの www', 'www.example.com/x-1-2='],
    ['URL の経路の数字', 'http://a.example/10-3-2='],
    ['日付(#1087 で止めてある)', '2026-10-16='],
  ])('%s: %s', (_name, v) => {
    expect(calc(v), v).toBeNull();
  });
});

describe('⚠ 対照群 ── 普通の計算は今までどおり', () => {
  it.each([
    ['2+3=', 5],
    ['10-3-2=', 5],
    ['1-2-3=', -4],
    ['100-50-20=', 30],
    ['結果は 3*4=', 12],
    ['２＋３＝', 5],
    ['- 1+2=', 3],
    // 前の語に URL があっても、空白で区切られた別の式は計算する
    ['https://a.example/ の価格 1200*1.1=', 1320],
    // 先頭が 0 でない 3 つ組は電話番号ではない
    ['123-45-6=', 72],
    // `&` だけでは URL と読まない
    ['R&D=1+2=', 3],
  ])('%s → %s', (v, want) => {
    expect(calc(v), v).toBe(want);
  });
});

describe('理由の 1 行', () => {
  it('電話番号の形だけの行は、理由を言う(黙って改行しない)/ 日付と同じ出し方', () => {
    const v = '03-1234-5678=';
    expect(explainCalcMiss(v, v.length)).toBe('計算できませんでした(電話番号や URL の形は計算しません)');
    const w = '０３－１２３４－５６７８＝';
    expect(explainCalcMiss(w, w.length)).toContain('電話番号');
    // 対照群: 計算できる行には何も言わない / 言葉の混ざる行は黙る
    expect(explainCalcMiss('2+3=', 4)).toBeNull();
    expect(explainCalcMiss('TEL 03-1234-5678=', 17)).toBeNull();
  });
});
