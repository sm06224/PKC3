/**
 * 🔴 **その場で計算**(#764。user 裁定 2026-09-06「PKC2 と同じで」)。
 *
 * 本文に `2+3=` と打って `Enter` を押すと、その場が `2+3=5` になって改行する。
 * ⚠ **式も答えも本文に残る** ── 表の升の式(`csv-formula.ts`)は「式のまま残って
 * 描くたびに計算」なので、**向きが逆**である(混同しない)。
 *
 * ## PKC2 から変えた所 ── 🔴 **切れ端を式にしない**
 *
 * PKC2(`src/features/math/inline-calc.ts`)は `=` から後ろへ走査し、
 * **計算に使えない字が出たら止めて、そこまでを式にしていた**。⚠ その結果:
 *
 * | 打った字 | PKC2 が本文へ書き込む字 | なぜ |
 * |---|---|---|
 * | `1,000=` | 🔴 `1,000=0` | `,` で止まり、式が `000` |
 * | `foo+1=` | 🔴 `foo+1=1` | `o` で止まり、式が `+1`(単項プラス) |
 * | `{{vars.a}}+1=` | 🔴 `…+1=1` | `}` で止まり、同上 |
 *
 * ⚠ どれも **user が打っていない字が本文に書き込まれる**向きの欠陥である。
 * 🔑 PKC2 の test は**評価器しか見ておらず、検出器を通した経路を 1 度も
 *   通していなかった**(CLAUDE.md §2)── だから 3 件とも見逃されていた。
 *
 * ### 🔑 足した門は 2 つ(下の `startsMidToken`)
 *
 * 1. **式の直前が数字 / `,` / `.`** なら発火しない ── 数を途中で切っている
 * 2. **式が演算子で始まり、直前が空白でない**なら発火しない ── 語にくっついた切れ端
 *
 * ⚠ **日本語の直後は許す**(`結果は3*4=` は `12` が出る)── 空白を置かない
 *   書き方は日本語の user の普通である。門②が「切れ端」だけを落とす。
 */

/**
 * 計算に使える字(この whitelist の外が 1 つでも入ったら式ではない)。
 *
 * 🔴 **桁区切りの `,` を入れた**(2026-09-08、#766 B-2)。
 * ⚠ 日本語で数を書く人の 1 行は `1,200 円` である ── 入れる前は `1,200+800=` が
 *   `,` で走査を止め、**何も起きなかった**(3 回試して 3 回とも無音だと、
 *   user は「この機能は効かない」と思ってやめる)。
 * 🔑 ただし**受けるのは桁区切りだけ** ── `,` を素通しにすると `1,2+3=` が
 *   `12+3` になって**打った覚えのない答え**が出る。落とすのは
 *   「数の直後で、3 桁の数が続き、その先が数でない」`,` に限る(下の `stripGrouping`)。
 * ⚠ 落とし切れなかった `,` が 1 つでも残った式は、**読み手がそこで止まる**ので
 *   `null` になる(弾く行は書いていない ── 書いたら変異試験で no-op と分かった)。
 */
const CALC_CHARS = /^[0-9+\-*/%().,\s]+$/;

/**
 * 桁区切りの `,` だけを落とす。⚠ **繰り返す** ── 1 回だと `1,234,567` の
 * 2 つ目が「直前の数」を先の一致に食われて残る(実測)。
 */
function stripGrouping(src: string): string {
  let out = src;
  for (;;) {
    const next = out.replace(/(\d),(\d{3})(?!\d)/gu, '$1$2');
    if (next === out) return out;
    out = next;
  }
}

/**
 * 🔴 **全角で打った字を半角に読み替える**(user 報告 2026-09-07
 * 「全文編集やインライン編集で数式評価が発火していない気がする」)。
 *
 * ⚠ **日本語入力のまま打つと全角になる** ── 実測(実ブラウザ):
 *   `２＋３＝` + `Enter` は**何も起きなかった**。日本語で書く人にとっては
 *   これが**既定の打ち方**なので、「効かない機能」に見える。
 * 🔑 読み替えるのは**読むときだけ** ── 打った式は全角のまま残し、
 *   答えだけ半角で挿す(`２＋３＝5`)。⚠ user が打った字を書き換えない。
 * ⚠ `，`(全角のカンマ)は**半角の `,` と同じく計算に使えない字**へ写る
 *   ── だから `１，０００＝` も半角と同じように止まる(桁区切りの門)。
 * ⚠ 全角の空白(`\u3000`)は写さなくてよい ── 正規表現の `\s` が既に含む。
 */
