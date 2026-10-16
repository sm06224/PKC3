/** @vitest-environment happy-dom */
/**
 * 🔴 **編集欄の入力補助の直し**(#1087)。Enter の続け方 / コード・数式の中の判定 /
 * 囲み(太字など)/ リンク / 括弧の自動補完 / 行頭ボタン。
 *
 * ⚠ どれも「直す前の実装に戻すと落ちる」ことを確かめて書いた(R1)。
 */
import { describe, expect, it } from 'vitest';
import { quoteOnEnter } from '../../src/features/markdown/quote-assist';
import { codeContextAt, insideBlockCode, insideCodeOrMath } from '../../src/features/markdown/code-context';
import {
  autoPairFor,
  insertLink,
  linkifyPastedUrl,
  toggleLinePrefix,
  toggleWrap,
  type LinePrefix,
  type TextSelection,
} from '../../src/features/markdown/text-ops';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

function press(v: string, caret: number = v.length): string | null {
  const r = quoteOnEnter(v, caret);
  if (r.kind === 'none') return null;
  if (r.kind === 'continue') return v.slice(0, caret) + r.insert + v.slice(caret);
  return v.slice(0, r.from) + r.text + v.slice(r.to);
}

describe('E1 引用の記号より手前で Enter を押しても `> > x` にならない', () => {
  it.each([0, 1])('`> x` の caret %i ── 何もしない', (caret) => {
    expect(quoteOnEnter('> x', caret)).toEqual({ kind: 'none' });
  });
  it('対照群: 記号の後ろ(2)と行末(3)では続く', () => {
    expect(press('> x', 2)).toBe('> \n> x');
    expect(press('> x', 3)).toBe('> x\n> ');
  });
  it('`>x`(空白なし)は記号の直後で続く / 手前(0)では続かない', () => {
    expect(press('>x', 1)).toBe('>\n>x');
    expect(quoteOnEnter('>x', 0)).toEqual({ kind: 'none' });
  });
  it('入れ子 `> > x` の手前でも続かない', () => {
    expect(quoteOnEnter('> > x', 3)).toEqual({ kind: 'none' });
    expect(press('> > x', 5)).toBe('> > x\n> > ');
  });
});

describe('E3 コード・数式の中の判定', () => {
  it('`$$` の塊の中では Enter でリストを続けない', () => {
    expect(press('$$\n- a')).toBeNull();
    expect(press('$$\n+ a')).toBeNull();
  });
  it('対照群: `$$` を閉じた後は続く', () => {
    expect(press('$$\nx\n$$\n- a')).toBe('$$\nx\n$$\n- a\n- ');
  });
  it('引用の中の fence の中では続けない(`> ```` ` を認識する)', () => {
    expect(press('> ```\n> - a')).toBe('> ```\n> - a\n> ');
    // ⚠ 続くのは**引用**であってリストではない(`> - ` にならない)
  });
  it('引用の中の fence を閉じた後は続く', () => {
    expect(press('> ```\n> x\n> ```\n> - a')).toBe('> ```\n> x\n> ```\n> - a\n> - ');
  });
  it('helper: 位置ごとの答え', () => {
    expect(codeContextAt('```\nx', 5)).toBe('fence');
    expect(codeContextAt('```\nx\n```\ny', 12)).toBeNull();
    expect(codeContextAt('$$\nx', 4)).toBe('math');
    expect(codeContextAt('$$\nx\n$$\ny', 9)).toBeNull();
    expect(codeContextAt('> ```\n> x', 9)).toBe('fence');
    expect(codeContextAt('a `b', 4)).toBe('inline');
    expect(codeContextAt('a `b` c', 7)).toBeNull();
    expect(insideCodeOrMath('~~~\nx', 5)).toBe(true);
    expect(insideBlockCode('a `b', 4)).toBe(false);
  });
});

