/** @vitest-environment happy-dom */
/**
 * 🔴 ブロック単位のリッチ編集の純関数コア(v4.0 Phase 1 / PR-05)。
 *
 * 観測点は**本物の描き手**(`renderMarkdown`)── 往復の一致は「描き手がそう読む」ことを含めて確かめる
 * (自前の構文解析と比べても、保存された本文の読まれ方は保証できない)。
 */
import { describe, expect, it } from 'vitest';
import {
  canRichEditSafely,
  classifyRichBlock,
  composeRichBlock,
  nextRichMeta,
  parseRichBlock,
  prepareRichBlock,
  PARAGRAPH_META,
  serializeRichBlock,
  serializeRichBlockWithPoints,
  serializeRichInline,
  type RichBlockMeta,
} from '@features/markdown/rich-block';
import { renderMarkdown } from '@features/markdown/markdown-render';
import { spliceLines } from '@features/markdown/edit-journal';

const render = (md: string): string => renderMarkdown(md, {});
const parseDom = (html: string): Element => {
  const t = document.createElement('template');
  t.innerHTML = html;
  const div = document.createElement('div');
  div.append(t.content);
  return div;
};
/** HTML の断片 → 木(ブラウザが作るゴミを模すため)。 */
const dom = (html: string): HTMLElement => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
};
const safe = (src: string): boolean => canRichEditSafely(src, render, parseDom);

describe('classifyRichBlock ── 安全なブロックだけを受ける', () => {
  it.each([
    ['段落', 'こんにちは **太字** と *斜体*', 'paragraph'],
    ['複数行の段落', '一行目\n二行目', 'paragraph'],
    ['空(新しいブロック)', '', 'paragraph'],
    ['見出し 1', '# 題', 'heading'],
    ['見出し 6', '###### 小見出し', 'heading'],
    ['引用', '> 引いた文\n> 続き', 'quote'],
    ['箇条書き -', '- 項目', 'list-item'],
    ['箇条書き *', '* 項目', 'list-item'],
    ['字下げした箇条書き', '    - 子の項目', 'list-item'],
    ['番号付き', '12. 項目', 'list-item'],
    ['番号付き )', '3) 項目', 'list-item'],
    ['チェック', '- [ ] やること', 'list-item'],
    ['チェック済み', '- [x] 済んだ', 'list-item'],
    ['続きの行を持つ項目', '- 項目\n  続き', 'list-item'],
  ])('%s', (_name, src, kind) => {
    expect(classifyRichBlock(src)).toBe(kind);
  });

  it.each([
    ['コードブロック', '```js\nconst a = 1;\n```'],
    ['チルダのコードブロック', '~~~\nx\n~~~'],
    ['数式ブロック', '$$\nx^2\n$$'],
    ['行内の数式', '面積は $x^2$ です'],
    [':::format', ':::format{align=center}\n中央\n:::'],
    [':::details', ':::details 詳しく\n中身\n:::'],
    [':::if', ':::if x\n中身\n:::'],
    ['.pkc-place', ':::pkc-place{x=1}\n:::'],
    ['表', '| a | b |\n|---|---|\n| 1 | 2 |'],
    ['表(先頭の | なし)', 'a | b\n--|--'],
    ['水平線', '---'],
    ['改ページ', '+++'],
    ['脚注の定義', '[^1]: 注'],
    ['脚注の参照', '本文[^1]です'],
    ['frontmatter', '---\ntitle: x\n---'],
    ['HTML ブロック', '<div>x</div>'],
    ['HTML タグ(行内)', 'a <span>b</span> c'],
    ['HTML コメント', 'a <!-- メモ --> c'],
    ['ルビ', '[[ruby:漢字|かんじ]]を読む'],
    ['圏点', 'ここが ^^大事^^ です'],
    ['インラインロール', '押す :kbd:[Ctrl] です'],
    ['画像', '![図](asset:abc)'],
    ['カード', '@[card](entry:abc)'],
    ['差し込み', '名前は {{name}} です'],
    ['逃がしでない \\', 'C:\\path\\to'],
    ['引用の入れ子', '> > 二重'],
    ['引用の中の箇条書き', '> - 項目'],
    ['子を持つ項目', '- 親\n  - 子'],
    ['空行を挟む段落', 'a\n\nb'],
    ['段落の中の箇条書き', '本文\n- 項目'],
    ['setext 見出し', '題\n==='],
    ['閉じの空白の無い見出し', '#題'],
    ['字下げした段落(コード)', '    コード'],
  ])('%s は null(原文の編集へ)', (_name, src) => {
    expect(classifyRichBlock(src)).toBeNull();
  });

  it('メタは元の綴り(記号・字下げ・チェックの字)を保つ', () => {
    expect(parseRichBlock('  * [X] 済み')).toEqual({
      meta: { kind: 'list-item', level: 0, indent: '  ', marker: '*', checked: 'X' },
      content: '済み',
    });
    expect(parseRichBlock('### 題')?.meta.level).toBe(3);
  });
});

