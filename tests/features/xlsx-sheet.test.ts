/**
 * 🔴 **xlsx の 1 枚を格子にする**(#854 段③)。
 *
 * ⚠ **ここが見るのは「読み違えたら黙って壊れる」所**である ── xlsx は
 *   ①字を升に書かない(共有文字列)②日付かどうかを升に書かない(書式)
 *   ③空の升と空の行を**書かない**、の 3 つで、どれも外すと
 *   **値が別の列・別の行に入る**(落ちずに、静かに)。
 */
import { describe, expect, it } from 'vitest';
import {
  columnIndexOf,
  sheetsOf,
  dateStyleIndexesOf,
  looksLikeDateFormat,
  serialToText,
  sharedStringsOf,
  xlsxSheetGrid,
} from '../../src/features/query/xlsx-sheet';

const NO_DATES: ReadonlySet<number> = new Set<number>();

describe('共有文字列(字は升に入っていない)', () => {
  it('🔴 `<si>` を順番に拾う', () => {
    expect(
      sharedStringsOf(
        '<sst><si><t>名前</t></si><si><t>売上</t></si></sst>',
      ),
    ).toEqual(['名前', '売上']);
  });

  it('🔴 1 つの升が書体で割れていても、繋いで 1 つに戻す', () => {
    // ⚠ 升の中で太字にすると `<r>` に割れる ── 繋がないと**太字の所だけ落ちる**
    expect(
      sharedStringsOf('<sst><si><r><t>前</t></r><r><t>後</t></r></si></sst>'),
    ).toEqual(['前後']);
  });

  it('⚠ 壊れていても表そのものは出す(番号の升が空になるだけ)', () => {
    expect(sharedStringsOf('<<<')).toEqual([]);
  });
});

describe('番地(空の升は書かれない)', () => {
  it('A / B / Z / AA / AB を列番号に直す', () => {
    expect(columnIndexOf('A1')).toBe(0);
    expect(columnIndexOf('B2')).toBe(1);
    expect(columnIndexOf('Z9')).toBe(25);
    expect(columnIndexOf('AA1')).toBe(26);
    expect(columnIndexOf('AB1')).toBe(27);
  });

  it('⚠ 読めない番地は null(当てずっぽうの列に入れない)', () => {
    expect(columnIndexOf('123')).toBeNull();
    expect(columnIndexOf('')).toBeNull();
  });
});

describe('日付の書式(升には連番しか入っていない)', () => {
  it('🔴 組み込みの日付の番号だけを日付と読む', () => {
    // ⚠ 14〜22 と 45〜47 が日付 / 時刻。**23〜44 は数や通貨**
    const xml = (id: number): string =>
      `<styleSheet><cellXfs count="1"><xf numFmtId="${String(id)}"/></cellXfs></styleSheet>`;
    expect(dateStyleIndexesOf(xml(14)).has(0), '14(日付)を落としている').toBe(true);
    expect(dateStyleIndexesOf(xml(22)).has(0)).toBe(true);
    expect(dateStyleIndexesOf(xml(45)).has(0)).toBe(true);
    // 🔴 **対照群** ── ここを範囲(14..47)で書くと金額が日付になる
    expect(dateStyleIndexesOf(xml(38)).has(0), '38(通貨)を日付と読んだ').toBe(false);
    expect(dateStyleIndexesOf(xml(0)).has(0), '0(既定)を日付と読んだ').toBe(false);
  });

  it('🔴 独自の書式は、字を読んで決める', () => {
    const xml = (code: string): string =>
      `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="${code}"/></numFmts>` +
      `<cellXfs count="1"><xf numFmtId="164"/></cellXfs></styleSheet>`;
    expect(dateStyleIndexesOf(xml('yyyy/mm/dd')).has(0)).toBe(true);
    // ⚠ **対照群** ── 桁区切りの数は日付ではない
    expect(dateStyleIndexesOf(xml('#,##0')).has(0), '桁区切りを日付と読んだ').toBe(false);
  });

  it('🔴 色や引用符の中の字を数えない', () => {
    // ⚠ `[Red]` の `d` / `"円"` の中の字で「日付」と読むと、金額が全部日付になる
    expect(looksLikeDateFormat('[Red]#,##0')).toBe(false);
    expect(looksLikeDateFormat('#,##0"円"')).toBe(false);
    // 🔑 対照群 ── 本物の日付は通る
    expect(looksLikeDateFormat('[$-409]yyyy-mm-dd')).toBe(true);
  });

  it('🔴 `cellStyleXfs` と混ぜない(混ぜると番号が丸ごとずれる)', () => {
    // ⚠ 先に `cellStyleXfs` が 3 つ並んでいても、数えるのは `cellXfs` の中だけ
    const xml =
      '<styleSheet>' +
      '<cellStyleXfs count="3"><xf numFmtId="14"/><xf numFmtId="14"/><xf numFmtId="14"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>' +
      '</styleSheet>';
    const got = dateStyleIndexesOf(xml);
    expect([...got], '`cellXfs` の 1 番だけが日付のはず').toEqual([1]);
  });
});

