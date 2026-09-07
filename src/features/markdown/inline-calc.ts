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

/** 計算に使える字(この whitelist の外が 1 つでも入ったら式ではない)。 */
const CALC_CHARS = /^[0-9+\-*/%().\s]+$/;

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
  const p = new Parser(src);
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
