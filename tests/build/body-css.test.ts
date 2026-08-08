/**
 * 本文の CSS を app.css から抜く仕掛け(2026-08-07)。
 *
 * 🔴 **この抜き出しは失敗しても静かである。** 規則が 0 本でも CSS として妥当なので、
 * 書き出した HTML は「本文が素のまま」になるだけ ── 例外も警告も出ない。だから
 * ここは「動いたか」ではなく「**何本・何個・どの層が**入ったか」を数える。
 *
 * 🔴 **一番の罠は「トークンの層が 2 つある」こと。** `tokens.css` は配色を
 * `:root[data-pkc-theme=…]` に、**幾何と書体を素の `:root`** に置いている。
 * テーマの層だけ読んでいた最初の実装は `--s2`〜`--s5` / `--radius` / `--font-mono` を
 * 落としており、`margin: var(--s5) 0 var(--s2)` が**丸ごと無効**になっていた ──
 * ⚠ 未定義の `var()` は宣言ごと無効になり、**先行する規則へ fall back しない**ので、
 * 焼いたせいで `.b` 側の余白まで消える = **何もしないより悪くなる**。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { auditBodyCss, extractBodyCss, isBodyRule, parseRules } from '../../build/body-css';

const APP = readFileSync('src/styles/app.css', 'utf8');
const TOKENS = readFileSync('src/styles/tokens.css', 'utf8');
const OUT = extractBodyCss(APP, TOKENS);

/** 出力の中で定義されているカスタムプロパティ。 */
function definedIn(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) out.add(m[1]!);
  return out;
}

