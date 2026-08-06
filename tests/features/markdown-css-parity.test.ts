/** @vitest-environment happy-dom */
/**
 * markdown が**出しているもの に CSS が在る**か。
 *
 * 🔴 **この検査は 2026-08-05 に作り直した。** 前の版はソースの
 * `class="…"` リテラルを正規表現で拾っていたので、
 *
 *   - `attrJoin('class', 'pkc-task-item')` のように**属性 API で付ける** class
 *   - `'pkc-section-callout' + knownClass` のように**組み立てる** class
 *   - `csv-table.ts` / `html-sandbox.ts` など**別ファイル**が出す class
 *   - `data-pkc-align` のように **class ですらない**見た目の鍵
 *
 * が丸ごと視界の外にあり、**19 個に CSS が 1 行も無いまま green** だった
 * (user 報告「PKC-Markdown のレンダリングができていない」の主因)。
 *
 * 直し方の要点は「**ソースの書き方ではなく、実際に出た HTML を見る**」こと。
 * 代表入力を本物の `renderMarkdown` に通し、返った DOM を歩いて拾う。
 *
 * ⚠ 空振り防止は「N 個以上出ている」ではなく「**代表的なものが実際に載っている**」で
 * 置く(CLAUDE.md「ガードは代替物で満たせない条件にする」)── 件数は
 * 無関係な class が増えるだけで満たされてしまう。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderMarkdown } from '@features/markdown/markdown-render';

/**
 * ⚠ **コメントを剥いでから走査する**。剥がないと、コメントに書いた
 * 「`.pkc-toc` は誰も出していない」という**説明文そのもの**が規則として拾われ、
 * 「規則が在る」「誰も出さない規則が在る」の両方を偽で満たす(実際に踏んだ)。
 */
const CSS = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 代表入力。**方言を網羅する**ことがこの検査の効き目そのものなので、
 * 記法を足したらここにも足す(足さないと、その記法は誰にも守られない)。
 */
const CORPUS: ReadonlyArray<readonly [string, string]> = [
  ['見出しと段落', '# 見出し 1\n\n## 見出し 2\n\n### 見出し 3\n\n本文\n'],
  ['強調など', '**強**、*斜*、~~消~~、`コード`、==印==、==[red]色付き印==\n'],
  ['リンク', '[外](https://example.com)\n[内](#見出し-1)\n[e](entry:abc)\n[a](asset:k1)\n'],
  ['画像', '![図](asset:k1)\n'],
  ['箇条書き', '- a\n  - b\n- c\n\n1. x\n2. y\n'],
  ['タスク', '- [ ] やること\n- [x] 済んだこと\n'],
  ['表', '| a | b |\n|:--|--:|\n| 1 | 2 |\n'],
  ['引用', '> 引用\n> > 入れ子\n'],
  ['コード', '```ts\nconst x = 1;\n```\n'],
  ['水平線と区切り', '---\n\n+++\n\n+++ {role=section}\n'],
  ['脚注', '本文[^a]\n\n[^a]: 注記\n'],
  ['ルビと圏点', '[[ruby:漢字|かんじ]] と [[em:重要]] と ^^強^^\n'],
  ['上下付き', ':sup:[2] と :sub:[3]\n'],
  ['簡易インライン', ':文字:bold,red,lg:\n'],
  // ⚠ **`<|` は「左」ではない**(2026-08-06 に註記を直した)。記法の正本
  //    (`PKC2: docs/development/notation-redesign-2026-05/01-notation-catalog.md` §1.4.2)は
  //    `|>` `<|` `|<` `>|` の**全 4 形を logical end** と定めており、「左」の行頭マーカーは
  //    §1.4.1 で**廃止**されている(左は frontmatter の direction か formal 形の仕事)。
  //    🔴 この誤った註記を根拠に実装を `start` へ変えてしまい、user の指摘で revert した ──
  //    **corpus の註記は実装より弱い出典**である(catalog が正本)。
  ['行頭アライン', '||中央\n\n|>end\n\n<|end(typo 寛容)\n'],
  ['字下げと空行', '__ 段落の字下げ\n\n_\n\n_3\n'],
  ['callout(8 種)',
    [':::note\n注意\n:::', ':::tip\nヒント\n:::', ':::warning\n警告\n:::', ':::danger\n危険\n:::',
     ':::info\n情報\n:::', ':::caution\n用心\n:::', ':::important\n重要\n:::', ':::summary\n要約\n:::'
    ].join('\n\n') + '\n'],
  ['section / callout の別形', ':::section{role=body}\n本文\n:::\n\n:::callout{type=tip}\n中身\n:::\n'],
  ['admonition', ':::admonition{type=warning title=題}\n中身\n:::\n'],
  ['details', ':::details{summary=たたむ}\n中身\n:::\n'],
  ['figure と参照', ':::figure{#f1}\n![図](asset:k1)\n^^^ 図の題\n:::\n\n[@f1] を参照\n'],
  ['table ブロック', ':::table{#t1}\n| a |\n|---|\n| 1 |\n^^^ 表の題\n:::\n'],
  ['equation ブロック', ':::equation{#e1}\nE=mc^2\n^^^ 式の題\n:::\n'],
  ['quote ブロック', ':::quote{author=誰か year=2026 source=どこか}\n引用\n:::\n'],
  ['目次', '# a\n## b\n\n:::toc{depth=2}\n'],
  ['コメント', '%%行内%%\n\n%%%\nブロック\n%%%\n'],
  ['変数', '---\nvars:\n  x: 値\n---\n\n{{vars.x}} と {{vars.未定義}}\n'],
  ['csv fence', '```csv\n列A,列B\n1,2\n```\n'],
  ['csv-render fence', '```csv-render\n列A,列B\n1,2\n```\n'],
  ['html fence', '```html-render\n<b>太字</b>\n```\n'],
  ['mermaid fence', '```mermaid\ngraph TD; A-->B;\n```\n'],
  ['カード埋め込み', '@[card](entry:abc)\n'],
  ['本文の取り込み', '![別のノート](entry:abc)\n'],
  ['format ブロック', ':::format{class=highlight indent=2 align=center}\n中身\n:::\n'],
  ['region ブロック', ':::frontmatter\nメタ\n:::\n\n:::body\n本体\n:::\n'],
  // ⚠ **AI が書きがちな崩れ形**(寛容 parse。PKC2005〜2008)も見た目を持つ ──
  //    崩れて入ってきた文書が素のまま出ると、user は「壊れた」と読む
  ['崩れ形(寛容 parse)',
    ':lead:[導入]\n\n:spacing:{size=2}\n\n:align:{position=center}\n\n次の段落\n\n:quote:{attribution=誰か}\n\n文中に :align:{position=end} が混ざった段落\n'],
];

