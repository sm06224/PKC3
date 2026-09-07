/**
 * 🔴 **表のセルを押したら打てる**(#418 段①)。
 *
 * 守る主張:
 * 1. **位置は数える側が採る** ── 行の位置もセルの範囲も `parseCsv` の走査から出る
 *    (自前の `split('\n')` で数え直すと、引用の中の改行で読み手が 2 つに割れる)
 * 2. 🔴 **触っていないセルの字は 1 バイトも動かない** ── 行を組み直さない
 * 3. 🔴 **当てずっぽうで別の行を書き換えない** ── 前提が崩れていれば**断る**
 */
import { describe, expect, it } from 'vitest';
import { parseCsv, csvEscapeField, type CsvPositions } from '../../src/features/markdown/csv-table';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

describe('位置を採る', () => {
  const pos = (src: string, d = ','): CsvPositions => {
    const out: CsvPositions = { rowLines: [], cellSpans: [] };
    parseCsv(src, d, out);
    return out;
  };

  it('行の位置', () => {
    expect(pos('a,b\nc,d\n').rowLines).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 1 },
    ]);
  });

  it('引用の中の改行でまたぐ', () => {
    expect(pos('"あ\nい",b\nc,d').rowLines).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 2 },
    ]);
  });

  it('セルの範囲は引用符を含む', () => {
    const p = pos('a,"b,x",c');
    expect(p.cellSpans![0]).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 7 },
      { start: 8, end: 9 },
    ]);
    expect('a,"b,x",c'.slice(2, 7)).toBe('"b,x"');
  });

  it('空のセルも範囲を持つ', () => {
    const p = pos(',,');
    expect(p.cellSpans![0]).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 1 },
      { start: 2, end: 2 },
    ]);
  });

  it('落とした末尾の空行は位置も落ちる', () => {
    const p = pos('a,b\n\n');
    expect(p.rowLines).toHaveLength(1);
    expect(p.cellSpans).toHaveLength(1);
  });

  it('逃げの規則', () => {
    expect(csvEscapeField('あ', ',')).toBe('あ');
    expect(csvEscapeField('a,b', ',')).toBe('"a,b"');
    expect(csvEscapeField('a,b', '\t')).toBe('a,b');
    expect(csvEscapeField('a"b', ',')).toBe('"a""b"');
    expect(csvEscapeField('', ',')).toBe('');
  });
});

describe('位置を採る', () => {
  const pos = (src: string, d = ','): CsvPositions => {
    const out: CsvPositions = { rowLines: [], cellSpans: [] };
    parseCsv(src, d, out);
    return out;
  };

  it('行の位置', () => {
    expect(pos('a,b\nc,d\n').rowLines).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 1 },
    ]);
  });

  it('引用の中の改行でまたぐ', () => {
    expect(pos('"あ\nい",b\nc,d').rowLines).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 2 },
    ]);
  });

  it('セルの範囲は引用符を含む', () => {
    const p = pos('a,"b,x",c');
    expect(p.cellSpans![0]).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 7 },
      { start: 8, end: 9 },
    ]);
    expect('a,"b,x",c'.slice(2, 7)).toBe('"b,x"');
  });

  it('空のセルも範囲を持つ', () => {
    const p = pos(',,');
    expect(p.cellSpans![0]).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 1 },
      { start: 2, end: 2 },
    ]);
  });

  it('落とした末尾の空行は位置も落ちる', () => {
    const p = pos('a,b\n\n');
    expect(p.rowLines).toHaveLength(1);
    expect(p.cellSpans).toHaveLength(1);
  });

  it('逃げの規則', () => {
    expect(csvEscapeField('あ', ',')).toBe('あ');
    expect(csvEscapeField('a,b', ',')).toBe('"a,b"');
    expect(csvEscapeField('a,b', '\t')).toBe('a,b');
    expect(csvEscapeField('a"b', ',')).toBe('"a""b"');
    expect(csvEscapeField('', ',')).toBe('');
  });
});

