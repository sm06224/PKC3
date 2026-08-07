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
 * 全 301 規則が「`.pkc-md-rendered` を起点にする 116 本」と「それ以外 185 本」に
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
  /**
   * 🔴 **引用符の中は字面であって構文ではない**(2026-08-07、レビュー 2 巡目)。
   * `{` `}` `;` を無条件に区切りとして扱うと、`[data-x="a;b"]` のような
   * 属性セレクタで**規則が丸ごと壊れる**(実測: セレクタが `b"]` になり、
   * `isBodyRule` を通らなくなって静かに落ちた)。⚠ これは下の `;` の分岐を
   * 足したときに**新しく開いた穴**である ── 直した先で開けたので記録する。
   */
  let quote = '';
  while (i < src.length) {
    const ch = src[i]!;
    if (quote !== '') {
      if (ch === quote) quote = '';
      head += ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      head += ch;
      i += 1;
      continue;
    }
    if (ch === '{') {
      const h = head.trim();
      head = '';
      i += 1;
      if (h.startsWith('@')) {
        // at-rule。⚠ `@media` / `@supports` は中に規則を持つ ── 文脈へ積む
        at.push(h);
        continue;
      }
      // 宣言ブロック ── 閉じ `}` まで読む。⚠ ここも**引用符を跨がない**
      // (`content: '}'` で規則が切れる)
      let end = i;
      let q = '';
      for (; end < src.length; end += 1) {
        const c = src[end]!;
        if (q !== '') {
          if (c === q) q = '';
          continue;
        }
        if (c === '"' || c === "'") q = c;
        else if (c === '}') break;
      }
      out.push({ at: [...at], selector: h, body: src.slice(i, end).trim() });
      i = end < src.length ? end + 1 : src.length;
      continue;
    }
    if (ch === '}') {
      at.pop();
      head = '';
      i += 1;
      continue;
    }
    /**
     * 🔴 **block を持たない at-statement で `head` を畳む**(`@import x;` / `@layer a;`)。
     *
     * ⚠ 直す前は `{` と `}` でしか畳んでいなかったので、`app.css:22` の
     * `@import './tokens.css';` が次の `{` まで `head` に残り、
     * `"@import './tokens.css';\n\n*"` が `@` 始まりと判定されて **at-rule の文脈へ積まれ、
     * 直後の `* { box-sizing: border-box }` が丸ごと捨てられていた**(合成入力で再現:
     * `@import 'x';` + 本文規則 2 本 → 1 本目が消える)。
     * 今日は捨てられるのが器の規則なので**出力は正しい**が、`@import` の位置が動くか
     * `@layer` が足された日に、**本文の規則 1 本が黙って焼かれなくなる**。
     */
    if (ch === ';') {
      head = '';
      i += 1;
      continue;
    }
    head += ch;
    i += 1;
  }
  return out;
}

/**
 * その節は本文の器を起点にしているか。
 *
 * ⚠ **前方一致だけでは足りない** ── `.pkc-md-rendered-csv` のような
 * 「同じ字で始まる別の class」を通してしまう。起点として使われている証拠は
 * **直後が境界**であること(`.pkc-md-rendered` そのもの / 空白 / `.` / `#` /
 * `[` / `:` / `>` / `+` / `~`)。
 */
