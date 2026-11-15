/** #1163 依頼 357(案 A): PKC2 の大きな表の行の高さを、同じ高さが続くところはまとめて書き、前書きの上限に収める。 */
import { describe, expect, it } from 'vitest';
import {
  packRowHeights,
  pkc2SheetRowHeightsDropped,
  spreadsheetFlavor,
  unpackRowHeights,
} from '../../src/features/flavor/spreadsheet-flavor';
import { parseFrontmatter, frontmatterProblem } from '../../src/features/markdown/frontmatter';

const sheet = (rows: number, heights: number[]) =>
  JSON.stringify({
    rows: Array.from({ length: rows }, (_, i) => [`r${String(i)}`, '1']),
    colWidths: [80, 120],
    rowHeights: heights,
  });

describe('行の高さをまとめて書く(依頼 357)', () => {
  it('短い表は今までどおり数の並び', () => {
    expect(packRowHeights([24, 24, 30])).toEqual([24, 24, 30]);
  });

  it('🔴 長い表は「高さ*行数」でまとめ、戻すと元に一致する', () => {
    const h = [...Array(6000).fill(24), 30, ...Array(12).fill(24)] as number[];
    const packed = packRowHeights(h);
    expect(packed).toBe('24*6000 30 24*12');
    expect(unpackRowHeights(packed)).toEqual(h);
    expect(unpackRowHeights('24*2 x')).toBeNull();
  });

  it('🔴 6000 行の表を取り込んでも前書きが読める(列の幅も行の高さも残る)', () => {
    const h = Array(6000).fill(24) as number[];
    const md = spreadsheetFlavor.fromPkc2(sheet(6000, h));
    const { meta } = parseFrontmatter(md);
    expect(meta['sheet.colWidths'], '前書きが読めていない(上限を超えた)').toEqual([80, 120]);
    expect(unpackRowHeights(meta['sheet.rowHeights'])).toEqual(h);
    expect(pkc2SheetRowHeightsDropped(sheet(6000, h))).toBe(false);
  });

  it('🔴 まとめても収まらなければ、行の高さだけ外して他は読める / 外したことを問える', () => {
    // 全部違う高さ(まとめられない)
    const h = Array.from({ length: 8000 }, (_, i) => 20 + (i % 7));
    const md = spreadsheetFlavor.fromPkc2(sheet(8000, h));
    const { meta } = parseFrontmatter(md);
    expect(meta['sheet.colWidths'], '前書きが読めていない').toEqual([80, 120]);
    expect(meta['sheet.rowHeights'], '収まらない行の高さを書いた').toBeUndefined();
    expect(frontmatterProblem(md)?.kind ?? 'ok').not.toBe('unreadable');
    expect(pkc2SheetRowHeightsDropped(sheet(8000, h))).toBe(true);
  });

  it('⚠ 他の項目(グラフの字)が大きすぎる表を、行の高さのせいにしない(着地前レビュー ⚠4)', () => {
    const body = JSON.stringify({
      rows: [['a', '1']],
      rowHeights: Array(600).fill(24),
      charts: [{ id: 'c', title: 'x'.repeat(5000) }],
    });
    expect(pkc2SheetRowHeightsDropped(body)).toBe(false);
  });
});