describe('E5 コード・数式の中では URL を選んだ字へ貼ってもリンクにしない', () => {
  const url = 'https://example.com/';
  const sel = (text: string, word: string): TextSelection => {
    const start = text.indexOf(word);
    return { text, start, end: start + word.length };
  };
  it('対照群: 普通の本文ではリンクになる', () => {
    const r = linkifyPastedUrl(sel('見て 語 を', '語'), url, true);
    expect(r?.text).toBe('見て [語](https://example.com/) を');
  });
  it('fence の中 / 数式の中 / 行内コードの中では null', () => {
    expect(linkifyPastedUrl(sel('```\n語\n```', '語'), url, true)).toBeNull();
    expect(linkifyPastedUrl(sel('$$\n語\n$$', '語'), url, true)).toBeNull();
    expect(linkifyPastedUrl(sel('a `語` b', '語'), url, true)).toBeNull();
  });
});

describe('E4 囲み(太字など)が行の頭の印・段落をまたいでも構造を壊さない', () => {
  const wrap = (text: string, mark = '**', from = 0, to = text.length): string =>
    toggleWrap({ text, start: from, end: to }, mark).text;
  const html = (md: string): string => renderMarkdown(md);

  it.each([
    ['## 見出し', '## **見出し**'],
    ['- 牛乳', '- **牛乳**'],
    ['1. 牛乳', '1. **牛乳**'],
    ['- [ ] 牛乳', '- [ ] **牛乳**'],
    ['> 引用', '> **引用**'],
    ['> - 牛乳', '> - **牛乳**'],
  ])('行頭の印は囲みの外: %s', (src, want) => {
    expect(wrap(src)).toBe(want);
  });

  it('見出し・リストの構造が描画で残る', () => {
    expect(html(wrap('## 見出し'))).toContain('<h2');
    expect(html(wrap('- 牛乳'))).toContain('<li>');
    expect(html(wrap('- 牛乳'))).toContain('<strong>牛乳</strong>');
  });

  it('段落をまたぐ選択は段落ごとに囲む(字のまま出ない)', () => {
    const out = wrap('一つ目\n\n二つ目');
    expect(out).toBe('**一つ目**\n\n**二つ目**');
    expect(html(out)).not.toContain('**');
    expect((html(out).match(/<strong>/g) ?? []).length).toBe(2);
  });

  it('`==` も行ごと(`==a\\nb==` にならない)', () => {
    expect(wrap('a\nb', '==')).toBe('==a==\n==b==');
  });

  it('複数行のリストは各行を囲み、空行は触らない', () => {
    expect(wrap('- a\n\n- b')).toBe('- **a**\n\n- **b**');
  });

  it('表の行を含む選択は断る(そのまま返す)', () => {
    const t = '| a | b |\n|---|---|';
    const sel: TextSelection = { text: t, start: 0, end: t.length };
    expect(toggleWrap(sel, '**')).toBe(sel);
    const one: TextSelection = { text: '| a | b |', start: 0, end: 9 };
    expect(toggleWrap(one, '**')).toBe(one);
  });

  it('対照群: 表のセルの中だけを選べば囲める', () => {
    expect(wrap('| a | b |', '**', 2, 3)).toBe('| **a** | b |');
  });

  it.each([
    ['## 見出し', '**'],
    ['- 牛乳\n- 卵', '**'],
    ['一つ目\n\n二つ目', '*'],
    ['a\nb', '=='],
    ['> - x\n> - y', '`'],
  ])('対称: 2 回押すと元に戻る %j (%s)', (src, mark) => {
    const once = toggleWrap({ text: src, start: 0, end: src.length }, mark);
    expect(once.text).not.toBe(src);
    const twice = toggleWrap(once, mark);
    expect(twice.text).toBe(src);
  });

  it('一部の行だけ囲まれていれば、残りを囲んで揃える(外さない)', () => {
    expect(wrap('**a**\nb')).toBe('**a**\n**b**');
  });

  it('選択の範囲が囲みの内側を指す(続けて打てる / 続けて外せる)', () => {
    const r = toggleWrap({ text: '- 牛乳', start: 0, end: 4 }, '**');
    expect(r.text.slice(r.start, r.end)).toBe('牛乳');
  });

  it('対照群: 1 行の普通の選択はこれまでどおり', () => {
    expect(wrap('hello world', '**', 6, 12)).toBe('hello **world**');
    expect(toggleWrap({ text: 'ab', start: 1, end: 1 }, '**')).toEqual({ text: 'a****b', start: 3, end: 3 });
  });
});

