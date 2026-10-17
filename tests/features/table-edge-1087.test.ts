/** @vitest-environment happy-dom */
/**
 * 🔴 **表まわりの 4 件**(#1087 A-3 / A-4 / B-1 / B-5)。
 *
 * - A-3 csv の `""` だけの行 / tsv の全部空の行 … 押せる印が出るのに打てない・＋×が断られる
 * - A-4 csv の升に ``` と打つ … 囲みがそこで閉じて下の本文を飲み込む
 * - B-1 先頭の `|` を省いた markdown の表の 1 列目に記法の字を打つ … 表が切れる
 * - B-5 1 列の markdown 表の末尾の空の行 … csv を経由すると行が減る
 *
 * 🔑 期待値は**実物の読み手**(`renderMarkdown` が焼いた印 / `tableAt`)から採る。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  applyBodyRewrite as applyStrict,
  bodyRewriteRefusal,
} from '../../src/features/markdown/body-rewrite';
import { applyOpened } from '../helpers/open-line';
import { csvEscapeField, parseCsv } from '../../src/features/markdown/csv-table';
import { gfmCellText } from '../../src/features/markdown/html-to-markdown';
import {
  fencesBelowFrontmatter,
  mdCellSpan,
  mdTableAt,
  tableAt,
} from '../../src/features/markdown/table-convert';

const write = (body: string, line: number, col: number, value: string): string | null =>
  applyOpened(body, { kind: 'csv-cell', line, col, value });

/** 描いた表の印(押せる升 / 行・列の ＋ ×)を原文の行・列で返す。 */
function marks(body: string) {
  const html = renderMarkdown(body, { interactiveCells: true });
  const cells = [
    ...html.matchAll(/data-pkc-action="edit-cell" data-pkc-cell-line="(\d+)" data-pkc-cell-col="(\d+)"/g),
  ].map((m) => ({ line: Number(m[1]), col: Number(m[2]) }));
  const shapes = [
    ...html.matchAll(
      /data-pkc-action="shape-cell" data-pkc-cell-line="(\d+)" data-pkc-cell-col="(\d+)" data-pkc-cell-what="(row|col)" data-pkc-cell-mode="(add|remove)"/g,
    ),
  ].map((m) => ({
    line: Number(m[1]),
    col: Number(m[2]),
    what: m[3] as 'row' | 'col',
    mode: m[4] as 'add' | 'remove',
  }));
  return { cells, shapes };
}

describe('A-3 空の行の升を打てる(描いた印と書き戻しの升が一致する)', () => {
  const DELIMS: Array<[string, string]> = [
    ['csv', ','],
    ['tsv', '\t'],
    ['psv', '|'],
  ];
  const KINDS = ['', '""', ' ', 'a'];

  it('🔴 csv / tsv / psv × 1〜4 行 × 1〜4 列 × 空・`""`・空白だけ: 印の出た升・行・列の口が全部効く', () => {
    let tried = 0;
    let onQuotedEmptyRow = 0;
    let onBlankTsvRow = 0;
    for (const [name, d] of DELIMS) {
      for (let rows = 1; rows <= 4; rows++) {
        for (let cols = 1; cols <= 4; cols++) {
          // 行の中身の組(全行が同じ種類 + 1 行目だけ 'a' の組)を総当たりに近く振る
          for (const kind of KINDS) {
            for (const first of ['a', kind]) {
              const lines: string[] = [];
              for (let r = 0; r < rows; r++) {
                const k = r === 0 ? first : kind;
                lines.push(Array.from({ length: cols }, () => k).join(d));
              }
              const body = `\`\`\`${name}\n${lines.join('\n')}\n\`\`\``;
              const m = marks(body);
              const tag = JSON.stringify(body);
              for (const c of m.cells) {
                tried += 1;
                expect(write(body, c.line, c.col, 'Z'), `印が出たのに打てない ${tag} ${c.line}:${c.col}`).not.toBeNull();
                if (cols === 1 && kind === '""' && lines[c.line - 1] === '""') onQuotedEmptyRow += 1;
                if (name === 'tsv' && kind === '' && cols > 1 && c.line >= 1) onBlankTsvRow += 1;
              }
              for (const s of m.shapes) {
                tried += 1;
                const rw = {
                  kind: 'csv-shape' as const,
                  line: s.line,
                  openLine: body.split('\n')[s.line] ?? '',
                  col: s.col,
                  what: s.what,
                  mode: s.mode,
                };
                const out = applyStrict(body, rw);
                // 最後の 1 行・1 列は消さない(理由つきの断り ── 黙った null ではない)
                const reason = bodyRewriteRefusal(body, rw);
                expect(
                  out !== null || reason !== null,
                  `口が出たのに黙って断られる ${tag} ${JSON.stringify(s)}`,
                ).toBe(true);
              }
            }
          }
        }
      }
    }
    // 空振り防止 ── 狙った形が実際に走っている
    expect(tried).toBeGreaterThan(500);
    expect(onQuotedEmptyRow, '`""` の行に印が出ていない').toBeGreaterThan(0);
    expect(onBlankTsvRow, 'tsv の全部空の行に印が出ていない').toBeGreaterThan(0);
  });

  it('🔴 字面: tsv の `\\t\\t` の行の 2 つ目の升に打つと、他の升は 1 バイトも動かない', () => {
    const body = '```tsv\na\tb\tc\n\t\t\nd\te\tf\n```';
    expect(write(body, 2, 1, 'Z')).toBe('```tsv\na\tb\tc\n\tZ\t\nd\te\tf\n```');
    // 行を足す(空の行から)/ 列を足す(その行の升も数える)
    const shape = (line: number, col: number, what: 'row' | 'col', mode: 'add' | 'remove') =>
      applyStrict(body, { kind: 'csv-shape', line, openLine: body.split('\n')[line]!, col, what, mode });
    expect(shape(2, 0, 'row', 'add')).toBe('```tsv\na\tb\tc\n\t\t\n\t\t\nd\te\tf\n```');
    expect(shape(1, 0, 'col', 'add')).toBe('```tsv\na\t\tb\tc\n\t\t\t\nd\t\te\tf\n```');
  });

  it('🔴 字面: 1 列の表の `""` の行に打てる / 行を足せる / 引用符は残る', () => {
    const body = '```csv\n名前\n""\nb\n```';
    expect(write(body, 2, 0, 'Z')).toBe('```csv\n名前\nZ\nb\n```');
    expect(
      applyStrict(body, { kind: 'csv-shape', line: 2, openLine: '""', col: 0, what: 'row', mode: 'add' }),
    ).toBe('```csv\n名前\n""\n\nb\n```');
  });

  it('⚠ parseCsv の返り値の意味は変えない: `""` だけの表は 0 行に畳む', () => {
    expect(parseCsv('""', ',')).toBeNull();
    expect(parseCsv('\t', '\t')).toBeNull();
    // 対照: 前に行が在れば `""` の行は残る(B-5)/ 空行は従来どおり捨てる
    expect(parseCsv('a\n""', ',')).toEqual([['a'], ['']]);
    expect(parseCsv('a\n\n', ',')).toEqual([['a']]);
  });
});