/** **何も描かれないのが正しい**入力(理由を書かずに足さない)。 */
const RENDERS_NOTHING: ReadonlySet<string> = new Set([
  'コメント', // `%%…%%` / `%%%…%%%` は render 時に消えるのが仕様
]);

/** 実際に出た HTML から、見た目の鍵になるものを拾う。 */
function emitted(): { classes: Set<string>; attrs: Set<string>; empty: string[] } {
  const classes = new Set<string>();
  const attrs = new Set<string>();
  const empty: string[] = [];
  const host = document.createElement('div');
  for (const [name, src] of CORPUS) {
    const html = renderMarkdown(src);
    host.innerHTML = html;
    // ⚠ 何も生まなかった入力は**この検査の穴**(記法が消えたことに気づけない)
    if (host.children.length === 0 && !RENDERS_NOTHING.has(name)) empty.push(name);
    for (const el of host.querySelectorAll('*')) {
      for (const c of el.classList) {
        // markdown 由来のものだけ(コード色分けの `pkc-tok-*` は別の仕組み)
        if (/^(pkc-|footnote)/.test(c) && !c.startsWith('pkc-tok-')) classes.add(c);
      }
      for (const a of el.attributes) {
        if (a.name.startsWith('data-pkc-')) attrs.add(a.name);
      }
    }
  }
  return { classes, attrs, empty };
}

/** `app.css` が言及している class / 属性。 */
function styled(): { classes: Set<string>; attrs: Set<string> } {
  const classes = new Set<string>();
  for (const m of CSS.matchAll(/\.((?:pkc-|footnote)[a-z0-9-]*)/g)) classes.add(m[1]!);
  const attrs = new Set<string>();
  // ⚠ **名前の直後が `=` か `]`** であることを要求する。前方一致で拾うと、
  //    `[data-pkc-alignX=…]` のような別名でも `data-pkc-align` が在ることになり、
  //    規則を壊す変異が素通りする(変異試験 C3 で実証)
  for (const m of CSS.matchAll(/\[(data-pkc-[a-z-]+)(?=[\]=])/g)) attrs.add(m[1]!);
  return { classes, attrs };
}

/**
 * 規則を持たなくてよいもの。**理由を書かずに足さない** ── ここが
 * 「例外を足せば通る」抜け道になると、この検査は何も守らなくなる。
 */
const NO_STYLE_NEEDED: Readonly<Record<string, string>> = {
  'pkc-md-rendered': '本文の器。中の要素に当てる起点で、自身は素のまま',
  'pkc-mermaid-placeholder': '器。状態は data-pkc-mermaid-state で見る',
  'pkc-md-block': '器。中の切替や操作子に当てる起点',
  'pkc-render-slot': '描画面の器。隠す規則は切替側(:checked ~)に在る',
};