const FULLWIDTH_TO_HALF: Readonly<Record<string, string>> = {
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
  '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  '＋': '+', '－': '-', '\u2212': '-', '＊': '*', '／': '/', '％': '%',
  '（': '(', '）': ')', '．': '.', '，': ',', '＝': '=',
};

/** 1 字を半角に読み替える(表に無ければそのまま)。 */
function toHalf(ch: string): string {
  return FULLWIDTH_TO_HALF[ch] ?? ch;
}

/**
 * 字の並びを半角に読み替える。
 * ⚠ 表は**すべて 1 字 → 1 字**なので、**位置が動かない**
 *   (添字で切っている呼び側が壊れない)。
 */
function toHalfWidth(s: string): string {
  return [...s].map(toHalf).join('');
}

/** 走査に使う 1 字の判定(上の whitelist と**同じ集合**を 1 か所で持つ)。 */
function isCalcChar(ch: string): boolean {
  return CALC_CHARS.test(toHalf(ch));
}

/**
 * 式を評価する。読めなければ `null`。
 *
 * ⚠ **`eval` も `Function` も使わない**(本文は user の打った字である)。
 * 文法は PKC2 と同じ:
 *
 * ```
 * expression := term (('+' | '-') term)*
 * term       := factor (('*' | '/' | '%') factor)*
 * factor     := ('+' | '-') factor | '(' expression ')' | number
 * number     := digit+ ('.' digit+)?
 * ```
 *
 * ⚠ **`%` は剰余**(モジュロ)であってパーセントではない ── PKC2 と同じ。
 */
export function evaluateCalcExpression(src: string): number | null {
  if (typeof src !== 'string' || src.trim() === '') return null;
  if (!CALC_CHARS.test(src)) return null;
  /**
   * 🔴 桁区切りを落としてから読む(#766 B-2)。
   *
   * ⚠ **落とし切れなかった `,` を弾く行は書かない** ── 書いたが、変異試験 C9 が
   *   **SURVIVED**(= no-op)で教えた:残った `,` は必ず読み手を途中で止めるので、
   *   下の `done()` が false になって**どのみち `null` になる**。
   *   🔑 CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れることを見る」。
   * 🔑 `1,2+3` を `12+3` と読まないことを担保しているのは、
   *   **`stripGrouping` が厳しいこと**である(3 桁ちょうどのときだけ落とす)。
   */
  const p = new Parser(stripGrouping(src));
  const v = p.parseExpression();
  if (v === null) return null;
  // ⚠ 全部読み切っていなければ式ではない(`1+2)` を通さない)
  // ⚠ ここで `skipWs()` を呼ばない ── `parseExpression` / `parseTerm` の
  //    ループが返る前に必ず飛ばしているので、外側の 1 回は届かない(no-op)
  if (!p.done()) return null;
  return Number.isFinite(v) ? v : null;
}

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  done(): boolean {
    return this.i >= this.s.length;
  }

  skipWs(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i += 1;
  }

  parseExpression(): number | null {
    let lhs = this.parseTerm();
    if (lhs === null) return null;
    for (;;) {
      this.skipWs();
      const op = this.s[this.i];
      if (op !== '+' && op !== '-') return lhs;
      this.i += 1;
      const rhs = this.parseTerm();
      if (rhs === null) return null;
      lhs = op === '+' ? lhs + rhs : lhs - rhs;
    }
  }

  private parseTerm(): number | null {
    let lhs = this.parseFactor();
    if (lhs === null) return null;
    for (;;) {
      this.skipWs();
      const op = this.s[this.i];
      if (op !== '*' && op !== '/' && op !== '%') return lhs;
      this.i += 1;
      const rhs = this.parseFactor();
      if (rhs === null) return null;
      // 🔴 **0 で割らない / 0 で余りを取らない** ── 黙って何も起こさない
      if ((op === '/' || op === '%') && rhs === 0) return null;
      lhs = op === '*' ? lhs * rhs : op === '/' ? lhs / rhs : lhs % rhs;
    }
  }

  private parseFactor(): number | null {
    this.skipWs();
    const ch = this.s[this.i];
    if (ch === '+' || ch === '-') {
      this.i += 1;
      const v = this.parseFactor();
      if (v === null) return null;
      return ch === '-' ? -v : v;
    }
    if (ch === '(') {
      this.i += 1;
      const v = this.parseExpression();
      if (v === null) return null;
      this.skipWs();
      if (this.s[this.i] !== ')') return null;
      this.i += 1;
      return v;
    }
    return this.parseNumber();
  }

  private parseNumber(): number | null {
    const start = this.i;
    while (this.i < this.s.length && this.s[this.i]! >= '0' && this.s[this.i]! <= '9') this.i += 1;
    if (this.i === start) return null;
    if (this.s[this.i] === '.') {
      this.i += 1;
      const fracStart = this.i;
      while (this.i < this.s.length && this.s[this.i]! >= '0' && this.s[this.i]! <= '9') this.i += 1;
      // ⚠ `12.` は数ではない(小数点の後に数字が要る)
      if (this.i === fracStart) return null;
    }
    return Number(this.s.slice(start, this.i));
  }
}

