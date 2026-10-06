/**
 * 🔴 **DuckDB へ写したときの「写せなかった物 / 形が変わった物」の字**(#682 段④d の着地後レビュー D3 / D6 / D7)。
 *
 * ⚠ 字は 1 か所(`duckdb-copy-report.ts`)から帯・構造ノート・つながり図へ配る ── ここで字そのものと、
 *   「並べているか」で逃げ道が変わることを pin する(画面側の test は「出ること」を見る)。
 */
import { describe, expect, it } from 'vitest';
import {
  DUCKDB_ROUNDED_TYPES_NOTE,
  EMPTY_DUCK_COPY,
  asTextLine,
  copyBandNote,
  copyDigestNotes,
  refusedLine,
  sqliteFallbackHint,
  type DuckDbCopyReport,
} from '../../src/features/query/duckdb-copy-report';
import { renderSchemaDigest } from '../../src/features/query/schema-digest';

const report = (over: Partial<DuckDbCopyReport> = {}): DuckDbCopyReport => ({ ...EMPTY_DUCK_COPY, ...over });
const big = { name: '大きい', view: false, why: 'x' };
const view = { name: '月別', view: true, why: 'ビューは読み込みません' };

describe('🔴 逃げ道は、並べているかで変わる(D7)', () => {
  it('1 件だけ → 内蔵の sqlite を選べる / 並べている → 選べない(DuckDB 固定)ので、1 つに戻すよう言う', () => {
    expect(sqliteFallbackHint(false)).toBe('内蔵の sqlite なら調べられます');
    expect(sqliteFallbackHint(true)).toBe('ファイルを 1 つに戻すと内蔵の sqlite で調べられます');
  });
});

describe('🔴 写せなかった表・ビューの 1 行', () => {
  it('表は名前を並べ、ビューは「写らない」と言う。逃げ道は末尾に 1 度だけ', () => {
    const r = report({ refused: [big, { ...big, name: '無い' }, view] });
    expect(refusedLine(r, false)).toBe(
      '読み込めなかった表: 大きい、無い / 読み込まれないビュー: 月別(ビューは読み込みません)(内蔵の sqlite なら調べられます)',
    );
    expect(refusedLine(r, true)).toContain('(ファイルを 1 つに戻すと内蔵の sqlite で調べられます)');
    expect(refusedLine(r, true), '並べているのに押せない道を案内している').not.toContain('内蔵の sqlite なら調べられます');
  });

  it('ビューだけでも出る(ビューが在ることを、写さなかったと言わないと「無い」と読まれる)', () => {
    expect(refusedLine(report({ refused: [view] }), false)).toContain('読み込まれないビュー: 月別');
    expect(refusedLine(report({ refused: [view] }), false)).not.toContain('読み込めなかった表');
  });

  it('名前が空の表は「名前の無い表」と言う(空の字を出さない)', () => {
    expect(refusedLine(report({ refused: [{ name: '', view: false, why: 'x' }] }), false)).toContain('(名前の無い表)');
  });

  it('無ければ出さない', () => {
    expect(refusedLine(EMPTY_DUCK_COPY, false)).toBe('');
    expect(copyBandNote(null, false)).toBe('');
    expect(copyBandNote(EMPTY_DUCK_COPY, false)).toBe('');
  });
});

describe('🔴 全部の列を文字で写した表(D6)', () => {
  it('表の名前を言い、数として使うときは CAST と案内する', () => {
    const line = asTextLine(report({ asText: ['価格', '混在'] }));
    expect(line).toContain('全部の列を文字にした表: 価格、混在');
    expect(line).toContain('CAST');
    expect(asTextLine(EMPTY_DUCK_COPY)).toBe('');
  });

  it('帯は 2 つの行を 1 行につなぐ(帯の行を増やして表を押し下げない)', () => {
    const band = copyBandNote(report({ refused: [big], asText: ['価格'] }), false);
    expect(band).toContain('読み込めなかった表: 大きい');
    expect(band).toContain('全部の列を文字にした表: 価格');
    expect(band).not.toContain('\n');
  });
});

describe('🔴 構造ノートの注記(D3 / D6)', () => {
  it('.sqlite を写したときだけ「型は 3 つに丸めている」と言う', () => {
    expect(copyDigestNotes(report({ sqlite: true }), false)).toEqual([DUCKDB_ROUNDED_TYPES_NOTE]);
    expect(DUCKDB_ROUNDED_TYPES_NOTE).toContain('BIGINT / DOUBLE / VARCHAR の 3 つに丸めています');
    // 対照群:csv / parquet だけの器では言わない(型はそもそも器の型のまま)
    expect(copyDigestNotes(report({ sqlite: false }), false)).toEqual([]);
    expect(copyDigestNotes(null, false)).toEqual([]);
  });

  it('写せなかった表の行が先 / 型の丸めが後', () => {
    expect(copyDigestNotes(report({ sqlite: true, refused: [big] }), true)).toEqual([
      '読み込めなかった表: 大きい(ファイルを 1 つに戻すと内蔵の sqlite で調べられます)',
      DUCKDB_ROUNDED_TYPES_NOTE,
    ]);
  });

  it('🔴 構造ノートの末尾に出る(AI へ貼った人が「この DB の表は、これで全部」と読まない)', () => {
    const columns = {
      columns: ['kind', 'tbl', 'cid', 'col', 'typ', 'nn', 'pk'],
      rows: [['table', '小', 0, 'id', 'INTEGER', 0, 0]],
    };
    const fks = { columns: ['tbl', 'ref', 'col', 'refcol'], rows: [] };
    const md = renderSchemaDigest({
      source: '家計.sqlite',
      columns,
      fks,
      notes: copyDigestNotes(report({ sqlite: true, refused: [big] }), false),
    });
    expect(md).toContain('⚠ 読み込めなかった表: 大きい');
    expect(md).toContain(`⚠ ${DUCKDB_ROUNDED_TYPES_NOTE}`);
    // 対照群:notes を渡さなければ、今までの字のまま(内蔵の sqlite の構造に何も足さない)
    const plain = renderSchemaDigest({ source: '家計.sqlite', columns, fks });
    expect(plain).not.toContain('読み込めなかった');
    expect(plain).not.toContain('丸めています');
    // 全部が写せなかった `.sqlite` は「表もビューも 1 つもありません」だけでは「空」と読める
    const empty = renderSchemaDigest({
      source: '家計.sqlite',
      columns: { columns: columns.columns, rows: [] },
      fks,
      notes: copyDigestNotes(report({ refused: [big] }), false),
    });
    expect(empty).toContain('表もビューも 1 つもありません。');
    expect(empty).toContain('⚠ 読み込めなかった表: 大きい');
  });
});
