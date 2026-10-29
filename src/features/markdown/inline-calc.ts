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

import { formatNumber } from './csv-formula';
import { lineStart } from './line-start';

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

/**
 * 🔴 **日本語入力でそのまま出る記号は「読むときだけ」演算子にする**(台帳 #1852 I2 / 依頼 78-3・308。推薦 A / B)。
 *
 * > `300×3=` と打つと答えだけが足される(`300×3=900`)。**打った `×` は `*` に書き換えない**。
 *
 * - `×` → `*`、`÷` → `/`。⚠ 直す表(`FULLWIDTH_TO_HALF`)には**入れない** ── 入れると、全角を半角へ直す
 *   (#773)で打った `×` が `*` に書き換わる。読み替えだけの表を別に持つ。
 * - 長音の `ー`(U+30FC)は**数の間**にあるときだけ `-`(`5ー3` は 5−3)。⚠ 語の中の `ー`(`コーヒー`)や
 *   数のないところの `ー` は、これまでどおり言葉である ── 位置で決めるので {@link isCalcCharAt} が文脈を見る。
 * 🔑 どれも 1 字 → 1 字なので、位置は動かない。
 */
const READ_ONLY_OPS: Readonly<Record<string, string>> = { '×': '*', '÷': '/' };
const LONG_VOWEL = 'ー';

/**
 * 🔴 **数に付いた単位**(台帳 #1852 I2 / 依頼 308 B。`100円*3=` を計算する)。表の升の式の単位の一覧
 * (`calc/sheet.ts` の `UNIT_HINT`)と同じ範囲。⚠ 数の**直後**(`3個`)にあり、その次が演算子・空白・閉じ括弧・`=` のときだけ単位と読む。
 * 次が数字だと、2 つの数をくっつけてしまう(`10月3日+2=` の `月`)ので読まない。
 */
const UNIT_TAIL = /(?:円|ドル|ユーロ|時間|分|秒|日|週|月|年|個|人|件|枚|本|台|回|冊|km|kg|cm|mm|ml|g|m|l)$/iu;
const UNIT_NEXT = /^[\s+\-*/%×÷)）=＝ー]/u;
const CURRENCY_PREFIX = /^[$¥￥€£]$/u;

/**
 * `text[0..end)` の終わりが、数に付いた単位ならその長さ(単位でなければ 0)。
 * ⚠ 単位の**手前**は数字か閉じ括弧、**次**は {@link UNIT_NEXT}(= `end` の字)。
 */
function unitEndingAt(text: string, end: number): number {
  const m = UNIT_TAIL.exec(text.slice(Math.max(0, end - 2), end));
  if (m === null) return 0;
  const len = m[0].length;
  const prev = text[end - len - 1];
  if (prev === undefined || !(isDigitCh(prev) || prev === ')' || prev === '）')) return 0;
  const next = text[end];
  if (next === undefined || !UNIT_NEXT.test(toRead(next))) return 0;
  return len;
}

/** 数字(半角・全角)か。 */
function isDigitCh(ch: string | undefined): boolean {
  return ch !== undefined && /[0-9０-９]/u.test(ch);
}

/**
 * `text[i]` の長音が、数と数の間の引き算か(空白は読み飛ばす。前は数か閉じ括弧、後ろは数か開き括弧)。
 * ⚠ 前後が数でなければ言葉のまま(`コーヒー 5ー` の `ー` は引き算にしない)。
 */
function longVowelIsMinus(text: string, i: number): boolean {
  let p = i - 1;
  while (p >= 0 && /[\s\u3000]/u.test(text[p]!)) p -= 1;
  let n = i + 1;
  while (n < text.length && /[\s\u3000]/u.test(text[n]!)) n += 1;
  const prev = p >= 0 ? text[p] : undefined;
  const next = n < text.length ? text[n] : undefined;
  const prevOk = isDigitCh(prev) || prev === ')' || prev === '）';
  const nextOk = isDigitCh(next) || next === '(' || next === '（';
  return prevOk && nextOk;
}

/** 1 字を半角に読み替える(表に無ければそのまま)。⚠ 直す(書き換える)ほうの表で、`×` `÷` は含まない。 */
function toHalf(ch: string): string {
  return FULLWIDTH_TO_HALF[ch] ?? ch;
}

/** 読むときの読み替え(直す表 + `×` `÷`)。長音は文脈が要るのでここでは扱わない。 */
function toRead(ch: string): string {
  return READ_ONLY_OPS[ch] ?? FULLWIDTH_TO_HALF[ch] ?? ch;
}

/**
 * 字の並びを半角に読み替える。
 * ⚠ 表は**すべて 1 字 → 1 字**なので、**位置が動かない**
 *   (添字で切っている呼び側が壊れない)。
 * 🔴 **読むための読み替え**(`×` `÷` と、数の間の長音 `ー` を含む)。打った字を**書き換える**ときは
 *   {@link toHalfRewrite} を使う ── こちらで直すと `×` が `*` に化ける。
 */