describe('セルを 1 つ書き換える(#418 段①)', () => {
  const cell = (body: string, line: number, col: number, value: string): string | null =>
    applyBodyRewrite(body, { kind: 'csv-cell', line, col, value });

  const SHEET = '```csv-render noheader\n,,\n,,\n```';

  it('🔴 空の升に打てる(user の物語 ── A1 に「品名」)', () => {
    expect(cell(SHEET, 1, 0, '品名')).toBe('```csv-render noheader\n品名,,\n,,\n```');
  });

  it('🔴 触っていないセルの字は 1 バイトも動かない', () => {
    // ⚠ `"b"` は要らない引用だが、**user が書いた字**である ── 組み直すと消える
    const body = '```csv\na,"b",c\n```';
    expect(cell(body, 1, 2, 'z')).toBe('```csv\na,"b",z\n```');
  });

  it('🔴 双方向 ── 空の字を渡すとセルが空になる', () => {
    expect(cell('```csv\na,b\n```', 1, 0, '')).toBe('```csv\n,b\n```');
  });

  it('🔴 区切り字は囲みの見出しから決まる(呼び手に決めさせない)', () => {
    // ⚠ csv ではカンマを包むが、tsv では**包まない** ── 包むと `"x,y"` の
    //    引用符が字として残り、user が打っていない字が表に出る
    expect(cell('```csv\na,b\n```', 1, 0, 'x,y')).toBe('```csv\n"x,y",b\n```');
    expect(cell('```tsv\na\tb\n```', 1, 0, 'x,y')).toBe('```tsv\nx,y\tb\n```');
    expect(cell('```psv\na|b\n```', 1, 1, 'z')).toBe('```psv\na|z\n```');
  });

  it('🔴 表の囲みの外は 1 行も書き換えない(散文・別の言語の囲み)', () => {
    expect(cell('ただの本文\nもう 1 行', 1, 0, 'z'), '散文を書き換えた').toBeNull();
    expect(cell('```js\na,b\n```', 1, 0, 'z'), 'コードの囲みを書き換えた').toBeNull();
  });

  it('⚠ 表示だけの囲み(`csv-render`)でも書ける ── 見せ方の違いであって別物ではない', () => {
    expect(cell('```csv-render noheader\na,b\n```', 1, 1, 'z')).toBe(
      '```csv-render noheader\na,z\n```',
    );
  });

  it('⚠ 同じ字なら書かない(更新日時だけ動かさない)', () => {
    expect(cell('```csv\na,b\n```', 1, 0, 'a')).toBeNull();
  });

  it('🔴 その行が無ければ断る', () => {
    expect(cell('```csv\na,b\n```', 99, 0, 'z')).toBeNull();
  });

  it('🔴 セルが無ければ断る(黙って列を足さない)', () => {
    expect(cell('```csv\na,b\n```', 1, 5, 'z')).toBeNull();
  });

  it('🔴 引用が閉じていない行は断る(次の行へまたがっている)', () => {
    // ⚠ ここで書くと**次の行の中身まで**巻き込む ── 断るのが正しい
    expect(cell('```csv\n"あ\nい",b\n```', 1, 0, 'z')).toBeNull();
  });

  /**
   * ⚠ **「空行は書き換えない」を外した**(#780。user 裁定 2026-09-07「押したら打てる」)。
   *
   * 🔑 実測すると、読み手は**その空行にも押せる升を 2 つ焼いていた**
   *   (`表=[["",""],["a","b"]]`)── つまり古い主張は「**押せるのに書けない**」を
   *   pin していた(打った字が消える形)。
   * ⚠ 囲みの**見出しの行**は今までどおり断る ── そこは表の中身ではない。
   */
  it('🔴 表でない行は断る(囲みの見出しを書き換えない)', () => {
    expect(cell(SHEET, 0, 0, 'z'), '囲みの見出しを書き換えた').toBeNull();
  });

  it('⚠ 引用符を打ったら、字として残る(記法として壊さない)', () => {
    expect(cell('```csv\na,b\n```', 1, 0, 'あ"い')).toBe('```csv\n"あ""い",b\n```');
  });
});

/**
 * 🔴 **押す口は「受け手が居る面」だけに焼く**(#418 段①)。
 *
 * ⚠ `interactiveTasks`(#277)と同じ作法である ── 押せるのに本文が変わらないと、
 *   user から見て「打ったのに消えた」= データを失った挙動になる。
 */