/**
 * 見つかった計算の依頼。
 *
 * ⚠ **挿す位置を持たない** ── 答えはカーソルの所へ挿す(`=` の直後 = カーソル)。
 *   位置を返すと、`execCommand` の道と fallback の道で挿し先が食い違う余地ができる
 *   (2026-09-07、着地前レビューが「誰も読んでいない field」として指摘)。
 */
export interface InlineCalcRequest {
  /** 式(前後の空白は落としてある。**半角に直してある**)。 */
  expression: string;
  /**
   * 🔴 **全角で打っていたときに、半角へ直す範囲と字**(#773。user 裁定 2026-09-07
   * 「**全角入力時は計算式を含めて半角化して欲しい**」)。半角で打っていれば `null`。
   *
   * ⚠ 直すのは**式と `＝` だけ** ── 式の前に書いた文(`合計` の後ろの全角の空白)や全角の空白は
   *   user の字なので触らない。
   * ⚠ 全角と半角は**1 字 → 1 字**なので、差し替えても後ろの位置が動かない。
   */
  halfWidth: { from: number; to: number; text: string } | null;
}

/**
 * 🔴 **「言葉が混ざっている」の判定**(2026-09-08、#766 A-2)。
 * ⚠ ここに当たる行では**理由を出さない** ── `締切=` / `md5=` / `A1+B1=` は
 *   user が計算を頼んだ行ではないので、口を出すとただの雑音になる。
 * ⚠ 全角の英字(`ｍｄ５`)は `toHalfWidth` で半角にならない(表は数と記号だけ)ので、
 *   ここで**全角の英字も直に**見る。
 */
const WORD_CHARS = /[A-Za-z\uFF21-\uFF3A\uFF41-\uFF5A\u3040-\u30FF\u4E00-\u9FFF\uFF66-\uFF9D]/u;

/** 行頭の箇条書きの印(`- ` / `* ` / `+ ` / `1. `)。⚠ 式から外す。 */
const LIST_MARKER = /^([\t ]*)([-*+]|\d+\.)\s+/;

/**
 * 🔴 **切れ端を式にしないための門**(PKC2 に無かったもの)。
 *
 * @param before 式の直前の 1 字(行頭なら `undefined`)
 * @param expr   前後の空白を落とした式
 */