/**
 * 見た目の鍵として **CSS が要る** data 属性。
 * ⚠ ここは「拾えたもの全部」にしない ── `data-pkc-action` のように
 * 動作の鍵でしかないものまで CSS を要求すると、無意味な規則が増える。
 */
const ATTRS_NEEDING_CSS: readonly string[] = [
  'data-pkc-align', // 行頭アライン(center / end)+ formal の physical(left / right …)
  'data-pkc-indent', // 段落の字下げ
  'data-pkc-render-mode', // 切替の無い fence では原文を常に隠す
  // ⚠ `data-pkc-blank-count` はここに入れない ── 高さは **style 変数**
  //    (`--pkc-blank-count`)で渡す。属性は読み手向けの手掛かり。
  //    繋がっているかは下の「空行マーカーの高さ」で直接見る
  // ⚠ `data-pkc-mermaid-state` はここに入れない ── 付けるのは adapter(焼いた後)で
  //    `renderMarkdown` は出さない。この検査は**描画関数が出すもの**を見る
];

/**
 * 🔴 **class を持たない要素**も見る。方言が出すのは class 付きだけではない ──
 * `==印==` は素の `<mark>`、`[[ruby:…]]` は `<ruby>/<rt>` を出す。
 * class だけ数える検査では**この型は永久に見つからない**(実ブラウザ計測で判明:
 * `.pkc-inline-mark` には規則が在るのに `<mark>` は素のままだった)。
 * ⚠ 一般の要素(`p` / `ul` / `table`)は入れない ── 素のままで正しいものまで
 * 規則を要求すると、無意味な規則が増える。**方言が作る要素だけ**を挙げる。
 */
const DIALECT_ELEMENTS: readonly string[] = ['mark', 'rt'];

describe('markdown の描画物と CSS', () => {
  const out = emitted();

  it('🔴 この検査が空振りしていない(代表的なものが実際に出ている)', () => {
    // ⚠ 「N 個以上」では駄目 ── 無関係な class が増えるだけで満たされる。
    //    **代替物で満たせない条件**にする
    for (const c of [
      'pkc-section-callout',
      'pkc-section-note',
      'pkc-task-item',
      'pkc-inline-mark',
      'pkc-asset-link',
      'pkc-fig',
      'footnote-item',
      'pkc-render-source',
    ]) {
      expect(out.classes.has(c), `代表 class ${c} が corpus から出ていない`).toBe(true);
    }
    for (const a of ATTRS_NEEDING_CSS) {
      expect(out.attrs.has(a), `代表属性 ${a} が corpus から出ていない`).toBe(true);
    }
    // ⚠ 何も生まない入力があれば、その記法は**測れていない**
    expect(out.empty, `何も描かれない入力: ${out.empty.join(', ')}`).toEqual([]);
  });

  it('🔴 出している class に**全部** CSS が在る', () => {
    const have = styled().classes;
    const missing = [...out.classes]
      .filter((c) => !have.has(c) && !(c in NO_STYLE_NEEDED))
      .sort();
    expect(missing, `CSS の無い class(${missing.length} 件): ${missing.join(', ')}`).toEqual([]);
  });

  it('🔴 方言が作る要素(class 無し)にも CSS が在る', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown('==印== と [[ruby:漢字|かんじ]]\n');
    for (const tag of DIALECT_ELEMENTS) {
      // 空振り防止 ── まず**本当に出ている**ことを確かめる
      expect(host.querySelector(tag), `${tag} が出ていない(この検査は空振り)`).not.toBeNull();
      // ⚠ **セレクタの独立したトークン**として要求する。`\b${tag}\b` だと
      //    `.pkc-inline-mark` の中の "mark" に当たって偽陽性になる
      //    (`-` は単語境界なので。変異試験 C4 で実証)
      const selectors = [...CSS.matchAll(/([^{}]+)\{/g)]
        .flatMap((m) => m[1]!.split(','))
        .map((x) => x.trim());
      const hit = selectors.some((sel) => new RegExp(`(^|\\s|>\\s*)${tag}$`).test(sel));
      expect(hit, `${tag} を指すセレクタが無い`).toBe(true);
    }
  });

  it('🔴 見た目の鍵になる data 属性に CSS が在る', () => {
    const have = styled().attrs;
    const missing = ATTRS_NEEDING_CSS.filter((a) => !have.has(a));
    expect(missing, `CSS の無い属性: ${missing.join(', ')}`).toEqual([]);
  });

  it('🔴 CSS に**誰も出さない** `pkc-*` の規則が残っていない', () => {
    // ⚠ 直したつもりで直っていないことの証拠になる(`.pkc-toc` がそれだった ──
    //    renderer が出すのは `pkc-toc-formal` / `pkc-toc-preview` なので当たらない)
    const orphan = [...styled().classes]
      .filter((c) => !out.classes.has(c) && !c.startsWith('pkc-tok-') && !(c in NO_STYLE_NEEDED))
      .sort();
    expect(orphan, `誰も出さない規則(${orphan.length} 件): ${orphan.join(', ')}`).toEqual([]);
  });

  /**
   * 🔴 **描画の下に原文を出さない**。段⑳ 以前の実際の姿がこれで、
   * 「図は描いたら焼く」で得たきれいな 1 枚が直下の生ソースで台無しだった。
   */
  it('🔴 既定(`-both`)では原文が隠れ、切替で入れ替わる', () => {
    expect(CSS, '原文を隠す規則が無い').toContain('.pkc-render-source');
    // 向きは `copy-md-block.ts`(checked = ソース面)と一致していること
    expect(CSS).toMatch(/:not\(:checked\)\s*~\s*\.pkc-render-source/);
    expect(CSS).toMatch(/:checked\s*~\s*\.pkc-render-slot/);
    // `-render` は切替が無いので常に隠す
    expect(CSS).toContain("[data-pkc-render-mode='render'] > .pkc-render-source");
    // ⚠ 切替は `display: none` にしない(キーボードで到達できなくなる)
    const at = CSS.indexOf('.pkc-render-toggle-input {');
    expect(at, '切替の規則が無い').toBeGreaterThanOrEqual(0);
    expect(CSS.slice(at, CSS.indexOf('}', at))).not.toContain('display: none');
  });
});