function toHalfWidth(s: string): string {
  const chars = [...s];
  // 長音の文脈は元の字の並びで見る(読み替えた後ではなく)
  return chars
    .map((ch, i) => {
      if (ch === LONG_VOWEL) return longVowelIsMinus(s, indexOfChar(chars, i)) ? '-' : ch;
      return toRead(ch);
    })
    .join('');
}

/** `chars`(コードポイントの配列)の i 番目が、元の文字列の何番目(UTF-16)か。 */
function indexOfChar(chars: readonly string[], i: number): number {
  let n = 0;
  for (let k = 0; k < i; k += 1) n += chars[k]!.length;
  return n;
}

/**
 * 字の並びを**書き換えるための**半角化(#773)。⚠ `×` `÷` `ー` は触らない ── user が打った字のまま残し、
 * 答えだけを足す(台帳 #1852 I2 / 依頼 78-3 の推薦 B)。
 */
function toHalfRewrite(s: string): string {
  return [...s].map(toHalf).join('');
}

/** 走査に使う 1 字の判定(上の whitelist と**同じ集合**を 1 か所で持つ)。⚠ 長音は文脈が要る({@link isCalcCharAt})。 */
function isCalcChar(ch: string): boolean {
  return CALC_CHARS.test(toRead(ch));
}

/** `text[i]` が計算に使える字か(長音だけ前後の字を見る)。 */
function isCalcCharAt(text: string, i: number): boolean {
  const ch = text[i]!;
  if (ch === LONG_VOWEL) return longVowelIsMinus(text, i);
  return isCalcChar(ch);
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

const DATE_YMD = /(?<!\d)\d{4}\s*[/-]\s*(?:0?[1-9]|1[0-2])\s*[/-]\s*(?:0?[1-9]|[12]\d|3[01])(?!\d)/u;
const DATE_MDY = /(?<!\d)(?:0?[1-9]|[12]\d|3[01])\s*[/-]\s*(?:0?[1-9]|[12]\d|3[01])\s*[/-]\s*\d{4}(?!\d)/u;

/**
 * 🔴 **日付と時刻は計算しない**(#1087)。`2026-10-17=` が `1999`、`2026-10-17-2026-10-01=` が `-38`、
 *   `12:30+45=` が `75`(`30+45` だけ読んでいた)になっていた ── 打った覚えのない答えである。
 *
 * ## どこで線を引いたか
 * - **日付** = 式の中に、年 4 桁・月 1〜12・日 1〜31 の「年 ○ 月 ○ 日」(`2026-10-17` / `2026/10/17`)、
 *   または年が最後の「月 日 年」(`10/17/2026`。1〜31 の 2 数 + 4 桁)が在るとき。区切りは `-` か `/`(どちらを混ぜてもよい)。
 * - **時刻** = 式の直前の字が `:` / `：`(`12:30+45=` は `30+45` を読んでいたので、その手前を見る)。
 * - ⚠ 日付ではない引き算・割り算は今までどおり計算する:`10-3=` / `8/2=` / `1-2-3=`(年が 4 桁でない)/
 *   `2026-13-45=`(月が範囲外)/ `2026-10=`(区切りが 1 つ)。
 *
 * @param before 式の直前の 1 字(行頭なら `undefined`)
 * @param expr   前後の空白を落とした式(半角)
 */
export function isDateOrTime(before: string | undefined, expr: string): boolean {
  if (before === ':' || before === '：') return true;
  return DATE_YMD.test(expr) || DATE_MDY.test(expr);
}

/**
 * 🔴 **電話番号と URL の形は計算しない**(#1163 依頼 151。Gemini 回答は案どおり)。
 * `TEL 03-1234-5678=` が `-6909`、`https://a.example/?a=1+2=` が `3` になっていた ── 打った覚えのない答えである。
 *
 * ## どこで線を引いたか
 * - **電話番号** = 式が「`0` で始まる市外局番(または `+` 国番号)- 局番 - 番号」の形(`03-1234-5678` / `090-1234-5678` / `0120-123-456` / `+81-3-1234-5678`)。
 *   ⚠ `10-3-2=` / `1-2-3=` のような普通の引き算は今までどおり計算する(先頭が 0 でも + でもない)。
 * - **URL** = `=` の手前の「空白で区切られた 1 かたまり」が `scheme://` か `www.` で始まる、または `?a=` の形(クエリ)を含む。
 *   ⚠ 空白で区切られたかたまりだけを見る ── `結果は 3*4=` のように、前の語に URL があっても影響しない。
 *
 * @param line  行の頭から `=` の直前までの字(半角へ直す前の原文)
 * @param expr  前後の空白を落とした式(半角)
 */
export function isPhoneOrUrl(line: string, expr: string): boolean {
  if (/^(?:0\d{1,4}|\+\d{1,3})(?:-\d{1,4}){1,2}-\d{3,4}$/.test(expr)) return true;
  const token = /\S+$/.exec(line)?.[0] ?? '';
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(token)) return true;
  // クエリ(`?a=` / `?a=1&b=`)。⚠ `&` だけでは URL と読まない(`R&D=…` を巻き込まない)
  return /\?[\w.%-]*=/.test(token) || (token.includes('?') && /&[\w.%-]*=/.test(token));
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

  // `=` から後ろへ、計算に使える字(と、数に付いた単位)の間だけ戻る
  let start = caretPos - 1;
  let skippedUnit = false;
  while (start > 0) {
    const ch = fullText[start - 1]!;
    if (ch === '\n') break;
    if (isCalcCharAt(fullText, start - 1)) {
      start -= 1;
      continue;
    }
    const unitLen = unitEndingAt(fullText, start);
    if (unitLen > 0) {
      start -= unitLen;
      skippedUnit = true;
      continue;
    }
    // 通貨記号(`$100*3=`)── 数の直前だけ
    if (CURRENCY_PREFIX.test(ch) && isDigitCh(fullText[start])) {
      start -= 1;
      skippedUnit = true;
      continue;
    }
    break;
  }

  /**
   * 🔴 **単位は読み飛ばす**(台帳 #1852 I2 / 依頼 308 B)── 読むだけで、打った単位は本文に残る(答えだけが足される)。
   *   式に残すのは計算に使える字だけ(走査が通ったのは計算の字と単位だけなので、それ以外を落とす)。
   */
  const readSlice = (a: number, b: number): string => {
    const half = toHalfWidth(fullText.slice(a, b));
    if (!skippedUnit) return half;
    let out = '';
    for (let k = 0; k < half.length; k += 1) if (isCalcCharAt(fullText, a + k)) out += half[k]!;
    return out;
  };
  // 行頭なら、箇条書きの印を式から外す(`- 1+2=` の `- `)
  const atLineStart = start === 0 || fullText[start - 1] === '\n';
  if (atLineStart) {
    const m = LIST_MARKER.exec(readSlice(start, caretPos - 1));
    if (m !== null) start += m[0].length;
  }

  const raw = readSlice(start, caretPos - 1);
  const expression = raw.trim();
  if (expression === '') return null;

  // 🔴 切れ端を式にしない(この門が PKC2 の 3 件を落とす)
  const lead = raw.length - raw.trimStart().length;
  const beforeRaw = start + lead > 0 ? fullText[start + lead - 1] : undefined;
  const before = beforeRaw === undefined ? undefined : toHalf(beforeRaw);
  if (startsMidToken(before, expression)) return null;
  // 🔴 単位を読み飛ばした式の手前が日付・時刻の語(`10月3日+2=`)なら計算しない ── 日付を足し算にしない
  if (skippedUnit && before !== undefined && /[月年日時分秒週]/u.test(before)) return null;
  if (isDateOrTime(before, expression)) return null;
  if (isPhoneOrUrl(fullText.slice(lineStart(fullText, caretPos), caretPos - 1), expression)) return null;
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
  const half = toHalfRewrite(typed);
  return {
    expression,
    halfWidth: half === typed ? null : { from, to: caretPos, text: half },
  };
}

