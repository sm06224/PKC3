/**
 * 🔴 **本文の csv を SQL から引ける形にする判断**(#681 段③)。
 *
 * ⚠ 実際に engine へ載せる所は `tests/adapter/storage-worker.test.ts` が
 *   **実物の sqlite で**見る。ここが見るのは**判断**である ──
 *   名前を受けるか / 列の名前をどう直すか / 打った字にその名前が出ているか。
 *
 * 🔑 分けている理由:worker の test は 1 件が重い(DB を通す)ので、
 *   総当たりに近い形はこちらへ置く(CLAUDE.md「起動を 1 つ足すと以後すべての回に効く」)。
 */
import { describe, expect, it } from 'vitest';
import {
  collectCsvTables,
  csvColumnNames,
  csvTableNameOf,
  csvTableNameRaw,
  csvTableNameWhy,
  csvTablesMentioned,
  csvCellsOverBudget,
  mergeCsvTables,
  validCsvTableName,
  CSV_TABLE_NAME_MAX,
  CSV_TABLE_CELLS_MAX,
} from '../../src/features/query/csv-tables';

const fence = (info: string, lines: readonly string[]): string =>
  ['```' + info, ...lines, '```', ''].join('\n');

describe('見出しから表の名前を読む', () => {
  it('name= を書いたときだけ名前が返る', () => {
    expect(csvTableNameOf('csv name=売上')).toBe('売上');
    expect(csvTableNameOf('csv noheader name=素')).toBe('素');
    expect(csvTableNameOf('csv')).toBeNull();
    expect(csvTableNameOf('')).toBeNull();
    expect(csvTableNameOf(null)).toBeNull();
  });

  /**
   * 🔴 **1 語目は名前にならない** ── ` ```csv ` の `csv` を名前と読むと、
   *   名前を付けていない囲みが**全部 `csv` という 1 つの表に混ざる**。
   */
  it('🔴 1 語目(csv / tsv / psv)は名前として読まない', () => {
    expect(csvTableNameOf('name=だめ')).toBeNull();
  });

  /**
   * 🔴 **全角の英数字の名前は受けない**(`sql-guard.ts` と噛み合わせる)。
   *
   * ⚠ 打った SQL は走らせる前に全角 → 半角へ直る(`normalizeSqlInput`)ので、
   *   全角で名付けた表は**どう打っても引けない** ── そして出るのは
   *   「そんな表は無い」だけで、理由は画面のどこにも出ない。
   * 🔑 受けなければ目録(`csv_tables`)にも出ないので、user はそこで気づける。
   */
  it('🔴 全角の英数字は名前にしない(打つと半角へ直るので永久に引けない)', () => {
    expect(validCsvTableName('ｓａｌｅｓ')).toBe(false);
    expect(validCsvTableName('ａ')).toBe(false);
    expect(validCsvTableName('１')).toBe(false);
    // ⚠ **対照群** ── 漢字・かなは直されないので受ける
    expect(validCsvTableName('売上')).toBe(true);
    expect(validCsvTableName('うりあげ')).toBe(true);
    expect(validCsvTableName('sales')).toBe(true);
  });

  it('⚠ 使えない字の名前は受けない(SQL に括らずに打てる字だけ)', () => {
    for (const bad of ['売 上', 'a"b', 'a-b', 'a.b', '', 'sqlite_x', 'x'.repeat(CSV_TABLE_NAME_MAX + 1)]) {
      expect(validCsvTableName(bad), `受けてはいけない名前: ${bad}`).toBe(false);
    }
    for (const ok of ['売上', 'sales', 'a_1', '_x', 'x'.repeat(CSV_TABLE_NAME_MAX)]) {
      expect(validCsvTableName(ok), `受けるべき名前: ${ok}`).toBe(true);
    }
    // ⚠ 見出しの語は空白で切れるので、名前に空白は**入りようがない**
    //   (`name=売 上` は `売` という名前と、`上` という知らない旗になる)
    expect(csvTableNameOf('csv name=売 上')).toBe('売');
    for (const bad of ['a"b', 'a-b', '', 'sqlite_x']) {
      expect(csvTableNameOf(`csv name=${bad}`), `受けてはいけない名前: ${bad}`).toBeNull();
    }
  });
});

