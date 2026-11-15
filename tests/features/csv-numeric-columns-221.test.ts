/** #1163 依頼 221(user 裁定 2026-11-15 = 原文の中身): SQL で、列の全部が素直な数の列は数として並べる。 */
import { describe, expect, it } from 'vitest';
import { isCanonicalNumber, numericColumns, rowForInsert } from '../../src/features/query/csv-tables';

describe('数の列の判定(依頼 221)', () => {
  it('素直な数だけが数(字へ戻しても同じ字)', () => {
    for (const v of ['0', '9', '100', '-3', '3.5', '-0.25']) expect(isCanonicalNumber(v), v).toBe(true);
    for (const v of ['007', '1.50', '+3', '1e3', '1,200', ' 9', '9 ', '.5', '-0', 'abc', '', '0.30000000000000004', '1234567890123456']) {
      expect(isCanonicalNumber(v), v).toBe(false);
    }
  });

  it('🔴 列の全部が数なら数の列 / 1 つでも 007 や字が混ざれば字の列 / 空の升は数えない', () => {
    const cols = ['金額', '番号', 'メモ', '空'];
    const rows = [
      ['100', '007', 'a', ''],
      ['9', '12', '3', ''],
      ['', '1', 'b', null],
    ];
    expect(numericColumns(cols, rows)).toEqual([true, false, false, false]);
  });

  it('⚠ 出所の列(_note / _lid / _sheet)はいつも字の列', () => {
    expect(numericColumns(['_note', '_lid', '金額'], [['2026', '123', '5']])).toEqual([false, false, true]);
  });

  it('🔴 数の列の空の升は NULL で入れる / 字の列の空はそのまま', () => {
    expect(rowForInsert(['', '5', ''], [true, true, false])).toEqual([null, '5', '']);
  });
});