/**
 * 🔴 **上の行の数を使う**(#1230。書き込み型のまま伸ばす ── 別アプリは作らない)。
 *
 * ## 何をするか
 *
 * 1. **変数 1 つ引き**: 上の行に `基本単価 = 3200`(名前 `=` 数)が在れば、下の行の
 *    `基本単価*8=` + `Enter` が `基本単価*8=25600` になる。
 * 2. **合計**: `合計=` / `sum=` + `Enter` で、**その行より上の、空行で区切られた塊**の
 *    各行の**末尾の数**を足す。
 *
 * ## 守ること
 *
 * ⚠ **追従しない** ── 答えは本文へ書き込まれ、定義の値を後から直しても変わらない
 *   (`2+3=5` と同じ。表の升の式とは向きが逆である)。
 * ⚠ **読むのは Enter した行と、その上の行だけ** ── 下は 1 バイトも読まない
 *   (大きなノートで重くしない。定義が下に在っても引かない)。
 * ⚠ **今までの `2+3=5` は 1 バイトも変えない** ── 変数は「定義された名前が式の中で
 *   実際に使われた」ときだけ働き、そうでなければ従来の経路へ落ちる。
 * ⚠ 見つからない名前・数の無い塊は**何もしない**(鳴らない ── `foo=` と同じ)。
 */

/** 計算の答えと、全角で打っていたときの半角への直し。 */
export interface InlineCalcResult {
  value: number;
  halfWidth: InlineCalcRequest['halfWidth'];
  /**
   * 🔴 **答えが長すぎて、正しく出せない**(台帳 #1852 I2 / 依頼 114-5。推薦 A)。真のとき**呼び側は答えを挿さず**、
   * {@link CALC_TOO_MANY_DIGITS} を言う。直す前は末尾の数字が違う値・丸めた値・指数の字が、断りなく本文に入っていた。
   */
  tooManyDigits: boolean;
}