describe('列の名前を直す', () => {
  /**
   * 🔴 **engine が落ちる形を、user に見せない**(重なった見出し / 空の見出し)。
   * ⚠ そのまま渡すと `duplicate column name` が出るが、それは
   *   **user が打っていない SQL の文句**である。
   */
  it('🔴 重なった見出し・空の見出しでも、打てる列名になる', () => {
    expect(csvColumnNames(['a', 'a', '', ' ', 'a'])).toEqual(['a', 'a_2', 'col3', 'col4', 'a_3']);
  });

  /**
   * 🔴 **出所の列(`_note` / `_lid`)は必ず先頭に足す**ので、本文の見出しが
   *   同じ字でも重ならないようにする ── 重なると engine が
   *   `duplicate column name` で落ち、user が打っていない SQL の文句が出る。
   */
  it('🔴 _note / _lid と同じ見出しでも重ならない', () => {
    expect(csvColumnNames(['_note', '_lid'])).toEqual(['_note_2', '_lid_2']);
  });

  it('⚠ 記号は _ に直し、頭の _ は落とす(打てる字にする)', () => {
    expect(csvColumnNames(['売上(円)', '1月'])).toEqual(['売上_円_', '1月']);
  });
});

describe('本文から拾う', () => {
  const note = { lid: 'l1', title: 'メモ' };

  it('名前つきの囲みだけを拾う', () => {
    const body = fence('csv name=売上', ['品名,数', 'りんご,3']) + fence('csv', ['a,b', '1,2']);
    const got = collectCsvTables(body, note);
    expect(got).toHaveLength(1);
    expect(got[0]?.name).toBe('売上');
    expect(got[0]?.columns).toEqual(['品名', '数']);
    expect(got[0]?.rows).toEqual([['りんご', '3']]);
  });

  it('noheader は col1 / col2 …(見出しを行として食わない)', () => {
    const got = collectCsvTables(fence('csv noheader name=素', ['あ,い', 'う,え']), note);
    expect(got[0]?.columns).toEqual(['col1', 'col2']);
    expect(got[0]?.rows).toEqual([
      ['あ', 'い'],
      ['う', 'え'],
    ]);
  });

  /** ⚠ frontmatter の中の囲みは本文ではない(起点は `fencesBelowFrontmatter` の 1 本)。 */
  it('⚠ frontmatter の下から数える', () => {
    const body = ['---', 'tags: [x]', '---', '', ...fence('csv name=下', ['a', '1']).split('\n')].join('\n');
    expect(collectCsvTables(body, note)[0]?.name).toBe('下');
  });

  it('⚠ 中身が空の囲みは表にしない', () => {
    expect(collectCsvTables(fence('csv name=空', []), note)).toEqual([]);
  });
});

describe('同じ名前を積む', () => {
  it('🔴 後の囲みで上書きしない ── 行が積まれ、出所が付く', () => {
    const a = collectCsvTables(fence('csv name=t', ['x', '1']), { lid: 'l1', title: 'A' });
    const b = collectCsvTables(fence('csv name=t', ['x', '2']), { lid: 'l2', title: 'B' });
    const [t] = mergeCsvTables([...a, ...b]);
    expect(t?.columns).toEqual(['_note', '_lid', 'x']);
    expect(t?.rows).toEqual([
      ['A', 'l1', '1'],
      ['B', 'l2', '2'],
    ]);
    expect(t?.blocks).toBe(2);
  });

  it('⚠ 列が食い違うときは和集合 ── 無い所は null(落とさない)', () => {
    const a = collectCsvTables(fence('csv name=t', ['x', '1']), { lid: 'l1', title: 'A' });
    const b = collectCsvTables(fence('csv name=t', ['y', '2']), { lid: 'l2', title: 'B' });
    const [t] = mergeCsvTables([...a, ...b]);
    expect(t?.columns).toEqual(['_note', '_lid', 'x', 'y']);
    expect(t?.rows).toEqual([
      ['A', 'l1', '1', null],
      ['B', 'l2', null, '2'],
    ]);
  });

  it('名前が違えば別の表になる', () => {
    const a = collectCsvTables(fence('csv name=t1', ['x', '1']), { lid: 'l1', title: 'A' });
    const b = collectCsvTables(fence('csv name=t2', ['x', '2']), { lid: 'l1', title: 'A' });
    expect(mergeCsvTables([...a, ...b]).map((t) => t.name)).toEqual(['t1', 't2']);
  });
});

