import { describe, expect, it } from 'vitest';
import {
  countFormulaLike,
  csvEscapeField,
  formulaLikeNote,
  isFormulaLikeValue,
} from '../../src/features/markdown/csv-table';

/** #1163 依頼 134(推薦 B): 値は変えず、式として動きうる値の数を知らせる。 */
describe('式に見える値を数える(依頼 134)', () => {
  it('= / @ / タブ / 改行で始まる字は数える', () => {
    for (const v of ['=SUM(A1)', '@cmd', '\t=1', '\r=1']) expect(isFormulaLikeValue(v)).toBe(true);
  });
  it('+ / - は数でないときだけ数える', () => {
    for (const v of ['-12', '+3', '-0.5', '+3.5e2', '-.5']) expect(isFormulaLikeValue(v)).toBe(false);
    for (const v of ['-2+3', '+cmd|x', '-A1', '- メモ']) expect(isFormulaLikeValue(v)).toBe(true);
  });
  it('ふつうの字・空・数の値・途中の = は数えない', () => {
    for (const v of ['abc', '', 'a=b', ' =1', 12, null, undefined]) expect(isFormulaLikeValue(v)).toBe(false);
  });
  it('表全体の数を返す', () => {
    expect(countFormulaLike([['=1', 'a', '-5'], ['@x', 3, '-x']])).toBe(3);
    expect(countFormulaLike([])).toBe(0);
  });
  it('知らせの文は数を含み、0 なら空', () => {
    expect(formulaLikeNote(0)).toBe('');
    expect(formulaLikeNote(3)).toContain('3 個');
    expect(formulaLikeNote(3)).toContain('値はそのまま');
  });
  it('値そのものは書き換えない(先頭に引用符を足さない)', () => {
    expect(csvEscapeField('=SUM(A1)', ',')).toBe('=SUM(A1)');
    expect(csvEscapeField('@x', ',')).toBe('@x');
  });
});