describe('セルに押す口を焼く(#418 段①)', () => {
  /**
   * ⚠ **押す口を「行と列の口」と取り違えない** ── どちらも同じ
   *   `data-pkc-cell-line` / `-col` を持つので、`data-pkc-action` まで見ないと
   *   **行を足すボタンをセルとして数える**(実際に 1 度そう数えて落ちた ──
   *   CLAUDE.md §1「範囲が広すぎて別のものに満たされる」)。
   */
  const cells = (html: string): Array<{ line: string; col: string }> =>
    [
      ...html.matchAll(
        /data-pkc-action="edit-cell" data-pkc-cell-line="(\d+)" data-pkc-cell-col="(\d+)"/g,
      ),
    ].map((m) => ({ line: m[1]!, col: m[2]! }));

  it('🔴 渡さなければ 1 つも出ない(書き出し・印刷では押せない)', () => {
    const out = renderMarkdown('```csv\na,b\nc,d\n```');
    expect(out, '前提: 表が描かれていない').toContain('pkc-md-rendered-csv');
    expect(cells(out)).toEqual([]);
    expect(out).not.toContain('edit-cell');
  });

  it('🔴 渡すと、原文の行番号が焼かれる(索引ではない)', () => {
    const out = renderMarkdown('```csv\na,b\nc,d\n```', { interactiveCells: true });
    // 見出し行は原文 1 行目、次の行は 2 行目(囲みの見出しが 0 行目)
    expect(cells(out)).toEqual([
      { line: '1', col: '0' },
      { line: '1', col: '1' },
      { line: '2', col: '0' },
      { line: '2', col: '1' },
    ]);
  });

  it('🔴 前に本文があってもずれない(囲みの位置から数える)', () => {
    const out = renderMarkdown('# 見出し\n\n本文\n\n```csv\na,b\n```', { interactiveCells: true });
    expect(cells(out).map((c) => c.line)).toEqual(['5', '5']);
  });

  it('🔴 前処理で行が消えてもずれない(`lineMap` で原文へ戻す)', () => {
    // ⚠ `%%%…%%%` は描画で**消える**ので、markdown-it が見る行番号は原文より
    //    3 つ小さい ── 戻さないと**別の行を書き換える**(静かなデータ破壊)。
    //    実測: 戻さないと 6 行目のはずが 3 行目を指した
    const body = '%%%\nメモ\nもう 1 行\n%%%\n\n```csv\nあ,い\n```';
    const out = renderMarkdown(body, { interactiveCells: true });
    expect(cells(out).map((c) => c.line)).toEqual(['6', '6']);
    // 🔑 **端どうしが噛み合う**ことまで見る ── 焼いた行がそのまま書き換えに通る
    expect(
      applyBodyRewrite(body, { kind: 'csv-cell', line: 6, col: 0, value: '品名' }),
    ).toBe('%%%\nメモ\nもう 1 行\n%%%\n\n```csv\n品名,い\n```');
  });

  it('🔴 frontmatter を剥がした面でも原文の行を指す(`taskLineOffset`)', () => {
    const out = renderMarkdown('```csv\na,b\n```', {
      interactiveCells: true,
      taskLineOffset: 3,
    });
    expect(cells(out).map((c) => c.line)).toEqual(['4', '4']);
  });

  it('🔴 またがっている行は押せない(書けない所を押させない)', () => {
    const out = renderMarkdown('```csv\n"あ\nい",b\nc,d\n```', { interactiveCells: true });
    // 1 行目(またがり)は出ず、2 行目(原文 3 行目)だけが押せる
    expect(cells(out).map((c) => c.line)).toEqual(['3', '3']);
  });

  it('🔴 添付から焼いた囲みは押せない(書き戻す先が本文に無い)', () => {
    const out = renderMarkdown('```csv asset:ast-k1\n控え\n```', {
      interactiveCells: true,
      fenceAssets: { 'ast-k1': 'a,b' },
    });
    expect(out, '前提: 添付の字が焼かれていない').toContain('pkc-md-rendered-csv');
    expect(cells(out), '本文に無い字を書き戻す口を出している').toEqual([]);
  });

  it('⚠ 焼いた行番号は、そのまま書き換えに通る(端どうしが噛み合う)', () => {
    const body = '# 見出し\n\n```csv\nあ,い\n```';
    const out = renderMarkdown(body, { interactiveCells: true });
    const first = cells(out)[0]!;
    expect(
      applyBodyRewrite(body, {
        kind: 'csv-cell',
        line: Number(first.line),
        col: Number(first.col),
        value: '品名',
      }),
    ).toBe('# 見出し\n\n```csv\n品名,い\n```');
  });
});

/**
 * 🔴 **行と列を足す / 消す**(#418 段①)。
 *
 * 🔑 打てるだけでは動線が元に戻る ── 5 列で足りなくなった瞬間に CSV の原文へ
 *   帰ることになる。⚠ そして user 指示 2026-08-23「**片道の操作を作らない**」に
 *   従い、足せるなら**消せる**。
 */