describe('打った字に名前が出ているか', () => {
  const names = ['売上', 'sales', 't'];

  it('語として出ていれば拾う', () => {
    expect(csvTablesMentioned('SELECT * FROM 売上', names)).toEqual(['売上']);
    expect(csvTablesMentioned('select * from sales s', names)).toEqual(['sales']);
    expect(csvTablesMentioned('SELECT * FROM 売上 JOIN t ON 1', names)).toEqual(['売上', 't']);
  });

  /**
   * 🔴 **語の一部では拾わない** ── 拾うと、打っていない表を毎回組み立てる
   *   (`sales_2026` と書いた人が `sales` の組み立てを買わされる)。
   */
  it('🔴 語の一部では拾わない', () => {
    expect(csvTablesMentioned('SELECT * FROM 売上高', names)).toEqual([]);
    expect(csvTablesMentioned('SELECT * FROM sales_2026', names)).toEqual([]);
    expect(csvTablesMentioned('SELECT * FROM entries', names)).toEqual([]);
  });

  /** ⚠ 引用符や括弧の隣は語の切れ目である(そこを語の続きと読むと拾えなくなる)。 */
  it('⚠ 記号の隣でも拾う', () => {
    expect(csvTablesMentioned('SELECT * FROM "t"', names)).toEqual(['t']);
    expect(csvTablesMentioned('SELECT*FROM(t)', names)).toEqual(['t']);
  });
});

/**
 * 🔴 **重すぎる組み立ては断る**(#681 段③)。
 *
 * ⚠ 組み立ては `PRAGMA query_only` を掛ける**前**に走る ── 見張りはまだ張って
 *   いないので、**ここで断らないと止められない**(worker は DB の lease を
 *   握っているので、固まると保存ごと止まる)。
 */
describe('重すぎる組み立ては断る', () => {
  const table = (name: string, rows: number, cols: number) => ({
    name,
    columns: Array.from({ length: cols }, (_, i) => `c${String(i)}`),
    rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'x')),
    blocks: 1,
  });

  it('収まっていれば通す', () => {
    expect(csvCellsOverBudget([table('t', 10, 10)], 200)).toBeNull();
    // ⚠ **ちょうど**は通す(境で 1 つずれていないこと)
    expect(csvCellsOverBudget([table('t', 10, 20)], 200)).toBeNull();
  });

  it('🔴 超えたら断る ── 名前と上限を言う(切らない)', () => {
    const why = csvCellsOverBudget([table('売上', 11, 20)], 200);
    expect(why).not.toBeNull();
    expect(why, 'どの表かを言っていない').toContain('売上');
    expect(why, '上限を言っていない').toContain('200');
    expect(why, '次の一手を言っていない').toContain('分けて');
  });

  it('⚠ 合わせて超えたときは、超えた所の名前を言う', () => {
    const why = csvCellsOverBudget([table('先', 10, 10), table('後', 10, 11)], 200);
    expect(why).toContain('後');
  });

  it('⚠ 既定の上限が効いている(呼び側が渡し忘れても素通りしない)', () => {
    expect(csvCellsOverBudget([table('t', 1, 1)])).toBeNull();
    expect(csvCellsOverBudget([table('t', CSV_TABLE_CELLS_MAX, 2)])).not.toBeNull();
  });
});

/**
 * 🔴 **受けられない名前は、理由を言う**(#681 段③)。
 *
 * ⚠ 黙って落とすと、user に見えるのは「表が出てこない」だけである ──
 *   これは CLAUDE.md §4 の「いちばん気づけない外し方」そのものなので、
 *   **理由を画面の言葉で持つ**(目録の `why` 列に出る)。
 */
describe('受けられない名前の理由', () => {
  it('受けられる名前は空文字(理由が無い)', () => {
    expect(csvTableNameWhy('売上')).toBe('');
    expect(csvTableNameWhy('sales')).toBe('');
  });

  it('🔴 断る形ごとに、違う理由を言う', () => {
    expect(csvTableNameWhy('')).toContain('空');
    expect(csvTableNameWhy('x'.repeat(CSV_TABLE_NAME_MAX + 1))).toContain('長すぎ');
    expect(csvTableNameWhy('sqlite_x')).toContain('sqlite_');
    expect(csvTableNameWhy('ｓａｌｅｓ')).toContain('全角');
    expect(csvTableNameWhy('売上(2026)')).toContain('記号は使えません');
  });

  /** ⚠ 理由は**次の一手**まで言う(「使えません」で止めない)。 */
  it('⚠ どう直せばよいかまで言う', () => {
    expect(csvTableNameWhy('ｓａｌｅｓ')).toContain('半角');
    expect(csvTableNameWhy('')).toContain('name=');
  });

  /** 🔑 生の字は**受けなくても**読める(目録に出すため)。 */
  it('🔑 生の字は、受けられなくても読める', () => {
    expect(csvTableNameRaw('csv name=売上(2026)')).toBe('売上(2026)');
    expect(csvTableNameOf('csv name=売上(2026)'), '受けてはいけない').toBeNull();
    expect(csvTableNameRaw('csv')).toBeNull();
  });
});
