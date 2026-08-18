/** @vitest-environment happy-dom */
/**
 * 貼り付けた HTML を markdown へ戻す(#251 の D)。
 *
 * 🔴 ここで守るのは「**貼ってみるまで気づけない**壊れ方」である ──
 * 1. 介入するかどうかの判定(**平文のほうが正確な場面で横取りしない**)
 * 2. 構造が**落ちない**(表の行 / 入れ子 / コードの中身)
 * 3. 平文が**記法に化けない**(`- ` で始まる文が箇条書きになる)
 * 4. 危ない宛先を**そのまま書かない**
 */
import { describe, expect, it } from 'vitest';
import {
  convertPastedHtml,
  markdownFromBody,
  plainLooksLikeMarkdown,
  PASTE_HTML_MAX,
} from '../../src/features/markdown/html-to-markdown';

/** 本体だけを渡して変換する(介入判定を挟まない素の変換)。 */
function md(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return markdownFromBody(doc.body);
}

/** 介入判定込み(text/plain も渡す)。 */
function conv(html: string, plain = ''): string | null {
  return convertPastedHtml({ html, plain });
}

describe('構造を markdown へ戻す', () => {
  it('見出しと段落', () => {
    expect(md('<h2>題</h2><p>本文</p>')).toBe('## 題\n\n本文');
  });

  it('🔴 入れ子のリストは**空行を空けない**(空けると別のリストに割れる)', () => {
    const out = md('<ul><li>親<ul><li>子</li></ul></li><li>次</li></ul>');
    expect(out).toBe('- 親\n  - 子\n- 次');
  });

  it('番号付きは `start` を継ぐ(3 から始まる引用が 1 に戻らない)', () => {
    expect(md('<ol start="3"><li>み</li><li>よ</li></ol>')).toBe('3. み\n4. よ');
  });

  it('🔴 コードは**中身を畳まない**(空白が意味を持つ)', () => {
    const out = md('<pre><code class="language-ts">const a = 1;\n  const b = 2;\n</code></pre>');
    expect(out).toBe('```ts\nconst a = 1;\n  const b = 2;\n```');
  });

  it('🔴 中身にバッククォートが在っても囲いが壊れない', () => {
    const out = md('<pre><code>```\nx\n```</code></pre>');
    expect(out?.startsWith('````')).toBe(true);
    expect(out?.endsWith('````')).toBe(true);
  });

  it('行内コードも同じ(囲いの数を増やす)', () => {
    expect(md('<p>これは <code>a`b</code> です</p>')).toBe('これは ``a`b`` です');
  });

  it('表(見出しあり)', () => {
    const out = md('<table><tr><th>名</th><th>数</th></tr><tr><td>あ</td><td>1</td></tr></table>');
    expect(out).toBe('| 名 | 数 |\n| --- | --- |\n| あ | 1 |');
  });

  it('🔴 見出し行が無い表でも**行が消えない**(先頭行を格上げしない)', () => {
    const out = md('<table><tr><td>あ</td><td>1</td></tr><tr><td>い</td><td>2</td></tr></table>');
    expect(out).toContain('| あ | 1 |');
    expect(out, '先頭行が見出しに吸われて消えた').toContain('| い | 2 |');
    // 空の見出し行 + 区切り行が足されている
    expect(out?.split('\n')).toHaveLength(4);
  });

  it('セルの `|` は逃がす(表が 1 列ずれない)', () => {
    const out = md('<table><tr><th>a|b</th></tr><tr><td>c</td></tr></table>');
    expect(out).toContain('a\\|b');
  });

  it('引用は行ごとに `>`', () => {
    expect(md('<blockquote><p>ひ</p><p>ふ</p></blockquote>')).toBe('> ひ\n>\n> ふ');
  });

  it('タスクリストは `- [x]` へ(PKC3 は GFM のタスクリストを描く)', () => {
    const out = md(
      '<ul><li><input type="checkbox" checked>すみ</li><li><input type="checkbox">まだ</li></ul>',
    );
    expect(out).toBe('- [x] すみ\n- [ ] まだ');
  });

  it('`<br>` は改行 1 つ(`breaks: true` の PKC3 ではこれが行送りになる)', () => {
    expect(md('<p>あ<br>い</p>')).toBe('あ\nい');
  });

  it('script / style は落とす(貼り先に出ると事故)', () => {
    expect(md('<p>本文</p><script>alert(1)</script><style>p{}</style>')).toBe('本文');
  });
});