describe('A-4 ``` と打っても囲みが閉じない', () => {
  const VALUES = ['```', '``` ', '```js', '  ```', '~~~', '~~~ \t', '````'];
  const CASES: Array<{ name: string; body: string; line: number; col: number }> = [
    { name: '1 列の csv', body: '```csv\n名前\nりんご\n```', line: 2, col: 0 },
    { name: '右が空の tsv', body: '```tsv\na\t\nb\t\n```', line: 2, col: 0 },
    { name: '先頭の升の csv', body: '```csv\na,b\nc,d\n```', line: 2, col: 0 },
  ];
  for (const c of CASES) {
    it(`🔴 ${c.name}: 囲みの外が 1 字も動かず、囲みは 1 つのまま、升に値が入る`, () => {
      const body = `前\n\n${c.body}\n\n後ろの本文\n- 箇条書き\n`;
      const shift = 2; // 前の 2 行
      for (const v of VALUES) {
        const out = write(body, c.line + shift, c.col, v);
        expect(out, `書けない ${JSON.stringify(v)}`).not.toBeNull();
        const outLines = out!.split('\n');
        const inLines = body.split('\n');
        expect(outLines.length, `行数が変わった ${JSON.stringify(v)}`).toBe(inLines.length);
        // 囲みの外(前 2 行と、囲みの閉じ以降)は不変
        const closeAt = shift + c.body.split('\n').length - 1;
        expect(outLines.slice(0, shift)).toEqual(inLines.slice(0, shift));
        expect(outLines.slice(closeAt), `囲みの外が動いた ${JSON.stringify(v)}`).toEqual(inLines.slice(closeAt));
        // 囲みは 1 つのまま、同じ範囲
        const fences = fencesBelowFrontmatter(out!);
        expect(fences, `囲みの数 ${JSON.stringify(v)}`).toHaveLength(1);
        expect(fences[0]!.start).toBe(shift);
        expect(fences[0]!.end).toBe(closeAt);
        // 升の字は引用符でくるまれて、読み戻すと打った字になる
        const inner = outLines.slice(shift + 1, closeAt).join('\n');
        const rows = parseCsv(inner, c.body.startsWith('```tsv') ? '\t' : ',')!;
        expect(rows[c.line - 1]![c.col], `読み戻した字 ${JSON.stringify(v)}`).toBe(v);
      }
    });
  }

  it('⚠ 柵に見えない字は包まない(字面が太らない)', () => {
    for (const v of ['``', 'a```', '    ```', '`` `', '~~', 'x ~~~']) {
      expect(csvEscapeField(v, ','), v).toBe(v);
    }
    expect(csvEscapeField('```', ',')).toBe('"```"');
    expect(csvEscapeField('   ~~~x', ',')).toBe('"   ~~~x"');
  });
});

