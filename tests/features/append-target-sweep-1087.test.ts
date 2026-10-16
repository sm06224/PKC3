/**
 * #1087 追記の入り先の見直し ── 取り消しの位置 / 囲み(fence)の閉じ / 目次との食い違い / CRLF。
 *
 * 守るのは「追記の入り先の一覧が、描画・目次と同じ見出しの集合である」ことと、
 * 「取り消しが、さっき足した行を消す」こと。
 */
import { describe, expect, it } from 'vitest';
import {
  appendIntoSection,
  insertedRun,
  listAppendTargets,
  removeInsertedLines,
} from '../../src/features/markdown/append-target';
import { extractHeadingsFromMarkdown } from '../../src/features/markdown/markdown-toc';
import { advanceFence, renumberLists } from '../../src/features/markdown/list-renumber';

const texts = (body: string): string[] => listAppendTargets(body).map((t) => t.text);
const slugOf = (body: string, text: string): string =>
  listAppendTargets(body).find((t) => t.text === text)!.slug;

describe('1. 取り消しは「さっき足した所」を消す', () => {
  const BASE = '# A\nx\n\n# B\ny\n';

  it('🔴 B に「済」→ A に「済」→ 取り消すと、A の「済」が消え B の「済」は残る', () => {
    const afterB = appendIntoSection(BASE, slugOf(BASE, 'B'), null, '済')!;
    const afterA = appendIntoSection(afterB, slugOf(afterB, 'A'), null, '済')!;
    const run = insertedRun(afterB, afterA)!;
    // 前提: 2 つの「済」は別の場所に在り、足した行は 1 つ目より前に在る
    expect(afterA.split('\n').filter((l) => l === '済')).toHaveLength(2);
    // 取り消し(位置つき)
    const undone = removeInsertedLines(afterA, run.lines, run.at)!;
    expect(undone).toBe(afterB);
    expect(undone.split('\n').indexOf('済'), 'B の済が残っていない').toBeGreaterThan(
      undone.split('\n').indexOf('# B'),
    );
    // 対照群(位置なし = 従来の規則)は、後ろの一致 = B の「済」を消してしまう
    expect(removeInsertedLines(afterA, run.lines)).not.toBe(afterB);
  });

  it('位置の行が別の窓で動いていたら、従来どおり後ろの一致へ落ちる(消せないよりよい)', () => {
    const afterB = appendIntoSection(BASE, slugOf(BASE, 'B'), null, '済')!;
    const afterA = appendIntoSection(afterB, slugOf(afterB, 'A'), null, '済')!;
    const run = insertedRun(afterB, afterA)!;
    const shifted = `別の窓の行\n${afterA}`;
    // 位置は 1 行ずれて一致しない → 後ろの一致で消える(= 従来の挙動)
    expect(removeInsertedLines(shifted, run.lines, run.at)).toBe(
      removeInsertedLines(shifted, run.lines),
    );
  });

  it('位置が範囲の外でも落ちない', () => {
    expect(removeInsertedLines('a\nb', ['b'], 99)).toBe('a');
    expect(removeInsertedLines('a\nb', ['b'], -1)).toBe('a');
  });

  it('insertedRun: 足した行と位置を返し、純粋な挿入でなければ null', () => {
    expect(insertedRun('a\nc', 'a\nb\nc')).toEqual({ at: 1, lines: ['b'] });
    expect(insertedRun('a\nc', 'a\nx')).toBeNull();
  });
});

