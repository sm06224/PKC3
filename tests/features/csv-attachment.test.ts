/**
 * 🔴 **添付した CSV / TSV を、SQL で調べられるようにする**(#854 段①)。
 *
 * ⚠ 判定は拡張子だけである(`sqlite-attachment.test.ts` と同じ理由)── 中身で
 *   見分けるには全部読むしかなく、選ぶ前に何十 MB も heap へ載せることになる。
 */
import { describe, expect, it } from 'vitest';
import {
  buildCsvAttachmentTable,
  CSV_ATTACHMENT_TABLE_NAME,
  csvAttachmentSourcesOf,
  looksLikeCsvAttachmentName,
} from '../../src/features/query/csv-attachment';

const att = (lid: string, title: string) => ({ lid, title, archetype: 'attachment' });
const note = { lid: 'n1', title: '売上.csv' };

describe('それらしい拡張子か', () => {
  it('.csv / .tsv を拾う(大文字でも)', () => {
    expect(looksLikeCsvAttachmentName('a.csv')).toBe('csv');
    expect(looksLikeCsvAttachmentName('A.CSV')).toBe('csv');
    expect(looksLikeCsvAttachmentName(' 売上.csv ')).toBe('csv');
    expect(looksLikeCsvAttachmentName('a.tsv')).toBe('tsv');
    expect(looksLikeCsvAttachmentName('A.TSV')).toBe('tsv');
  });

  it('⚠ それ以外は拾わない(.sqlite / 写真 / 拡張子無し)', () => {
    for (const n of ['a.sqlite', 'a.db', 'a.png', 'a.docx', 'a.csv.txt', 'csv', '']) {
      expect(looksLikeCsvAttachmentName(n), `拾ってはいけない名前: ${n}`).toBeNull();
    }
  });
});

describe('選べる相手を拾う', () => {
  it('🔴 添付で、かつ csv / tsv のものだけ', () => {
    const got = csvAttachmentSourcesOf([
      att('a', '売上.csv'),
      att('b', '客.tsv'),
      att('c', '会員.sqlite'),
      att('d', 'ねこ.png'),
      // ⚠ **添付でないノート**は、題名が .csv でも並ばない(中身が bytes ではない)
      { lid: 'e', title: 'メモ.csv', archetype: 'text' },
    ]);
    expect(got).toEqual([
      { lid: 'a', name: '売上.csv' },
      { lid: 'b', name: '客.tsv' },
    ]);
  });

  it('⚠ 並びは題名順(入れ直すたびに場所が変わらない)', () => {
    const got = csvAttachmentSourcesOf([att('a', 'ん.csv'), att('b', 'あ.csv'), att('c', 'k.csv')]);
    expect(got.map((s) => s.name)).toEqual(['k.csv', 'あ.csv', 'ん.csv']);
  });

  it('⚠ 空振り防止 ── 1 つも無ければ空、1 つ在れば拾う(両方向)', () => {
    expect(csvAttachmentSourcesOf([att('a', 'ねこ.png')])).toEqual([]);
    expect(csvAttachmentSourcesOf([att('a', 'ねこ.png'), att('b', '売上.csv')])).toEqual([
      { lid: 'b', name: '売上.csv' },
    ]);
  });
});

describe('file 全体を 1 つの表にする', () => {
  it('🔴 1 行目が見出し、値は全部 TEXT、どこから来たか分かる列が付く', () => {
    const t = buildCsvAttachmentTable('name,age\n太郎,20\n花子,30\n', 'csv', note);
    expect(t).not.toBeNull();
    expect(t!.name).toBe(CSV_ATTACHMENT_TABLE_NAME);
    expect(t!.columns).toEqual(['_note', '_lid', 'name', 'age']);
    expect(t!.rows).toEqual([
      ['売上.csv', 'n1', '太郎', '20'],
      ['売上.csv', 'n1', '花子', '30'],
    ]);
    expect(t!.truncated).toBe(false);
  });

  it('⚠ tsv も同じ規則で読める(区切り字だけが違う)', () => {
    const t = buildCsvAttachmentTable('name\tage\n太郎\t20\n', 'tsv', note);
    expect(t!.columns).toEqual(['_note', '_lid', 'name', 'age']);
    expect(t!.rows).toEqual([['売上.csv', 'n1', '太郎', '20']]);
  });

  it('⚠ 見出しより短い行は、足りない升を null にする(値は空文字と区別する)', () => {
    const t = buildCsvAttachmentTable('a,b,c\n1,2\n', 'csv', note);
    expect(t!.rows).toEqual([['売上.csv', 'n1', '1', '2', null]]);
  });

  it('🔴 見出し行だけ(データ行 0 件)は、壊れているのではなく空の表', () => {
    const t = buildCsvAttachmentTable('a,b\n', 'csv', note);
    expect(t).not.toBeNull();
    expect(t!.rows).toEqual([]);
    expect(t!.truncated).toBe(false);
  });

  it('🔴 .csv に見えても中身が空 / 読める行が無ければ null(呼び側が断る)', () => {
    expect(buildCsvAttachmentTable('', 'csv', note)).toBeNull();
    expect(buildCsvAttachmentTable('   \n\n  ', 'csv', note)).toBeNull();
  });

  describe('上限で打ち切る(#854 段①)', () => {
    // ⚠ 見出し込みで列 4 つ(_note, _lid, a, b)── budget を桁で調整して境界を作る
    const body = (rows: number): string =>
      'a,b\n' + Array.from({ length: rows }, (_, i) => `${String(i)},${String(i)}`).join('\n') + '\n';

    it('🔴 升の総数(行 × 列)を超えたら、行を切って truncated を立てる', () => {
      // 列 4(_note, _lid, a, b)、budget 20 → 1 行あたり 5 行までが上限
      const t = buildCsvAttachmentTable(body(10), 'csv', note, 20);
      expect(t!.truncated, '打ち切ったのに立っていない').toBe(true);
      expect(t!.rows.length, '切った行数が上限どおりでない').toBe(5);
      // ⚠ 空振り防止 ── 切った行は本当に先頭からである(末尾を切ったのではない)
      expect(t!.rows[0]).toEqual(['売上.csv', 'n1', '0', '0']);
      expect(t!.rows[4]).toEqual(['売上.csv', 'n1', '4', '4']);
    });

    it('⚠ 対照群 ── ちょうど収まる件数では切らない', () => {
      const t = buildCsvAttachmentTable(body(5), 'csv', note, 20);
      expect(t!.truncated, '境界ぴったりなのに切ったことにしている').toBe(false);
      expect(t!.rows.length).toBe(5);
    });

    it('⚠ 既定の上限(CSV_TABLE_CELLS_MAX)は、小さい file では効かない(対照群)', () => {
      const t = buildCsvAttachmentTable(body(5), 'csv', note);
      expect(t!.truncated, '小さい file まで切っている').toBe(false);
      expect(t!.rows.length).toBe(5);
    });
  });
});