describe('行と列を足す / 消す(#418 段①)', () => {
  const shape = (
    body: string,
    line: number,
    col: number,
    what: 'row' | 'col',
    mode: 'add' | 'remove',
  ): string | null => applyBodyRewrite(body, { kind: 'csv-shape', line, col, what, mode });

  const T = '```csv\na,b,c\nd,e,f\n```';

  it('🔴 行を足すと、押した行の下に同じ幅の空行が入る', () => {
    expect(shape(T, 1, 0, 'row', 'add')).toBe('```csv\na,b,c\n,,\nd,e,f\n```');
  });

  it('🔴 行を消せる(双方向)', () => {
    expect(shape(T, 1, 0, 'row', 'remove')).toBe('```csv\nd,e,f\n```');
  });

  it('🔴 最後の 1 行は消さない(表ごと消えて原文に放り出される)', () => {
    expect(shape('```csv\na,b\n```', 1, 0, 'row', 'remove')).toBeNull();
  });

  it('🔴 列を足すと、全部の行に 1 つずつ入る(でこぼこにしない)', () => {
    expect(shape(T, 1, 0, 'col', 'add')).toBe('```csv\na,,b,c\nd,,e,f\n```');
  });

  it('🔴 列を消せる(双方向)', () => {
    expect(shape(T, 1, 1, 'col', 'remove')).toBe('```csv\na,c\nd,f\n```');
  });

  it('⚠ 末尾の列を消しても区切り字が余らない', () => {
    expect(shape(T, 1, 2, 'col', 'remove')).toBe('```csv\na,b\nd,e\n```');
  });

  it('🔴 最後の 1 列は消さない', () => {
    expect(shape('```csv\na\nb\n```', 1, 0, 'col', 'remove')).toBeNull();
  });

  it('🔴 触っていないセルの字は 1 バイトも動かない', () => {
    // ⚠ 要らない引用も**user が書いた字**である ── 組み直すと消える
    const body = '```csv\n"a",b\n"c",d\n```';
    expect(shape(body, 1, 1, 'col', 'add')).toBe('```csv\n"a",b,\n"c",d,\n```');
  });

  it('🔴 またがっている行が 1 つでもあれば、列の操作は丸ごと断る', () => {
    // ⚠ 半分だけ当てると、表の形が行ごとに食い違う(いちばん直しにくい壊れ方)
    const body = '```csv\na,b\n"あ\nい",d\n```';
    expect(shape(body, 1, 0, 'col', 'add'), '半分だけ当てた').toBeNull();
  });

  it('🔴 表の外は 1 行も触らない', () => {
    expect(shape('ふつうの本文\nもう 1 行', 1, 0, 'row', 'add')).toBeNull();
    expect(shape(T, 0, 0, 'row', 'add'), '囲みの見出しを押した').toBeNull();
  });

  it('⚠ tsv でも区切り字は囲みの見出しから決まる', () => {
    expect(shape('```tsv\na\tb\n```', 1, 0, 'col', 'add')).toBe('```tsv\na\t\tb\n```');
  });

  it('⚠ 足した行は、そのまま打てる(端どうしが噛み合う)', () => {
    const grown = shape(T, 1, 0, 'row', 'add')!;
    expect(applyBodyRewrite(grown, { kind: 'csv-cell', line: 2, col: 1, value: 'z' })).toBe(
      '```csv\na,b,c\n,z,\nd,e,f\n```',
    );
  });
});

/**
 * 🔴 **行・列の口も、押せる面だけに出る**(#418 段①)。
 */
describe('行・列の口を焼く(#418 段①)', () => {
  const shapes = (html: string): Array<{ line: string; col: string; what: string; mode: string }> =>
    [
      ...html.matchAll(
        /data-pkc-action="shape-cell" data-pkc-cell-line="(\d+)" data-pkc-cell-col="(\d+)" data-pkc-cell-what="(row|col)" data-pkc-cell-mode="(add|remove)"/g,
      ),
    ].map((m) => ({ line: m[1]!, col: m[2]!, what: m[3]!, mode: m[4]! }));

  it('🔴 渡さなければ 1 つも出ない(書き出し・印刷では触れない)', () => {
    const out = renderMarkdown('```csv\na,b\nc,d\n```');
    expect(out, '前提: 表が描かれていない').toContain('pkc-md-rendered-csv');
    expect(shapes(out)).toEqual([]);
  });

  it('🔴 印は CSS で出す ── ボタンに字を入れない(升の字を汚さない)', () => {
    // ⚠ 升の**中**に置くので、字を入れると `textContent` に混ざる ──
    //    コピーした TSV に `＋×` が入る(実際に入っていた)。
    //    🔑 意味は `aria-label` / `title` が持つので、読み上げは落ちない
    const out = renderMarkdown('```csv\n名前,数\n```', { interactiveCells: true });
    expect(out, '前提: 口が出ていない').toContain('pkc-csv-shape');
    expect(out, 'ボタンに字が入っている').toContain('title="この列を消す"></button>');
    expect(out).not.toContain('>＋<');
    expect(out).not.toContain('>×<');
    // 🔑 意味は落ちていない
    expect(out).toContain('aria-label="この列の右に列を足す"');
  });

  it('🔴 足すのと消すのが対で出る(片道にしない)', () => {
    const got = shapes(renderMarkdown('```csv\na,b\nc,d\n```', { interactiveCells: true }));
    expect(got.filter((g) => g.what === 'row' && g.mode === 'add').length).toBeGreaterThan(0);
    expect(got.filter((g) => g.what === 'row' && g.mode === 'remove').length).toBe(
      got.filter((g) => g.what === 'row' && g.mode === 'add').length,
    );
    expect(got.filter((g) => g.what === 'col' && g.mode === 'remove').length).toBe(
      got.filter((g) => g.what === 'col' && g.mode === 'add').length,
    );
  });

  it('🔴 見出しの無い表でも列を足せる(`noheader` で口が消えない)', () => {
    // ⚠ `<thead>` が出ないので、1 行目の升に置かないと**列を足す道が無くなる**
    const got = shapes(
      renderMarkdown('```csv-render noheader\n,,\n,,\n```', { interactiveCells: true }),
    );
    expect(got.some((g) => g.what === 'col' && g.mode === 'add'), '列を足す口が無い').toBe(true);
  });

  it('🔴 列の口は 1 列につき 1 組(升の数だけ増やさない)', () => {
    const got = shapes(renderMarkdown('```csv\na,b,c\nd,e,f\n```', { interactiveCells: true }));
    expect(got.filter((g) => g.what === 'col' && g.mode === 'add')).toHaveLength(3);
    expect(got.filter((g) => g.what === 'row' && g.mode === 'add')).toHaveLength(1);
  });

  it('⚠ 焼いた口は、そのまま書き換えに通る(端どうしが噛み合う)', () => {
    const body = '```csv\na,b\nc,d\n```';
    const add = shapes(renderMarkdown(body, { interactiveCells: true })).find(
      (g) => g.what === 'row' && g.mode === 'add',
    )!;
    expect(
      applyBodyRewrite(body, {
        kind: 'csv-shape',
        line: Number(add.line),
        col: Number(add.col),
        what: 'row',
        mode: 'add',
      }),
    ).toBe('```csv\na,b\nc,d\n,\n```');
  });
});

