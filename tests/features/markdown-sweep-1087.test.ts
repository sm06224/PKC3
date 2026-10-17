/** @vitest-environment node */
/**
 * #1087 の全数調査で見つかった markdown の描画の欠陥 5 件(M1 / M2 / M3 / M4 / M5。M8 は取り下げ: 行内コードの中も置き換わるのはマニュアルに書いた仕様)。
 * どれも「直す前の実装へ戻すと落ちる」形で書く(各 it の入力は調査の再現入力)。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { ensureBlankAroundColonBlocksWithLineMap } from '../../src/features/markdown/colon-block-normalize';

const identity = (s: string): number[] => s.split('\n').map((_, i) => i);
const taskLines = (html: string): number[] =>
  [...html.matchAll(/data-pkc-task-line="(\d+)"/g)].map((m) => Number(m[1]));

describe('M1: fence の中の `:::` 行に空行を挿さない', () => {
  it('``` の中は 1 字も変わらず、lineMap も恒等', () => {
    const src = '```\n:::format{class=k}\n本文\n:::\n```';
    const r = ensureBlankAroundColonBlocksWithLineMap(src, identity(src));
    expect(r.transformed).toBe(src);
    expect(r.lineMap).toEqual([0, 1, 2, 3, 4]);
  });
  it('~~~ でも同じ。fence の外の `:::` には従来どおり空行が入る', () => {
    const src = '~~~\n:::a\n~~~\n文\n:::b\n本文\n:::';
    const r = ensureBlankAroundColonBlocksWithLineMap(src, identity(src));
    expect(r.transformed).toBe('~~~\n:::a\n~~~\n文\n\n:::b\n\n本文\n\n:::');
  });
  it('描画: コードの表示に空行が増えない', () => {
    const html = renderMarkdown('```\n:::format{class=k}\n本文\n:::\n```');
    expect(html).toContain(':::format{class=k}\n本文\n:::');
  });
  it('fence の後ろの task は原文の行(index 4)を指したまま', () => {
    const html = renderMarkdown('```\n:::a\n:::\n```\n- [ ] x', { interactiveTasks: true });
    expect(taskLines(html)).toEqual([4]);
  });
});

describe('M2: `:::toc` の前後に空行が無くても目次になる', () => {
  const cases = ['# h\n:::toc\nbody', ':::toc\nfoo', 'text\n:::toc', '- a\n  :::toc'];
  for (const src of cases) {
    it(JSON.stringify(src), () => {
      const html = renderMarkdown(src);
      expect(html).toContain('pkc-toc');
      // 目印の字(私用領域)が画面に漏れない
      expect(html).not.toMatch(/[-]/);
    });
  }
  it('隣の字は消えない', () => {
    const html = renderMarkdown('text\n:::toc\nbody');
    expect(html).toContain('text');
    expect(html).toContain('body');
  });
  it('目次の後ろの task は原文の行(index 2)を指す', () => {
    const html = renderMarkdown('# h\n:::toc\n- [ ] t', { interactiveTasks: true });
    expect(taskLines(html)).toEqual([2]);
  });
});

describe('M3: 表の行を寄せの印として食わない', () => {
  it('先頭のセルが空の行 `|| A | B |`', () => {
    const html = renderMarkdown('|x|y|\n|-|-|\n|| A | B |');
    expect(html).toContain('<table');
    expect(html).toMatch(/<td[^>]*>\s*A\s*<\/td>/);
  });
  it('先頭のセルが `<` `>` で始まる行', () => {
    const html = renderMarkdown('|条件|値|\n|-|-|\n|<10|a|\n|>=18|b|');
    expect(html).toContain('<table');
    expect(html).toContain('&lt;10');
    expect(html).toContain('&gt;=18');
  });
  it('対照: 表でない `|> 右寄せ` は従来どおり寄せの印', () => {
    const html = renderMarkdown('|> 右寄せ');
    expect(html).not.toContain('|&gt;');
    expect(html).toContain('右寄せ');
  });
});

describe('M4: 閉じた強調で始まる行を字下げにしない', () => {
  it('`__bold__ rest`', () => {
    expect(renderMarkdown('__bold__ rest')).toContain('<strong>bold</strong>');
  });
  it('`__init__.py is…`', () => {
    expect(renderMarkdown('__init__.py is a file')).toContain('<strong>init</strong>.py');
  });
  it('対照: 閉じの無い `__段落` は従来どおり字下げ(`__` は消える)', () => {
    const html = renderMarkdown('__段落です');
    expect(html).not.toContain('__');
    expect(html).toContain('段落です');
    expect(html).not.toContain('<strong>');
  });
});

describe('M5: 段落の直後(空行なし)の `$$` 数式ブロック', () => {
  it('段落 → $$ … $$', () => {
    const html = renderMarkdown('前の行\n$$\nx^2\n$$\n後ろ');
    expect(html).not.toContain('<p>$$');
    expect(html).toContain('pkc-math');
    expect(html).toContain('後ろ');
  });
  it('閉じの無い `$$` は素の段落のまま', () => {
    const html = renderMarkdown('前の行\n$$\nx^2');
    expect(html).toContain('$$');
    expect(html).not.toContain('pkc-math');
  });
});
