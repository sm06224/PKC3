/**
 * 🔴 **ノート内データフロー:名前付きデータセットの抽出**(#2115 PR-2)。
 *
 * 守る主張:
 * 1. csv / tsv / psv の名前付きの囲みだけを拾い、列名と列の型を既存の正本(`csvColumnNames` / `numericColumns`)で決める
 * 2. Markdown の表は直前(空行 0〜1 行)の `<!-- dataset: x -->` / `<!-- name=x -->` があるときだけ拾う
 * 3. 添付は明示の宣言と、リンクからの自動候補(明示が勝つ・ぶつかれば静かに譲る)
 * 4. 使えない名前・重なった名前・大きすぎる表は黙って捨てず、理由を `diagnostics` に出す
 */
import { describe, expect, it } from 'vitest';
import {
  collectImplicitAssetDatasets,
  extractNoteDatasets,
  type NoteAssetDataset,
  type NoteDataset,
  type NoteInlineDataset,
} from '../../../src/features/dataflow';
import { CSV_TABLE_CELLS_MAX } from '../../../src/features/query/csv-tables';
import { renderMarkdown } from '../../../src/features/markdown/markdown-render';

const F = '```';
const body = (...lines: string[]): string => lines.join('\n');
const inline = (d: NoteDataset | undefined): NoteInlineDataset => {
  if (d === undefined || d.kind === 'asset') throw new Error(`inline ではない: ${JSON.stringify(d)}`);
  return d;
};
const asset = (d: NoteDataset | undefined): NoteAssetDataset => {
  if (d === undefined || d.kind !== 'asset') throw new Error(`asset ではない: ${JSON.stringify(d)}`);
  return d;
};