/**
 * 🔴 **規則が在るのに繋がっていない**型の欠陥を直接見る。
 *
 * 「CSS が 0 行」を数える検査では**絶対に見つからない** ── 規則
 * (`height: calc(1.45em * var(--pkc-blank-count, 1))`)も属性
 * (`data-pkc-blank-count`)も在り、**変数に値が入っていない**だけだったので、
 * `_3` と `_1` が同じ高さになっていた。
 */
describe('空行マーカーの高さ', () => {
  const host = document.createElement('div');
  const blank = (src: string): HTMLElement | null => {
    host.innerHTML = renderMarkdown(src);
    return host.querySelector<HTMLElement>('.pkc-blank-line');
  };

  it('🔴 行数が style 変数に届いている(規則が読む値)', () => {
    const el = blank('前\n\n_3\n\n後\n');
    expect(el, '空行マーカーが出ていない').not.toBeNull();
    expect(el!.getAttribute('data-pkc-blank-count')).toBe('3');
    expect(el!.style.getPropertyValue('--pkc-blank-count').trim(), '高さの元が届いていない').toBe(
      '3',
    );
  });

  it('1 行のときも同じ経路で届く', () => {
    const el = blank('前\n\n_\n\n後\n');
    expect(el!.style.getPropertyValue('--pkc-blank-count').trim()).toBe('1');
  });

  it('CSS 側がその変数を読んでいる(片方だけ直すのを防ぐ)', () => {
    expect(CSS).toContain('var(--pkc-blank-count');
  });
});

/**
 * 🔴 **注意書きも読み幅の上限に従う**(2026-08-05、実ブラウザで気づいた)。
 *
 * 読み幅の上限は allow-list 方式(新しいブロックは「上限が掛からない」側に倒れる)。
 * その安全な既定のせいで、`:::note` などの箱だけが**全幅に伸びて**、
 * 周りの段落(42rem)と揃わなかった。⚠ 表・図・コードは対象外のままにする
 * (横に広いほど読めるので、そこは既定が正しい)。
 */
describe('読み幅の上限', () => {
  const RULE = /\[data-pkc-field='detail-body'\] > :is\(([^)]*)\)/;
  it('🔴 注意書きが対象に入っている', () => {
    const m = RULE.exec(CSS);
    expect(m, '読み幅の規則が見つからない').not.toBeNull();
    expect(m![1], '注意書きだけ全幅に伸びる').toContain('.pkc-section-callout');
  });
  it('表・図・コードは対象外のまま(横に広いほど読める)', () => {
    // ⚠ **項目ごとに厳密一致**で見る ── `toContain('pre')` は
    //    `.pkc-toc-preview` の "pre" に当たって偽陽性になる(実際に踏んだ)
    const items = RULE.exec(CSS)![1]!.split(',').map((x) => x.trim());
    for (const s of ['table', 'pre', 'figure', 'iframe']) {
      expect(items, `${s} に読み幅の上限が掛かっている`).not.toContain(s);
    }
  });
});
