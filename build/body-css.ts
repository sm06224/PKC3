/**
 * 🔴 **本文の見た目の正本を 1 本にする**(2026-08-07)。
 *
 * `src/styles/app.css` から**本文の規則だけ**を抜き、書き出す HTML の `<style>` へ
 * 焼くための純関数。⚠ build 時に 1 度走らせる(`build/body-css-plugin.ts`)ので、
 * 生成物に載るのは抜いた分(約 12 KB)だけ ── app.css の全文(80 KB)は載らない。
 *
 * ## なぜ要るのか(実測)
 *
 * 直す前、書き出した HTML では **`.pkc-*` の規則が 10 個**しか無かった
 * (`app.css` は 71 個)。実ブラウザで開くと 21 の観測点のうち **17 が違って**いた:
 * `:::note` / `:::danger` は枠も地も無く**本文の段落と見分けが付かない** /
 * タスク行は**丸ポチとチェック欄が二重**に出る / 圏点が付かない /
 * `_3`(空行 3 つ)の高さが 0 / ルビ・`==印==` の目印が素の字。
 *
 * ## 判定は 1 つ ── 「全 comma 節が `.pkc-md-rendered` で始まるか」
 *
 * 🔑 「class 名で本文用と器用を分ける」は**実測で崩れた** ── `app.css` の
 * `.pkc-*` は **71 個すべてが本文の記法が出す class** で、器は
 * `[data-pkc-region=…]` / `[data-pkc-field=…]` 属性で書かれており `.pkc-*` を
 * 1 つも使っていない。分かれ目は class 名ではなく**規則の階層**にある ──
 * 全 294 規則が「`.pkc-md-rendered` 前置きの 113 本」と「それ以外 181 本」に
 * 機械的に割れる(境界例は読み幅の 1 本だけ。それは器の規則なので落ちて正しい)。
 * ⚠ **第 2 の判定を足さない**(CLAUDE.md「判定を増やさない」)── 「書き出しに
 *   要る規則か」を選び始めると、そこが古くなる。書き出し面で死んでいる 4 本
 *   (コピーボタン / mermaid の原文)も無害なので一緒に焼く。
 *
 * ## 🔴 tokens を必ず一緒に焼く ── 規則だけでは「何もしないより悪化する」
 *
 * 実測: 規則だけ写して `var(--border)` 等の定義を持ち込まないと、その宣言は
 * **computed-value time で無効**になり、**先行する規則へ fall back しない**。
 * つまり `+++` の罫線が消え(`border-top-width` 1px → 0px)、`==印==` の目印の
 * 地が透明になり、表のセル罫が黒くなる ── **いま効いているものまで潰す**。
 *
 * ⚠ **値を静的に解決するのも駄目**(実測)。light の値で潰すと、暗い環境で
 *   `:::toc` の地がほぼ白のまま文字が白になって**読めなくなる**。
 *   書き出す HTML は `color-scheme: light dark` で地を環境に追従させているので、
 *   トークンも **light と dark の 2 ブロック**で焼いて追従させる。
 * ⚠ 本文の規則は色を `color-mix(in oklab, var(--surface-2) 92%, …)` で作っている
 *   箇所が 11 ある ── トークンを渡せば混色も自動で追従する。静的解決はこの
 *   自己追従性を捨てることになる。
 */

/** 本文の規則の目印。⚠ ここを変えるときは `app.css` の器の class 名と揃える。 */
const BODY_SCOPE = '.pkc-md-rendered';

export interface BodyCss {
  /** 焼く CSS(本文の規則 + tokens の不変 / light / dark)。 */
  readonly css: string;
  /** 本文の規則が参照している CSS 変数(`--border` 等。`--` 込み。推移閉包)。 */
  readonly vars: readonly string[];
  /** 抜いた規則の数(空振り防止に使う)。 */
  readonly ruleCount: number;
  /**
   * 🔴 **要求されたのに定義が見つからなかった変数**。
   *
   * 1 個でも在ってはならない ── `var()` が未定義だと、その宣言は
   * **computed-value time で無効**になり、**先行する規則へ fall back しない**。
   * つまり「焼いたせいで、いま効いているものまで消える」= 何もしないより悪くなる。
   * ⚠ だから plugin 側はこれが空でなければ **build を止める**。
   */
  readonly missing: readonly string[];
}

/** コメントを落とす。⚠ 文字列の中の `/*` は CSS には出ないので単純置換で足りる。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** `a, b` を節に割る。⚠ `:is(a, b)` の中のカンマでは割らない(括弧の深さを見る)。 */
function splitSelectors(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of sel) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