function startsAtBody(part: string): boolean {
  if (!part.startsWith(BODY_SCOPE)) return false;
  const rest = part.slice(BODY_SCOPE.length);
  return rest === '' || /^[\s.#[:>+~]/.test(rest);
}

/** その規則は本文の規則か(**全 comma 節**が `.pkc-md-rendered` を起点にしている)。 */
export function isBodyRule(selector: string): boolean {
  const parts = splitSelectors(selector);
  if (parts.length === 0) return false;
  return parts.every(startsAtBody);
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
 * 変数の**推移閉包**を取る ── トークンの値が別のトークンを参照していたら、その
 * 参照先も焼かないと「宣言ごと無効」がトークン側で起きる。
 *
 * ⚠ **2026-08-07 時点の `tokens.css` は `var(` を 1 個も持たない**(実測 0 件)ので、
 *   ここは今日 1 個も足さない ── つまり**この関数を消しても出力は byte 一致する**。
 *   残しているのは `--accent-dim: color-mix(… var(--accent) …)` のような書き方を
 *   `tokens.css` に入れた日に静かに壊れるのを防ぐため。⚠ だから
 *   `tests/build/body-css.test.ts` は**合成した tokens** で閉包を直接検める
 *   (本物の tokens では素通りするので、それだけでは無検査になる)。
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

/**
 * 下限。2026-08-07 時点で 116 本 / 19 個。
 * ⚠ **実測値ぴったりにしない** ── 規則を 1 本消すだけで build が落ちると、まともな
 *   整理ができない。事故の桁(半分に減る / 空になる)を止める値にする。
 */
export const MIN_RULES = 80;
export const MIN_VARS = 12;
/** 上限。⚠ **tripwire は両側に置く**(CLAUDE.md)── 器の規則が混ざり始めたら鳴る。 */
export const MAX_RULES = 250;

/**
 * 🔴 **焼いた文字列そのものを検める**(2026-08-07、レビュー指摘で作った)。
 *
 * ⚠ 直す前の検査は `missing` / `ruleCount` / `vars` の 3 つで、**どれも
 *   「`:root{…}` が実際に出力に在るか」を見ていなかった** ── `extractBodyCss` の
 *   トークンを push する 3 行を落とすと、`missing = []` / `ruleCount = 116` /
 *   `vars = 19` のまま**全部緑で build が成功し、トークンが 1 個も焼かれない HTML が
 *   出荷される**。それは本 file が「何もしないより悪くなる」と呼んでいる状態そのもの。
 * ⚠ `vars` は**需要**(規則が要求した個数)であって供給ではない。だからここでは
 *   **出力の中の定義の数**を数える。
 *
 * @returns 見つかった問題(空なら合格)。build を止めるのは呼び手の仕事。
 */
export function auditBodyCss(out: BodyCss): string[] {
  const bad: string[] = [];
  const css = out.css;
  if (out.missing.length > 0) {
    bad.push(
      `本文の CSS が参照するトークンの定義が tokens.css に見つかりません: ${out.missing.join(', ')}` +
        ` ── :root(幾何)/ [data-pkc-theme='light'](配色)を確かめてください`,
    );
  }
  // 🔴 未定義の `var()` は宣言ごと無効になり、**先行する規則へ fall back しない**
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
  const undef = [
    ...new Set(
      [...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)] // 既定値つきは壊れないので数えない
        .map((m) => m[1]!)
        .filter((v) => !defined.has(v)),
    ),
  ].sort();
  if (undef.length > 0) {
    bad.push(`焼いた CSS が定義の無い var を参照しています(宣言ごと無効): ${undef.join(', ')}`);
  }
  if (defined.size < MIN_VARS) {
    bad.push(`焼いたトークンが ${defined.size} 個しかありません(下限 ${MIN_VARS})`);
  }
  // ⚠ 暗い環境の層は**包まれた形**で在ること(素で出すと light を常時上書きする)
  if (!css.includes('@media (prefers-color-scheme:dark){:root{')) {
    bad.push('暗い環境のトークンの層が(prefers-color-scheme で包まれた形で)ありません');
  }
  /**
   * 🔴 **規則も「焼いた文字列」から数え直す**(2026-08-07、レビュー 2 巡目)。
   *
   * ⚠ 直す前はここが `out.ruleCount`(= `kept.length`)を見ていた ── **需要側の数**である。
   *   `extractBodyCss` の規則を組み立てるループを消すと、`ruleCount = 116` /
   *   `missing = []` / トークン 19 個 / dark 層あり のまま **audit が合格し、
   *   本文の規則が 1 本も入っていない 671 バイトの CSS が出荷される**(実測)。
   *   これは 1 巡目でトークンについて直した欠陥の**鏡像**だった。
   * 🔑 `ruleCount` との**突合**も置く ── 抜いたのに焼かれなかった分を直接検出できる。
   */
  const emitted = parseRules(css).filter((r) => isBodyRule(r.selector)).length;
  if (emitted !== out.ruleCount) {
    bad.push(`抜いた ${out.ruleCount} 本のうち ${emitted} 本しか焼かれていません`);
  }
  if (emitted < MIN_RULES) {
    bad.push(
      `焼いた CSS に本文の規則が ${emitted} 本しかありません(下限 ${MIN_RULES})` +
        ` ── app.css の本文の規則が .pkc-md-rendered 起点でなくなった可能性があります`,
    );
  }
  if (emitted > MAX_RULES) {
    bad.push(`焼いた CSS の本文の規則が ${emitted} 本あります(上限 ${MAX_RULES}。器が混ざった?)`);
  }
  // ⚠ 印刷の層も落ちうる ── 落ちると紙で改頁が起きず、見出しが行末で独りになる
  if (!css.includes('@media print{')) {
    bad.push('印刷の層(@media print)が焼かれていません');
  }
  /**
   * ⚠ **`<style>` を早期終了させる字面を通さない**。この CSS は書き出し HTML の
   * `<style>` へ**素で**埋まる ── `pkc3-html.ts` は本文の `<` を全部退避する規律を
   * 掲げているのに、ここだけ外から来た 12KB が素通りしていた。`content: '</style>'`
   * と書かれた日に、CSS の残りが**本文として画面に出る**。
   */
  if (/<\//.test(css)) bad.push('焼いた CSS に `</` が含まれています(style が早期終了する)');
  return bad;
}

/** 空白を詰める(見た目の整形は要らない ── 配る HTML に埋め込む文字列である)。 */
function minify(css: string): string {
  /**
   * 🔴 **引用符の中は詰めない**(2026-08-07、レビュー 2 巡目)。
   * `content: '注: '` は詰めると**別の文字列**になり、`[title="a, b"]` は詰めると
   * **一致しなくなる**(どちらも実測)。今日の `app.css` は `content: ''` が
   * 3 本だけなので実害は無いが、`content: '※ '` を書くのは `:is()` を素の子孫で
   * 書くのと同じくらい自然な次の一手である ── 同じ論法で守る。
   * ⚠ 目印は**私用領域の文字**にする(`\uE000`)── 制御文字は eslint の
   *   `no-control-regex` に当たり、そもそも CLAUDE.md が生バイトを禁じている。
   *   CSS の字面には決して現れない符号位置なので、衝突しない。
   */
  const literals: string[] = [];
  const masked = css.replace(/'[^'\n]*'|"[^"\n]*"/g, (m) => {
    literals.push(m);
    return `\uE000${literals.length - 1}\uE000`;
  });
  const packed = (
    masked
      // ⚠ **先に改行ごと 1 個の空白へ潰す**。改行を残すと、prettier が折り返した
      //   セレクタ(`.pkc-md-rendered\n  li.pkc-task-item…`)の中に改行が残る ──
      //   CSS としては空白なので動くが、読めない字面が配る HTML に載る
      .replace(/\s+/g, ' ')
      // ⚠ 空白を消してよいのは**区切り記号の周り**だけ。値の中の空白
      //   (`margin:var(--s5) 0 var(--s2)` / `calc(1.45em * …)`)は意味を持つ
      .replace(/\s*([{};,>])\s*/g, '$1')
      // 🔴 **`:` は「後ろの空白」だけ詰める**。前の空白まで消すと、子孫結合子が
      //   消えて**複合セレクタという別物**になる ── `.pkc-md-rendered :is(p,ul)`
      //   (器の中の p/ul)が `.pkc-md-rendered:is(p,ul)`(器自身)へ化ける。
      //   ⚠ 今日の 116 本に「空白 + 擬似」の形は無い(`> :first-child` は `>` が
      //     先に詰まるので無害)が、`:is()` を素の子孫で書くのは自然な次の一手であり、
      //     そのとき**規則が静かに別物になる**。`margin: var(--s5)` /
      //     `(prefers-color-scheme: dark)` はここで従来どおり詰まる
      .replace(/:\s+/g, ':')
      .replace(/;}/g, '}')
      .trim()
  );
  // 退避した字面を戻す。⚠ 目印は制御文字なので、CSS の字面と衝突しない
  return packed.replace(/\uE000(\d+)\uE000/g, (_, n: string) => literals[Number(n)]!);
}