/** 答えを挿さないときに言う 1 行(画面の下)。 */
export const CALC_TOO_MANY_DIGITS = '桁が多すぎて正しく計算できません';

/** 数の字(桁区切り・小数点を含む 1 かたまり)の桁数が 15 を超えるか。 */
const NUMBER_RUN = /\d[\d,]*(?:\.\d+)?/gu;
const SAFE_DIGITS = 15;

/**
 * 🔴 **答えが正しく出せる桁を超えるか**(依頼 114-5)。次のどれかで真:
 * ① 式の中に 15 桁を超える数が在る(読んだ時点で末尾が違う値になる)
 * ② 答えが 1e15 以上(整数でも 2 進の誤差が入る)
 * ③ 答えが小数で、**15 桁の短い小数として正確に言える**のに、画面に出す丸め(12 桁)で桁が落ちる
 *    (`100000000.123456*2=` の `200000000.246912`)。
 * ⚠ `1/3` や `0.1+0.2` は短い小数ではない(割り切れない / 2 進の端数)ので、これまでどおり丸めて挿す。
 * ⚠ 整数(1e15 未満)は `String()` でそのまま正確に出るので対象外。
 * @param expression 半角に読み替えた式(無ければ空)
 */
export function calcAnswerTooLong(value: number, expression: string): boolean {
  if (!Number.isFinite(value)) return false;
  for (const run of expression.match(NUMBER_RUN) ?? []) {
    if (run.replace(/\D/gu, '').replace(/^0+/u, '').length > SAFE_DIGITS) return true;
  }
  if (Math.abs(value) >= 1e15) return true;
  if (Number.isInteger(value)) return false;
  const p15 = value.toPrecision(SAFE_DIGITS);
  if (Number(p15) !== value) return false;
  const digits = p15.replace(/^-/u, '').replace('.', '').replace(/^0+/u, '').replace(/0+$/u, '');
  return digits.length > 12;
}

/** 数 1 つ(桁区切りと小数を含む)。⚠ 符号は別に見る。 */
const NUMBER_SRC = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;

/**
 * 変数の定義の行 ── `名前 = 数`(半角に読み替えた後の形に当てる)。
 *
 * ⚠ 名前は**空白・`=`・演算子・括弧・`.`・`,` を含まない**字の並びで、**数字だけの名前は
 *   定義と見なさない**(`12 = 3` を `12` の再定義にしない ── 下の `isVariableName`)。
 * ⚠ 行全体が `名前 = 数` でなければ定義ではない(`基本単価*8=25600` は定義ではない)。
 */
const DEFINITION_LINE = new RegExp(
  String.raw`^(?:[\t ]*(?:[-*+]|\d+\.)\s+)?\s*([^\s=+\-*/%().,]+)\s*=\s*(-?${NUMBER_SRC})\s*$`,
  'u',
);

/** 名前として使える字の並びか(数字だけは名前ではない)。 */
function isVariableName(name: string): boolean {
  return name !== '' && /\D/u.test(name);
}