/**
 * 🔴 **原文を升に焼く**(#418 段①の 2 稿目)。
 *
 * ⚠ 升の中身は inline の markdown として描かれるので、押す側が描かれた字を
 *   読むと `**` が落ちる ── **描いた側が原文を渡す**。
 */
describe('升に原文を焼く(#418 段①)', () => {
  const raws = (html: string): string[] =>
    [...html.matchAll(/data-pkc-cell-raw="([^"]*)"/g)].map((m) => m[1]!);

  it('🔴 装飾のある升でも、原文がそのまま焼かれる', () => {
    const out = renderMarkdown('```csv\n**太字**,ふつう\n```', { interactiveCells: true });
    // 前提 ── 升は本当に markdown として描かれている(原文と描画が違う形)
    expect(out, '前提: 装飾が描かれていない').toContain('<strong>太字</strong>');
    expect(raws(out)).toEqual(['**太字**', 'ふつう']);
  });

  it('🔴 `"` を含む升でも属性が壊れない', () => {
    const out = renderMarkdown('```csv\n"あ""い",b\n```', { interactiveCells: true });
    expect(raws(out)[0]).toBe('あ&quot;い');
  });

  it('🔴 渡さなければ焼かない(書き出し・印刷に余分な属性を出さない)', () => {
    expect(raws(renderMarkdown('```csv\na,b\n```'))).toEqual([]);
  });

  it('⚠ 焼いた原文は、そのまま打ち直しに使える(端どうしが噛み合う)', () => {
    const body = '```csv\n**太字**,い\n```';
    const raw = raws(renderMarkdown(body, { interactiveCells: true }))[0]!;
    // user が末尾に足しただけのつもりで確定する
    expect(applyBodyRewrite(body, { kind: 'csv-cell', line: 1, col: 0, value: `${raw}!` })).toBe(
      '```csv\n**太字**!,い\n```',
    );
  });
});

/**
 * 🔴 **式は描くときだけ評価する**(#418 段②)。
 *
 * 🔑 正本は本文 ── 結果を本文へ書き戻さない(書き戻すと**式が消える**)。
 * ⚠ 押したときに出るのは**式のほう**である(段① の `data-pkc-cell-raw`)。
 */
describe('表の升の式(#418 段②)', () => {
  const cellsOf = (html: string): string[] => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return [...host.querySelectorAll('th, td')].map((c) => c.textContent ?? '');
  };
  const rawOf = (html: string): string[] =>
    [...html.matchAll(/data-pkc-cell-raw="([^"]*)"/g)].map((m) => m[1]!);

  it('🔴 升には結果が出る', () => {
    const out = renderMarkdown('```csv\n2,3,=A1*B1\n```');
    expect(cellsOf(out)).toEqual(['2', '3', '6']);
  });

  it('🔴 押すと式が出る(結果ではない)', () => {
    const out = renderMarkdown('```csv\n2,3,=A1*B1\n```', { interactiveCells: true });
    expect(rawOf(out)[2], '押したら結果が入ってしまう').toBe('=A1*B1');
  });

  it('🔴 本文は 1 バイトも変わらない(結果を書き戻さない)', () => {
    const body = '```csv\n2,3,=A1*B1\n```';
    renderMarkdown(body, { interactiveCells: true });
    // ⚠ 描画は本文を触らない ── 触ったら次に開いたとき式が消えている
    expect(body).toBe('```csv\n2,3,=A1*B1\n```');
    // 🔑 打ち直しも式から始まる(端どうしが噛み合う)
    expect(applyBodyRewrite(body, { kind: 'csv-cell', line: 1, col: 2, value: '=A1+B1' })).toBe(
      '```csv\n2,3,=A1+B1\n```',
    );
  });

  it('🔴 書き出し・印刷でも同じ結果が出る(面で見え方を変えない)', () => {
    // ⚠ 押せる面だけ計算すると、配った HTML と画面で数字が食い違う
    const withCells = renderMarkdown('```csv\n2,3,=A1*B1\n```', { interactiveCells: true });
    expect(cellsOf(withCells).map((c) => c.replace(/[＋×]/g, ''))).toEqual(['2', '3', '6']);
  });

  it("🔴 `'` で始めれば字のまま出る(`=` を書く道を失わない)", () => {
    const out = renderMarkdown("```csv\n'=A1,ふつう\n```");
    expect(cellsOf(out)).toEqual(['=A1', 'ふつう']);
  });

  it('⚠ 誤った式は升に理由が出る(表全体は消えない)', () => {
    const out = renderMarkdown('```csv\n=1/0,=NOPE(),2\n```');
    expect(cellsOf(out)).toEqual(['#DIV/0!', '#NAME?', '2']);
  });

  it('⚠ 升の中の装飾は式の後でも効く(描き方の規則を分けない)', () => {
    const out = renderMarkdown("```csv\n'**太字**,x\n```");
    expect(out, '式にしたら装飾が効かなくなった').toContain('<strong>太字</strong>');
  });
});