describe('2. fence の閉じは、同じ記号で同じ長さ以上', () => {
  it('advanceFence: 長さと種類を見る', () => {
    const open4 = advanceFence('', '````md');
    expect(open4).not.toBe('');
    expect(advanceFence(open4, '```'), '短い記号では閉じない').toBe(open4);
    expect(advanceFence(open4, '~~~~'), '別の種類では閉じない').toBe(open4);
    expect(advanceFence(open4, '`````'), '長い記号で閉じる').toBe('');
    expect(advanceFence(open4, '````')).toBe('');
    const tilde = advanceFence('', '~~~');
    expect(advanceFence(tilde, '```'), '``` は ~~~ を閉じない').toBe(tilde);
    expect(advanceFence(tilde, '~~~ x'), '中身のある行は閉じではない').toBe(tilde);
    expect(advanceFence('', '```x```'), '行内のコードは fence ではない').toBe('');
  });

  const FOUR = ['# A', '', '````md', '```', '# in', '```', '````', '', '# B', ''].join('\n');
  it('追記先: 4 つの記号の中の ``` で閉じた扱いにならず、後ろの # B が見える', () => {
    expect(texts(FOUR)).toEqual(['A', 'B']);
  });
  it('目次: 同じ本文で # B が見える', () => {
    expect(extractHeadingsFromMarkdown(FOUR).map((h) => h.text)).toEqual(['A', 'B']);
  });

  const TILDE = ['# A', '', '```', '~~~', '# fake', '~~~', '```', '', '# B', ''].join('\n');
  it('追記先: ``` の中の ~~~ は閉じではなく、中の # fake は見出しにならない', () => {
    expect(texts(TILDE)).toEqual(['A', 'B']);
  });
  it('目次: 同じ本文で # fake を拾わず # B を拾う', () => {
    expect(extractHeadingsFromMarkdown(TILDE).map((h) => h.text)).toEqual(['A', 'B']);
  });

  it('目次の :::if 除去: 4 つの記号の中の ``` で閉じた扱いにならない', () => {
    const src = [
      '````md',
      '```',
      ':::if{format=pdf}',
      '```',
      '````',
      '',
      '# 残る',
      '',
      ':::if{format=pdf}',
      '# 消える',
      ':::',
      '',
    ].join('\n');
    // 直す前: ``` で fence が閉じたことになり、fence の中の `:::if{format=pdf}` が本物の開きに読まれ、
    // 以降の「# 残る」まで消えた
    expect(extractHeadingsFromMarkdown(src).map((h) => h.text)).toEqual(['残る']);
  });

  it('番号の振り直し: 4 つの記号の中の ``` の下の番号を触らない', () => {
    const src = ['````', '```', '5. 触らない', '```', '````', '', '3. 振り直す', ''].join('\n');
    expect(renumberLists(src)).toBe(['````', '```', '5. 触らない', '```', '````', '', '1. 振り直す', ''].join('\n'));
  });
});

describe('3. 追記先の見出しは、目次・描画と同じ集合', () => {
  it('(a) 下線の見出し(=== / ---)も選べ、その節の末尾に入る', () => {
    const body = ['A', '===', '', 'a 本文', '', 'B', '===', '', 'b 本文', '', 'C', '---', '', 'c 本文', ''].join('\n');
    expect(listAppendTargets(body).map((t) => [t.text, t.level])).toEqual([
      ['A', 1],
      ['B', 1],
      ['C', 2],
    ]);
    const next = appendIntoSection(body, slugOf(body, 'A'), null, '足す')!;
    expect(next).toBe(
      ['A', '===', '', 'a 本文', '', '足す', '', 'B', '===', '', 'b 本文', '', 'C', '---', '', 'c 本文', ''].join('\n'),
    );
    // 深さ 2 の下線(---)の節は、その中(次の同格以上の手前 = 末尾)へ入る
    const inC = appendIntoSection(body, slugOf(body, 'C'), null, '足す')!;
    expect(inC.indexOf('足す')).toBeGreaterThan(inC.indexOf('c 本文'));
  });

  it('(a) 水平線(段落の無い ---)は見出しにしない', () => {
    expect(texts(['# A', '', '---', '', '本文', ''].join('\n'))).toEqual(['A']);
  });

  it('(b) :::comment と %%% の中の # は選べない(目次と同じ)', () => {
    const body = [
      '# A',
      '',
      ':::comment',
      '# 隠れ 1',
      ':::',
      '',
      '%%%',
      '# 隠れ 2',
      '%%%',
      '',
      '# B',
      '',
    ].join('\n');
    expect(texts(body)).toEqual(['A', 'B']);
    // 節の範囲は原文の行で解ける(B の見出しの行が原文のまま)
    const next = appendIntoSection(body, slugOf(body, 'A'), null, '足す')!;
    expect(next.indexOf('足す')).toBeLessThan(next.indexOf('# B'));
    expect(next.indexOf('足す')).toBeGreaterThan(next.indexOf('%%%\n# 隠れ 2\n%%%'));
  });

  it('目次(注入つき)と追記先の見出しの字が揃う', async () => {
    const { stripComments } = await import('../../src/features/markdown/markdown-render');
    const body = ['Z', '===', '', '%%%', '# 隠れ', '%%%', '', '## 子', '', '````', '# コード', '````', ''].join('\n');
    const toc = extractHeadingsFromMarkdown(body, {
      stripHidden: (s) => stripComments(s).transformed,
      blockForms: true,
    }).map((h) => h.text);
    expect(texts(body)).toEqual(toc);
    expect(toc).toEqual(['Z', '子']);
  });

  it('(c) $$ の塊と <pre> の中の # は描画が見出しにしないので選べない', () => {
    const body = ['# A', '', '$$', '# 式の中', '$$', '', '<pre>', '# pre の中', '</pre>', '', '# B', ''].join('\n');
    expect(texts(body)).toEqual(['A', 'B']);
  });

  it('(c) 閉じの無い $$ は塊ではない(後ろの見出しを巻き込まない)', () => {
    expect(texts(['# A', '', '$$', '# B', ''].join('\n'))).toEqual(['A', 'B']);
  });
});

