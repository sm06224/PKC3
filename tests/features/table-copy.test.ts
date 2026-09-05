/**
 * 🔴 **表を持ち出す形の組み立て**(#708 段①)。
 *
 * 🔑 **期待値は「別の綴り」ではなく「別の観測」から作る**(CLAUDE.md §1)──
 *   組み立てた字を **読み手に読み直させて**、升が 1 つも変わっていないことを見る。
 *   ⚠ 期待する字を手で書くと、実装が間違える形では**期待値も同じように間違える**
 *   (`|` を逃がし忘れたら、手書きの期待値も逃がし忘れている)。
 * ⚠ CSV の読み手は実物(`parseCsv`)を使う ── ここで自前の split を書くと、
 *   **書き手と読み手が同じ盲点を共有する**。
 */
import { describe, expect, it } from 'vitest';
import {
  TABLE_COPY_CHOICES,
  tableToCsv,
  tableToMarkdown,
  tableToTsv,
  type TableCopyRow,
} from '@features/markdown/table-copy';
import { parseCsv } from '@features/markdown/csv-table';

/**
 * ⚠ **升をわざと意地悪にする** ── 素直な升だけだと、逃がしの規則を
 *   消しても全部緑になる(代替物で満たせる検査になる)。
 */
const NASTY: TableCopyRow[] = [
  { cells: ['名前', 'メモ'], head: true },
  // `|` = markdown の列区切り / `,` `"` = CSV の区切りと引用符 / 空の升
  { cells: ['a|b', 'x,y'], head: false },
  { cells: ['", "', ''], head: false },
  /**
   * 🔴 **升の中の改行**(2026-09-05、着地前レビュー A-1)。⚠ 直す前は
   *   この次元が **0 件**だったので、「読む側が改行を空白へ潰していた」ことに
   *   誰も気づけなかった(CLAUDE.md §2「fixture のゼロ件の次元は測っていない次元」)。
   * 🔑 `csv` の囲みは**引用で囲めば升に改行を書ける**ので、これは user が実際に
   *   書ける形である ── 形ごとに扱いが分かれるところを、ここで見る。
   */
  { cells: ['1\n2', 'x'], head: false },
];

describe('tableToTsv', () => {
  /**
   * 🔴 **潰すのはここだけ**(A-1)── TSV は tab で列が、改行で行が割れるので、
   * 升の中の tab / 改行は空白 1 個へ潰す。⚠ CSV / markdown は潰さない(下の 2 つ)。
   */
  it('升を tab、行を改行で繋ぎ、升の中の改行は空白へ潰す(表計算に貼る形)', () => {
    expect(tableToTsv(NASTY)).toBe('名前\tメモ\na|b\tx,y\n", "\t\n1 2\tx');
  });
});

describe('tableToCsv', () => {
  /**
   * 🔴 **書いた CSV を実物の読み手が読み直すと、升が 1 つも変わらない。**
   * ⚠ これが崩れる形が「静かに壊れる」側 ── 貼った先で列がずれる。
   */
  it('🔴 実物の `parseCsv` で読み直すと、升が元どおり', () => {
    const back = parseCsv(tableToCsv(NASTY), ',');
    // 空振り防止 ── 読み手が諦めた(null)回を「一致した」と読まない
    expect(back, '読み手が読めなかった').not.toBeNull();
    expect(back).toEqual(NASTY.map((r) => r.cells));
  });

  /**
   * 🔴 **升の中の改行を、CSV は保つ**(A-1)── `csv` の囲みは引用で囲めば
   * 升に改行を書けるので、保存した `.csv` でそれが消えたら**別のデータ**である。
   * 🔑 観測点は**実物の読み手で読み直した升**(上の往復と同じ作法)。
   */
  it('🔴 升の中の改行を潰さない(引用で包んで往復する)', () => {
    const csv = tableToCsv([{ cells: ['1\n2', 'x'], head: false }]);
    expect(csv, '包まずに改行を出している(読み手が行を割ってしまう)').toBe('"1\n2",x');
    expect(parseCsv(csv, ','), '読み直すと升が変わっている').toEqual([['1\n2', 'x']]);
  });

  it('区切り字・引用符を含む升だけを包む(素の升は太らせない)', () => {
    const line = tableToCsv([{ cells: ['素', 'x,y', '"'], head: false }]);
    expect(line).toBe('素,"x,y",""""');
  });
});

describe('tableToMarkdown', () => {
  /**
   * 🔴 **`|` を逃がす**。逃がさないと列が 1 つ増えて、貼った先の表がずれる。
   * ⚠ 空振り防止 ── 逃がした印(`\|`)が実際に出ていることも見る
   *   (「読み直せた」だけだと、読み手の寛容さに救われうる)。
   */
  it('🔴 升の中の `|` を逃がす', () => {
    const md = tableToMarkdown(NASTY)!;
    expect(md, '`|` が逃がされていない(貼った先で列がずれる)').toContain('a\\|b');
  });

  /**
   * 🔴 **見出しの無い表で、先頭行が消えない。**
   * ⚠ 先頭行を見出しへ格上げすると**データが 1 行消える** ── 消える向きの誤差は作らない。
   */
  it('🔴 見出しの無い表には空の見出しを足す(データ行を食わない)', () => {
    const md = tableToMarkdown([
      { cells: ['1', '2'], head: false },
      { cells: ['3', '4'], head: false },
    ])!;
    const lines = md.split('\n');
    expect(lines[0], '先頭行が見出しへ格上げされた(データが 1 行消える)').toBe('|  |  |');
    expect(lines.slice(2), 'データ行が欠けた').toEqual(['| 1 | 2 |', '| 3 | 4 |']);
  });

  /**
   * 🔴 **GFM の表は改行を持てない**(A-1 の対)── 1 行 1 行なので、升の中に
   * 改行が残ると**そこで行が切れて表が崩れる**。⚠ 潰すのは `gfmCellText` の側で、
   * 読む側(`readTableRows`)ではない ── CSV はそのままでよいので。
   */
  it('🔴 升の中の改行を空白へ潰す(行が切れない)', () => {
    const md = tableToMarkdown([{ cells: ['1\n2', 'x'], head: false }])!;
    const rows = md.split('\n');
    expect(rows, '升の改行で行が増えた(表が崩れる)').toHaveLength(3);
    expect(rows[2]).toBe('| 1 2 | x |');
  });

  it('升が 1 つも無ければ null', () => {
    expect(tableToMarkdown([])).toBeNull();
  });
});

describe('TABLE_COPY_CHOICES', () => {
  /**
   * ⚠ **並べる字の正本がここ 1 つ**であること ── id が重複すると、
   *   選んだ行と実行する形が食い違う(押した物と違う形が入る)。
   */
  it('id が重複していない', () => {
    const ids = TABLE_COPY_CHOICES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('🔴 表計算に貼る形が先頭(いちばん多い用事を一番上に置く)', () => {
    expect(TABLE_COPY_CHOICES[0]?.id).toBe('tsv');
  });
});