describe('canRichEditSafely ── 本物の描き手で往復して 1 バイトも変わらないときだけ', () => {
  it.each([
    'hello **b** *i* ~~s~~ ==m== `c` [l](https://x.y) [e](entry:abc)\nline2',
    '# 見出し **太字**',
    '## 1. はじめに',
    '> 引用 **b**\n> 二行目',
    '- 項目 **b**',
    '  * 字下げ',
    '3. 番号',
    '- [ ] やること',
    '- [x] 済んだ **太字**',
    '- [ ] ',
    '- ',
    'a :under:underline: b :red:#e03131: c :both:underline, #e03131:',
    '**a*b***',
    'a\\*b と \\_x\\_',
    '自動リンク https://example.com です',
    'a_b_c',
    '``a`b``',
    '**:赤い太字:#e03131:**',
    '',
  ])('往復する: %j', (src) => {
    expect(safe(src)).toBe(true);
  });

  it.each([
    ['実体参照(字が変わる)', 'x &amp; y'],
    ['開いたままの記号', 'a `b'],
    ['見出しの閉じの記号', '# 題 #'],
    ['太字の別綴り', '__太字__'],
    ['斜体の別綴り', '_斜体_'],
    ['名前付きの属性', ':字:bold:'],
    ['背景色', ':字:bg-yellow:'],
    ['複数段落の引用', '> a\n>\n> b'],
    ['行末の 2 空白(強制改行)', 'a  \nb'],
  ])('%s は開かない', (_name, src) => {
    expect(safe(src)).toBe(false);
  });

  it('開くときの木には描き手の飾り(target / data-pkc-action / class)が残らない', () => {
    const p = prepareRichBlock('[e](entry:abc) と [w](https://x.y)', render, parseDom);
    expect(p).not.toBeNull();
    const box = document.createElement('div');
    box.append(p!.nodes);
    expect(box.innerHTML).toBe('<a href="entry:abc">e</a> と <a href="https://x.y">w</a>');
  });
});