describe('E4 リンク挿入', () => {
  const link = (text: string, start: number, end: number): TextSelection =>
    insertLink({ text, start, end });
  it('ラベルの端の空白は外に出す', () => {
    const r = link('a 語 b', 1, 4);
    expect(r.text).toBe('a [語](url) b');
    expect(r.text.slice(r.start, r.end)).toBe('url');
  });
  it('ラベルの `]` は escape する', () => {
    const r = link('x]y', 0, 3);
    expect(r.text).toBe('[x\\]y](url)');
    expect(r.text.slice(r.start, r.end)).toBe('url');
    expect(renderMarkdown(r.text)).toContain('<a ');
  });
  it('段落をまたぐ選択は断る', () => {
    const sel: TextSelection = { text: 'a\n\nb', start: 0, end: 4 };
    expect(insertLink(sel)).toBe(sel);
  });
  it('対照群: 選択なしは雛形 / 普通の選択は従来どおり', () => {
    const r0 = link('', 0, 0);
    expect(r0.text).toBe('[リンク](url)');
    expect(r0.text.slice(r0.start, r0.end)).toBe('url');
    expect(link('語', 0, 1).text).toBe('[語](url)');
  });
});

describe('E7 括弧の自動補完 ── 閉じを打っているときは足さない', () => {
  const key = (text: string, k: string, caret = text.length) =>
    autoPairFor({ text, start: caret, end: caret }, k);
  it('開いた fence の中で 3 つ目の ` を打つ → 補わない', () => {
    expect(key('```\nabc\n``', '`')).toBeNull();
  });
  it('対照群: fence の外の行頭 3 つ目は対を足す', () => {
    expect(key('``', '`')?.insert).toBe('`\n```');
    expect(key('```\nabc\n```\n\n``', '`')?.insert).toBe('`\n```');
  });
  it('`abc の後ろで ` を打つ → 補わない', () => {
    expect(key('`abc', '`')).toBeNull();
  });
  it('対照群: 閉じた後の ` と、何も無い所の ` は対を足す', () => {
    expect(key('`abc` ', '`')?.insert).toBe('``');
    expect(key('x ', '`')?.insert).toBe('``');
  });
});

describe('E9 行頭ボタンは引用の印を残し、リストの印を二重にしない', () => {
  const apply = (text: string, kind: LinePrefix): string =>
    toggleLinePrefix({ text, start: 0, end: text.length }, kind).text;
  // [元, 押す, 結果]
  const TABLE: [string, LinePrefix, string][] = [
    ['> - a', 'ul', '> a'],
    ['> - a', 'ol', '> 1. a'],
    ['> - a', 'h1', '> # a'],
    ['> - a', 'task', '> - [ ] a'],
    ['> 1. a', 'ul', '> - a'],
    ['> a', 'ul', '> - a'],
    ['> a', 'h2', '> ## a'],
    ['> # a', 'h1', '> a'],
    ['> > - a', 'ul', '> > a'],
    ['  - a', 'h1', '# a'],
    ['  - a', 'quote', '>   - a'],
    ['  - a', 'ol', '  1. a'],
    ['  a', 'ul', '  - a'],
    ['  a', 'h2', '## a'],
    ['- a', 'ul', 'a'],
    ['- a', 'h1', '# a'],
    ['# a', 'ul', '- a'],
    ['a', 'quote', '> a'],
    ['> a', 'quote', 'a'],
  ];
  it.each(TABLE)('%j + %s → %j', (src, kind, want) => {
    expect(apply(src, kind)).toBe(want);
  });
  it('番号は行ごとに数える / 引用は残す', () => {
    expect(apply('> a\n> - b', 'ol')).toBe('> 1. a\n> 2. b');
  });
});
