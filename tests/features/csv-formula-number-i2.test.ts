/** @vitest-environment node */
/**
 * 🔴 **表の式が、`1,200` や全角の数字を数として読む**(台帳 #1852 I2 / 依頼 307。Gemini 回答 = 推薦 A)。
 *
 * 直す前は `1,200` / `１２３` の升を `=SUM(...)` が何も言わずに飛ばし(4 升で答えが 0)、`=A1+1` は
 * 「数として読めません: 1,200」と出ていた。`¥` `円` `%` の付いた升は、これまでどおり読まない。
 */
import { describe, expect, it } from 'vitest';
import { cellNumber, evaluateFormula } from '../../src/features/markdown/csv-formula';

describe('cellNumber(升の字を数として読む)', () => {
  it('桁区切りと全角の数字は数', () => {
    expect(cellNumber('1,200')).toBe(1200);
    expect(cellNumber('1,234,567.5')).toBe(1234567.5);
    expect(cellNumber('-1,200')).toBe(-1200);
    expect(cellNumber('１２３')).toBe(123);
    expect(cellNumber('１，２００')).toBe(1200);
    expect(cellNumber('－５')).toBe(-5);
    expect(cellNumber('１．５')).toBe(1.5);
    expect(cellNumber('  42  ')).toBe(42);
    expect(cellNumber('1.0')).toBe(1);
  });
  it('🔑 桁区切りに見えない `,` は数ではない(`1,2` を 12 と読まない)', () => {
    for (const s of ['1,2', '1,20', '12,345,67', ',123', '1,,000', '1,200,']) {
      expect(cellNumber(s), s).toBeNull();
    }
  });
  /**
   * 🔴 **先頭の `¥` は数として読む**(#1163 依頼 222。user 裁定 2026-11-15 で依頼 307 の「読まない」を置き換えた)。
   * ⚠ もとの test は「通貨の読み方は表によって違うので `¥` も読まない」を pin していた ── 後ろに付く単位(`円` `%`)は
   *   その理由が今も当たるので読まないまま。頭に付く `¥` だけを読む(表の並べ替えと同じ読み方)。
   */
  it('🔴 先頭の ¥(全角も)は落として読む / 符号の前後どちらでも', () => {
    expect(cellNumber('¥300')).toBe(300);
    expect(cellNumber('￥1,200')).toBe(1200);
    expect(cellNumber('-¥300')).toBe(-300);
    expect(cellNumber('¥-300')).toBe(-300);
    expect(cellNumber('¥１２３')).toBe(123);
  });
  it('円 % $ の付いた升・途中の ¥・空・語は、これまでどおり読まない', () => {
    for (const s of ['1,200円', '50%', '', '   ', 'あ', '１２３円', '$5', '3¥', '¥', '¥あ']) {
      expect(cellNumber(s), s).toBeNull();
    }
  });
});

describe('式の中の升', () => {
  const row = [['1,200', '１２３', '¥300', '50%', '1,200円']];
  it('🔴 SUM は 1,200 と １２３ と ¥300 を足す(円 % の 2 升は今までどおり飛ばす)', () => {
    expect(evaluateFormula('=SUM(A1:E1)', row).text).toBe('1623');
    expect(evaluateFormula('=COUNT(A1:E1)', row).text).toBe('3');
  });
  it('🔴 =A1+1 は 1201、全角も', () => {
    expect(evaluateFormula('=A1+1', row).text).toBe('1201');
    expect(evaluateFormula('=B1*2', row).text).toBe('246');
  });
  it('🔴 =C1+1 は 301(¥300 を数として読む。依頼 222)', () => {
    expect(evaluateFormula('=C1+1', row).text).toBe('301');
  });
  it('対照群:円 % の升を足すと、これまでどおり「数として読めません」', () => {
    for (const ref of ['D1', 'E1']) {
      const r = evaluateFormula(`=${ref}+1`, row);
      expect(r.text, ref).toBe('#ERR!');
      expect(r.why ?? '', ref).toContain('数として読めません');
    }
  });
  it('比べるときも数で比べる(`1,200 > 999`)', () => {
    expect(evaluateFormula('=IF(A1>999,1,0)', row).text).toBe('1');
  });
  it('全角の数字と半角の桁区切りが混ざっても読める', () => {
    const r = [['1,000', '３,000']];
    // `３,000`:全角の 3 + 半角の `,000` ── 折り返してから桁区切りを見るので 3000
    expect(evaluateFormula('=SUM(A1:B1)', r).text).toBe('4000');
  });
});