/**
 * 🔴 **誤りの理由は升に添える**(#418 段②の 2 稿目)。
 *
 * ⚠ #426 と同じ向き ── 「効かないなら**なぜ効かないか**を出す」。
 */
describe('式の誤りの理由を升に出す(#418 段②)', () => {
  it('🔴 指せば理由が読める', () => {
    const out = renderMarkdown('```csv\n=VLOOKUP(1),2\n```');
    expect(out, '理由が升に付いていない').toMatch(/<th[^>]*title="[^"]*VLOOKUP/);
  });
  it('⚠ 正しい式の升には 1 バイトも足さない(goldens を動かさない)', () => {
    // ⚠ **升だけを見る** ── 塊にはコピーと切替の `title` が元から在る
    //    (1 稿目は `not.toContain('title=')` と広く書いて、それに満たされて落ちた)
    const ok = renderMarkdown('```csv\n=1+1,2\n```');
    expect(ok, '前提: 式が計算されていない').toContain('<th>2</th>');
    expect(ok.match(/<t[hd][^>]*title=/), '正しい升に理由が付いた').toBeNull();
  });
  it('⚠ 理由の中の `"` で属性が壊れない', () => {
    const out = renderMarkdown('```csv\n=A"\n```');
    expect(out).toContain('#ERR!');
    // 空振り防止 ── 属性として読める形のまま
    expect(out.match(/title="[^"]*"/)).not.toBeNull();
  });
});

/**
 * 🔴 **引用(`>`)の中の csv の囲みも、升を押して打てる**(#775)。
 *
 * > user から見た形: 引用の中に csv を書くと**升は押せて、欄が開いて、字も打てる**。
 * > ところが確定すると「本文が変わっているため反映できませんでした」と出て、
 * > **打った字は消えていた**(実測 2026-09-07:焼いた升 4 / 書けた升 0)。
 *
 * 🔑 根は「同じ問いに答える口が 2 つ」(CLAUDE.md §7)── 焼く側(markdown-it)は
 *   引用を 1 段剥がして囲みを読むのに、書く側の走査(`allFences`)は
 *   **引用の中の柵を 1 本も見なかった**。
 *
 * ⚠ ここは**前置きが 1 文字も動かないこと**を字面で見る ── 描いた表だけを見ると、
 *   前置きを食っても引用が 1 段浅くなるだけで**表は同じに見える**。
 */