describe('本文の CSS を抜く', () => {
  it('🔴 この検査が空振りしていない(規則とトークンが実際に入っている)', () => {
    // ⚠ 下限だけでなく**上限**も置く(CLAUDE.md「tripwire は両側」)── 器の規則まで
    //    混ざり始めたら、ここが先に鳴る
    expect(OUT.ruleCount, `本文の規則が ${OUT.ruleCount} 本`).toBeGreaterThanOrEqual(100);
    expect(OUT.ruleCount, `本文の規則が ${OUT.ruleCount} 本(器が混ざった?)`).toBeLessThan(200);
    expect(OUT.vars.length, `トークンが ${OUT.vars.length} 個`).toBeGreaterThanOrEqual(15);
    expect(OUT.css.length, '出力が短すぎる').toBeGreaterThan(8000);
  });

  /**
   * 🔴 **この 1 本が「何もしないより悪くなる」を止めている。**
   * 出力が参照する `var()` は、**すべて出力の中で定義されていなければならない**。
   */
  it('🔴 参照している var が全部出力の中で定義されている', () => {
    expect(OUT.missing, `定義の無いトークン: ${OUT.missing.join(', ')}`).toEqual([]);
    const defined = definedIn(OUT.css);
    const used = new Set<string>();
    for (const m of OUT.css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
      // ⚠ 既定値つき(`var(--x, 1)`)は未定義でも壊れない ── 数えない
      if (m[2] === ')') used.add(m[1]!);
    }
    const undefinedVars = [...used].filter((v) => !defined.has(v)).sort();
    expect(undefinedVars, `未定義の var(宣言ごと無効になる): ${undefinedVars.join(', ')}`).toEqual(
      [],
    );
  });

  /**
   * 🔴 **幾何・書体の層(素の `:root`)が入っている**。ここが最初に落ちた場所である。
   * ⚠ 「トークンが N 個以上」では守れない ── 配色 13 個だけで満たされる。
   *   **代替物で満たせない条件**にする(CLAUDE.md)。
   */
  it('🔴 テーマで変わらない層(幾何・書体)も焼かれている', () => {
    for (const name of ['--s2', '--s3', '--s5', '--radius', '--font-mono']) {
      expect(OUT.vars, `${name} が抜けている(宣言ごと無効になる)`).toContain(name);
      expect(OUT.css, `${name} の定義が出力に無い`).toContain(`${name}:`);
    }
    // 配色の層も同時に要る(片方だけ拾う実装で通らないように)
    for (const name of ['--fg', '--border', '--surface-2', '--accent']) {
      expect(OUT.vars, `${name} が抜けている`).toContain(name);
    }
  });

  /**
   * 🔴 **暗い環境は `prefers-color-scheme` で追従させる**。静的に light で潰すと
   * `:::toc` の地がほぼ白のまま文字が白になり、**読めなくなる**(実測)。
   */
  it('🔴 light は素の :root、dark は prefers-color-scheme で包む', () => {
    expect(OUT.css, '既定(light)の :root が無い').toMatch(/^:root\{--/);
    const dark = OUT.css.indexOf('@media (prefers-color-scheme:dark){:root{');
    expect(dark, '暗い環境の層が無い').toBeGreaterThan(0);
    const darkBlock = OUT.css.slice(dark, OUT.css.indexOf('}}', dark));
    const lightBlock = OUT.css.slice(0, dark);
    /**
     * 🔴 **名前ではなく値で見る**(2026-08-07 のレビューで直した)。
     * `find('dark')` を `find('light')` に取り違える変異は、名前だけ見る検査を
     * **素通りする** ── 暗い環境の閲覧者に明るい配色が当たり、`color-scheme` が
     * 地を黒くしたところへ `#16191d` の字が乗って**読めなくなる**(この file の
     * 冒頭が「実測」として挙げている、まさにその状態)。
     */
    const valueOf = (block: string, name: string): string | undefined =>
      new RegExp(`${name}:([^;}]+)`).exec(block)?.[1];
    for (const name of ['--fg', '--surface-2', '--border', '--accent']) {
      expect(darkBlock, `${name} が暗い環境で上書きされていない`).toContain(`${name}:`);
      const l = valueOf(lightBlock, name);
      const d = valueOf(darkBlock, name);
      expect(l, `${name} の明るい側の値が読めない(この検査は空振り)`).toBeTruthy();
      expect(d, `${name} が暗い環境で light と同じ値(取り違えている)`).not.toBe(l);
    }
    // ⚠ **色以外を dark に混ぜない** ── 幾何をテーマ層から拾い始めた印
    expect(darkBlock, '幾何が暗い環境の層に混ざっている').not.toContain('--s5:');
  });

  /**
   * 🔴 **器の規則を持ち込まない**。閲覧側は `body{display:grid}` の別の器なので、
   * アプリの器の規則が混ざると**見た目を壊す**(直す目的と逆になる)。
   */
  it('🔴 器の規則(region / field)が 1 本も混ざっていない', () => {
    for (const key of ['data-pkc-region', 'data-pkc-view']) {
      expect(OUT.css, `器の規則が混ざっている: ${key}`).not.toContain(key);
    }
    /**
     * ⚠ `data-pkc-field` は**読み幅の 1 か所だけ**通す(2026-08-08 の統一)。
     * 読み幅の規則は `.pkc-md-rendered[data-pkc-field='detail-body']` 起点で、
     * 属性は**要素の絞り込み**である(器を起点にした規則ではない)。
     * それ以外の field は器の印なので 1 件も通さない ── 等値で pin する
     * (器の field が混ざっても、読み幅が落ちても、どちらでも落ちる)。
     */
    const fields = [...OUT.css.matchAll(/data-pkc-field='([^']*)'/g)].map((m) => m[1]);
    expect(fields, '読み幅以外の field の規則が混ざった(または読み幅が落ちた)').toEqual([
      'detail-body',
    ]);
    // ⚠ 逆に、本文が使う data 属性は**在らねばならない**(選り過ぎの検出)
    for (const key of ['data-pkc-align', 'data-pkc-indent', 'data-pkc-render-mode']) {
      expect(OUT.css, `本文の属性の規則が落ちている: ${key}`).toContain(key);
    }
  });

  /**
   * 🔴 **読み幅が焼かれている**(user 裁定 2026-08-08: アプリと書き出しで統一。
   * 46em/器 → 42rem/各ブロック)。書き出し側の `.b{max-width}` は消えたので、
   * **ここが落ちる = 配った HTML の本文が全幅に伸びる**。
   * ⚠ 規則と token 定義の**両方**を見る ── 規則だけだと `--read-w` の定義が
   *   落ちた日に宣言ごと無効になり(未定義の var は fall back しない)、
   *   規則が在るのに幅が消える。
   */
  it('🔴 読み幅の規則と --read-w の定義が焼かれている(下限 tripwire)', () => {
    expect(OUT.css, '読み幅の規則が焼かれていない').toContain('max-width:var(--read-w)');
    expect(OUT.vars, '--read-w が要求されていない').toContain('--read-w');
    expect(OUT.css, '--read-w の定義が無い(宣言ごと無効になる)').toContain('--read-w:');
  });

  /**
   * 🔴 **`@media` の文脈を持ち運ぶ**。落とすと、印刷用の `break-after: page` が
   * **画面でも常時効く** ── 本文がどこでも切れる。
   */
  it('🔴 印刷の規則が @media print の中に在る(画面へ漏れない)', () => {
    const at = OUT.css.indexOf('@media print{');
    expect(at, '@media print が無い').toBeGreaterThan(0);
    const inPrint = OUT.css.slice(at);
    expect(inPrint, '改頁が印刷の中に無い').toContain('break-after:page');
    // ⚠ 画面側(@media print より前)に印刷専用の宣言が漏れていないこと
    const onScreen = OUT.css.slice(0, at);
    expect(onScreen, '改頁が画面にも効いている').not.toContain('break-after:page');
    expect(onScreen, '改頁禁止が画面にも効いている').not.toContain('break-inside:avoid');
  });

  /**
   * ⚠ `--pkc-blank-count` は **renderer が inline style で渡す**もので、トークンではない。
   * 焼くと `_3`(空行 3 つ)の高さがその固定値になる。
   */
  it('空行の数は焼かない(renderer が inline で渡す値)', () => {
    expect(OUT.vars, '--pkc-blank-count を焼いている').not.toContain('--pkc-blank-count');
    expect(OUT.css, '空行の高さの規則そのものは要る').toContain('var(--pkc-blank-count,1)');
    expect(OUT.css, '空行の数を定義してしまっている').not.toContain('--pkc-blank-count:');
  });

  /** minify が字面を壊していない ── 抜いた本数のまま読み直せる。 */
  it('出力を読み直しても規則の数が変わらない(詰め方で壊していない)', () => {
    const back = parseRules(OUT.css).filter((r) => isBodyRule(r.selector));
    expect(back.length, '読み直すと本数が変わる').toBe(OUT.ruleCount);
    // ⚠ セレクタに改行が残っていない(配る HTML に載る字面である)
    const nl = back.filter((r) => r.selector.includes('\n'));
    expect(nl.map((r) => r.selector), 'セレクタに改行が残っている').toEqual([]);
  });
});

describe('本文の規則かどうかの判定', () => {
  /**
   * ⚠ 判定は**1 つだけ**(CLAUDE.md「判定を増やさない」)── 「全 comma 節が
   * `.pkc-md-rendered` で始まるか」。**「書き出しに要る規則か」を選び始めない**。
   */
  const CASES: ReadonlyArray<readonly [string, boolean]> = [
    ['.pkc-md-rendered', true],
    ['.pkc-md-rendered h1', true],
    ['.pkc-md-rendered h1,.pkc-md-rendered h2', true],
    ['.pkc-md-rendered[data-pkc-writing="vertical"]', true],
    ['.pkc-md-rendered .pkc-fig > figcaption', true],
    // ⚠ 1 節でも外れたら false ── 器と本文を跨ぐ規則は器の規則である
    ['.pkc-md-rendered h1,h2', false],
    ['h1,.pkc-md-rendered h1', false],
    ["[data-pkc-field='detail-body'] > :is(p,.pkc-md-rendered)", false],
    /**
     * ⚠ **前方一致だけでは足りない**(2026-08-07 のレビューで直した)。
     * `.pkc-md-rendered-csv` は「同じ字で始まる別の class」で、器を起点にしていない
     * ── トップレベルに書かれたら**焼いてはいけない**。
     * (器の中に出る `.pkc-md-rendered .pkc-md-rendered-csv` は下の行のとおり通る)
     */
    ['.pkc-md-rendered-csv', false],
    ['.pkc-md-rendered .pkc-md-rendered-csv', true],
    ['.pkc-md-renderedx p', false],
    ['body', false],
    ['', false],
  ];
  for (const [sel, want] of CASES) {
    it(`${want ? '本文' : '器'}: ${sel || '(空)'}`, () => {
      expect(isBodyRule(sel)).toBe(want);
    });
  }

  /**
   * ⚠ `:is(a, b)` の中のカンマで節に割らない ── 割ると
   * 「`.pkc-md-rendered :is(p, table)`」が 2 節に見えて、後ろの節が外れる。
   */
  it(':is(…) の中のカンマでは節に割らない', () => {
    expect(isBodyRule('.pkc-md-rendered :is(p, table, blockquote)')).toBe(true);
  });

  /**
   * ⚠ **角括弧の中のカンマでも割らない**。丸括弧だけ数える実装でも `:is(…)` の
   * 1 件は通ってしまうので、**属性値の中のカンマ**で直接見る
   * (深さを丸括弧だけにする変異が、これが無いと生き延びる)。
   */
  it('属性値の中のカンマでは節に割らない', () => {
    expect(isBodyRule('.pkc-md-rendered [title="a,b"]')).toBe(true);
    expect(isBodyRule(".pkc-md-rendered [data-x='a,b'] p")).toBe(true);
    // ⚠ 割ってしまう実装では 2 節に見え、後ろの節が起点を持たないので false になる
    expect(isBodyRule('.pkc-md-rendered [title="a,b"],.pkc-md-rendered q')).toBe(true);
  });
});

describe('app.css との突合(片方だけ古くならない)', () => {
  /**
   * 🔴 **app.css の `.pkc-md-rendered` 前置きの規則が全部入っている**。
   * ⚠ 「N 本以上」では守れない ── 抜き出しの規則を変えて 1 本だけ落とす変異が
   *   素通りする。**app.css を数え直して突合する**。
   */
  it('🔴 抜けている本文の規則が 1 本も無い', () => {
    /**
     * 🔴 **右辺を独立に数える**(2026-08-07、レビュー 2 巡目で直した)。
     * 直す前は `parseRules(APP).filter(isBodyRule).length` と比べていたが、
     * `OUT.ruleCount` の定義が**まったく同じ式**なので `x === x` の
     * **トートロジー**だった ── `parseRules` / `isBodyRule` を変えると両辺が
     * 一緒に動く。docstring は「app.css を数え直して突合する」と主張していたのに、
     * その主張が成立していなかった。
     *
     * だから**別の数え方**で突合する:`.pkc-md-rendered` という字面の出現数。
     * 抜いた規則は**セレクタも宣言もそのまま**焼かれるので、両者は一致するはず。
     * ⚠ 1 本落ちれば必ず減る(どの本文規則もこの字面を最低 1 回持つ)。
     */
    const occurrences = (css: string): number =>
      (css.replace(/\/\*[\s\S]*?\*\//g, '').match(/\.pkc-md-rendered/g) ?? []).length;
    const inApp = occurrences(APP);
    expect(inApp, 'app.css に本文の規則が無い(この検査は空振り)').toBeGreaterThan(100);
    expect(occurrences(OUT.css), '焼いた CSS で本文のセレクタが減っている').toBe(inApp);
    // ⚠ 規則の**本数**も見る(字面の数だけでは、1 本を 2 本へ割る変異が通る)
    expect(OUT.ruleCount, '抜いた本数が減っている').toBeGreaterThanOrEqual(100);
  });

  /**
   * ⚠ **トークンの層で名前が重なっていない**ことを pin する。重なると
   * 「配色 → 幾何」の並びが勝ち手を決めることになり、tokens.css の並びを
   * 変えただけで見た目が動く(気づけない)。
   */
  it('配色の層と幾何の層で名前が重なっていない', () => {
    const rules = parseRules(TOKENS).filter((r) => r.at.length === 0);
    const names = (pick: (sel: string) => boolean): Set<string> => {
      const out = new Set<string>();
      for (const r of rules.filter((x) => pick(x.selector))) {
        for (const m of r.body.matchAll(/(--[\w-]+)\s*:/g)) out.add(m[1]!);
      }
      return out;
    };
    const geo = names((s) => s.trim() === ':root');
    const light = names((s) => s.includes("data-pkc-theme='light'"));
    expect(geo.size, '幾何の層が空(この検査は空振り)').toBeGreaterThan(4);
    expect(light.size, '配色の層が空(この検査は空振り)').toBeGreaterThan(8);
    const both = [...geo].filter((n) => light.has(n)).sort();
    expect(both, `2 つの層で重なっている: ${both.join(', ')}`).toEqual([]);
  });
});

/**
 * 🔴 **合成した CSS で「今日は起きないこと」を検める**(2026-08-07 のレビュー指摘)。
 *
 * ⚠ 本物の `app.css` / `tokens.css` だけで検めていると、**今日の入力に無い形**を
 * 壊す変異が全部生き延びる ── 実際、下の 4 つはどれも「本物では素通りするが、
 * 明日 CSS を 1 行足した人が静かに壊す」型だった。
 */
describe('合成した CSS で境界を検める(本物では素通りする形)', () => {
  /**
   * 🔴 **block を持たない at-statement**(`@import x;` / `@layer a;`)。
   * ⚠ 直す前は `head` が `{` `}` でしか畳まれず、`@import` が次の `{` まで
   *   残って「`@` 始まり」と判定され、**直後の規則が丸ごと捨てられて**いた。
   *   `app.css:22` の `@import './tokens.css';` の直後は `*{box-sizing}`(器の
   *   規則)なので今日の出力は正しいが、位置が動けば本文の規則が消える。
   */
  it('🔴 @import の直後の規則を落とさない', () => {
    const rules = parseRules(
      "@import './tokens.css';\n.pkc-md-rendered p{color:red}\n.pkc-md-rendered q{color:blue}\n",
    );
    expect(rules.map((r) => r.selector)).toEqual(['.pkc-md-rendered p', '.pkc-md-rendered q']);
    // ⚠ セレクタに at-statement が混ざっていない(混ざると規則ごと当たらなくなる)
    expect(rules[0]!.selector, 'セレクタが at-statement で汚れている').not.toContain('@');
  });

  it('@layer 宣言の直後も同じ(将来の書き方)', () => {
    const rules = parseRules('@layer base, app;\n.pkc-md-rendered p{color:red}\n');
    expect(rules.map((r) => r.selector)).toEqual(['.pkc-md-rendered p']);
  });

  /**
   * 🔴 **`:` の前の空白を消さない**。消すと子孫結合子が消えて
   * **複合セレクタという別物**になる(器の中の p → 器そのもの)。
   */
  it('🔴 空白 + 擬似クラスを複合セレクタへ潰さない', () => {
    const out = extractBodyCss(
      '.pkc-md-rendered :is(p, ul){margin:0}\n' +
        '.pkc-md-rendered ::selection{background:red}\n' +
        '.pkc-md-rendered > :first-child{margin-top:0}\n' +
        '.pkc-md-rendered p{margin: var(--s5) 0 var(--s2)}\n',
      TOKENS,
    );
    expect(out.css, '器の中の p/ul が器そのものへ化けている').toContain(
      '.pkc-md-rendered :is(p,ul){margin:0}',
    );
    expect(out.css, '擬似要素が器そのものに付いた').toContain('.pkc-md-rendered ::selection{');
    // ⚠ `>` は詰めてよい(結合子が明示されているので意味が変わらない)
    expect(out.css).toContain('.pkc-md-rendered>:first-child{');
    // ⚠ 値の中の空白は残す / 宣言の `:` の後ろは詰める
    expect(out.css).toContain('margin:var(--s5) 0 var(--s2)');
  });

  /**
   * 🔴 **引用符の中は字面であって構文ではない**(2026-08-07、レビュー 2 巡目)。
   * `;` で `head` を畳む分岐を足したとき、**属性セレクタの中の `;` でも畳んで**
   * しまい、規則が丸ごと壊れていた(実測: セレクタが `b"]` になる)── 直した先で
   * 開けた穴である。
   */
  it('🔴 属性値の中の `;` `{` `}` で規則を切らない', () => {
    const rules = parseRules(
      '.pkc-md-rendered [data-x="a;b"]{color:red}\n' +
        ".pkc-md-rendered [data-y='c{d'] p{color:blue}\n" +
        '.pkc-md-rendered q::after{content:"}"}\n' +
        '.pkc-md-rendered p{color:green}\n',
    );
    expect(rules.map((r) => r.selector)).toEqual([
      '.pkc-md-rendered [data-x="a;b"]',
      ".pkc-md-rendered [data-y='c{d'] p",
      '.pkc-md-rendered q::after',
      '.pkc-md-rendered p',
    ]);
    expect(rules[2]!.body, '宣言が引用符の中の } で切れている').toBe('content:"}"');
  });

  /**
   * 🔴 **引用符の中を詰めない**。`content: '注: '` は詰めると**別の文字列**になり、
   * `[title="a, b"]` は詰めると**一致しなくなる**(どちらも実測)。
   */
  it('🔴 minify が文字列と属性値を書き換えない', () => {
    const out = extractBodyCss(
      ".pkc-md-rendered p::after{content:'注: '}\n" +
        '.pkc-md-rendered q::before{content:", "}\n' +
        '.pkc-md-rendered [title="a, b"]{color:red}\n' +
        '.pkc-md-rendered i::after{content:"a   b"}\n',
      TOKENS,
    );
    expect(out.css, '文字列の末尾の空白が消えた').toContain("content:'注: '");
    expect(out.css, '文字列の中のカンマの後ろが詰まった').toContain('content:", "');
    expect(out.css, '属性値が詰まってセレクタが一致しなくなった').toContain('[title="a, b"]');
    expect(out.css, '文字列の中の連続空白が潰れた').toContain('content:"a   b"');
    // ⚠ 引用符の外は従来どおり詰まる(退避が効きすぎていないこと)
    expect(out.css).toContain('.pkc-md-rendered p::after{');
  });

  /**
   * 🔴 **トークンの推移閉包**。`tokens.css` は今日 `var(` を 1 個も持たないので、
   * 閉包を消しても本物では出力が byte 一致する ── **合成でしか検められない**。
   */
  it('🔴 トークンが別のトークンを参照していたら、その参照先も焼く', () => {
    const tokens =
      ":root, :root[data-pkc-theme='light']{--a:#111;--b:color-mix(in oklab, var(--a) 50%, #fff)}\n" +
      ":root[data-pkc-theme='dark']{--a:#eee;--b:#333}\n" +
      ':root{--geo:2px}\n';
    const out = extractBodyCss('.pkc-md-rendered p{color:var(--b);padding:var(--geo)}\n', tokens);
    expect([...out.vars].sort(), '参照先の --a が抜けている(宣言ごと無効になる)').toEqual([
      '--a',
      '--b',
      '--geo',
    ]);
    expect(out.css, '--a の定義が焼かれていない').toContain('--a:#111');
    expect(auditBodyCss(out).filter((m) => m.includes('定義の無い var'))).toEqual([]);
  });

  /**
   * 🔴 **dark にしか無いトークンは「欠落」である**。明るい環境で `var()` が
   * 未定義になり、宣言ごと無効になる ── コメントはそう書いてあるのに無検査だった。
   */
  it('🔴 暗い側にしか定義が無いトークンを欠落として数える', () => {
    const tokens =
      ":root, :root[data-pkc-theme='light']{--a:#111}\n" +
      ":root[data-pkc-theme='dark']{--a:#eee;--only-dark:#f00}\n";
    const out = extractBodyCss('.pkc-md-rendered p{color:var(--only-dark)}\n', tokens);
    expect(out.missing, '暗い側にしか無い変数を見逃している').toEqual(['--only-dark']);
    expect(auditBodyCss(out).join('\n')).toContain('--only-dark');
  });
});

/**
 * 🔴 **焼いた文字列そのものを検める検査**(`auditBodyCss`)。
 *
 * ⚠ 直す前の tripwire は `missing` / `ruleCount` / `vars` の 3 つで、**どれも
 *   出力を見ていなかった** ── トークンを push する 3 行を落とすと 3 つとも緑のまま
 *   「トークンが 1 個も焼かれていない HTML」が出荷される。**この describe が
 *   その門である**(plugin の hook は Vite を起こさないと走らないので、判定は
 *   純関数側に置いてここから叩く)。
 */
describe('焼いた文字列の検品', () => {
  const ok = (): Parameters<typeof auditBodyCss>[0] => extractBodyCss(APP, TOKENS);

  it('本物の入力は合格する(この検査が常に鳴っていない)', () => {
    expect(auditBodyCss(ok())).toEqual([]);
  });

  it('🔴 トークンが 1 個も焼かれていない出力を止める', () => {
    const base = ok();
    // トークンの :root 群だけ落とす(規則はそのまま)= 実装の 3 行を消したのと同じ形
    const css = base.css.slice(base.css.indexOf('.pkc-md-rendered'));
    const bad = auditBodyCss({ ...base, css });
    expect(bad.join('\n'), '定義の無い var を見逃した').toContain('定義の無い var');
    expect(bad.join('\n'), '焼いたトークンの個数を見ていない').toContain('焼いたトークンが');
  });

  it('🔴 暗い環境の層が包まれていない出力を止める', () => {
    const base = ok();
    const css = base.css.replace('@media (prefers-color-scheme:dark){:root{', ':root{');
    expect(auditBodyCss({ ...base, css }).join('\n')).toContain('暗い環境のトークンの層');
  });

  /**
   * 🔴 **規則も「焼いた文字列」から数える**(2026-08-07、レビュー 2 巡目)。
   * 直す前は `out.ruleCount`(需要側の数)を見ていたので、**規則を 1 本も出さない
   * 671 バイトの CSS が合格していた**(実測)── トークンについて直した欠陥の鏡像。
   */
  it('🔴 規則が 1 本も焼かれていない出力を止める(需要の数では通してしまう)', () => {
    const base = ok();
    // 規則の部分だけ削る = 組み立てのループを消したのと同じ形。ruleCount は抜いた数のまま
    const css = base.css.slice(0, base.css.indexOf('.pkc-md-rendered'));
    const bad = auditBodyCss({ ...base, css }).join('\n');
    expect(bad, '規則 0 本の出力を通した').toContain('本文の規則が 0 本');
    // ⚠ 実測数を直書きしない ── 規則を 1 本足すたびにここが割れる。突合の**形**を見る
    expect(bad, '抜いた数との食い違いを言っていない').toContain(
      `抜いた ${base.ruleCount} 本のうち 0 本`,
    );
  });

  it('🔴 印刷の層が落ちた出力を止める(紙で改頁が起きなくなる)', () => {
    const base = ok();
    const css = base.css.slice(0, base.css.indexOf('@media print{'));
    expect(auditBodyCss({ ...base, css }).join('\n')).toContain('印刷の層');
  });

  it('🔴 器の規則が混ざって膨らんだ出力を止める(tripwire は両側)', () => {
    const base = ok();
    const extra = Array.from(
      { length: 200 },
      (_, i) => `.pkc-md-rendered .x${i}{color:red}`,
    ).join('');
    expect(auditBodyCss({ ...base, css: base.css + extra }).join('\n')).toContain('上限');
  });

  /**
   * 🔴 **`</` を通さない**。この CSS は書き出し HTML の `<style>` へ**素で**埋まる ──
   * `content: '</style>'` と書かれた日に style が早期終了し、CSS の残りが
   * **本文として画面に出る**。⚠ この file(pkc3-html.ts)は本文の `<` を全部退避する
   * 規律を掲げているのに、外から来た 12KB だけが素通りしていた。
   */
  it('🔴 style を早期終了させる字面を通さない', () => {
    const base = ok();
    const css = `${base.css}.pkc-md-rendered p::after{content:'</style><b>x'}`;
    expect(auditBodyCss({ ...base, css }).join('\n')).toContain('style が早期終了');
  });
});