/** 全角の英字を半角へ(`ｓｕｍ` → `sum`)。⚠ 合計の合図を見るときだけ使う。 */
function foldLetters(s: string): string {
  return s.replace(/[Ａ-Ｚａ-ｚ]/gu, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
}

/**
 * `lineStartIdx`(その行の頭)より**上**の行から、`名前 = 数` を集める。
 * ⚠ **いちばん近い物が勝つ**(下から上へ読み、先に見つけた名前を上書きしない)。
 * @returns 名前 → 数の字(桁区切りは落としてある。符号付き)
 */
function collectDefinitions(fullText: string, lineStartIdx: number): Map<string, string> {
  const defs = new Map<string, string>();
  let end = lineStartIdx - 1; // 直前の行の終わり(`\n` の位置)
  while (end >= 0) {
    const start = lineStart(fullText, end); // ⚠ 素の lastIndexOf は先頭の空行で行頭を取り違える
    const raw = fullText.slice(start, end);
    // ⚠ `=` を含まない行は定義ではない(大半の行はここで落とす)
    if (raw.includes('=') || raw.includes('＝')) {
      const m = DEFINITION_LINE.exec(toHalfWidth(raw).replace(/\r$/u, ''));
      if (m !== null && isVariableName(m[1]!) && !defs.has(m[1]!)) {
        defs.set(m[1]!, m[2]!.replace(/,/gu, ''));
      }
    }
    end = start - 1;
  }
  return defs;
}

/**
 * 行末の数を読む(半角に読み替えた行を渡す)。無ければ `null`。
 *
 * ⚠ **語や式の切れ端は数にしない** ── `md5` の `5` / `v1.2` の `1.2` /
 *   `3-5`(引き算)の `5` / `3+5` の `5` は拾わない(`startsMidToken` と同じ向き)。
 * ⚠ 日本語の直後は拾う(`りんご300` の `300`)。負の数は `-` の前が語や数でないときだけ。
 */
function trailingNumber(line: string): number | null {
  const t = line.trim();
  const m = new RegExp(`${NUMBER_SRC}$`, 'u').exec(t);
  if (m === null) return null;
  const before = m.index > 0 ? t[m.index - 1]! : undefined;
  let negative = false;
  if (before !== undefined) {
    if (/[0-9A-Za-z_,.+*/%]/u.test(before)) return null;
    // 🔴 `:` `：` `#` `＃` の直後の数は合計に入れない(#1087)── `会議 12:30` の `30` は分、`#12` は番号であって量ではない
    if (/[:：#＃]/u.test(before)) return null;
    if (before === '-') {
      const beforeSign = m.index > 1 ? t[m.index - 2]! : undefined;
      if (beforeSign !== undefined && /[0-9A-Za-z_)]/u.test(beforeSign)) return null;
      negative = true;
    }
  }
  const n = Number(m[0].replace(/,/gu, ''));
  return negative ? -n : n;
}

/**
 * `合計=` の合計。上へ、**空行(空白だけの行)に当たるまで**の各行の末尾の数を足す。
 * 数が 1 つも無ければ `null`。
 */
/**
 * 行の頭(`=` / `＝` より前)が合計の合図(`合計` / `sum`)か。⚠ 合図を見る門と、前の合計の行を足さない門の**同じ 1 本**(§7)。
 */
function isSumLabel(head: string): boolean {
  const label = foldLetters(toHalfWidth(head)).replace(LIST_MARKER, '').trim().toLowerCase();
  return label === '合計' || label === 'sum';
}

/** 前に出した合計の行(`合計=500`)か。⚠ `=` の後が答えの行だけ(`=` が無い行は見ない)。 */
function isSumResultLine(raw: string): boolean {
  const eq = toHalfWidth(raw).indexOf('=');
  return eq >= 0 && isSumLabel(raw.slice(0, eq));
}

function sumAbove(fullText: string, lineStartIdx: number): number | null {
  let total = 0;
  let found = false;
  let end = lineStartIdx - 1;
  while (end >= 0) {
    const start = lineStart(fullText, end); // ⚠ 素の lastIndexOf は先頭の空行で行頭を取り違える
    const raw = fullText.slice(start, end);
    if (raw.trim() === '') break; // ⚠ 空行で塊が切れる
    /**
     * 🔴 **前に出した合計の行は足さない**(#1087)── 足すと、合計の下に 1 行足して合計し直したとき
     *   前の合計ぶんが二重に入る(300 + 200 → 合計=500、バナナ 150 → 合計= が 1150 になっていた)。
     * ⚠ 答えの行(`基本単価*8=25600`)は今までどおり足す ── 外すのは合計の合図の行だけ。
     */
    if (isSumResultLine(raw)) {
      end = start - 1;
      continue;
    }
    const n = trailingNumber(toHalfWidth(raw));
    if (n !== null) {
      total += n;
      found = true;
    }
    end = start - 1;
  }
  return found ? total : null;
}

/** 合図(`=` / `＝`)の直前で、行の終わりに在るか。⚠ `detectInlineCalcRequest` と同じ門。 */
function atCalcSignal(fullText: string, caretPos: number): boolean {
  if (toHalf(fullText[caretPos - 1] ?? '') !== '=') return false;
  const after = fullText[caretPos];
  return after === undefined || after === '\n';
}

/**
 * 名前が、ASCII の語の**途中**に当たっていないか(`data` の `a` を名前 `a` と読まない)。
 * ⚠ 日本語は語の切れ目が無いので見ない(`お名前*2` の `名前` は読む ── `結果は3*4=` と同じ向き)。
 * @param text  読んでいる字(半角に読み替え済み)
 * @param from  名前の始まり
 */
function insideAsciiWord(text: string, from: number, name: string): boolean {
  const prev = from > 0 ? text[from - 1]! : '';
  return /[0-9A-Za-z_]/u.test(prev) && /[0-9A-Za-z_]/u.test(name[0]!);
}

/**
 * 定義された名前を使った式を読む。使っていなければ `null`(従来の経路へ落とす)。
 *
 * 🔑 **名前を数に差し替えてから、従来の評価器へ渡す**(`基本単価*8` → `(3200)*8`)。
 *   文法も 0 割りの門も 1 か所のまま ── 変数のために評価器を 2 つ持たない。
 * ⚠ 式の始まりを探すとき、**定義された名前だけ**を「式の字」と見なす
 *   (地の文の `結果は` を式に巻き込まない)。⚠ 切れ端の門(`startsMidToken`)も
 *   「計算する所が無い」門(`hasNoOperation`)も、従来と同じ物を通す。
 */
function resolveWithVariables(fullText: string, caretPos: number): InlineCalcResult | null {
  const ls = lineStart(fullText, caretPos);
  const hw = toHalfWidth(fullText.slice(ls, caretPos)); // 1 字 → 1 字なので位置は同じ
  const head = hw.slice(0, -1);
  // ⚠ 数と記号だけの行(`2+3=`)に名前は居ない ── 上を読まずに落とす
  if (!/[^0-9+\-*/%().,\s]/u.test(head)) return null;

  const defs = collectDefinitions(fullText, ls);
  if (defs.size === 0) return null;
  const names = [...defs.keys()].sort((a, b) => b.length - a.length);

  // `=` から後ろへ、計算に使える字と定義された名前の間だけ戻る
  let start = head.length;
  while (start > 0) {
    const name = names.find(
      (n) => start >= n.length && head.endsWith(n, start) && !insideAsciiWord(head, start - n.length, n),
    );
    if (name !== undefined) {
      start -= name.length;
    } else if (CALC_CHARS.test(head[start - 1]!)) {
      start -= 1;
    } else {
      break;
    }
  }
  // 行頭なら、箇条書きの印を式から外す
  if (start === 0) {
    const m = LIST_MARKER.exec(head);
    if (m !== null) start += m[0].length;
  }

  const raw = head.slice(start);
  const expression = raw.trim();
  if (expression === '') return null;
  const lead = raw.length - raw.trimStart().length;
  const before = start + lead > 0 ? head[start + lead - 1] : undefined;
  if (startsMidToken(before, expression)) return null;
  if (isDateOrTime(before, expression)) return null;
  if (hasNoOperation(expression)) return null;

  // 名前を数へ(長い名前から合わせる)
  let used = false;
  let substituted = '';
  for (let i = 0; i < expression.length; ) {
    const name = names.find((n) => expression.startsWith(n, i) && !insideAsciiWord(expression, i, n));
    if (name !== undefined) {
      substituted += `(${defs.get(name)!})`;
      used = true;
      i += name.length;
    } else {
      substituted += expression[i]!;
      i += 1;
    }
  }
  if (!used) return null;
  const value = evaluateCalcExpression(substituted);
  if (value === null) return null;

  const from = ls + start + lead;
  const typed = fullText.slice(from, caretPos);
  const half = toHalfRewrite(typed);
  return {
    value,
    halfWidth: half === typed ? null : { from, to: caretPos, text: half },
    tooManyDigits: calcAnswerTooLong(value, substituted),
  };
}

/**
 * 🔴 **Enter / 「この行を計算する」が通る唯一の口**(#1230)。
 *
 * 順番は ① `合計=` ② 定義された名前を使う式 ③ 従来の式(`detectInlineCalcRequest` +
 * `evaluateCalcExpression`)。⚠ ③は**1 バイトも変えていない** ── ①②が当たらなければ
 * 今までと同じ答えが出る。
 *
 * @returns 答えと半角への直し / `null`(何もしない)
 */
export function resolveInlineCalc(
  fullText: string,
  caretPos: number,
  /** 🔴 欄の上にある本文(1 行ずつ打つ編集の、開いている行より上。#1852 I2 / 依頼 78-2)。無ければ空。 */
  above: string = '',
): InlineCalcResult | null {
  if (typeof fullText !== 'string') return null;
  if (caretPos < 0 || caretPos > fullText.length) return null;
  if (above !== '') return shiftResult(resolveInlineCalc(above + fullText, caretPos + above.length), above.length);
  if (!atCalcSignal(fullText, caretPos)) return null;

  const ls = lineStart(fullText, caretPos);
  // ① 合計(⚠ 合図は行の頭から `合計` / `sum` だけ。箇条書きの印は外す)
  if (isSumLabel(fullText.slice(ls, caretPos - 1))) {
    const total = sumAbove(fullText, ls);
    if (total === null) return null;
    // ⚠ 直すのは合図の `＝` だけ(`合計` / `ｓｕｍ` は user の字)
    const sign = fullText[caretPos - 1]!;
    return {
      value: total,
      halfWidth: sign === '=' ? null : { from: caretPos - 1, to: caretPos, text: '=' },
      tooManyDigits: calcAnswerTooLong(total, ''),
    };
  }

  /**
   * 🔴 **決めた名前に数を付け足した打ち間違い(`基本単価2*8=`)は、計算しない**(#1163 の依頼 100-3)。
   * ⚠ 直す前は、`基本単価` を地の文と読んで `2*8` だけを計算し、**打ち間違いに気づけない数(16)が黙って入った**。
   *   計算しない代わりに、理由を `explainCalcMiss` が言う(「『基本単価2』は上の行で決めていません」)。
   */
  if (nearMissName(fullText, ls, fullText.slice(ls, caretPos - 1)) !== null) return null;

  // ② 名前を使った式
  const withVars = resolveWithVariables(fullText, caretPos);
  if (withVars !== null) return withVars;

  // ③ 従来の式
  const req = detectInlineCalcRequest(fullText, caretPos);
  if (req === null) return null;
  const value = evaluateCalcExpression(req.expression);
  return value === null
    ? null
    : { value, halfWidth: req.halfWidth, tooManyDigits: calcAnswerTooLong(value, req.expression) };
}

/**
 * 🔴 **欄の上にある本文を前に付けて読んだ結果の位置を、欄の座標へ戻す**(依頼 78-2)。
 * ⚠ 直す範囲(`halfWidth`)は式のある行(= 欄の中)なので、必ず `above` より後ろ。
 */
function shiftResult(r: InlineCalcResult | null, by: number): InlineCalcResult | null {
  if (r === null || r.halfWidth === null) return r;
  return { ...r, halfWidth: { ...r.halfWidth, from: r.halfWidth.from - by, to: r.halfWidth.to - by } };
}

/**
 * 上の行で決めた名前に、数だけが付いた語(`基本単価` を決めたときの `基本単価2`)を式の中に持つか。持つならその語。
 * ⚠ 出す条件は `unknownNameNote` と同じく**空白のない 1 つの式**に絞る(`りんご 2*3=` のような文には口を出さない)。
 * @param line 行頭から `=` の手前まで(箇条書きの印を含んでよい)
 */
function nearMissName(fullText: string, ls: number, line: string): string | null {
  const body = toHalfWidth(line).replace(LIST_MARKER, '').trim();
  if (body === '' || /\s/u.test(body) || !/[+\-*/%]/u.test(body)) return null;
  const defs = collectDefinitions(fullText, ls);
  if (defs.size === 0) return null;
  for (const t of body.match(/[^+\-*/%().,]+/gu) ?? []) {
    if (defs.has(t) || !/\D/u.test(t)) continue;
    for (const name of defs.keys()) {
      if (t.length > name.length && t.startsWith(name) && /^\d+$/u.test(t.slice(name.length))) return t;
    }
  }
  return null;
}

/** セルの番地の形(`A1` / `B12`)。名前の打ち間違いとは読まない。 */
const CELL_REF = /^[A-Za-z]{1,3}\d{1,4}$/u;

/**
 * 🔴 **上の行で決めた名前を打ち間違えたとき**(#1163 の依頼 100-3。Gemini の裁定:推薦どおり)。
 *
 * 上の行に `基本単価 = 3200` と書き、`基本単価2*8=` と打ち間違えて Enter を押すと、何も出ずに改行だけになっていた
 * (言葉の入った行には口を出さない決まりのため)。名前を決めた行が上に在る人に限り、「その名前は決めていません」と言う。
 *
 * ⚠ 出す条件は絞る ── 普通の文には出さない:
 *   ① 上の行に `名前 = 数` が 1 つ以上ある(名前を使う習慣のある人)
 *   ② 行が**空白のない 1 つの式**(`名前*数`)で、演算子を含む。`結果は 基本単価*8=` のような文は黙る
 *   ③ 式の中に、決めていない名前がある(数だけ・決めた名前だけの式は対象外)。セルの番地の形(`A1`)は名前と読まない
 * @returns 出す 1 行 / `null`
 */
function unknownNameNote(fullText: string, ls: number, body: string): string | null {
  if (/\s/u.test(body) || !/[+\-*/%]/u.test(body)) return null;
  const defs = collectDefinitions(fullText, ls);
  if (defs.size === 0) return null;
  const tokens = body.match(/[^+\-*/%().,]+/gu) ?? [];
  const unknown = tokens.find((t) => /\D/u.test(t) && !defs.has(t) && !CELL_REF.test(t));
  return unknown === undefined ? null : `『${unknown}』は上の行で決めていません`;
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
export function explainCalcMiss(fullText: string, caretPos: number, above: string = ''): string | null {
  if (typeof fullText !== 'string') return null;
  if (caretPos < 0 || caretPos > fullText.length) return null;
  if (above !== '') return explainCalcMiss(above + fullText, caretPos + above.length);
  // 合図(`=` / `＝`)が直前に無ければ、そもそも計算を頼んでいない
  if (toHalf(fullText[caretPos - 1] ?? '') !== '=') return null;
  // 行の終わりでなければ発火しない(製品と同じ門 ── ここだけ緩めない)
  const after = fullText[caretPos];
  if (after !== undefined && after !== '\n') return null;
  // 🔴 計算できたなら黙る(成功に口を出さない)。⚠ 桁が多すぎて挿さない回は、その理由を言う(依頼 114-5)
  const solved = resolveInlineCalc(fullText, caretPos);
  if (solved !== null) return solved.tooManyDigits ? CALC_TOO_MANY_DIGITS : null;

  const head = toHalfWidth(fullText.slice(lineStart(fullText, caretPos), caretPos - 1));
  const body = head.replace(LIST_MARKER, '').trim();
  if (body === '') return null;
  // ⚠ **数が 1 つも無い行**は普通の文(`(=` のような打ち間違いに口を出さない)
  if (!/\d/u.test(body)) return null;
  // ⚠ **言葉が混ざる行**は普通の文(`締切=` / `md5=` / `A1+B1=`)── ただし 1 つだけ言う場面がある(下の `unknownNameNote`)
  if (WORD_CHARS.test(body)) return unknownNameNote(fullText, lineStart(fullText, caretPos), body);

  // ① 計算に使えない字が入っている(`2^3=` の `^` / `50=` の後ろの記号)
  const bad = [...body].find((ch) => !CALC_CHARS.test(ch));
  if (bad !== undefined) return `計算できませんでした(${bad} は計算に使えません)`;
  // ② 桁区切りに見えない `,`(`1,2+3=`)
  if (stripGrouping(body).includes(','))
    return '計算できませんでした(桁区切りの , は 3 桁ごとのときだけ数として読みます)';
  // ③ `%` は余り(百分率ではない)── 末尾の `%` は必ずここに来る
  if (/%\s*$/u.test(body)) return '計算できませんでした(% は「余り」です。百分率ではありません)';
  // ③' 日付や時刻(`2026-10-17=` / `12:30+45=`)
  if (isDateOrTime(undefined, body)) return '計算できませんでした(日付や時刻は計算できません)';
  // ③'' 電話番号の形(`03-1234-5678=`)。URL は言葉が混ざる行なので、ここへは来ない
  if (isPhoneOrUrl(head, body)) return '計算できませんでした(電話番号や URL の形は計算しません)';
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

export function calcLineAction(fullText: string, caretPos: number, above: string = ''): CalcLineAction | null {
  if (typeof fullText !== 'string') return null;
  if (caretPos < 0 || caretPos > fullText.length) return null;
  if (above !== '') {
    const r = calcLineAction(above + fullText, caretPos + above.length);
    return r !== null && r.kind === 'insert' ? { ...r, at: r.at - above.length } : r;
  }
  const start = lineStart(fullText, caretPos);
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
  const solved = resolveInlineCalc(probe, at);
  // 🔴 桁が多すぎるときは挿さずに理由を言う(Enter と同じ。依頼 114-5)
  if (solved !== null && solved.tooManyDigits) return { kind: 'why', text: CALC_TOO_MANY_DIGITS };
  const v = solved?.value ?? null;
  if (v !== null) {
    // ⚠ `=` を足す回は、答えの前に `=` も入れる(1 回の挿入にまとめる)
    // ⚠ 普通の数字にならない答え(`1e21` 以上など)は何も挿さない(他の「計算にならなかった」と同じ)
    const shown = formatCalcResult(v);
    if (shown === null) return null;
    return { kind: 'insert', at: end, text: `${hasEq ? '' : '='}${shown}` };
  }
  const why = explainCalcMiss(probe, at);
  if (why === null) return null;
  /**
   * 🔴 **もう答えが付いている行**(`1200*1.1=1320`)── 足した `=` が古い `=` とぶつかって
   *   「= は計算に使えません」と出ていた(#1087)。user が見たいのは「済んでいる」ことなので、そう言う。
   * ⚠ 数と記号だけの行(`explainCalcMiss` が `= は計算に使えません` と答えた行)に限る ──
   *   `締切=5` のような言葉の入った行は、そもそも `why` が `null` で、ここへ来ない。
   */
  if (!hasEq && why === '計算できませんでした(= は計算に使えません)' && /[=＝]\s*[-+]?[\d.,０-９．，]+\s*$/u.test(line))
    return { kind: 'why', text: 'この行は計算済みです' };
  return { kind: 'why', text: why };
}

/**
 * 答えを字にする。
 * ⚠ **浮動小数のゴミを落とす**(`0.1+0.2` を `0.30000000000000004` と出さない)。
 * 🔴 **指数表記にしない**(#1087)── `1e-7` や `1e+21` を本文へ挿すと、読めない字になる。
 *   小数は 12 桁まで・桁区切り無しの**普通の数字**で出す。大きすぎて(1e21 以上)普通の数字にならない答えと、
 *   数にならない答え(`Infinity` / `NaN`)は `null` ── 呼び側は何も挿さない(他の「計算にならなかった」と同じ)。
 *   ⚠ 12 桁までで 0 に丸まる極小(`1e-13`)は `0` と挿すと嘘なので、これも `null`。
 */
export function formatCalcResult(value: number): string | null {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21) return null;
  // ⚠ `0` を別扱いしない ── `Number.isInteger(-0)` は true、`String(-0)` は `'0'`
  //    なので、次の行が同じ答えを返す(no-op だった)
  if (Number.isInteger(value)) return String(value);
  const rounded = Number(value.toPrecision(12));
  // 🔴 12 桁で丸めた後は `String()`(#1087)── `toFixed(12)` を通すと、約 8000 以上の小数で
  //   `13605.870000000001` のような端数が戻っていた。表の升の式と**同じ 1 関数**(`formatNumber`)。
  //   指数表記になる極小(1e-7 未満)のときだけ `toFixed` で普通の数字にする。
  const plain = formatNumber(rounded);
  const fixed = /e/u.test(plain) ? rounded.toFixed(12).replace(/\.?0+$/u, '') : plain;
  return fixed === '0' || fixed === '-0' || fixed === '' ? null : fixed;
}