function startsMidToken(before: string | undefined, expr: string): boolean {
  if (before === undefined || before === '\n') return false;
  /**
   * ① **語や数を途中で切っている**(`1,000=` の `000` / `md5=` の `5` /
   *   `1e3+1=` の `3+1`)。
   *
   * 🔴 **1 稿目は `[0-9,.]` しか見ておらず、`md5=` → `md5=5` /
   *   `A1+B1=` → `A1+B1=1` / `v1.2=` → `v1.2=1.2` を通していた**
   *   (2026-09-07、着地前の動線レビューが実測して指摘)── ⚠ これは
   *   この file が「PKC2 から直した」と書いている `1,000=0` と**同じ型**である
   *   (数だけ見て、語を見ていなかった)。
   * ⚠ **日本語は含めない** ── `結果は3*4=` は通す(空白を置かない書き方が普通)。
   *   だから ASCII の語の字(`[A-Za-z0-9_]`)と `,` `.` だけを見る。
   */
  /**
   * ⚠ **数字と `.` は、いまの走査では `before` に現れない**(2026-09-07、
   *   着地前レビューが総当たりで実測 ── 現れうるのは
   *   `\t \n # $ , = > _ a { | } あ` の類だけ)。`CALC_CHARS` に入っている字は
   *   走査が**そこで止まらない**からである。効いているのは `,` と ASCII の語の字。
   * 🔑 それでも落とさないのは、`CALC_CHARS` を狭めた日にここが受け皿になるため
   *   ── ⚠ 「これが無いと壊れる」ではなく「**いまは効いていない**」と書いておく。
   */
  if (/[0-9A-Za-z_,.]/.test(before)) return true;
  // ② 語にくっついた切れ端(`foo+1=` の `+1` / `${…}+1=`)
  //    ⚠ 直前が空白なら切れ端ではない(`結果は 3*4=` は通す)
  if (/^[+\-*/%]/.test(expr) && !/\s/.test(before)) return true;
  return false;
}

/**
 * 🔴 **数を 1 つ書いただけのものは式ではない**(2026-09-07、同じレビュー)。
 *
 * ⚠ `2^3=` は `^` で走査が止まるので式が `3` になり、`2^3=3` と**8 でない答え**が
 *   本文へ入っていた(`第2=` → `第2=2` も同じ)。門①(ASCII の語)だけでは
 *   `^` や日本語の直後を止められない。
 * 🔑 判定は「**計算する所が 1 つも無い**」── 演算子も括弧も無い式は、
 *   答えが打った字と同じになるので、そもそも計算する意味が無い。
 * ⚠ 失う動線は `1200=` → `1200=1200` だけである。
 */
function hasNoOperation(expr: string): boolean {
  /**
   * ⚠ **括弧は「計算する所」に数えない**(2026-09-07、全角を受けるときに気づいた)
   *   ── 日本語の箇条書きの印 `（１）` は全角の丸括弧なので、数えると
   *   `（１）＝` が `（１）＝1` になる。括弧しか無い式は答えが中身と同じである。
   */
  return !/[+\-*/%]/.test(expr);
}

/**
 * カーソルの位置から、計算の依頼を読む。読めなければ `null`。
 *
 * ⚠ **発火の条件はただ 1 つ:カーソルの直前が `=`** ── それ以外は
 *   `Enter` をそのまま通す(打ち間違いで本文が壊れない、が PKC2 からの設計)。
 */
