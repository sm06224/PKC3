/**
 * 🔴 **添付した `.xlsx` を、SQL で調べられるようにする**(#854 段③)。
 *
 * ⚠ `csv-attachment.test.ts` と**同じ形で揃える**(選び所も出口も共通なので、
 *   片方だけ違う規則にすると、呼び側が 2 通りの扱いを持つことになる)。
 * ⚠ ここだけ csv と違うのは **1 file が表 1 つとは限らない**ところ ──
 *   枚(シート)ごとに `sheet1` / `sheet2` … を作り、**本当の名前は `_sheet` の列**に置く。
 */
import { describe, expect, it } from 'vitest';
import {
  buildXlsxAttachmentTable,
  looksLikeXlsxAttachmentName,
  XLSX_SOURCE_COLUMNS,
  xlsxAttachmentSourcesOf,
  xlsxTableName,
} from '../../src/features/query/xlsx-attachment';
import type { XlsxCell } from '../../src/features/query/xlsx-sheet';

const att = (lid: string, title: string) => ({ lid, title, archetype: 'attachment' });
const note = { lid: 'n1', title: '売上.xlsx' };
const sheet = { index: 0, name: '売上' };

describe('それらしい拡張子か', () => {
  it('.xlsx を拾う(大文字でも、前後の空白が在っても)', () => {
    expect(looksLikeXlsxAttachmentName('a.xlsx')).toBe(true);
    expect(looksLikeXlsxAttachmentName('A.XLSX')).toBe(true);
    expect(looksLikeXlsxAttachmentName(' 売上.xlsx ')).toBe(true);
  });

  it('🔴 `.xls`(古い形式)は受けない ── 中身が zip ではないので、この読み手では開けない', () => {
    // ⚠ 受けてしまうと「選べるのに必ず断られる口」になる(無言の dead click と同じ害)
    expect(looksLikeXlsxAttachmentName('売上.xls')).toBe(false);
    expect(looksLikeXlsxAttachmentName('売上.XLS')).toBe(false);
  });

  it('⚠ それ以外も拾わない(.csv / .sqlite / 写真 / 拡張子無し / 途中に在るだけ)', () => {
    for (const n of ['a.csv', 'a.sqlite', 'a.png', 'a.xlsx.txt', 'xlsx', '']) {
      expect(looksLikeXlsxAttachmentName(n), `拾ってはいけない名前: ${n}`).toBe(false);
    }
  });
});

describe('選べる相手を拾う', () => {
  it('🔴 添付で、かつ .xlsx のものだけ', () => {
    const got = xlsxAttachmentSourcesOf([
      att('a', '売上.xlsx'),
      att('b', '客.csv'),
      att('c', '会員.sqlite'),
      att('d', '古い台帳.xls'),
      // ⚠ **添付でないノート**は、題名が .xlsx でも並ばない(中身が bytes ではない)
      { lid: 'e', title: 'メモ.xlsx', archetype: 'text' },
    ]);
    expect(got).toEqual([{ lid: 'a', name: '売上.xlsx' }]);
  });

  it('⚠ 並びは題名順(入れ直すたびに場所が変わらない)', () => {
    const got = xlsxAttachmentSourcesOf([
      att('a', 'ん.xlsx'),
      att('b', 'あ.xlsx'),
      att('c', 'k.xlsx'),
    ]);
    expect(got.map((s) => s.name)).toEqual(['k.xlsx', 'あ.xlsx', 'ん.xlsx']);
  });

  it('⚠ 空振り防止 ── 1 つも無ければ空、1 つ在れば拾う(両方向)', () => {
    expect(xlsxAttachmentSourcesOf([att('a', 'ねこ.png')])).toEqual([]);
    expect(xlsxAttachmentSourcesOf([att('a', 'ねこ.png'), att('b', '売上.xlsx')])).toEqual([
      { lid: 'b', name: '売上.xlsx' },
    ]);
  });
});

describe('表の名前は何枚目かで決める', () => {
  it('🔴 1 始まりで数える(枚の名前は使わない ── 打てない名前ができる)', () => {
    expect(xlsxTableName(0)).toBe('sheet1');
    expect(xlsxTableName(1)).toBe('sheet2');
    expect(xlsxTableName(11)).toBe('sheet12');
  });
});