describe('連番 → 日付(1900 年の穴)', () => {
  it('🔴 普通の日付が合う', () => {
    // 🔑 45914 = 2025-09-14(基準 1899-12-30)
    expect(serialToText(45914)).toBe('2025-09-14');
    expect(serialToText(1)).toBe('1900-01-01');
  });

  it('🔴 **存在しない 1900-02-29 の穴**で 1 日ずれない', () => {
    // ⚠ xlsx は連番 60 に「1900-02-29」を持っている(実在しない日)
    //    ── だから 61 以降だけが 1 日ぶん進んでいる
    expect(serialToText(59), '1900-02-28 が合っていない').toBe('1900-02-28');
    expect(serialToText(61), '1900-03-01 が合っていない').toBe('1900-03-01');
  });

  it('時刻を持つ升は、日付の後ろに付ける', () => {
    expect(serialToText(45914.5)).toBe('2025-09-14 12:00');
  });

  it('⚠ 1 日に満たないものは時刻だけ(意味の無い 1899-12-30 を出さない)', () => {
    expect(serialToText(0.5)).toBe('12:00');
  });

  /**
   * 🔴 **割り切れない時刻で 1 分ずれない**(2026-09-14、CI が落ちて直した所)。
   *
   * ⚠ 連番の小数部はほとんど割り切れない ── 17:00 は `0.7083333…` である。
   *   切り捨てると **1019.9999… → 16:59** になり、**1 分早い時刻**が出る。
   */
  it('🔴 割り切れない時刻(17:00 = 0.70833…)が 16:59 にならない', () => {
    expect(serialToText(45914 + 17 / 24)).toBe('2025-09-14 17:00');
    expect(serialToText(45914 + 1 / 3), '08:00(0.3333…)がずれた').toBe('2025-09-14 08:00');
  });

  it('⚠ 日の終わり際でも、日付と時刻が食い違わない', () => {
    // ⚠ 丸めで 1440 分になると `24:00` か「日付そのままで 00:00」になる ──
    //    どちらも嘘なので、その日の終わりに留める
    expect(serialToText(45914 + 86_390 / 86_400)).toBe('2025-09-14 23:59');
  });

  it('⚠ 直せないものは null(呼び側が生の数を出す)', () => {
    expect(serialToText(Number.NaN)).toBeNull();
    expect(serialToText(-1)).toBeNull();
  });
});

