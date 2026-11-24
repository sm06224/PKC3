/** #1163 依頼 371(案 A): csv の表に行・列を追加す / 消すと、式の升の名前を自動でずらす。 */
import { describe, expect, it } from 'vitest';
import { shiftFormulaRefs } from '../../src/features/markdown/csv-formula';
import { applyOpened as applyBodyRewrite } from '../helpers/open-line';

describe('shiftFormulaRefs(依頼 371)', () => {
  it('🔴 行を追加すと、足した位置から下を指す名前が 1 つずれる', () => {
    expect(shiftFormulaRefs('=A3+B4', 'row', 2, 1)).toBe('=A4+B5');
    expect(shiftFormulaRefs('=A1+A2', 'row', 2, 1), '上を指す名前は動かない').toBe('=A1+A2');
    expect(shiftFormulaRefs('=SUM(A1:A3)', 'row', 2, 1), '範囲は広がる').toBe('=SUM(A1:A4)');
  });
  it('🔴 列を追加すと、足した位置から右を指す名前がずれる', () => {
    expect(shiftFormulaRefs('=B1*C1', 'col', 1, 1)).toBe('=C1*D1');
    expect(shiftFormulaRefs('=A1', 'col', 1, 1)).toBe('=A1');
  });
  it('🔴 消すと、下・右がつまり、消した升そのものは #REF!', () => {
    expect(shiftFormulaRefs('=A4+A2', 'row', 1, -1)).toBe('=A3+#REF!');
    expect(shiftFormulaRefs('=C1', 'col', 1, -1)).toBe('=B1');
  });
  it('範囲の端が消えたら内側へ縮める / 丸ごと消えたら #REF!', () => {
    expect(shiftFormulaRefs('=SUM(A2:A5)', 'row', 1, -1)).toBe('=SUM(A2:A4)');
    expect(shiftFormulaRefs('=SUM(A1:A2)', 'row', 1, -1)).toBe('=SUM(A1:A1)');
    expect(shiftFormulaRefs('=SUM(B1:B3)', 'col', 1, -1)).toBe('=SUM(#REF!)');
  });
  it('⚠ 字の中("…")・関数の名前・変わらない名前の綴りは触らない', () => {
    expect(shiftFormulaRefs('=IF(A3>0,"A3",a1)', 'row', 1, 1)).toBe('=IF(A4>0,"A3",a1)');
    expect(shiftFormulaRefs('=SUM(a3)', 'row', 0, 1)).toBe('=SUM(A4)');
  });
});

describe('表の行・列の ＋ × で式がずれる(依頼 371)', () => {
  const shape = (body: string, line: number, col: number, what: 'row' | 'col', mode: 'add' | 'remove') =>
    applyBodyRewrite(body, { kind: 'csv-shape', line, openLine: body.split('\n')[line] ?? '', col, what, mode });

  it('🔴 行を追加すと、下の行を指す式が付いてくる(合計は足した行も含む)', () => {
    const body = '```csv\n品,数\na,1\nb,2\n計,=SUM(B2:B3)\n```\n';
    // 2 行目(a)の下に行を追加す
    expect(shape(body, 2, 0, 'row', 'add')).toBe('```csv\n品,数\na,1\n,\nb,2\n計,=SUM(B2:B4)\n```\n');
  });

  it('🔴 列を消すと、右の列を指す式がつまる / 消した列を指す式は #REF!', () => {
    const body = '```csv\na,b,c\n1,2,=A2+C2\n3,4,=B2*2\n```\n';
    expect(shape(body, 1, 1, 'col', 'remove')).toBe('```csv\na,c\n1,=A2+B2\n3,=#REF!*2\n```\n');
  });

  it('⚠ 式の無い表は 1 バイトも変わらない(対照群)', () => {
    const body = '```csv\na,b\n1,2\n```\n';
    expect(shape(body, 2, 0, 'row', 'add')).toBe('```csv\na,b\n1,2\n,\n```\n');
  });

  it('⚠ 升の中に改行がある表は、行の番号と表の行がずれるので式をずらさない(読めない物を当て推量で書き換えない)', () => {
    const body = '```csv\na,b\n"x\ny",1\n2,=B3\n```\n';
    // 見出しの下に行を追加す ── ずらせば `=B3` が `=B4` になってしまう形
    const out = shape(body, 1, 0, 'row', 'add');
    expect(out, '前提: 行は足せる').not.toBeNull();
    // 🔑 全文で見る(`toContain` だと、ずらしても通る)
    expect(out!).toBe('```csv\na,b\n,\n"x\ny",1\n2,=B3\n```\n');
  });

  it('🔴 表の最後に空行があっても、式はずれる(着地前レビュー 🔴1)', () => {
    const body = '```csv\na,1\nb,2\n計,=SUM(B1:B2)\n\n```\n';
    expect(shape(body, 1, 0, 'row', 'add')).toBe('```csv\na,1\n,\nb,2\n計,=SUM(B1:B3)\n\n```\n');
  });
});
