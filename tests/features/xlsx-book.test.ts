/**
 * 🔴 **`.xlsx` の 1 冊を、枚(シート)ごとの表に開く**(#854 段③)。
 *
 * ⚠ ここで見るのは**束ねる側**である ── zip を解く / 格子にする / 表にする は
 *   それぞれ `zip-reader` / `xlsx-sheet` / `xlsx-attachment` の test が見る。
 *   ここが守るのは「**3 つを繋いだとき、枚が 1 つも落ちない**」の 1 点。
 */
import { describe, expect, it } from 'vitest';
import {
  readXlsxBook,
  XLSX_BOOK_CELLS_MAX,
  XLSX_SHEETS_TABLE,
} from '../../src/features/query/xlsx-book';
import { buildXlsx } from './xlsx-fixture';

const note = { lid: 'n1', title: '台帳.xlsx' };

describe('1 冊を開く', () => {
  it('🔴 枚の数だけ表ができる ── 1 枚目だけにしない(黙って消える形を作らない)', async () => {
    const bytes = await buildXlsx([
      { name: '売上', rows: [['品', '額'], ['りんご', '100']] },
      { name: '経費', rows: [['費目', '額'], ['交通', '300']] },
    ]);
    const book = await readXlsxBook(bytes, note);
    // 🔴 枚が 2 つ以上あるので、いちばん前に**目録**が付く(どれが何の枚か読める)
    expect(book.tables.map((t) => t.name), '2 枚目が落ちている').toEqual([
      XLSX_SHEETS_TABLE,
      'sheet1',
      'sheet2',
    ]);
    expect(book.tables[0]!.columns).toEqual(['name', 'sheet', 'rows']);
    expect(book.tables[0]!.rows, '目録が枚の名前を持っていない').toEqual([
      ['sheet1', '売上', '1'],
      ['sheet2', '経費', '1'],
    ]);
    expect(book.tables[1]!.columns).toEqual(['_note', '_lid', '_sheet', '品', '額']);
    expect(book.tables[1]!.rows).toEqual([['台帳.xlsx', 'n1', '売上', 'りんご', '100']]);
    expect(book.tables[2]!.rows).toEqual([['台帳.xlsx', 'n1', '経費', '交通', '300']]);
    expect(book.truncated).toBe(false);
  });

  it('🔴 行が 0 件の枚も、目録に名前が載る(名前の無い行を作らない)', async () => {
    // ⚠ 表の `_sheet` 列から名前を採り直すと、行が 0 件の枚は**空**になる
    const bytes = await buildXlsx([
      { name: '見出しだけ', rows: [['品', '額']] },
      { name: '中身', rows: [['a'], ['1']] },
    ]);
    const book = await readXlsxBook(bytes, note);
    expect(book.tables[0]!.rows, '行が 0 件の枚の名前が落ちている').toEqual([
      ['sheet1', '見出しだけ', '0'],
      ['sheet2', '中身', '1'],
    ]);
  });

  it('🔴 枚が 1 つの本には目録を作らない(打つ前の手数を増やさない)', async () => {
    const bytes = await buildXlsx([{ name: '売上', rows: [['品'], ['りんご']] }]);
    const book = await readXlsxBook(bytes, note);
    expect(book.tables.map((t) => t.name), '見分けるものが無いのに目録を足している').toEqual([
      'sheet1',
    ]);
  });

  it('⚠ 目録は「1 枚」と「2 枚」の境で出る(対照群 ── 2 枚なら必ず出る)', async () => {
    const two = await buildXlsx([
      { name: '甲', rows: [['a'], ['1']] },
      { name: '乙', rows: [['b'], ['2']] },
    ]);
    expect((await readXlsxBook(two, note)).tables[0]!.name).toBe(XLSX_SHEETS_TABLE);
  });

  it('🔴 空の枚を飛ばした結果 1 枚になった本にも、目録は作らない', async () => {
    // ⚠ 数えるのは**目録に載る表**であって、`workbook.xml` の枚の数ではない ──
    //    ここを枚の数で数えると「1 行しかない目録」が出る(見分けるものが無い)
    const bytes = await buildXlsx([
      { name: 'から', rows: [] },
      { name: '中身', rows: [['a'], ['1']] },
    ]);
    expect((await readXlsxBook(bytes, note)).tables.map((t) => t.name)).toEqual(['sheet2']);
  });

  it('🔴 zip の中の file 名ではなく、`workbook.xml` の並びで数える', async () => {
    // ⚠ **わざと逆**にしてある ── file 名から推測すると「売上」に経費が入る
    const bytes = await buildXlsx([
      { name: '売上', rows: [['a'], ['売']], file: 'sheet9.xml' },
      { name: '経費', rows: [['a'], ['経']], file: 'sheet1.xml' },
    ]);
    const book = await readXlsxBook(bytes, note);
    expect(book.tables[1]!.rows[0], 'sheet1 に 1 枚目(売上)が入っていない').toEqual([
      '台帳.xlsx',
      'n1',
      '売上',
      '売',
    ]);
    expect(book.tables[2]!.rows[0]).toEqual(['台帳.xlsx', 'n1', '経費', '経']);
  });

  it('⚠ 空の枚は表にしない(列 0 の表は作れない)── ただし残りは落ちない', async () => {
    const bytes = await buildXlsx([
      { name: 'から', rows: [] },
      { name: '中身', rows: [['a'], ['1']] },
    ]);
    const book = await readXlsxBook(bytes, note);
    expect(book.tables, '空の枚を表にしている、または残りまで落としている').toHaveLength(1);
    // 🔴 **名前は「何枚目か」のまま**(詰めない)── 詰めると画面の枚と番号がずれる
    expect(book.tables[0]!.name, '空の枚を飛ばしたぶん番号を詰めている').toBe('sheet2');
  });

  it('🔴 読めない本は、その場で断る(黙って空を返さない)', async () => {
    const noWb = await buildXlsx([{ name: 'a', rows: [['a']] }], { omit: ['xl/workbook.xml'] });
    await expect(readXlsxBook(noWb, note)).rejects.toThrow(/workbook\.xml/);
    const noRels = await buildXlsx([{ name: 'a', rows: [['a']] }], {
      omit: ['xl/_rels/workbook.xml.rels'],
    });
    await expect(readXlsxBook(noRels, note)).rejects.toThrow(/workbook\.xml\.rels/);
    // ⚠ そもそも zip ではない
    await expect(readXlsxBook(new TextEncoder().encode('ただの字'), note)).rejects.toThrow();
  });

  it('🔴 中身のある枚が 1 つも無ければ断る(「開けました」と言わない)', async () => {
    const bytes = await buildXlsx([{ name: 'から', rows: [] }]);
    await expect(readXlsxBook(bytes, note)).rejects.toThrow(/中身のある枚/);
  });

  it('⚠ 目録に在る枚の中身が無い本でも、残りは読める(1 枚で諦めない)', async () => {
    const bytes = await buildXlsx(
      [
        { name: '欠け', rows: [['a'], ['1']], file: 'gone.xml' },
        { name: '在る', rows: [['b'], ['2']] },
      ],
      { omit: ['xl/worksheets/gone.xml'] },
    );
    const book = await readXlsxBook(bytes, note);
    expect(book.tables.map((t) => t.name)).toEqual(['sheet2']);
    expect(book.truncated, '落とした枚が在るのに黙っている').toBe(true);
  });

  describe('上限', () => {
    const many = (rows: number) => [['a', 'b'], ...Array.from({ length: rows }, () => ['1', '2'])];

    it('🔴 枚の中で切ったら truncated を立てる', async () => {
      const bytes = await buildXlsx([{ name: '大', rows: many(10) }]);
      const book = await readXlsxBook(bytes, note, { perSheet: 25 });
      // 列 5(_note/_lid/_sheet/a/b)、予算 25 → 5 行
      expect(book.tables[0]!.rows).toHaveLength(5);
      expect(book.truncated, '切ったのに黙っている').toBe(true);
    });

    it('🔴 1 冊ぶんの上限に当たったら、そこから先の枚は載せない(黙らない)', async () => {
      const bytes = await buildXlsx([
        { name: '甲', rows: many(4) },
        { name: '乙', rows: many(4) },
        { name: '丙', rows: many(4) },
      ]);
      // 1 枚 = 4 行 × 5 列 = 20 升。冊の予算 25 → 2 枚目を載せた時点で使い切る
      const book = await readXlsxBook(bytes, note, { book: 25 });
      expect(book.tables.map((t) => t.name), '3 枚目まで載せている').toEqual([
        XLSX_SHEETS_TABLE,
        'sheet1',
        'sheet2',
      ]);
      expect(book.truncated).toBe(true);
    });

    it('🔴 冊の上限で「枚ごとの満額」を割らない ── 載せた枚は痩せない', async () => {
      const bytes = await buildXlsx([
        { name: '甲', rows: many(4) },
        { name: '乙', rows: many(4) },
      ]);
      const book = await readXlsxBook(bytes, note, { book: 25 });
      // ⚠ 2 枚目は「残り 5 升」しか無いが、**割らない**ので 4 行そのまま入る
      expect(book.tables[2]!.rows, '残りで割って痩せさせている').toHaveLength(4);
      expect(book.tables[2]!.truncated, '枚の中では切っていないのに切ったことにしている').toBe(
        false,
      );
    });

    it('⚠ 対照群 ── 既定の上限は、小さい本では 1 度も当たらない', async () => {
      const bytes = await buildXlsx([
        { name: '甲', rows: many(3) },
        { name: '乙', rows: many(3) },
      ]);
      const book = await readXlsxBook(bytes, note);
      expect(book.truncated, '小さい本まで切っている').toBe(false);
      expect(book.tables, '目録 + 枚 2 つで 3 つのはず').toHaveLength(3);
      expect(XLSX_BOOK_CELLS_MAX, '冊の上限が枚の上限を下回っている(必ず割ることになる)')
        .toBeGreaterThan(200_000);
    });
  });
});