describe('リンクと画像', () => {
  it('普通のリンク', () => {
    expect(md('<p><a href="https://e.com/a">題</a></p>')).toBe('[題](https://e.com/a)');
  });

  it('ラベルが URL 自身なら裸で書く(`[url](url)` を作らない)', () => {
    expect(md('<p><a href="https://e.com/a">https://e.com/a</a></p>')).toBe('https://e.com/a');
  });

  it('🔴 `javascript:` は**リンクにしない**が、文字は残す', () => {
    const out = md('<p><a href="javascript:alert(1)">押して</a></p>');
    expect(out).toBe('押して');
    expect(out).not.toContain('javascript:');
  });

  it('🔴 `data:text/html` もリンクにしない(貼り先で開くと危ない)', () => {
    expect(md('<p><a href="data:text/html,<b>x">危</a></p>')).toBe('危');
  });

  it('画像の `data:` は**そのまま出す**(資産へ逃がすのは呼び側の仕事)', () => {
    expect(md('<img src="data:image/png;base64,AA" alt="ず">')).toBe(
      '![ず](data:image/png;base64,AA)',
    );
  });

  it('🔴 読めない画像は **alt を文字として**残す(黙って消さない)', () => {
    expect(md('<img src="javascript:x" alt="ず">')).toBe('ず');
  });

  it('宛先に空白が混じるなら `<…>` で囲う(裸だとリンクが切れる)', () => {
    expect(md('<p><a href="https://e.com/a b">題</a></p>')).toBe('[題](<https://e.com/a b>)');
  });
});

describe('装飾', () => {
  it('太字・斜体・打ち消し', () => {
    expect(md('<p><strong>太</strong> <em>斜</em> <del>消</del></p>')).toBe('**太** *斜* ~~消~~');
  });

  it('🔴 Google ドキュメントの「効いていない `<b>`」を強調にしない', () => {
    // ⚠ Google ドキュメントは本文全体を `<b style="font-weight:normal">` で包む ──
    //   素直に読むと**貼ったもの全部が太字**になる
    const out = md('<b style="font-weight:normal" id="docs-internal-guid-x"><p>本文</p></b>');
    expect(out).toBe('本文');
  });

  it('前後の空白は強調の外へ出す(`** 字 **` は強調にならない)', () => {
    expect(md('<p>あ<strong> 太 </strong>い</p>')).toBe('あ **太** い');
  });

  it('中身が空の強調は記号を作らない', () => {
    expect(md('<p>あ<strong> </strong>い</p>')).toBe('あ い');
  });
});

describe('平文が記法に化けない', () => {
  it('🔴 `- ` で始まる文が箇条書きにならない', () => {
    expect(md('<p>- これは箇条書きではない</p>')).toBe('\\- これは箇条書きではない');
  });

  it('🔴 `#` で始まる文が見出しにならない', () => {
    expect(md('<p># ハッシュタグ</p>')).toBe('\\# ハッシュタグ');
  });

  it('`*` や `[` を含む平文はそのまま読める形にする', () => {
    expect(md('<p>a*b [c]</p>')).toBe('a\\*b \\[c\\]');
  });

  it('語中の `_` は escape しない(`snake_case` が読めなくなる)', () => {
    expect(md('<p>snake_case_name</p>')).toBe('snake_case_name');
  });
});

describe('介入するかどうか(`convertPastedHtml`)', () => {
  it('🔴 text/plain が既に markdown 原文なら**横取りしない**(AI の「コピー」)', () => {
    const html = '<h2>題</h2><ul><li>あ</li></ul>';
    expect(conv(html, '## 題\n\n- あ'), '原文を捨てて HTML から作り直した').toBeNull();
  });

  it('箇条書きの `- ` だけでは「markdown 原文」と見なさない', () => {
    // ⚠ `- ` を根拠にすると、**ただの箇条書きを貼っただけ**で HTML 側の入れ子を捨てる
    expect(plainLooksLikeMarkdown('- あ\n- い')).toBe(false);
    const out = conv('<ul><li>あ<ul><li>子</li></ul></li></ul>', '- あ\n- 子');
    expect(out, '平文の `- ` を見て入れ子を捨てた').toBe('- あ\n  - 子');
  });

  it('構造も装飾もリンクも無いなら介入しない(平文のほうが正確)', () => {
    expect(conv('<div>ただの文</div>', 'ただの文')).toBeNull();
    // ⚠ **平文と食い違っていても**介入しない ── ここを「同じなら null」だけで
    //   見ていると、構造の判定を消しても素通りする(変異が生き延びた)
    expect(conv('<div>ただの文</div>', 'ちがう平文'), '形が無いのに横取りした').toBeNull();
  });

  it('🔴 大きすぎる HTML は**解析しない**(貼付でメインスレッドを止めない)', () => {
    const big = `<p>${'あ'.repeat(PASTE_HTML_MAX)}</p><h1>題</h1>`;
    expect(big.length).toBeGreaterThan(PASTE_HTML_MAX);
    expect(conv(big, 'x')).toBeNull();
  });

  it('解析が失敗したら介入しない(黙って既定へ)', () => {
    expect(
      convertPastedHtml({ html: '<h1>題</h1>', plain: '' }, () => {
        throw new Error('parse failed');
      }),
    ).toBeNull();
  });

  it('空の HTML は介入しない', () => {
    expect(conv('', 'あ')).toBeNull();
  });

  it('🔴 平文と同じものを作っただけなら介入しない(undo の段数だけ増える)', () => {
    // リンクだけの HTML。ラベル = URL なので出来上がりは平文と同じ
    expect(conv('<a href="https://e.com/a">https://e.com/a</a>', 'https://e.com/a')).toBeNull();
  });

  it('構造が在れば介入する', () => {
    expect(conv('<h2>題</h2><p>本文</p>', '題 本文')).toBe('## 題\n\n本文');
  });
});