describe('枚 1 つを表にする', () => {
  const grid = (rows: string[][]): XlsxCell[][] => rows;

  it('🔴 1 行目が見出し、どこから来たか分かる列が 3 つ付く(`_sheet` を含む)', () => {
    const t = buildXlsxAttachmentTable(
      grid([
        ['品', '個数'],
        ['りんご', '3'],
        ['みかん', '5'],
      ]),
      sheet,
      note,
    );
    expect(t).not.toBeNull();
    expect(t!.name).toBe('sheet1');
    expect(t!.columns).toEqual(['_note', '_lid', '_sheet', '品', '個数']);
    expect(t!.rows).toEqual([
      ['売上.xlsx', 'n1', '売上', 'りんご', '3'],
      ['売上.xlsx', 'n1', '売上', 'みかん', '5'],
    ]);
    expect(t!.truncated).toBe(false);
  });

  it('🔴 `_sheet` には**本当の枚の名前**が入る(`WHERE _sheet = ...` が書ける)', () => {
    const t = buildXlsxAttachmentTable(grid([['a'], ['1']]), { index: 2, name: '第 3 四半期' }, note);
    expect(t!.name, '表の名前は何枚目かで決まる').toBe('sheet3');
    expect(t!.rows).toEqual([['売上.xlsx', 'n1', '第 3 四半期', '1']]);
  });

  it('🔴 見出しが `_sheet` でも、先に取られている列とぶつからない(名前を変える)', () => {
    // ⚠ 先取りする列を**全部**渡しているから起きる ── `_note` / `_lid` だけ渡すと、
    //   同じ名前の列が 2 つ並んで **どちらが本物か分からない表**ができる
    const t = buildXlsxAttachmentTable(
      grid([
        ['_sheet', '_note', '_lid'],
        ['x', 'y', 'z'],
      ]),
      sheet,
      note,
    );
    expect(t!.columns).toEqual(['_note', '_lid', '_sheet', '_sheet_2', '_note_2', '_lid_2']);
    expect(t!.rows).toEqual([['売上.xlsx', 'n1', '売上', 'x', 'y', 'z']]);
  });

  it('⚠ 見出しより短い行は、足りない升を null にする(空の升と同じ扱い)', () => {
    const t = buildXlsxAttachmentTable(grid([['a', 'b', 'c'], ['1', '2']]), sheet, note);
    expect(t!.rows).toEqual([['売上.xlsx', 'n1', '売上', '1', '2', null]]);
  });

  it('⚠ 見出しより長い行は、名前の無い列を作らずに捨てる', () => {
    const t = buildXlsxAttachmentTable(
      grid([
        ['a', 'b'],
        ['1', '2', '3'],
      ]),
      sheet,
      note,
    );
    expect(t!.columns).toEqual(['_note', '_lid', '_sheet', 'a', 'b']);
    expect(t!.rows).toEqual([['売上.xlsx', 'n1', '売上', '1', '2']]);
  });

  it('⚠ 見出しの升が空なら、`col1` … の名前を振る(名前の無い列を作らない)', () => {
    const t = buildXlsxAttachmentTable([['品', null], ['りんご', '3']], sheet, note);
    expect(t!.columns).toEqual(['_note', '_lid', '_sheet', '品', 'col2']);
  });

  it('🔴 見出し行だけ(データ行 0 件)は、壊れているのではなく空の表', () => {
    const t = buildXlsxAttachmentTable(grid([['a', 'b']]), sheet, note);
    expect(t).not.toBeNull();
    expect(t!.rows).toEqual([]);
    expect(t!.truncated).toBe(false);
  });

  it('🔴 空の枚は null(呼び側が飛ばす ── 列 0 の表は engine が作れない)', () => {
    expect(buildXlsxAttachmentTable([], sheet, note)).toBeNull();
    expect(buildXlsxAttachmentTable([[]], sheet, note)).toBeNull();
  });

  describe('上限で打ち切る', () => {
    // ⚠ 列は 5 つ(_note, _lid, _sheet, a, b)── budget を桁で調整して境界を作る
    const body = (rows: number): XlsxCell[][] => [
      ['a', 'b'],
      ...Array.from({ length: rows }, (_, i): XlsxCell[] => [String(i), String(i)]),
    ];

    it('🔴 升の総数(行 × 列)を超えたら、行を切って truncated を立てる', () => {
      // 列 5、budget 25 → 5 行までが上限
      const t = buildXlsxAttachmentTable(body(10), sheet, note, 25);
      expect(t!.truncated, '打ち切ったのに立っていない').toBe(true);
      expect(t!.rows.length, '切った行数が上限どおりでない').toBe(5);
      // ⚠ 空振り防止 ── 残したのは本当に先頭からである(末尾を残したのではない)
      expect(t!.rows[0]).toEqual(['売上.xlsx', 'n1', '売上', '0', '0']);
      expect(t!.rows[4]).toEqual(['売上.xlsx', 'n1', '売上', '4', '4']);
    });

    it('⚠ 対照群 ── ちょうど収まる件数では切らない', () => {
      const t = buildXlsxAttachmentTable(body(5), sheet, note, 25);
      expect(t!.truncated, '境界ぴったりなのに切ったことにしている').toBe(false);
      expect(t!.rows.length).toBe(5);
    });

    it('⚠ 既定の上限は、小さい枚では効かない(対照群)', () => {
      const t = buildXlsxAttachmentTable(body(5), sheet, note);
      expect(t!.truncated, '小さい枚まで切っている').toBe(false);
      expect(t!.rows.length).toBe(5);
    });

    it('🔴 予算は枚ごとに渡す ── ここで割らない(枚が増えるほど痩せてはいけない)', () => {
      // ⚠ 同じ予算を 2 枚へ渡したら、**2 枚とも**同じ行数まで入る
      const a = buildXlsxAttachmentTable(body(10), { index: 0, name: '甲' }, note, 25);
      const b = buildXlsxAttachmentTable(body(10), { index: 1, name: '乙' }, note, 25);
      expect(a!.rows.length).toBe(5);
      expect(b!.rows.length, '2 枚目だけ痩せている').toBe(5);
    });
  });
});

describe('先に取る列の並び', () => {
  it('🔴 `csv` の 2 つに `_sheet` を足した形(行の頭もこの順)', () => {
    expect(XLSX_SOURCE_COLUMNS).toEqual(['_note', '_lid', '_sheet']);
  });
});