describe('引用の中の csv の升を打つ(#775)', () => {
  const write = (body: string, line: number, col: number, value: string): string | null =>
    applyBodyRewrite(body, { kind: 'csv-cell', line, col, value });
  const shape = (
    body: string,
    line: number,
    col: number,
    what: 'row' | 'col',
    mode: 'add' | 'remove',
  ): string | null => applyBodyRewrite(body, { kind: 'csv-shape', line, col, what, mode });

  const Q = '> ```csv\n> 品名,数\n> りんご,3\n> ```\n';

  it('🔴 升を打つと、引用の前置きはそのまま残る', () => {
    expect(write(Q, 2, 0, 'みかん')).toBe('> ```csv\n> 品名,数\n> みかん,3\n> ```\n');
  });

  it('🔴 行を足すと、足した行にも同じ前置きが付く', () => {
    // ⚠ 付けないと引用の外へ落ちて、そこで囲みが閉じる(表が真っ二つになる)
    expect(shape(Q, 2, 0, 'row', 'add')).toBe('> ```csv\n> 品名,数\n> りんご,3\n> ,\n> ```\n');
  });

  it('🔴 列を足す / 消すも、前置きの外は触らない', () => {
    expect(shape(Q, 1, 1, 'col', 'add')).toBe('> ```csv\n> 品名,数,\n> りんご,3,\n> ```\n');
    expect(shape(Q, 1, 1, 'col', 'remove')).toBe('> ```csv\n> 品名\n> りんご\n> ```\n');
  });

  /**
   * 🔴 **剥がすのは「囲みが居る深さ」だけ**(1 段)。
   *
   * ⚠ 読み手も 1 段しか剥がさない ── `> ``` ` の中に `>> a,b` と書くと、
   *   1 つ目の升の字は **`> a`**(`>` が 1 つ残る)。全段まとめて剥がすと
   *   画面と書き戻しが食い違う。
   */
  it('🔴 深さが途中で増えても、剥がすのは 1 段だけ', () => {
    const body = '> ```csv\n>> a,b\n> ```\n';
    expect(write(body, 1, 0, 'ZQZ'), '2 段目まで剥がした').toBe('> ```csv\n>ZQZ,b\n> ```\n');
  });

  /**
   * 🔴 **素の囲みの中の `> ` は升の字である**(対照群)。
   *
   * ⚠ 行ごとに前置きを数えると、ここを引用と読んで**user の字を食う**。
   *   読み手も `> a` を 1 つ目の升として渡してくる(実測)。
   */
  it('🔴 引用の外の囲みでは、`> ` を升の字として扱う', () => {
    const body = '```csv\n> a,b\n1,2\n```\n';
    expect(write(body, 1, 0, 'ZQZ')).toBe('```csv\nZQZ,b\n1,2\n```\n');
  });

  /**
   * 🔴 **閉じが来ていない囲みは、末尾までが中身**(#775)。
   *
   * ⚠ 直す前は閉じの有無に関わらず「閉じの手前まで」だったので、最後の行が
   *   **押せるのに書けない**形だった。素の本文では末尾の空行が閉じの代わりに
   *   なって**偶然当たっていた**ので、露見したのはこの 2 形である。
   */
  it('🔴 閉じない囲みでも、最後の行が打てる(引用の中・素のどちらも)', () => {
    expect(write('> ```csv\n> a,b\n', 1, 1, 'ZQZ'), '引用の中').toBe('> ```csv\n> a,ZQZ\n');
    expect(write('```csv\na,b', 1, 1, 'ZQZ'), '末尾に改行が無い').toBe('```csv\na,ZQZ');
  });

  it('⚠ 前置きの数が足りない行は、この囲みの行ではないので断る', () => {
    // 🔑 対照群 ── 同じ本文の、深さの足りる行は打てる(門が死んでいない)
    const body = '>> ```csv\n>> a,b\n> c,d\n>> ```\n';
    expect(write(body, 2, 0, 'ZQZ'), '1 段浅い行を書き換えた').toBeNull();
    expect(write(body, 1, 0, 'ZQZ'), '深さの足りる行が打てない').toBe(
      '>> ```csv\n>> ZQZ,b\n> c,d\n>> ```\n',
    );
  });

  /**
   * 🔴 **空の行(`>` だけ)は、この表の「行」ではない**(変異 M16)。
   *
   * ⚠ 前置きを剥がさずに `trim()` すると、`>` は空でないので**表の行として数えられる**
   *   ── そのあと csv として読めないので、**行・列の ＋ × が丸ごと断られる**
   *   (押しても何も起きない dead click になる)。
   * 🔑 対照群は「空の行を挟んでも、上下の行が同じように動くこと」である。
   */
  it('🔴 引用の中の空の行を挟んでも、行・列の ＋ × は効く', () => {
    const body = '> ```csv\n> a,b\n>\n> 1,2\n> ```\n';
    expect(shape(body, 1, 1, 'col', 'add'), '空の行で列足しが断られた').toBe(
      '> ```csv\n> a,b,\n>\n> 1,2,\n> ```\n',
    );
    expect(shape(body, 1, 1, 'col', 'remove'), '空の行で列消しが断られた').toBe(
      '> ```csv\n> a\n>\n> 1\n> ```\n',
    );
    expect(shape(body, 3, 0, 'row', 'add'), '空の行で行足しが断られた').toBe(
      '> ```csv\n> a,b\n>\n> 1,2\n> ,\n> ```\n',
    );
    // 🔑 空の行そのものは「行」に数えない ── 数えると幅の合わない行が混ざる
    expect(write(body, 3, 0, 'ZQZ')).toBe('> ```csv\n> a,b\n>\n> ZQZ,2\n> ```\n');
  });

  it('⚠ 引用の中の囲みでも、コードの字は書き換えない', () => {
    // 🔴 `txt` は表ではない ── 押せる印も焼かれないが、別の窓から古い依頼が来た日に
    //    囲みの中身を書き換えない(対照群は上の `Q` が持つ)
    expect(write('> ```txt\n> a,b\n> ```\n', 1, 0, 'ZQZ')).toBeNull();
  });
});