describe('4. 閉じの # は前に空白が要る', () => {
  it('追記先: ## C# は「C#」', () => {
    expect(texts('## C#\n\n本文\n')).toEqual(['C#']);
    expect(texts('## C ##\n')).toEqual(['C']);
    expect(texts('# 1#\n')).toEqual(['1#']);
  });
  it('目次: ## C# は「C#」', () => {
    expect(extractHeadingsFromMarkdown('## C#\n').map((h) => h.text)).toEqual(['C#']);
    expect(extractHeadingsFromMarkdown('## C ##\n').map((h) => h.text)).toEqual(['C']);
    expect(
      extractHeadingsFromMarkdown('> ## C#\n', { blockForms: true }).map((h) => h.text),
    ).toEqual(['C#']);
  });
});

describe('5. CRLF の本文へは CRLF で挟む', () => {
  it('節の途中へ挟んでも、LF の行が混ざらない', () => {
    const body = ['# A', '', 'a', '', '# B', 'b', ''].join('\r\n');
    const next = appendIntoSection(body, slugOf(body, 'A'), null, '足す')!;
    expect(next).toBe(['# A', '', 'a', '', '足す', '', '# B', 'b', ''].join('\r\n'));
    expect(next.replace(/\r\n/g, ''), '裸の LF が残っている').not.toContain('\n');
  });
  it('末尾(改行なし)の節へ挟んでも終わりの改行の有無は変えない', () => {
    const body = ['# A', 'a'].join('\r\n');
    const next = appendIntoSection(body, slugOf(body, 'A'), null, '足す')!;
    expect(next).toBe(['# A', 'a', '', '足す'].join('\r\n'));
  });
  it('複数行の字・見出しつきも CRLF', () => {
    const body = ['# A', 'a', '', '# B', ''].join('\r\n');
    const next = appendIntoSection(body, slugOf(body, 'A'), '## 新', '一\n二')!;
    expect(next.replace(/\r\n/g, '')).not.toContain('\n');
    expect(next).toContain('## 新\r\n\r\n一\r\n二');
  });
  it('LF の本文は従来どおり LF のまま', () => {
    const body = '# A\na\n\n# B\n';
    expect(appendIntoSection(body, slugOf(body, 'A'), null, 'x')).toBe('# A\na\n\nx\n\n# B\n');
  });
  it('CRLF でも足した行を取り消せる(位置つき)', () => {
    const body = ['# A', 'a', '', '# B', ''].join('\r\n');
    const next = appendIntoSection(body, slugOf(body, 'A'), null, 'x')!;
    const run = insertedRun(body, next)!;
    expect(removeInsertedLines(next, run.lines, run.at)).toBe(body);
  });
});