describe('serializeRichBlock ── DOM → PKC-Markdown', () => {
  const para = (html: string): string => serializeRichBlock(PARAGRAPH_META, dom(html));

  it('行内の書式', () => {
    expect(para('a <strong>b</strong> <b>B</b> c')).toBe('a **b** **B** c');
    expect(para('<em>i</em> <i>I</i>')).toBe('*i* *I*');
    expect(para('<s>s</s> <del>d</del> <strike>t</strike>')).toBe('~~s~~ ~~d~~ ~~t~~');
    expect(para('<mark>m</mark>')).toBe('==m==');
    expect(para('<code>x*y</code>')).toBe('`x*y`');
    expect(para('<code>a`b</code>')).toBe('``a`b``');
    expect(para('<a href="https://x.y">l</a>')).toBe('[l](https://x.y)');
    expect(para('<a href="entry:abc">内部</a>')).toBe('[内部](entry:abc)');
    expect(para('<a href="https://x.y">https://x.y</a>')).toBe('https://x.y');
  });

  it('下線・文字色・併用(字のすぐ外に置く)', () => {
    expect(para('<span data-pkc-rich-underline="1" style="text-decoration: underline">u</span>')).toBe(':u:underline:');
    expect(para('<u>u</u>')).toBe(':u:underline:');
    expect(para('<span data-pkc-rich-color="#e03131" style="color: #e03131">c</span>')).toBe(':c:#e03131:');
    expect(para('<font color="#1c7ed6">f</font>')).toBe(':f:#1c7ed6:');
    expect(
      para('<span data-pkc-rich-color="#e03131" data-pkc-rich-underline="1" style="color: #e03131; text-decoration: underline">both</span>'),
    ).toBe(':both:underline, #e03131:');
    // 入れ子の属性は 1 つの囲みへまとめる
    expect(para('<u><span data-pkc-rich-color="#e03131">x</span></u>')).toBe(':x:underline, #e03131:');
    // 太字の中の色は、太字の内側に置く
    expect(para('<span data-pkc-rich-color="#e03131"><strong>x</strong></span>')).toBe('**:x:#e03131:**');
  });

  it('改行(<br>)・ブラウザのゴミの正規化', () => {
    expect(para('a<br>b')).toBe('a\nb');
    expect(para('a<br><br>')).toBe('a'); // 末尾の番兵
    expect(para('<br>a')).toBe('a');
    expect(para('a<br><br><br>b')).toBe('a\nb'); // 連続は 1 つ
    expect(para('a<div>b</div><div><br></div>')).toBe('a\nb'); // Enter が作る <div>
    expect(para('<p>a</p><p>b</p>')).toBe('a\nb');
    expect(para('a&nbsp;&nbsp;b')).toBe('a  b');
    expect(para('&nbsp;a&nbsp;')).toBe('a');
    expect(para('<span>a</span><span style="font-size: 12px">b</span>')).toBe('ab'); // 素の span・style のクズ
    expect(para('<strong></strong>a<em> </em>')).toBe('a'); // 空の書式
    expect(para('<strong>a</strong><strong>b</strong>')).toBe('**ab**'); // 隣り合う同じ書式
    expect(para('<strong>a </strong>b')).toBe('**a** b'); // 内側の端の空白
    expect(para('a\u200bb')).toBe('ab');
  });

  it('字の中の記号は逃がす(描き手が記法と読まないように)', () => {
    expect(para('2*3')).toBe('2\\*3');
    expect(para('a~~b')).toBe('a\\~\\~b');
    expect(para('a~b')).toBe('a~b');
    expect(para('a==b')).toBe('a\\=\\=b');
    expect(para('x = y')).toBe('x = y');
    expect(para('[a](b)')).toBe('[a\\](b)');
    expect(para('[注]')).toBe('[注]');
    expect(para('$5')).toBe('\\$5');
    expect(para('_x_')).toBe('\\_x\\_');
    expect(para('a_b_c')).toBe('a_b_c');
    expect(para('a :b:red: c')).toBe('a \\:b:red: c');
    expect(para('10:30 に')).toBe('10:30 に');
    expect(para('# 題')).toBe('\\# 題');
    expect(para('- 項目')).toBe('\\- 項目');
    expect(para('1. 番号')).toBe('1\\. 番号');
    expect(para('a<br>&gt; 引用')).toBe('a\n\\> 引用');
    expect(para('a<br>---')).toBe('a\n\\---');
    expect(para('&lt;b&gt;')).toBe('\\<b>');
  });

  it('逃がした字は描き手で字のまま出る(逃がしの読み方の検算)', () => {
    for (const typed of ['2*3', 'a~~b~~', '==m==', '[a](b)', '$x$', '_x_', 'a :b:red: c', '# 題', '`c`', '&amp;']) {
      const md = para(document.createTextNode(typed).nodeValue!.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
      const html = render(md);
      const out = parseDom(html).textContent?.trim();
      expect(out, `${typed} → ${md}`).toBe(typed);
    }
  });

  it('見出し・引用・リスト項目の行頭を復元する(レベル変更・マーカー維持)', () => {
    const h2: RichBlockMeta = { ...PARAGRAPH_META, kind: 'heading', level: 2 };
    expect(serializeRichBlock(h2, dom('題 <strong>b</strong>'))).toBe('## 題 **b**');
    expect(serializeRichBlock({ ...h2, level: 4 }, dom('題'))).toBe('#### 題');
    expect(serializeRichBlock(h2, dom('1. はじめに'))).toBe('## 1. はじめに');
    expect(serializeRichBlock(h2, dom('a<br>b'))).toBe('## a b');
    const q: RichBlockMeta = { ...PARAGRAPH_META, kind: 'quote' };
    expect(serializeRichBlock(q, dom('a<br>b'))).toBe('> a\n> b');
    const li: RichBlockMeta = { kind: 'list-item', level: 0, indent: '  ', marker: '*', checked: null };
    expect(serializeRichBlock(li, dom('項目<br>続き'))).toBe('  * 項目\n    続き');
    expect(serializeRichBlock({ ...li, marker: '10.' }, dom('x<br>y'))).toBe('  10. x\n      y');
    expect(serializeRichBlock({ ...li, checked: 'x' }, dom('済み'))).toBe('  * [x] 済み');
    expect(serializeRichBlock({ ...li, checked: ' ' }, dom(''))).toBe('  * [ ] ');
    // 項目の頭の `[ ]` を字で打ったら逃がす(チェックに化けない)
    expect(serializeRichBlock(li, dom('[ ] 字'))).toBe('  * \\[ ] 字');
  });

  it('点(caret・選択)をブロックの原文の位置へ写す', () => {
    const root = dom('ab<strong>cd</strong>');
    const strong = root.querySelector('strong')!;
    const r = serializeRichBlockWithPoints({ ...PARAGRAPH_META, kind: 'heading', level: 1 }, root, [
      { node: root.firstChild!, offset: 1 },
      { node: strong.firstChild!, offset: 2 },
    ]);
    expect(r.text).toBe('# ab**cd**');
    expect(r.offsets).toEqual([3, 8]);
    // 色の囲みの中の caret で囲みが割れない(綴りが変わらない)
    const red = dom('<span data-pkc-rich-color="red">abc</span>');
    const t = red.querySelector('span')!.firstChild!;
    expect(serializeRichInline(red, [{ node: t, offset: 1 }]).text).toBe(':abc:red:');
    expect(serializeRichInline(red, [{ node: t, offset: 1 }]).offsets).toEqual([2]);
  });
});

describe('原本不変 ── 未編集のブロックは 1 バイトも触らない', () => {
  it('開いて何も変えずに綴り直すと、原文と完全に一致する(往復の検算が開く条件)', () => {
    const blocks = ['# 題 **b**', 'a :u:underline: b\nc', '- [x] 済み', '> 引用'];
    for (const src of blocks) {
      const p = prepareRichBlock(src, render, parseDom);
      expect(p, src).not.toBeNull();
      expect(serializeRichBlock(p!.meta, p!.nodes)).toBe(src);
    }
  });

  it('1 ブロックだけ書き戻しても、ほかの行(コード・:::format)はバイト単位で同じ', () => {
    const body = '# 題\n\n本文の段落\n\n```js\nconst  x = 1;  \n```\n\n:::format{align=center}\n中央\n:::\n';
    const p = prepareRichBlock('本文の段落', render, parseDom)!;
    const box = document.createElement('div');
    box.append(p.nodes);
    box.append(document.createTextNode('と追記'));
    const text = serializeRichBlock(p.meta, box);
    const next = spliceLines(body, 2, 2, text);
    expect(next).toBe(body.replace('本文の段落', '本文の段落と追記'));
  });

  it('composeRichBlock は parseRichBlock の逆', () => {
    for (const src of ['- [ ] a\n  b', '3) x', '> a\n> b', '## h', 'p\nq']) {
      const p = parseRichBlock(src)!;
      expect(composeRichBlock(p.meta, p.content)).toBe(src);
    }
  });
});

describe('nextRichMeta ── Enter で作る次のブロック', () => {
  it('リストは同じ種類の次の項目(番号は進め、チェックは外す)、ほかは段落', () => {
    const li: RichBlockMeta = { kind: 'list-item', level: 0, indent: ' ', marker: '9)', checked: 'x' };
    expect(nextRichMeta(li)).toEqual({ ...li, marker: '10)', checked: ' ' });
    expect(nextRichMeta({ ...li, marker: '-', checked: null }).marker).toBe('-');
    expect(nextRichMeta({ ...PARAGRAPH_META, kind: 'heading', level: 2 })).toEqual(PARAGRAPH_META);
  });
});