/**
 * 🔴 **原文に無い升も打てる**(#780。user 裁定 2026-09-07)。
 *
 * > 「**押したら打てる**」(表の中の「原文に無い升」= 升の数が足りない行の空いている所、
 * > 空行の升)
 *
 * ## なぜ直すのか
 *
 * 読み手は**見出しの列数ぶんに詰め物をして**升を並べるので、升の足りない行にも
 * **押せる印が焼かれる**。⚠ 直す前はそこを書く側が断っていたので、
 * 「**押せる → 打てる → 消える**」だった(実測 2026-09-07:9 升のうち 2 升 /
 * 行・列の ＋ × は 10 個のうち 5 個が dead click)。
 *
 * ⚠ **表の幅を超える依頼は今までどおり断る** ── 焼く側は幅までしか升を出さない。
 */
describe('原文に無い升を打つ(#780)', () => {
  const cell = (body: string, line: number, col: number, value: string): string | null =>
    applyBodyRewrite(body, { kind: 'csv-cell', line, col, value });
  const shape = (
    body: string,
    line: number,
    col: number,
    what: 'row' | 'col',
    mode: 'add' | 'remove',
  ): string | null => applyBodyRewrite(body, { kind: 'csv-shape', line, col, what, mode });

  /** 3 列の表。⚠ 2 行目は**升が 1 つしかない**(読み手は空の升を 2 つ足して描く)。 */
  const SHORT = '```csv\na,b,c\n1\n2,3,4\n```\n';
  /** 空行を挟んだ表(読み手は**空の行**を 1 本描く)。 */
  const BLANK = '```csv\na,b\n\n1,2\n```\n';

  it('🔴 升が足りない行の、空いている升に打てる(区切りを補う)', () => {
    expect(cell(SHORT, 2, 1, 'ZQZ'), '2 列目に打てない').toBe('```csv\na,b,c\n1,ZQZ\n2,3,4\n```\n');
    expect(cell(SHORT, 2, 2, 'ZQZ'), '3 列目に打てない').toBe('```csv\na,b,c\n1,,ZQZ\n2,3,4\n```\n');
  });

  it('🔴 空行の升にも打てる', () => {
    expect(cell(BLANK, 2, 0, 'ZQZ')).toBe('```csv\na,b\nZQZ\n1,2\n```\n');
    expect(cell(BLANK, 2, 1, 'ZQZ')).toBe('```csv\na,b\n,ZQZ\n1,2\n```\n');
  });

  it('🔴 引用の中でも同じ(前置きは 1 文字も動かない)', () => {
    expect(cell('> ```csv\n> a,b,c\n> 1\n> ```\n', 2, 2, 'ZQZ')).toBe(
      '> ```csv\n> a,b,c\n> 1,,ZQZ\n> ```\n',
    );
  });

  /** ⚠ **対照群** ── 焼く側は表の幅までしか升を出さないので、その先は断る。 */
  it('🔴 表の幅を超える升は、今までどおり断る(黙って列を足さない)', () => {
    expect(cell(SHORT, 2, 3, 'ZQZ'), '幅 3 の表の 4 列目に書いた').toBeNull();
    expect(cell(BLANK, 2, 2, 'ZQZ'), '幅 2 の表の 3 列目に書いた').toBeNull();
  });

  /** ⚠ **対照群** ── 空を打っても原文は変わらないので、更新日時を動かさない。 */
  it('⚠ 空を打っても書かない(同じ字なら書かない、と同じ向き)', () => {
    expect(cell(SHORT, 2, 2, '')).toBeNull();
  });

  it('🔴 升が足りない行が在っても、列の ＋ × が効く(その行は飛ばす)', () => {
    // ⚠ 触っていない行(`1`)は**1 バイトも動かない**
    expect(shape(SHORT, 1, 1, 'col', 'add')).toBe('```csv\na,b,,c\n1\n2,3,,4\n```\n');
    expect(shape(SHORT, 1, 2, 'col', 'remove')).toBe('```csv\na,b\n1\n2,3\n```\n');
  });

  it('🔴 升が 1 つしかない行の列を消すと、その行は空になる(例外を投げない)', () => {
    expect(shape(SHORT, 1, 0, 'col', 'remove')).toBe('```csv\nb,c\n\n3,4\n```\n');
  });

  it('🔴 空行でも、行の ＋ × が効く', () => {
    expect(shape(BLANK, 2, 0, 'row', 'add'), '空行から足せない').toBe(
      '```csv\na,b\n\n\n1,2\n```\n',
    );
    expect(shape(BLANK, 2, 0, 'row', 'remove'), '空行を消せない').toBe('```csv\na,b\n1,2\n```\n');
  });

  /** ⚠ **対照群** ── またがっている行は今までどおり**丸ごと**断る。 */
  it('🔴 またがっている行が 1 つでもあれば、列の操作は丸ごと断る', () => {
    expect(shape('```csv\na,b\n"あ\nい",d\n```\n', 1, 0, 'col', 'add')).toBeNull();
  });

  /** ⚠ **対照群** ── 表の幅が 1 なら、列を消すと表そのものが消える。 */
  it('🔴 幅が 1 の表では、最後の 1 列を消さない', () => {
    expect(shape('```csv\na\nb\n```', 1, 0, 'col', 'remove')).toBeNull();
  });
});
