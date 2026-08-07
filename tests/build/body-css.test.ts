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
import { extractBodyCss, isBodyRule, parseRules } from '../../build/body-css';

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
    // ⚠ 同じ名前が両方の層に在ること = 上書きが成立していること
    const darkBlock = OUT.css.slice(dark, OUT.css.indexOf('}}', dark));
    for (const name of ['--fg', '--surface-2', '--border']) {
      expect(darkBlock, `${name} が暗い環境で上書きされていない`).toContain(`${name}:`);
    }
    // ⚠ **色以外を dark に混ぜない** ── 幾何をテーマ層から拾い始めた印
    expect(darkBlock, '幾何が暗い環境の層に混ざっている').not.toContain('--s5:');
  });

  /**
   * 🔴 **器の規則を持ち込まない**。閲覧側は `body{display:grid}` の別の器なので、
   * アプリの器の規則が混ざると**見た目を壊す**(直す目的と逆になる)。
   */
  it('🔴 器の規則(region / field)が 1 本も混ざっていない', () => {
    for (const key of ['data-pkc-region', 'data-pkc-field', 'data-pkc-view']) {
      expect(OUT.css, `器の規則が混ざっている: ${key}`).not.toContain(key);
    }
    // ⚠ 逆に、本文が使う data 属性は**在らねばならない**(選り過ぎの検出)
    for (const key of ['data-pkc-align', 'data-pkc-indent', 'data-pkc-render-mode']) {
      expect(OUT.css, `本文の属性の規則が落ちている: ${key}`).toContain(key);
    }
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
    ['.pkc-md-rendered-csv', true],
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
});

describe('app.css との突合(片方だけ古くならない)', () => {
  /**
   * 🔴 **app.css の `.pkc-md-rendered` 前置きの規則が全部入っている**。
   * ⚠ 「N 本以上」では守れない ── 抜き出しの規則を変えて 1 本だけ落とす変異が
   *   素通りする。**app.css を数え直して突合する**。
   */
  it('🔴 抜けている本文の規則が 1 本も無い', () => {
    const want = parseRules(APP).filter((r) => isBodyRule(r.selector));
    expect(want.length, 'app.css に本文の規則が無い(この検査は空振り)').toBeGreaterThan(100);
    expect(OUT.ruleCount, '抜き出しが app.css より少ない').toBe(want.length);
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