interface Rule {
  /** `@media …` の入れ子(外→内)。トップレベルなら空。 */
  readonly at: readonly string[];
  readonly selector: string;
  readonly body: string;
}

/**
 * 規則を平らに数え上げる。⚠ **`@media` の文脈を持ち運ぶ** ── 落とすと
 * 印刷の規則が画面の規則として焼かれる(改頁が常時効いてしまう)。
 */
export function parseRules(css: string): Rule[] {
  const src = stripComments(css);
  const out: Rule[] = [];
  const at: string[] = [];
  let i = 0;
  let head = '';
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '{') {
      const h = head.trim();
      head = '';
      i += 1;
      if (h.startsWith('@')) {
        // at-rule。⚠ `@media` / `@supports` は中に規則を持つ ── 文脈へ積む
        at.push(h);
        continue;
      }
      // 宣言ブロック ── 対応する `}` まで読む(中に `{` は来ない)
      const end = src.indexOf('}', i);
      const body = src.slice(i, end < 0 ? src.length : end);
      out.push({ at: [...at], selector: h, body: body.trim() });
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (ch === '}') {
      at.pop();
      head = '';
      i += 1;
      continue;
    }
    head += ch;
    i += 1;
  }
  return out;
}

/** その規則は本文の規則か(**全 comma 節**が `.pkc-md-rendered` で始まる)。 */
export function isBodyRule(selector: string): boolean {
  const parts = splitSelectors(selector);
  if (parts.length === 0) return false;
  return parts.every((p) => p.startsWith(BODY_SCOPE));
}

/** `var(--x)` を数え上げる。 */
function varsIn(text: string): string[] {
  return [...text.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!);
}

/**
 * 宣言ブロックから**カスタムプロパティだけ**を取り出す。
 * ⚠ `d.split(':')[0]` にしない ── 値の中の `:`(`url(a:b)` 等)で名前が壊れる。
 */
function customProps(rule: Rule | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!rule) return out;
  for (const d of rule.body.split(';')) {
    const at = d.indexOf(':');
    if (at < 0) continue;
    const name = d.slice(0, at).trim();
    if (!name.startsWith('--')) continue;
    out.set(name, d.slice(at + 1).trim());
  }
  return out;
}

/**
 * tokens.css の 3 つの層。
 *
 * 🔴 **`invariant` を落とすと「焼いたせいで壊れる」**(2026-08-07 に実際に踏んだ)。
 * `tokens.css` は配色をテーマごとの `:root[data-pkc-theme=…]` に、**幾何と書体を
 * 素の `:root`** に置いている。テーマの層だけ見ていたので `--s2`〜`--s5` /
 * `--radius` / `--font-mono` の 6 個が抜け、`margin: var(--s5) 0 var(--s2)` の
 * ような宣言が**丸ごと無効**になっていた ── 見出しの余白が消え、`pre` の角が
 * 落ち、コードが本文と同じ書体になる。
 */
interface Tokens {
  /** 素の `:root`(テーマで変わらない幾何・書体)。 */
  readonly invariant: ReadonlyMap<string, string>;
  /** `:root, :root[data-pkc-theme='light']`(既定の配色)。 */
  readonly light: ReadonlyMap<string, string>;
  /** `:root[data-pkc-theme='dark']`(暗い環境で当てる配色)。 */
  readonly dark: ReadonlyMap<string, string>;
}

function readTokens(tokensCss: string): Tokens {
  const rules = parseRules(tokensCss).filter((r) => r.at.length === 0);
  const invariant = new Map<string, string>();
  for (const r of rules) {
    const parts = splitSelectors(r.selector);
    // ⚠ **節が 1 個で、それが素の `:root`** のときだけ。`includes(':root')` にすると
    //    light の `:root, :root[data-pkc-theme='light']` にも当たる
    if (parts.length !== 1 || parts[0] !== ':root') continue;
    for (const [k, v] of customProps(r)) invariant.set(k, v);
  }
  // ⚠ `data-pkc-theme='dark'` は `'github-dark'` / `'solarized-dark'` の部分文字列に
  //    ならない(引用符が境界になる)── ここを緩めるとテーマを取り違える
  const find = (theme: string): Rule | undefined =>
    rules.find((r) => r.selector.includes(`data-pkc-theme='${theme}'`));
  return { invariant, light: customProps(find('light')), dark: customProps(find('dark')) };
}

/**
 * 変数の**推移閉包**を取る ── トークンの値が別のトークンを参照していることがある
 * (`color-mix(… var(--accent) …)`)。1 段しか見ないと、その参照先だけ抜けて
 * また「宣言ごと無効」になる。
 */