describe('B-1 先頭の `|` を省いた表の 1 列目に記法の字を打っても表が切れない', () => {
  const TABLE = ['前の段落', '', '見出し1 | 見出し2', '--- | ---', 'x | y', 'p | q', '', '後ろ'].join('\n');
  const VALUES = ['- x', '# 見出し', '1. x', '::: ', '~~~', '```', '    x', '   ', '', '> q', '+ z', '* z', '1) z'];
  const shape = (body: string, line: number) => {
    const t = mdTableAt(body, line);
    return t === null ? null : { start: t.start, end: t.end, cells: mdCellCountOf(body.split('\n')[line]!) };
  };
  const mdCellCountOf = (line: string): number => {
    let n = 0;
    while (mdCellSpan(line, n) !== null) n += 1;
    return n;
  };

  it('🔴 データ行・見出し行のどちらでも、書いた後も表の範囲と升の数が同じ', () => {
    let wrapped = 0;
    for (const line of [2, 4, 5]) {
      for (const v of VALUES) {
        const before = shape(TABLE, line);
        expect(before, '前提: 表の行ではない').not.toBeNull();
        const out = write(TABLE, line, 0, v);
        expect(out, `書けない ${JSON.stringify(v)}`).not.toBeNull();
        expect(shape(out!, line), `表が崩れた line=${line} ${JSON.stringify(v)}`).toEqual(before);
        // 他の行は 1 字も動かない
        const a = TABLE.split('\n');
        const b = out!.split('\n');
        expect(b.length).toBe(a.length);
        for (let i = 0; i < a.length; i++) if (i !== line) expect(b[i]).toBe(a[i]);
        if (b[line]!.startsWith('| ')) wrapped += 1;
      }
    }
    // 空振り防止 ── 頭に `| ` を足した形が実際に在る
    expect(wrapped).toBeGreaterThan(10);
  });

  it('🔴 書いた字は 1 列目の升に入る(2 列目は動かない)', () => {
    const out = write(TABLE, 4, 0, '- x')!;
    const line = out.split('\n')[4]!;
    const s0 = mdCellSpan(line, 0)!;
    const s1 = mdCellSpan(line, 1)!;
    expect(line.slice(s0.start, s0.end)).toBe(gfmCellText('- x'));
    expect(line.slice(s1.start, s1.end)).toBe('y');
  });

  it('⚠ 引用の中でも前置きの内側に足す', () => {
    const body = '> a | b\n> --- | ---\n> x | y';
    const out = write(body, 2, 0, '- x')!;
    expect(out).toBe('> a | b\n> --- | ---\n> | - x | y');
    expect(shape(out, 2)).toEqual(shape(body, 2));
  });

  it('⚠ 崩れない書き方は 1 字も変えない(`| ` を足さない / 先頭の `|` が在る行 / 2 列目)', () => {
    expect(write(TABLE, 4, 0, 'X')!.split('\n')[4]).toBe('X | y');
    expect(write(TABLE, 4, 1, '- y')!.split('\n')[4]).toBe('x | - y');
    const piped = ['| a | b |', '|---|---|', '| x | y |'].join('\n');
    expect(write(piped, 2, 0, '- x')!.split('\n')[2]).toBe('| - x | y |');
    expect(write(piped, 2, 0, '')!.split('\n')[2]).toBe('|  | y |');
  });
});

describe('B-5 1 列の markdown 表の末尾の空の行は、csv を経由しても消えない', () => {
  const toCsv = (body: string) => {
    return applyStrict(body, { kind: 'table-format', line: 0, openLine: body.split('\n')[0]!, to: 'csv' });
  };
  const rowsOf = (body: string): number => tableAt(body, 0)!.rows.length;

  for (const tail of [1, 2]) {
    it(`🔴 末尾の空の行 ${tail} 行: markdown → csv → markdown で行数が変わらない`, () => {
      const md = ['| 名前 |', '|---|', '| a |', ...Array.from({ length: tail }, () => '|  |')].join('\n');
      const before = rowsOf(md);
      const csv = toCsv(md)!;
      expect(csv, '前提: 末尾の空の行が csv に残っていない').toContain('\n""');
      expect(rowsOf(csv), 'csv にした時点で行が減った').toBe(before);
      const back = applyStrict(csv, {
        kind: 'table-format',
        line: 0,
        openLine: csv.split('\n')[0]!,
        to: 'markdown',
      })!;
      expect(rowsOf(back), '往復で行が減った').toBe(before);
    });
  }

  it('⚠ 2 列以上や、末尾が空でない表は今までと同じ字になる', () => {
    expect(toCsv('| a | b |\n|---|---|\n| 1 | |')).toBe('```csv\na,b\n1,\n```');
    expect(toCsv('| 名前 |\n|---|\n| a |')).toBe('```csv\n名前\na\n```');
  });
});
