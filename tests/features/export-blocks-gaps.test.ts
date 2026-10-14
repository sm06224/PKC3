/** @vitest-environment happy-dom */
/**
 * 🔴 **書き出しの中身が欠ける物**(#1087)── Word / PowerPoint の塊を作る所(`html-blocks.ts`)。
 *
 * 守る主張:
 * 1. 引用の中に段落が 1 つでも在っても、箇条書き・コード・入れ子の引用・見出しが消えない。
 *    ⚠ 見るのは塊だけでなく、**Word の document.xml と PowerPoint の slide1.xml に字が届くこと**(出口 2 つ)。
 * 2. 箇条書きの項目の中のコード枠・表は、項目の字に潰れず別の塊として項目の後ろへ出る。コピーボタンの字は混ざらない。
 * 3. 表のセルの中の箇条書きが `ab` につながらない。
 */
import { describe, expect, it } from 'vitest';
import { buildDocx, type DocxBlock } from '@features/export/docx';
import { buildPptx } from '@features/export/pptx';
import { htmlToDocxBlocks } from '@adapter/platform/export/html-blocks';
import { renderMarkdown } from '@features/markdown/markdown-render';

const blocksOfHtml = (html: string): DocxBlock[] => {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return htmlToDocxBlocks(doc).blocks;
};
const blocksOfMd = (md: string): DocxBlock[] => blocksOfHtml(renderMarkdown(md));
const textOf = (b: DocxBlock): string =>
  'runs' in b ? b.runs.map((r) => r.text).join('') : 'text' in b ? b.text : '';
const docXml = (blocks: DocxBlock[]): string =>
  buildDocx(blocks, 'T', '2026-10-14T00:00:00.000Z').parts.find((x) => x.name === 'word/document.xml')!.text;
const slideXml = (blocks: DocxBlock[]): string =>
  buildPptx(blocks, { title: 'T' }).parts.find((x) => x.name === 'ppt/slides/slide1.xml')!.text;

describe('🔴 引用の中身が最初の段落だけにならない', () => {
  it('引用の中の段落 + 箇条書き: 両方が残る', () => {
    const blocks = blocksOfMd('> intro\n>\n> - x\n> - y');
    expect(blocks.map((b) => `${b.kind}:${textOf(b)}`)).toEqual(['quote:intro', 'li:x', 'li:y']);
  });

  it('引用の中のコード・入れ子の引用・見出しが残り、字を持つ塊は引用になる', () => {
    const blocks = blocksOfMd('> a\n>\n> > nested\n>\n> ## head\n>\n> ```\n> c\n> ```');
    expect(blocks.map((b) => `${b.kind}:${textOf(b)}`)).toEqual([
      'quote:a', 'quote:nested', 'quote:head', 'code:c\n',
    ]);
    // 見出しは引用の中でも見出しだと分かる(太字)
    expect(blocks[2]).toMatchObject({ runs: [{ bold: true }] });
  });

  it('段落の無い引用(字だけ)は今までどおり 1 つの引用', () => {
    expect(blocksOfHtml('<blockquote>ただの字</blockquote>')).toEqual([
      { kind: 'quote', runs: [{ text: 'ただの字' }] },
    ]);
  });

  it('出口 2 つ: Word の document.xml と PowerPoint の slide1.xml に箇条書きの字が届く', () => {
    const blocks = blocksOfMd('> intro\n>\n> - ぎゅうにゅう\n> - たまご');
    for (const [name, xml] of [['Word', docXml(blocks)], ['PowerPoint', slideXml(blocks)]] as const) {
      expect(xml, `${name} に intro`).toContain('intro');
      expect(xml, `${name} に箇条書き 1`).toContain('ぎゅうにゅう');
      expect(xml, `${name} に箇条書き 2`).toContain('たまご');
    }
  });
});

describe('🔴 箇条書きの項目の中の塊', () => {
  it('コード枠は項目の後ろの別の塊。コピーボタンの字(⧉)が項目に混ざらない', () => {
    const blocks = blocksOfMd('- item\n\n  ```js\n  const a=1;\n  ```\n- two');
    expect(blocks.map((b) => b.kind)).toEqual(['li', 'code', 'li']);
    expect(textOf(blocks[0]!)).toBe('item');
    expect(blocks[1]).toMatchObject({ kind: 'code', text: 'const a=1;\n', lang: 'js' });
    expect(textOf(blocks[2]!)).toBe('two');
    for (const b of blocks) expect(textOf(b)).not.toContain('⧉');
  });

  it('表は項目の字に潰れず、表の塊として出る', () => {
    const blocks = blocksOfMd('- item\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n');
    expect(blocks.map((b) => b.kind)).toEqual(['li', 'table']);
    expect(textOf(blocks[0]!)).toBe('item');
    const t = blocks[1] as Extract<DocxBlock, { kind: 'table' }>;
    expect(t.rows.map((r) => r.map((c) => c.runs.map((x) => x.text).join('')))).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('項目の中の入れ子の箇条書きと、塊の順序が保たれる(字 → 塊 → 入れ子)', () => {
    const blocks = blocksOfHtml(
      '<ul><li><p>親</p><pre><code>X</code></pre><ul><li>子</li></ul></li><li>次</li></ul>',
    );
    expect(blocks.map((b) => `${b.kind}:${textOf(b)}`)).toEqual(['li:親', 'code:X', 'li:子', 'li:次']);
    expect(blocks[2]).toMatchObject({ depth: 1 });
  });

  it('画面の道具(button)は走りに入らない', () => {
    const blocks = blocksOfHtml('<p>本文<button class="pkc-md-copy-btn">⧉</button></p>');
    expect(blocks).toEqual([{ kind: 'p', runs: [{ text: '本文' }] }]);
    const li = blocksOfHtml('<ul><li>項目<button>⧉</button><span class="pkc-md-copy-btn">▾</span></li></ul>');
    expect(textOf(li[0]!)).toBe('項目');
  });
});

describe('🔴 表のセルの中の箇条書き', () => {
  it('a と b が「ab」につながらず、行が分かれる', () => {
    const blocks = blocksOfHtml('<table><tr><td><ul><li>a</li><li>b</li></ul></td></tr></table>');
    const t = blocks[0] as Extract<DocxBlock, { kind: 'table' }>;
    expect(t.rows[0]![0]!.runs.map((r) => r.text).join('')).toBe('a\nb');
  });

  it('対照群: 改行を含まない行内の要素は今までどおり(余計な改行を入れない)', () => {
    const blocks = blocksOfHtml('<table><tr><td>あ<em>い</em>\n<em>う</em></td></tr></table>');
    const t = blocks[0] as Extract<DocxBlock, { kind: 'table' }>;
    expect(t.rows[0]![0]!.runs.map((r) => r.text).join('')).toBe('あい う');
  });

  it('ul の後ろの字は別の行', () => {
    const blocks = blocksOfHtml('<table><tr><td><ul><li>a</li></ul>後ろ</td></tr></table>');
    const t = blocks[0] as Extract<DocxBlock, { kind: 'table' }>;
    expect(t.rows[0]![0]!.runs.map((r) => r.text).join('')).toBe('a\n後ろ');
  });
});