export function detectInlineCalcRequest(
  fullText: string,
  caretPos: number,
): InlineCalcRequest | null {
  if (typeof fullText !== 'string') return null;
  if (caretPos < 0 || caretPos > fullText.length) return null;
  // ⚠ 全角の `＝` も合図にする(日本語入力のまま打つとこちらになる)
  if (toHalf(fullText[caretPos - 1] ?? '') !== '=') return null;
  /**
   * 🔴 **行の終わりでなければ撃たない**(2026-09-07、同じレビュー)。
   *
   * ⚠ 既にある `1200*1.1=1320` の `=` の直後で行を割ろうと `Enter` を押すと、
   *   答えが**もう 1 つ**挿さって `1200*1.1=1320` の下に `1320` が残っていた
   *   ── 増えた字が元と同じなので、**見ても間違いに見えない**。
   * 🔑 打っている最中は必ず行末なので、この門で失う動線は無い。
   */
  const after = fullText[caretPos];
  if (after !== undefined && after !== '\n') return null;

  // `=` から後ろへ、計算に使える字の間だけ戻る
  let start = caretPos - 1;
  while (start > 0) {
    const ch = fullText[start - 1]!;
    if (ch === '\n' || !isCalcChar(ch)) break;
    start -= 1;
  }

  // 行頭なら、箇条書きの印を式から外す(`- 1+2=` の `- `)
  const atLineStart = start === 0 || fullText[start - 1] === '\n';
  if (atLineStart) {
    const m = LIST_MARKER.exec(toHalfWidth(fullText.slice(start, caretPos - 1)));
    if (m !== null) start += m[0].length;
  }

  const raw = toHalfWidth(fullText.slice(start, caretPos - 1));
  const expression = raw.trim();
  if (expression === '') return null;

  // 🔴 切れ端を式にしない(この門が PKC2 の 3 件を落とす)
  const lead = raw.length - raw.trimStart().length;
  const beforeRaw = start + lead > 0 ? fullText[start + lead - 1] : undefined;
  const before = beforeRaw === undefined ? undefined : toHalf(beforeRaw);
  if (startsMidToken(before, expression)) return null;
  if (hasNoOperation(expression)) return null;

  /**
   * 🔴 **打った字が全角なら、式と `＝` を半角へ直す**(#773 の裁定)。
   *
   * ⚠ 始まりは `start + lead`(**式の 1 字目**)── ここより前の全角の空白や
   *   日本語は user の字なので、範囲に入れない。
   * ⚠ 終わりは `caretPos`(`＝` を**含む**)── 「計算式を含めて半角化」なので
   *   合図の `＝` も直す。
   */
  const from = start + lead;
  const typed = fullText.slice(from, caretPos);
  const half = toHalfWidth(typed);
  return {
    expression,
    halfWidth: half === typed ? null : { from, to: caretPos, text: half },
  };
}

/**
 * 🔴 **計算にならなかったとき、理由を 1 行で返す**(2026-09-08、#766 A-2)。
 *
 * ## なぜ要るか
 *
 * ⚠ お知らせを読んだ人が最初に試すのは、例文の `2+3=` ではなく**自分の数字**である。
 *   `1,2+3=` / `2^3=` / `50%=` ── どれも**何も起きない**ので、3 回試して 3 回とも
 *   無音だと「この機能は効かない」と思ってやめる。
 * 🔴 しかも**発火したときしか痕跡が無い**ので、user に**確かめる材料が 1 つも無い**。
 *
 * ## 出す条件を絞る(普通の文では 1 度も出さない)
 *
 * 🔑 出すのは「**数と記号だけの行**」に限る ── `締切=` や `md5=` のように
 *   言葉が混ざる行では**黙る**(user 裁定 A-2 の条件そのもの)。
 * ⚠ 「数が 1 つも無い」行も黙る ── `(=` のような打ち間違いに口を出さない。
 * ⚠ **計算できた回は必ず `null`**(成功に注釈を付けない)。
 *
 * @returns 出す 1 行。出さないなら `null`
 */
export function explainCalcMiss(fullText: string, caretPos: number): string | null {
  if (typeof fullText !== 'string') return null;
  if (caretPos < 0 || caretPos > fullText.length) return null;
  // 合図(`=` / `＝`)が直前に無ければ、そもそも計算を頼んでいない
  if (toHalf(fullText[caretPos - 1] ?? '') !== '=') return null;
  // 行の終わりでなければ発火しない(製品と同じ門 ── ここだけ緩めない)
  const after = fullText[caretPos];
  if (after !== undefined && after !== '\n') return null;
  // 🔴 計算できたなら黙る(成功に口を出さない)
  const req = detectInlineCalcRequest(fullText, caretPos);
  if (req !== null && evaluateCalcExpression(req.expression) !== null) return null;

  const nl = fullText.lastIndexOf('\n', caretPos - 1);
  const head = toHalfWidth(fullText.slice(nl + 1, caretPos - 1));
  const body = head.replace(LIST_MARKER, '').trim();
  if (body === '') return null;
  // ⚠ **数が 1 つも無い行**は普通の文(`(=` のような打ち間違いに口を出さない)
  if (!/\d/u.test(body)) return null;
  // ⚠ **言葉が混ざる行**は普通の文(`締切=` / `md5=` / `A1+B1=`)
  if (WORD_CHARS.test(body)) return null;

  // ① 計算に使えない字が入っている(`2^3=` の `^` / `50=` の後ろの記号)
  const bad = [...body].find((ch) => !CALC_CHARS.test(ch));
  if (bad !== undefined) return `計算できませんでした(${bad} は計算に使えません)`;
  // ② 桁区切りに見えない `,`(`1,2+3=`)
  if (stripGrouping(body).includes(','))
    return '計算できませんでした(桁区切りの , は 3 桁ごとのときだけ数として読みます)';
  // ③ `%` は余り(百分率ではない)── 末尾の `%` は必ずここに来る
  if (/%\s*$/u.test(body)) return '計算できませんでした(% は「余り」です。百分率ではありません)';
  // ④ 計算する所が無い(`1200=` / `(1)=`)
  if (hasNoOperation(body)) return '計算できませんでした(足し算や掛け算がありません)';
  // ⑤ 0 で割った(`1/0=` / `1%0=`)
  if (/[/%]\s*0(?!\.\d*[1-9])/u.test(body)) return '計算できませんでした(0 で割れません)';
  return '計算できませんでした(式として読めませんでした)';
}

