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
  svgImage,
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

  /**
   * 🔴 **裸で書いてよいのは、本文の描画が拾い直せる形だけ**(#78、2026-08-22。
   * 着地前レビューが拾った)。
   *
   * ⚠ 上の省略は「描画側の linkify が拾い直す」ことを前提にしていた。
   *   その前提は markdown-it 15 で崩れた ── `fuzzyLink` が既定 off になり、
   *   `www.…` のような**スキームの無い宛先は自動リンクされない**。
   * 🔑 症状は「**貼ったリンクが地の文になって消える**」で、警告も出ない。
   *   だから拾えない形は `[label](target)` を書いて残す ──
   *   壊れる向きが「余計な記法が残る」側になり、**宛先は消えない**。
   * ⚠ `markdown-render.ts` の linkify の絞り込みと**対の判定**である
   *   (CLAUDE.md §7「同じ判定が複数の場所にある」)。
   */
  it('🔴 スキームの無い宛先は裸にしない(貼ったリンクを地の文にしない)', () => {
    expect(
      md('<p><a href="www.example.com">www.example.com</a></p>'),
      '裸で出したので、本文では地の文になり宛先が消える',
    ).toBe('[www.example.com](www.example.com)');
    // ⚠ **対照群**(同じ it に置く)── 拾える形は今までどおり裸のまま
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

/**
 * 🔴 **着地前レビューで見つかった、黙って壊れる形**(#261)。
 * どれも「実際のコピー元で普通に起きる」形である ── 実測で確かめてから直した。
 */
describe('現実のコピー元で壊れない', () => {
  it('🔴 行内の器が塊を抱えていても潰れない(Google ドキュメントは全体を b で包む)', () => {
    // ⚠ **塊を 2 つ以上**置く ── 1 つだと、潰しても同じ文字列になるので空振りする
    //   (直す前の実測: `題あい` ── 見出しも箇条書きも消え、語まで繋がった)
    const out = md(
      '<b style="font-weight:normal" id="docs-internal-guid-x">' +
        '<h1>題</h1><p>あ</p><ul><li>い</li></ul></b>',
    );
    expect(out).toBe('# 題\n\nあ\n- い');
    expect(out, '語が繋がっている(区切りが消えた)').not.toContain('題あい');
  });

  it('span が塊を抱えていても同じ', () => {
    expect(md('<span><h2>題</h2><p>本文</p></span>')).toBe('## 題\n\n本文');
  });

  it('🔴 リンクが塊を抱えていたら、語は繋げずリンクは残す(ニュースのカード)', () => {
    // ⚠ ここは**降りない** ── 降りると宛先を失う(記法 1 つ = user の動線 1 つ)
    expect(md('<a href="https://e.com/a"><h3>題名</h3><p>説明</p></a>')).toBe(
      '[題名 説明](https://e.com/a)',
    );
  });

  it('🔴 リストの直下に在る入れ子で、項目が消えない', () => {
    // 直す前の実測: `1. 一` だけ ── 「二」が黙って消えていた
    expect(md('<ol><li>一</li><ol><li>二</li></ol></ol>')).toBe('1. 一\n   1. 二');
  });

  it('🔴 `li` が包まれていても、中身は消えない', () => {
    expect(md('<ul><div><li>あ</li></div></ul>'), 'リストが丸ごと消えた').toContain('あ');
  });

  it('🔴 入れ子の表を二重に拾わない(HTML メール / 表レイアウト)', () => {
    const out = md('<table><tr><td>外<table><tr><td>内</td></tr></table></td></tr></table>');
    // 直す前の実測: `| 外内 |` の下に `| 内 |` が出て、同じ中身が 2 回入っていた
    expect(out?.split('\n').filter((l) => l.includes('内')), '内側の行が 2 回出ている')
      .toHaveLength(1);
  });

  it('🔴 入れ子のタスクで、親まで済みにしない(`- 親` の下に `- [x] 子`)', () => {
    const out = md(
      '<ul><li>親<ul><li><input type="checkbox" checked>子</li></ul></li></ul>',
    );
    expect(out).toBe('- 親\n  - [x] 子');
    expect(out, '親はタスクですらないのに済みになった').not.toContain('[x] 親');
  });

  it('🔴 ただし `<p>` に包まれた箱は拾う(loose なリストで印を落とさない)', () => {
    // ⚠ 上を「直下だけ」で直すと**こちらが壊れる** ── GFM の loose なリストは
    //   `<li><p><input>…` の形である(主張の向きを変えたら反対側を見る)
    expect(md('<ul><li><p><input type="checkbox"> あ</p></li></ul>')).toBe('- [ ] あ');
  });

  it('親も子もタスクなら、両方に印が付く(GitHub の入れ子タスク)', () => {
    const out = md(
      '<ul><li><input type="checkbox">親<ul><li><input type="checkbox" checked>子</li></ul></li></ul>',
    );
    expect(out).toBe('- [ ] 親\n  - [x] 子');
  });
});

describe('落としていない記法(誰も見ていなかった出力)', () => {
  it('区切り線', () => {
    expect(md('<p>あ</p><hr><p>い</p>')).toBe('あ\n\n---\n\nい');
  });

  it('🔴 行ごとに列数が違う表で、列が落ちない', () => {
    // ⚠ 幅を先頭行で決めると 2 行目の `y` が落ちる(**データ欠損の向き**)
    const out = md('<table><tr><th>a</th></tr><tr><td>x</td><td>y</td></tr></table>');
    expect(out).toBe('| a |  |\n| --- | --- |\n| x | y |');
  });

  it('🔴 セルの中の改行は空白へ(表が途中で割れない)', () => {
    const out = md('<table><tr><th>a</th></tr><tr><td>x<br>y</td></tr></table>');
    expect(out).toBe('| a |\n| --- |\n| x y |');
  });

  it('🔴 画像の説明に `]` が在ってもリンクが壊れない', () => {
    expect(md('<img src="https://e.com/a.png" alt="図 1]の続き">')).toBe(
      '![図 1\\]の続き](https://e.com/a.png)',
    );
  });

  it('言語クラスの別名も読む(GitHub / highlight.js)', () => {
    expect(md('<pre><code class="highlight-source-ts">x</code></pre>')).toBe('```ts\nx\n```');
    expect(md('<pre><code class="lang-py">x</code></pre>')).toBe('```py\nx\n```');
  });

  it('🔴 NBSP も畳む(Word / Google ドキュメント由来の見えない字)', () => {
    // ⚠ 生バイトを書かない(CLAUDE.md §9)── `\u00a0` で組み立てる
    const nb = `<p>あ${'\u00a0'}${'\u00a0'}い</p>`;
    expect(md(nb), '見えない字が本文に居座る').toBe('あ い');
  });
});

/**
 * 🔴 **ページ中の図(`<svg>`)を捨てない**(user 裁定 2026-08-18)。
 *
 * 直す前は `SKIP` に入れて**痕跡なく消して**いた ── 図は知識の一部で、消えたことに
 * 気づけないのがいちばん悪い。持ち出せる容れ物である以上、**中に見えていたものは
 * 一緒に運べなければならない**。
 */
describe('図(svg)を資産として持つ', () => {
  const svg = (inner: string, attrs = ''): string =>
    `<svg width="10" height="10"${attrs}>${inner}</svg>`;

  it('🔴 画像として出す(消さない)', () => {
    const out = md(svg('<rect width="10" height="10"/>'));
    expect(out, '図が消えた').toMatch(/^!\[図\]\(<?data:image\/svg\+xml/);
    expect(decodeURIComponent(out ?? ''), '中身が入っていない').toContain('<rect');
  });

  it('🔴 `<script>` を落とす(書き出した `.svg` を直接開く経路が残る)', () => {
    /**
     * ⚠ **DOM API で組み立てる。** 解析器に食わせると happy-dom は `<svg>` の中の
     * `<script>` を**自分で落とす**ので、掃除を外しても緑になる(実際に変異が
     * 生き延びた ── 測っていたのは解析器の癖だった)。実ブラウザは両方を持つ。
     */
    const doc = new DOMParser().parseFromString('<svg width="4"><rect/></svg>', 'text/html');
    const el = doc.querySelector('svg')!;
    const script = doc.createElementNS('http://www.w3.org/2000/svg', 'script');
    script.textContent = 'alert(1)';
    el.appendChild(script);
    // 前提: 解析器に落とされていない(空振り防止)
    expect(el.querySelectorAll('script'), 'この test は空振り').toHaveLength(1);
    const out = decodeURIComponent(svgImage(el));
    expect(out, 'スクリプトが資産に入った').not.toContain('alert(1)');
    expect(out, '図形まで落とした').toContain('<rect');
  });

  it('🔴 `on*` の属性も落とす', () => {
    const out = decodeURIComponent(md(svg('<rect onload="alert(1)"/>')) ?? '');
    expect(out).not.toContain('onload');
  });

  it('🔴 外を見に行く参照は落とす(開いた先で通信させない)', () => {
    const out = decodeURIComponent(md(svg('<image href="https://e.com/a.png"/>')) ?? '');
    expect(out).not.toContain('e.com');
  });

  it('名前空間が付く(無いと `<img>` で描けない)', () => {
    // ⚠ これは **`XMLSerializer` が自分で付ける**(実測)── こちらで足す 1 行は
    //   no-op だったので置いていない。ここは「結果として付いている」ことだけを見る
    expect(decodeURIComponent(md(svg('<rect/>')) ?? '')).toContain(
      'xmlns="http://www.w3.org/2000/svg"',
    );
  });

  it('図の `<title>` を説明に使う', () => {
    expect(md(svg('<title>売上の推移</title><rect/>'))).toMatch(/^!\[売上の推移\]/);
  });

  it('図だけのコピーでも介入する(素通りさせない)', () => {
    expect(conv(svg('<rect/>'), 'PLAIN')).not.toBeNull();
  });
});