describe('シートを格子にする', () => {
  const sheet = (rows: string): string => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;

  it('🔴 共有文字列の番号が、字に戻る', () => {
    const xml = sheet('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>');
    expect(xlsxSheetGrid(xml, ['名前', '売上'], NO_DATES)).toEqual([['名前', '売上']]);
  });

  it('🔴 **飛んだ列**が、空のまま正しい場所に入る', () => {
    // ⚠ ここを番地で読まないと、`C1` の値が **2 列目**に入る(黙って全部ずれる)
    const xml = sheet('<row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row>');
    expect(xlsxSheetGrid(xml, [], NO_DATES)).toEqual([['1', null, '3']]);
  });

  it('🔴 **飛んだ行**が、空行として詰まる', () => {
    // ⚠ 詰めないと「3 行目の値が 2 行目に見える」
    const xml = sheet('<row r="1"><c r="A1"><v>1</v></c></row><row r="3"><c r="A3"><v>3</v></c></row>');
    expect(xlsxSheetGrid(xml, [], NO_DATES)).toEqual([['1'], [null], ['3']]);
  });

  it('🔴 日付の書式が付いた升だけ、日付に直る', () => {
    const xml = sheet('<row r="1"><c r="A1" s="1"><v>45914</v></c><c r="B1" s="0"><v>45914</v></c></row>');
    // ⚠ **対照群が同じ行に在る** ── 同じ数でも、書式が違えば直さない
    expect(xlsxSheetGrid(xml, [], new Set([1]))).toEqual([['2025-09-14', '45914']]);
  });

  it('升の種類ごとに読む場所を変える', () => {
    const xml = sheet(
      '<row r="1">' +
        '<c r="A1" t="inlineStr"><is><t>直書き</t></is></c>' +
        '<c r="B1" t="b"><v>1</v></c>' +
        '<c r="C1" t="e"><v>#DIV/0!</v></c>' +
        '<c r="D1" t="str"><v>式の答え</v></c>' +
        '<c r="E1" s="2"/>' +
        '</row>',
    );
    // ⚠ エラーは**そのまま出す**(隠すと user が気づけない)
    // ⚠ `<v>` の無い升は空(書式だけ付いた升は実在する)
    expect(xlsxSheetGrid(xml, [], NO_DATES)).toEqual([
      ['直書き', 'TRUE', '#DIV/0!', '式の答え', null],
    ]);
  });

  /**
   * 🔴 **`<row>` に `r` が無い file が実在する**(2026-09-14 の変異試験 M9)。
   *
   * ⚠ 直す前の test は**全部 `<row r="1">` のように番号を書いていた**ので、
   *   `Number(...) || fallbackRow` の**右辺が 1 度も評価されていなかった**
   *   (CLAUDE.md「`A || B` を足したら、`B` が false になる場面で見る」)。
   * ⚠ 落ちると `rowNo = 0` になり、**先頭行が丸ごと消える**(手書きや古い道具の
   *   file を開くと、1 行目が無いように見える)。
   */
  it('🔴 `<row>` に番号が無くても、出てきた順に行を振る', () => {
    const xml = sheet('<row><c r="A1"><v>1</v></c></row><row><c r="A2"><v>2</v></c></row>');
    expect(xlsxSheetGrid(xml, [], NO_DATES)).toEqual([['1'], ['2']]);
  });

  /**
   * 🔴 **後の行が狭いときに、先に出た広い行の幅を失わない**(変異試験 M10)。
   *
   * ⚠ 直す前の test は「後の行のほうが狭い」形を 1 つも持っていなかったので、
   *   幅を**覚え続ける**(`Math.max`)ことを誰も見ていなかった。
   * ⚠ 覚えないと、最後に見た行の幅で全部を組み直すので、
   *   **1 行目の `C1` が消える**(落ちずに、静かに)。
   */
  it('🔴 後の行が狭くても、先に出た広い行の幅を保つ', () => {
    const xml = sheet(
      '<row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row>' +
        '<row r="3"><c r="A3"><v>9</v></c></row>',
    );
    expect(xlsxSheetGrid(xml, [], NO_DATES)).toEqual([
      ['1', null, '3'],
      [null, null, null],
      ['9', null, null],
    ]);
  });

  it('⚠ 番号が共有文字列の外なら空(壊れた file で別の字を出さない)', () => {
    const xml = sheet('<row r="1"><c r="A1" t="s"><v>9</v></c></row>');
    expect(xlsxSheetGrid(xml, ['あ'], NO_DATES)).toEqual([[null]]);
  });

  it('⚠ 壊れたシートは空の格子(落とさない)', () => {
    expect(xlsxSheetGrid('<<<', [], NO_DATES)).toEqual([]);
  });
});

/**
 * 🔴 **枚(シート)の並びと名前**(#854 段③)。
 *
 * ⚠ ここを外すと「**『売上』と書いてある表に経費が入る**」という、いちばん質の
 *   悪い間違い方になる ── zip の file 名と画面の順番は**一致しない**。
 */
describe('枚の並びと名前', () => {
  const WB =
    '<workbook><sheets>' +
    '<sheet name="売上" sheetId="1" r:id="rId3"/>' +
    '<sheet name="経費 2026" sheetId="2" r:id="rId1"/>' +
    '</sheets></workbook>';
  const RELS =
    '<Relationships>' +
    '<Relationship Id="rId1" Target="worksheets/sheet2.xml"/>' +
    '<Relationship Id="rId3" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  it('🔴 file 名ではなく、`workbook.xml` の順番で並べる', () => {
    // ⚠ **`rId` の番号順でも file 名順でもない** ── 画面の順番は `<sheet>` の並び
    expect(sheetsOf(WB, RELS)).toEqual([
      { name: '売上', path: 'xl/worksheets/sheet1.xml' },
      { name: '経費 2026', path: 'xl/worksheets/sheet2.xml' },
    ]);
  });

  it('⚠ `Target` が絶対でも同じ所を指す', () => {
    const rels = '<Relationships><Relationship Id="rId3" Target="/xl/worksheets/sheet7.xml"/></Relationships>';
    const wb = '<workbook><sheets><sheet name="A" r:id="rId3"/></sheets></workbook>';
    expect(sheetsOf(wb, rels)).toEqual([{ name: 'A', path: 'xl/worksheets/sheet7.xml' }]);
  });

  it('🔴 結び付かない枚は落とす(推測で並べない)', () => {
    // ⚠ `rId9` はどこにも無い ── ここで file 名から当てずっぽうに繋ぐと、
    //    名前と中身が食い違う(落ちないので誰も気づけない)
    const wb = '<workbook><sheets><sheet name="迷子" r:id="rId9"/></sheets></workbook>';
    expect(sheetsOf(wb, RELS)).toEqual([]);
  });

  it('⚠ 結び付けが壊れていたら空(呼び側が断る)', () => {
    expect(sheetsOf(WB, '<<<')).toEqual([]);
    expect(sheetsOf('<<<', RELS)).toEqual([]);
  });
});