/**
 * 🔴 **「操作を探す」から計算する**(2026-09-08、#766 D-2)。
 *
 * ## なぜ要るか
 *
 * ⚠ 入口が**本文に打つことだけ**だった ── `Ctrl`+`K` で「計算」と打っても **0 行**、
 *   書式パネルにも無い。マニュアル自身が「名前を忘れても**操作を探す**で引けます」と
 *   書いているのに、この機能だけそこに居なかった。
 * 🔑 画面に物は 1 つも増えない(探したときだけ出る)。
 *
 * ## 何をするか
 *
 * **いまカーソルの在る行**を読み、`=` が無ければ**足してから**計算する。
 * ⚠ 打っている最中と**同じ規則**を通す(`detectInlineCalcRequest`)── 別の判定を
 *   作ると、`Enter` で計算できる式とパレットで計算できる式が食い違う(§7)。
 *
 * @returns 挿す字と場所 / 出す理由 / `null`(その行では何も言わない)
 */
export type CalcLineAction =
  | { readonly kind: 'insert'; readonly at: number; readonly text: string }
  | { readonly kind: 'why'; readonly text: string };

export function calcLineAction(fullText: string, caretPos: number): CalcLineAction | null {
  if (typeof fullText !== 'string') return null;
  if (caretPos < 0 || caretPos > fullText.length) return null;
  const start = fullText.lastIndexOf('\n', Math.max(0, caretPos - 1)) + 1;
  const nl = fullText.indexOf('\n', caretPos);
  const end = nl === -1 ? fullText.length : nl;
  const line = fullText.slice(start, end);
  if (line.trim() === '') return null;

  /**
   * 🔴 **`=` が無ければ、足した形で読む。**
   * ⚠ 本文をその場で書き換えて読むのではなく、**読むときだけ**足す ──
   *   書き換えてから読むと、計算にならなかった回に `=` だけが残る。
   */
  const hasEq = toHalf(line.at(-1) ?? '') === '=';
  const probe = hasEq ? fullText : `${fullText.slice(0, end)}=${fullText.slice(end)}`;
  const at = hasEq ? end : end + 1;
  const req = detectInlineCalcRequest(probe, at);
  const v = req === null ? null : evaluateCalcExpression(req.expression);
  if (v !== null) {
    // ⚠ `=` を足す回は、答えの前に `=` も入れる(1 回の挿入にまとめる)
    return { kind: 'insert', at: end, text: `${hasEq ? '' : '='}${formatCalcResult(v)}` };
  }
  const why = explainCalcMiss(probe, at);
  return why === null ? null : { kind: 'why', text: why };
}

/**
 * 答えを字にする。
 * ⚠ **浮動小数のゴミを落とす**(`0.1+0.2` を `0.30000000000000004` と出さない)。
 */
export function formatCalcResult(value: number): string {
  if (!Number.isFinite(value)) return '';
  // ⚠ `0` を別扱いしない ── `Number.isInteger(-0)` は true、`String(-0)` は `'0'`
  //    なので、次の行が同じ答えを返す(no-op だった)
  if (Number.isInteger(value)) return String(value);
  return Number(value.toPrecision(12)).toString();
}