describe('csv / tsv / psv の囲み', () => {
  it('名前付きの csv を拾い、列名と型を決める(007 / 1,200 は字・120 / -3.5 は数)', () => {
    const r = extractNoteDatasets(
      body(
        '# 見出し',
        `${F}csv name=売上`,
        'コード,金額,数量,単価',
        '007,"1,200",120,-3.5',
        '010,300,4,2',
        F,
      ),
    );
    expect(r.diagnostics).toEqual([]);
    const d = inline(r.datasets[0]);
    expect(d).toMatchObject({ kind: 'csv', name: '売上', line: 1, implicit: false });
    expect(d.columns).toEqual(['コード', '金額', '数量', '単価']);
    expect(d.types).toEqual(['TEXT', 'TEXT', 'REAL', 'REAL']);
    expect(d.rows).toEqual([
      ['007', '1,200', '120', '-3.5'],
      ['010', '300', '4', '2'],
    ]);
  });

  it('tsv / psv も読み、区切り字は言語に従う', () => {
    const r = extractNoteDatasets(
      body(`${F}tsv name=t`, 'a\tb', '1\t2', F, '', `${F}psv name=p`, 'x|y', '3|4', F),
    );
    expect(r.datasets.map((d) => [d.kind, d.name])).toEqual([
      ['tsv', 't'],
      ['psv', 'p'],
    ]);
    expect(inline(r.datasets[0]).rows).toEqual([['1', '2']]);
    expect(inline(r.datasets[1]).columns).toEqual(['x', 'y']);
  });

  it('noheader は col1.. の列名にし、1 行目もデータにする', () => {
    const d = inline(extractNoteDatasets(body(`${F}csv name=n noheader`, '1,2', '3,4', F)).datasets[0]);
    expect(d.columns).toEqual(['col1', 'col2']);
    expect(d.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('列名の重なりは _2 で逃がし、余り列は 列3 にする(足りない升は空)', () => {
    const d = inline(extractNoteDatasets(body(`${F}csv name=w`, 'a,A', '1,2,3', '4', F)).datasets[0]);
    expect(d.columns).toEqual(['a', 'A_2', '列3']);
    expect(d.rows).toEqual([
      ['1', '2', '3'],
      ['4', '', ''],
    ]);
  });

  it('⚠ _note / _lid を勝手に混ぜない(単一ノート)', () => {
    const d = inline(extractNoteDatasets(body(`${F}csv name=s`, 'x', '1', F)).datasets[0]);
    expect(d.columns).toEqual(['x']);
  });

  it('名前の無い囲み・csv 以外の囲みは拾わない', () => {
    const r = extractNoteDatasets(body(`${F}csv`, 'a', '1', F, `${F}js name=x`, 'a', F));
    expect(r.datasets).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it('引用の中の囲みも拾う', () => {
    const d = inline(extractNoteDatasets(body(`> ${F}csv name=q`, '> a,b', '> 1,2', `> ${F}`)).datasets[0]);
    expect(d.rows).toEqual([['1', '2']]);
  });

  it('frontmatter の中の柵は数えない', () => {
    const r = extractNoteDatasets(body('---', 'x: 1', '---', `${F}csv name=f`, 'a', '1', F));
    expect(r.datasets.map((d) => [d.name, d.line])).toEqual([['f', 3]]);
  });

  it('🔴 升の上限を超えたら黙って切らず断る', () => {
    const cols = 1000;
    const rowsN = Math.floor(CSV_TABLE_CELLS_MAX / cols) + 1;
    const header = Array.from({ length: cols }, (_, i) => `c${String(i)}`).join(',');
    const row = Array.from({ length: cols }, () => '1').join(',');
    const r = extractNoteDatasets(
      body(`${F}csv name=big`, header, ...Array.from({ length: rowsN }, () => row), F),
    );
    expect(r.datasets).toEqual([]);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ kind: 'too-large', name: 'big', line: 0 });
    expect(r.diagnostics[0]?.why).toContain(String(CSV_TABLE_CELLS_MAX));
  });

  it('上限ちょうどは受ける(境界)', () => {
    const cols = 1000;
    const rowsN = CSV_TABLE_CELLS_MAX / cols;
    const header = Array.from({ length: cols }, (_, i) => `c${String(i)}`).join(',');
    const row = Array.from({ length: cols }, () => '1').join(',');
    const r = extractNoteDatasets(
      body(`${F}csv name=edge`, header, ...Array.from({ length: rowsN }, () => row), F),
    );
    expect(r.diagnostics).toEqual([]);
    expect(inline(r.datasets[0]).rows).toHaveLength(rowsN);
  });

  it('空の囲みは empty の診断', () => {
    const r = extractNoteDatasets(body(`${F}csv name=e`, F));
    expect(r.datasets).toEqual([]);
    expect(r.diagnostics.map((d) => d.kind)).toEqual(['empty']);
  });

  it('見出しに asset: があれば添付のデータセットになる', () => {
    const r = extractNoteDatasets(body(`${F}tsv name=a noheader asset:ast-1`, F));
    expect(asset(r.datasets[0])).toMatchObject({ assetKey: 'ast-1', format: 'tsv', noHeader: true, implicit: false });
  });
});

describe('名前の検査', () => {
  it.each([
    ['entries', '中の仕組み'],
    ['sqlite_x', 'sqlite_'],
    ['ｓａｌｅｓ', '全角'],
    ['a-b', '文字・数字・_'],
  ])('%s は invalid-name(理由つき)', (name, piece) => {
    const r = extractNoteDatasets(body(`${F}csv name=${name}`, 'a', '1', F));
    expect(r.datasets).toEqual([]);
    expect(r.diagnostics[0]).toMatchObject({ kind: 'invalid-name', name, line: 0 });
    expect(r.diagnostics[0]?.why).toContain(piece);
  });

  it('同じ名前は先を採り、後を duplicate-name にする(大小は ASCII だけ畳む)', () => {
    const r = extractNoteDatasets(
      body(`${F}csv name=Sales`, 'a', '1', F, `${F}csv name=sales`, 'a', '2', F),
    );
    expect(r.datasets.map((d) => d.name)).toEqual(['Sales']);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ kind: 'duplicate-name', name: 'sales', line: 4 });
    expect(inline(r.datasets[0]).rows).toEqual([['1']]);
  });
});

describe('Markdown の表', () => {
  const table = ['| 地域 | 金額 |', '|---|---|', '| 東 | 100 |', '| 西 | 007 |'];

  it.each([
    ['<!-- dataset: 地域表 -->', 0],
    ['<!--dataset:地域表-->', 0],
    ['  <!-- DATASET : 地域表 -->  ', 0],
    ['<!-- name=地域表 -->', 0],
    ['<!-- Name = 地域表 -->', 0],
    ['<!-- dataset: 地域表 -->', 1],
  ])('%s(空行 %d 行)を名前として読む', (comment, blanks) => {
    const r = extractNoteDatasets(body(comment, ...Array.from({ length: blanks }, () => ''), ...table));
    expect(r.diagnostics).toEqual([]);
    const d = inline(r.datasets[0]);
    expect(d).toMatchObject({ kind: 'markdown', name: '地域表', line: 1 + blanks });
    expect(d.columns).toEqual(['地域', '金額']);
    expect(d.types).toEqual(['TEXT', 'TEXT']);
    expect(d.rows).toEqual([
      ['東', '100'],
      ['西', '007'],
    ]);
  });

  it('空行 2 行は離れすぎ(表は拾わず、コメントは orphan-label)', () => {
    const r = extractNoteDatasets(body('<!-- dataset: x -->', '', '', ...table));
    expect(r.datasets).toEqual([]);
    expect(r.diagnostics).toEqual([expect.objectContaining({ kind: 'orphan-label', name: 'x', line: 0 })]);
  });

  it('コメントの無い表は拾わない', () => {
    expect(extractNoteDatasets(body(...table)).datasets).toEqual([]);
  });

  it('🔴 コードブロックの中のコメントと表は拾わない', () => {
    const r = extractNoteDatasets(body(`${F}md`, '<!-- dataset: x -->', ...table, F));
    expect(r.datasets).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it('🔴 コードブロックの中のコメントは、その外の直後の表に付かない', () => {
    const r = extractNoteDatasets(body(`${F}md`, '<!-- dataset: x -->', F, ...table));
    expect(r.datasets).toEqual([]);
  });

  it('数の列は REAL(空の升は判定から外す)', () => {
    const d = inline(
      extractNoteDatasets(body('<!-- dataset: n -->', '| a | b |', '|---|---|', '| 1 | x |', '|  | y |')).datasets[0],
    );
    expect(d.types).toEqual(['REAL', 'TEXT']);
  });

  it('引用の中の表は、同じ深さのコメントで名前が付く', () => {
    const r = extractNoteDatasets(body('> <!-- dataset: q -->', ...table.map((l) => `> ${l}`)));
    expect(inline(r.datasets[0]).rows).toHaveLength(2);
  });

  it.each(['%% dataset: 地域表 %%', '%%name=地域表%%', '  %% DATASET : 地域表 %%  '])(
    '隠しメモ %s も名前として読む',
    (memo) => {
      const r = extractNoteDatasets(body(memo, ...table));
      expect(r.diagnostics).toEqual([]);
      expect(inline(r.datasets[0])).toMatchObject({ name: '地域表', line: 1 });
    },
  );

  it('`\\%%`(字のままの %%)・%%% の塊は名前ではない', () => {
    expect(extractNoteDatasets(body('\\%% dataset: x %%', ...table)).datasets).toEqual([]);
    expect(extractNoteDatasets(body('%%% dataset: x %%%', ...table)).datasets).toEqual([]);
  });

  it('🔑 隠しメモの名前は、描いた本文を 1 バイトも変えない(見た目 0 変化)', () => {
    const plain = renderMarkdown(body('', ...table));
    const named = renderMarkdown(body('%% dataset: 地域表 %%', ...table));
    expect(named).toContain('<table');
    expect(named).not.toContain('地域表');
    expect(named).toBe(plain);
  });

  it('⚠ いまの描画は html: false なので、HTML コメントの名前は字のまま見える(隠すのは PR-3)', () => {
    const named = renderMarkdown(body('<!-- dataset: 地域表 -->', ...table));
    expect(named).toContain('&lt;!-- dataset: 地域表 --&gt;');
    // 表そのものは壊れない
    expect(named).toContain('<table');
  });
});

describe('添付の csv', () => {
  it('明示の宣言 <!-- dataset: 名前=asset:鍵 -->', () => {
    const r = extractNoteDatasets(body('本文', '<!-- dataset: 売上=asset:ast-abc_1.v2 -->'));
    expect(asset(r.datasets[0])).toMatchObject({ name: '売上', assetKey: 'ast-abc_1.v2', line: 1, implicit: false });
  });

  it('鍵が空・読めない字なら invalid-asset', () => {
    const r = extractNoteDatasets(body('<!-- dataset: a=asset: -->', '<!-- dataset: b=asset:x/y -->'));
    expect(r.datasets).toEqual([]);
    expect(r.diagnostics.map((d) => [d.kind, d.name])).toEqual([
      ['invalid-asset', 'a'],
      ['invalid-asset', 'b'],
    ]);
  });

  it('リンク [売上.csv](asset:k) は自動の候補(implicit)', () => {
    const r = extractNoteDatasets(body('明細は [売上.csv](asset:ast-1) と [在庫.TSV](asset:ast-2)'));
    expect(r.datasets.map((d) => [d.name, asset(d).assetKey, asset(d).format, asset(d).implicit])).toEqual([
      ['売上', 'ast-1', 'csv', true],
      ['在庫', 'ast-2', 'tsv', true],
    ]);
  });

  it('画像・インラインコード・コードブロックの中・csv 以外の拡張子は候補にしない', () => {
    const r = extractNoteDatasets(
      body('![a.csv](asset:k1) `[b.csv](asset:k2)` [c.txt](asset:k3)', F, '[d.csv](asset:k4)', F),
    );
    expect(r.datasets).toEqual([]);
  });

  it('🔑 明示が勝ち、同じ名前の自動候補は静かに譲る(診断も出さない)', () => {
    const r = extractNoteDatasets(body(`${F}csv name=売上`, 'a', '1', F, '[売上.csv](asset:ast-9)'));
    expect(r.datasets).toHaveLength(1);
    expect(r.datasets[0]?.kind).toBe('csv');
    expect(r.diagnostics).toEqual([]);
  });

  it('taken(ビューの名前)にも譲る', () => {
    expect(collectImplicitAssetDatasets('[v.csv](asset:k)', ['V'])).toEqual([]);
  });

  it('別の鍵を指す同じ名前のリンクは両方とも譲る / 同じ鍵なら 1 つ', () => {
    expect(collectImplicitAssetDatasets(body('[a.csv](asset:k1)', '[a.csv](asset:k2)'))).toEqual([]);
    const same = collectImplicitAssetDatasets(body('[a.csv](asset:k1)', '[a.csv](asset:k1)'));
    expect(same.map((d) => [d.name, d.line])).toEqual([['a', 0]]);
  });

  it('使えない名前のリンク(予約語・記号)は静かに候補から外す', () => {
    const r = extractNoteDatasets(body('[entries.csv](asset:k1) [a b.csv](asset:k2)'));
    expect(r.datasets).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });
});
