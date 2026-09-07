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

/** 走査に使う 1 字の判定(上の whitelist と**同じ集合**を 1 か所で持つ)。 */
function isCalcChar(ch: string): boolean {
  return CALC_CHARS.test(ch);
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
  p.skipWs();
  // ⚠ 全部読み切っていなければ式ではない(`1+2)` を通さない)
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

/** 見つかった計算の依頼。 */
export interface InlineCalcRequest {
  /** 式(前後の空白は落としてある)。 */
  expression: string;
  /** `=` の位置(この後ろに答えを挿す)。 */
  equalsPos: number;
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
  // ① 数を途中で切っている(`1,000=` の `000` / `1.5.2` のような形)
  if (/[0-9,.]/.test(before)) return true;
  // ② 語にくっついた切れ端(`foo+1=` の `+1` / `${…}+1=`)
  //    ⚠ 直前が空白なら切れ端ではない(`結果は 3*4=` は通す)
  if (/^[+\-*/%]/.test(expr) && !/\s/.test(before)) return true;
  return false;
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
  if (fullText[caretPos - 1] !== '=') return null;

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
    const m = LIST_MARKER.exec(fullText.slice(start, caretPos - 1));
    if (m !== null) start += m[0].length;
  }

  const raw = fullText.slice(start, caretPos - 1);
  const expression = raw.trim();
  if (expression === '') return null;

  // 🔴 切れ端を式にしない(この門が PKC2 の 3 件を落とす)
  const lead = raw.length - raw.trimStart().length;
  const before = start + lead > 0 ? fullText[start + lead - 1] : undefined;
  if (startsMidToken(before, expression)) return null;

  return { expression, equalsPos: caretPos - 1 };
}

/**
 * 答えを字にする。
 * ⚠ **浮動小数のゴミを落とす**(`0.1+0.2` を `0.30000000000000004` と出さない)。
 */
export function formatCalcResult(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  if (Number.isInteger(value)) return String(value);
  return Number(value.toPrecision(12)).toString();
}