function closeOver(want: Set<string>, t: Tokens): void {
  for (let grew = true; grew; ) {
    grew = false;
    for (const name of [...want]) {
      for (const src of [t.invariant, t.light, t.dark]) {
        const value = src.get(name);
        if (value === undefined) continue;
        for (const dep of varsIn(value)) {
          if (want.has(dep)) continue;
          want.add(dep);
          grew = true;
        }
      }
    }
  }
}

/** 要求された変数だけを宣言列にする(順序は tokens.css の宣言順)。 */
function declsFor(src: ReadonlyMap<string, string>, want: ReadonlySet<string>): string {
  const out: string[] = [];
  for (const [k, v] of src) if (want.has(k)) out.push(`${k}:${v}`);
  return out.length === 0 ? '' : `${out.join(';')};`;
}

/**
 * 本文の規則と、それが要求するトークンを抜く。
 *
 * ⚠ `--pkc-blank-count` は renderer が inline style で渡す(トークンではない)ので
 * 焼かない ── 焼くと空行の数がその値で固定される。
 */
export function extractBodyCss(appCss: string, tokensCss: string): BodyCss {
  const kept = parseRules(appCss).filter((r) => isBodyRule(r.selector));
  const tokens = readTokens(tokensCss);
  const vars = new Set<string>();
  for (const r of kept) for (const v of varsIn(r.body)) vars.add(v);
  vars.delete('--pkc-blank-count');
  closeOver(vars, tokens);

  // `@media` の文脈ごとにまとめ直す(同じ文脈の規則は 1 つの `@media` に入れる)
  const byContext = new Map<string, Rule[]>();
  for (const r of kept) {
    // ⚠ 文脈の区切りは **NUL**(空白ではない)── `@media print` にも
    //   `@media (prefers-color-scheme: dark)` にも空白が入っているので、空白で
    //   join / split すると入れ子の at-rule が**ばらばらに割れる**。
    //   ⚠ 生バイトで書かない(`tests/repo-hygiene.test.ts` が機械的に止める)
    const key = r.at.join('\u0000');
    const group = byContext.get(key);
    if (group) group.push(r);
    else byContext.set(key, [r]);
  }
  const parts: string[] = [];
  // 並びは tokens.css と同じ「配色 → 幾何」にする(名前が重なったときの勝ち手を
  // 正本と揃えておく。今日は重なりが 0 で、それを test が pin する)
  const light = declsFor(tokens.light, vars);
  const invariant = declsFor(tokens.invariant, vars);
  const dark = declsFor(tokens.dark, vars);
  if (light !== '') parts.push(`:root{${light}}`);
  if (invariant !== '') parts.push(`:root{${invariant}}`);
  // ⚠ 暗い環境では dark を当てる ── 静的に light で潰すと白箱に白文字になる(実測)
  if (dark !== '') parts.push(`@media (prefers-color-scheme:dark){:root{${dark}}}`);
  for (const [key, group] of byContext) {
    const body = group.map((r) => `${r.selector}{${r.body}}`).join('');
    if (key === '') {
      parts.push(body);
      continue;
    }
    const opens = key.split('\u0000');
    parts.push(`${opens.map((o) => `${o}{`).join('')}${body}${'}'.repeat(opens.length)}`);
  }
  // 「基底の層(幾何 + light)に定義が在るか」で見る ── dark にしか無い変数は
  // 明るい環境で無効になるので、それも欠落として数える
  const missing = [...vars].filter((v) => !tokens.invariant.has(v) && !tokens.light.has(v)).sort();
  return {
    css: minify(parts.join('\n')),
    vars: [...vars].sort(),
    ruleCount: kept.length,
    missing,
  };
}

/** 空白を詰める(見た目の整形は要らない ── 配る HTML に埋め込む文字列である)。 */
function minify(css: string): string {
  return (
    css
      // ⚠ **先に改行ごと 1 個の空白へ潰す**。改行を残すと、prettier が折り返した
      //   セレクタ(`.pkc-md-rendered\n  li.pkc-task-item…`)の中に改行が残る ──
      //   CSS としては空白なので動くが、読めない字面が配る HTML に載る
      .replace(/\s+/g, ' ')
      // ⚠ 空白を消してよいのは**区切り記号の周り**だけ。値の中の空白
      //   (`margin:var(--s5) 0 var(--s2)` / `calc(1.45em * …)`)は意味を持つ
      .replace(/\s*([{}:;,>])\s*/g, '$1')
      .replace(/;}/g, '}')
      .trim()
  );
}
