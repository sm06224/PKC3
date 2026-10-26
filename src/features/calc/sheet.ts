/**
 * 🔴 **計算スクラッチパッドの評価器**(#1230。user 指示 2026-10-26「全部やるのです」)。
 *
 * 文章と計算式を混ぜて書くと、各行の右に結果が並ぶ(Soulver / Calca の操作感)。
 *
 * ```
 * 基本単価 = 3200 円
 * 作業時間 = 40 時間
 * 小計 = 基本単価 * 作業時間        → 128,000
 * 特別値引き = 8000 円
 * 小計2 = 小計 - 特別値引き         → 120,000
 * 消費税 = 小計2 * 10%             → 12,000
 * 合計 = 小計2 + 消費税            → 132,000
 * ```
 *
 * ## 本文の「この行を計算する」(`inline-calc.ts`)との関係
 *
 * 🟣 Gemini 裁定 2026-10-02 で、本文の上には**書き込み型**(`基本単価*8=` + Enter で字が入る・後から追従しない)を入れた。
 * こちらは user 指示 2026-10-26 で足した**追従型**(値を直すと下の結果も変わる)の別ウィンドウ。
 * 本文の面は 5 つあり、追従型を本文に入れると全面に規則が要るので、**本文には入れず、この窓だけ**に置く。
 *
 * ⚠ **`%` の意味が本文の計算と違う**: 本文の計算は `%` を**余り**として読む(PKC2 と同じ)が、こちらは**割合**
 *   (`10%` = 0.1、`100 + 10%` = 110)。単位や `円` を混ぜて書く画面では、割合のほうが普通に読まれるため。
 *   マニュアルの両方の節に書く。
 *
 * ## 読み方の規則(迷ったら「計算しない」側に倒す ── 文章を勝手に式にしない)
 *
 * - 行の頭の `名前 =` か `名前:` は**名前の定義**。以降の行で名前が使える(同じ名前は後の定義が勝つ)。
 * - 式に使えるのは 数・`+ - * / × ÷ ( )`・割合 `%`・名前・単位。
 *   **単位は計算に使わず読み飛ばす**: 数や名前の直後の語(`3200 円`)、数の直前の通貨記号(`$100`)。
 *   行の頭の語(`電車 1200円` の `電車`)は項目名で、行の終わりの語(`1200円 往復`)はメモ。
 * - 式の途中に語が挟まる(`3 個 + 5 個` は可、`3 を 5`  は不可)。単位は 1 語まで。
 * - **日付・時刻・電話番号らしい並び**(`2026-10-26`、`10:30`、`03-1234-5678`)と、**番号つきの箇条書き**(`1. `)は計算しない。
 * - **数だけの 1 行**は計算する。**文章に数が混じるだけ**(`プロジェクト 2026`)は、単位が付いていなければ計算しない。
 * - `合計` / `sum` / `total` だけの行は、その行より上で**空行か前の合計まで**の行の結果を足す。
 *   `名前 = 合計` や `合計 =` のように名前を付けてもよい。
 * - 0 で割る・式が読めない行は、結果の欄にその理由を出す(黙って空にしない)。
 *
 * 🔑 **pure module**。DOM も storage も知らない。`eval` / `Function` は使わない(本文は user の打った字)。
 */
import { formatNumber } from '../markdown/csv-formula';
import { tableToMarkdown } from '../markdown/table-copy';

export type SheetRowKind = 'blank' | 'text' | 'value' | 'sum' | 'error';

export interface SheetRow {
  /** 元の行(書き換えない)。 */
  readonly text: string;
  readonly kind: SheetRowKind;
  /** `value` / `sum` のときの数。割合だけの式(`10%`)は割合の値(0.1)。 */
  readonly value: number | null;
  /** 結果の欄に出す字。`blank` / `text` は空。`error` は理由。 */
  readonly display: string;
  /** 名前の定義だったとき、その名前。 */
  readonly name: string | null;
  /** 割合の値か(`10%`)。名前に入れたとき、使う側も割合として読むための印。 */
  readonly pct: boolean;
}

/** 合計を表す語(大小文字を区別しない)。 */
const SUM_WORDS: ReadonlySet<string> = new Set(['合計', 'sum', 'total']);

// ── 字の正規化 ───────────────────────────────────────────────────────

const FULL_TO_HALF: Readonly<Record<string, string>> = {
  '＋': '+', '－': '-', '−': '-', '＊': '*', '／': '/', '％': '%',
  '（': '(', '）': ')', '．': '.', '，': ',', '＝': '=', '：': ':', '×': '*', '÷': '/',
};

/** 全角の数字と記号を半角へ。⚠ 1 字 → 1 字(位置が動かない)。 */
function normalize(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0xff10 && c <= 0xff19) out += String.fromCharCode(c - 0xfee0);
    else out += FULL_TO_HALF[ch] ?? ch;
  }
  return out;
}

/** 桁区切りの `,` だけを落とす(`1,200` → `1200`)。3 桁ちょうどのときだけ ── `1,2` は触らない。 */
function stripGrouping(s: string): string {
  let out = s;
  for (;;) {
    const next = out.replace(/(\d),(\d{3})(?!\d)/gu, '$1$2');
    if (next === out) return out;
    out = next;
  }
}

// ── 語の仕分け ───────────────────────────────────────────────────────

type Tok =
  | { t: 'num'; v: number; pct: boolean }
  | { t: 'var'; v: number; pct: boolean; name: string }
  | { t: 'op'; v: '+' | '-' | '*' | '/' }
  | { t: 'lp' }
  | { t: 'rp'; pct: boolean }
  | { t: 'word'; v: string };

const OP_CHARS = '+-*/()%';

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

/**
 * 式の部分を字句に割る。名前は**長いものを先に**当てる(`小計2` と `小計` が両方あれば `小計2`)。
 * @returns 割れなければ `null`(`%` が単独で出た等)
 */
function tokenize(src: string, vars: ReadonlyMap<string, VarVal>): Tok[] | null {
  // 名前は先頭の 1 字で引く(長いものを先に)── 位置ごとに全部の名前を試さない
  const byFirst = new Map<string, string[]>();
  for (const n of [...vars.keys()].sort((a, b) => b.length - a.length)) {
    const list = byFirst.get(n[0]!);
    if (list === undefined) byFirst.set(n[0]!, [n]);
    else list.push(n);
  }
  const nameAt = (at: number): string | undefined => byFirst.get(src[at]!)?.find((n) => src.startsWith(n, at));
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/u.test(ch)) {
      i += 1;
      continue;
    }
    // 名前(語の途中から当てない: 直前が語の字なら、その語の続きとして扱う)
    const hit = nameAt(i);
    if (hit !== undefined) {
      const known = vars.get(hit)!;
      toks.push({ t: 'var', v: known.v, pct: known.pct, name: hit });
      i += hit.length;
      continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1]))) {
      let j = i;
      while (isDigit(src[j])) j += 1;
      if (src[j] === '.' && isDigit(src[j + 1])) {
        j += 1;
        while (isDigit(src[j])) j += 1;
      }
      const v = Number(src.slice(i, j));
      let pct = false;
      if (src[j] === '%') {
        pct = true;
        j += 1;
      }
      toks.push({ t: 'num', v: pct ? v / 100 : v, pct });
      i = j;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      toks.push({ t: 'op', v: ch });
      i += 1;
      continue;
    }
    if (ch === '(') {
      toks.push({ t: 'lp' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      let pct = false;
      if (src[i + 1] === '%') {
        pct = true;
        i += 1;
      }
      toks.push({ t: 'rp', pct });
      i += 1;
      continue;
    }
    if (ch === '%') return null;
    // 語: 空白・数・記号・名前の頭までを 1 語とする
    let j = i;
    while (j < src.length) {
      const c = src[j]!;
      if (/\s/u.test(c) || isDigit(c) || OP_CHARS.includes(c)) break;
      if (j > i && nameAt(j) !== undefined) break;
      j += 1;
    }
    if (j === i) return null;
    toks.push({ t: 'word', v: src.slice(i, j) });
    i = j;
  }
  return toks;
}

/**
 * 語を仕分ける。行の頭の語は項目名、行の終わりの語はメモ、式の途中の語は**単位として 1 語だけ**許す。
 * @returns 式の字句(語を除いたもの)。読み飛ばせない語が混じれば `null`(= 文章)
 */
function dropWords(toks: readonly Tok[]): Tok[] | null {
  let a = 0;
  while (a < toks.length && toks[a]!.t === 'word') a += 1;
  let b = toks.length;
  while (b > a && toks[b - 1]!.t === 'word') b -= 1;
  const mid = toks.slice(a, b);
  const core: Tok[] = [];
  for (let k = 0; k < mid.length; k += 1) {
    const tk = mid[k]!;
    if (tk.t !== 'word') {
      core.push(tk);
      continue;
    }
    const prev = mid[k - 1];
    const next = mid[k + 1];
    if (prev === undefined || next === undefined) return null;
    if (prev.t === 'word' || next.t === 'word') return null;
    // 単位: 数・名前・閉じ括弧の直後(`3 個 + 5`)── 次は演算子か閉じ括弧
    const afterValue = prev.t === 'num' || prev.t === 'var' || prev.t === 'rp';
    const beforeBreak = next.t === 'op' || next.t === 'rp';
    // 通貨記号: 演算子か開き括弧の直後で、次が数か名前(`10 + $5`)
    const prefix = (prev.t === 'op' || prev.t === 'lp') && (next.t === 'num' || next.t === 'var');
    if ((afterValue && beforeBreak) || prefix) continue;
    return null;
  }
  return core;
}

// ── 式の評価 ─────────────────────────────────────────────────────────

class Bad extends Error {}

interface Val {
  readonly v: number;
  /** 割合の項(`10%`)が単独で現れたか。`+` `-` の右なら左を基準にする。 */
  readonly pct: boolean;
}

class Parser {
  private i = 0;
  constructor(private readonly toks: readonly Tok[]) {}

  done(): boolean {
    return this.i >= this.toks.length;
  }

  expr(): Val {
    let lhs = this.term();
    for (;;) {
      const tk = this.toks[this.i];
      if (tk === undefined || tk.t !== 'op' || (tk.v !== '+' && tk.v !== '-')) return lhs;
      this.i += 1;
      const rhs = this.term();
      // 割合の項は、左の値に対する割合として読む(`100 + 10%` = 110)
      const r = rhs.pct ? lhs.v * rhs.v : rhs.v;
      lhs = { v: tk.v === '+' ? lhs.v + r : lhs.v - r, pct: false };
    }
  }

  private term(): Val {
    let lhs = this.unary();
    for (;;) {
      const tk = this.toks[this.i];
      if (tk === undefined || tk.t !== 'op' || (tk.v !== '*' && tk.v !== '/')) return lhs;
      this.i += 1;
      const rhs = this.unary();
      if (tk.v === '/' && rhs.v === 0) throw new Bad('0 では割れません');
      lhs = { v: tk.v === '*' ? lhs.v * rhs.v : lhs.v / rhs.v, pct: false };
    }
  }

  private unary(): Val {
    const tk = this.toks[this.i];
    if (tk !== undefined && tk.t === 'op' && (tk.v === '+' || tk.v === '-')) {
      this.i += 1;
      const x = this.unary();
      return { v: tk.v === '-' ? -x.v : x.v, pct: x.pct };
    }
    return this.primary();
  }

  private primary(): Val {
    const tk = this.toks[this.i];
    if (tk === undefined) throw new Bad('式が途中で終わっています');
    if (tk.t === 'num') {
      this.i += 1;
      return { v: tk.v, pct: tk.pct };
    }
    if (tk.t === 'var') {
      this.i += 1;
      // 🔴 割合で定義した名前(`税率 = 10%`)は、割合の印を保つ(`100 + 税率` = 110。直接 `100 + 10%` と書いたときと同じ)
      return { v: tk.v, pct: tk.pct };
    }
    if (tk.t === 'lp') {
      this.i += 1;
      const inner = this.expr();
      const close = this.toks[this.i];
      if (close === undefined || close.t !== 'rp') throw new Bad('閉じ括弧がありません');
      this.i += 1;
      return close.pct ? { v: inner.v / 100, pct: true } : inner;
    }
    throw new Bad('式が読めません');
  }
}

// ── 行の読み ─────────────────────────────────────────────────────────

const DATE_LIKE = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\b\d{1,2}:\d{2}\b|\d{2,4}-\d{2,4}-\d{3,4}/u;
const LIST_NUMBER = /^\s*\d+[.)]\s/u;
const BULLET = /^\s*(?:[-*+>]\s+)+/u;
/** 名前の頭に置けない字(空白・`=` `:`・演算子・括弧・数・`.` `,`)。 */
const LABEL_FIRST_BAD = /[\s=:+\-*/%()0-9.,]/u;
/** 名前の途中で打ち切る字。ここで `=` か `:` に当たれば名前の定義、ほかなら定義ではない。 */
const LABEL_STOP: ReadonlySet<string> = new Set(['=', ':', '+', '-', '*', '/', '%', '(', ')']);

/**
 * 名前の定義 `名前 = …` / `名前: …` を割る。名前は数や記号で始めない。
 * 🔴 **1 回の走査で割る**(旧版は正規表現 `…*?\s*[=:]`)── 空白が長く続く行で、遅延量指定と `\s*` が
 *   互いに押し合って 2 次の時間になった(レビュー ⚠1)。ここは各字を 1 度ずつしか見ない。
 */
export function splitLabel(full: string): { label: string; rest: string } | null {
  let i = 0;
  while (i < full.length && /\s/u.test(full[i]!)) i += 1;
  const first = full[i];
  if (first === undefined || LABEL_FIRST_BAD.test(first)) return null;
  let j = i + 1;
  while (j < full.length && !LABEL_STOP.has(full[j]!)) j += 1;
  const stop = full[j];
  if (stop !== '=' && stop !== ':') return null;
  let k = j + 1;
  while (k < full.length && /\s/u.test(full[k]!)) k += 1;
  const rest = full.slice(k);
  // 旧版の `(.*)$` は行の区切りに当たると定義にならなかった(同じ振る舞いに揃える)
  if (/[\n\r\u2028\u2029]/u.test(rest)) return null;
  return { label: full.slice(i, j).trim(), rest };
}
/** 数に付く語のうち、単位として確かなもの(数だけの行 + 文章のときの判定に使う)。 */
const UNIT_HINT = /^(?:円|[$¥￥€£]|ドル|ユーロ|時間|分|秒|日|週|月|年|個|人|件|枚|本|台|回|冊|km|kg|cm|mm|g|m|l|ml|%)/iu;

export const SHEET_NAME_MAX = 40;

/** 評価する行数の上限。⚠ 超えた分は評価しない(画面が理由を言う)。 */
export const SHEET_MAX_LINES = 2000;

function makeValue(text: string, v: number, pct: boolean, name: string | null, kind: 'value' | 'sum'): SheetRow {
  return { text, kind, value: v, display: formatSheetNumber(v, pct), name, pct };
}

function errorRow(text: string, why: string, name: string | null = null): SheetRow {
  return { text, kind: 'error', value: null, display: why, name, pct: false };
}

/** 数を画面の字にする。桁区切り・小数は意味のある桁で丸める・割合なら `%`。 */
export function formatSheetNumber(v: number, pct = false): string {
  if (!Number.isFinite(v)) return '—';
  const shown = pct ? v * 100 : v;
  let s = formatNumber(shown);
  if (/e/iu.test(s)) s = shown.toFixed(12).replace(/\.?0+$/u, '');
  if (s === '-0') s = '0';
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  return `${neg ? '-' : ''}${grouped}${frac === undefined ? '' : `.${frac}`}${pct ? '%' : ''}`;
}

/**
 * 全行を評価する。⚠ 上の行から順に読み、定義は**その行より下**にだけ効く(下で定義した名前を上で使わない)。
 */
export function evaluateSheet(source: string): SheetRow[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n').slice(0, SHEET_MAX_LINES);
  const rows: SheetRow[] = [];
  const ctx: Ctx = { vars: new Map(), plain: new Set(), block: [] };
  for (const raw of lines) {
    if (raw.trim() === '') {
      rows.push({ text: raw, kind: 'blank', value: null, display: '', name: null, pct: false });
      ctx.block = [];
      continue;
    }
    const row = evalLine(raw, ctx);
    rows.push(row);
    if (row.kind === 'sum') ctx.block = [];
    else if (row.kind === 'value' && row.value !== null) ctx.block.push(row.value);
    if ((row.kind === 'value' || row.kind === 'sum') && row.name !== null && row.value !== null) {
      ctx.vars.set(row.name, { v: row.value, pct: row.pct });
      // 合計の語を名前にした行(`合計 =`)は、次の `合計` を変数にしない(合計の語のまま働く)
      if (row.kind === 'value') ctx.plain.add(row.name);
      else ctx.plain.delete(row.name);
    }
  }
  return rows;
}

interface VarVal {
  readonly v: number;
  /** 割合で定義した(`税率 = 10%`)。使うときも割合として読む。 */
  readonly pct: boolean;
}

interface Ctx {
  /** 名前 → 値(と、割合で定義したかの印)。 */
  readonly vars: Map<string, VarVal>;
  /** 値の行で定義した名前(合計の行で定義した名前は含まない)。 */
  readonly plain: Set<string>;
  /** 直近の空行(か合計)より後の、数を持つ行の値。 */
  block: number[];
}

function evalLine(raw: string, ctx: Ctx): SheetRow {
  const text = (): SheetRow => ({ text: raw, kind: 'text', value: null, display: '', name: null, pct: false });
  const full = normalize(raw).replace(BULLET, '');
  // 日付・時刻・電話番号らしい並び、番号つきの箇条書き、見出しは計算しない(名前の定義より先に見る: `会議 10:30`)
  if (DATE_LIKE.test(full) || LIST_NUMBER.test(full) || /^\s*#/u.test(full)) return text();

  let name: string | null = null;
  let rest = full;
  const lm = splitLabel(full);
  if (lm !== null) {
    const label = lm.label;
    if (label !== '' && label.length <= SHEET_NAME_MAX) {
      name = label;
      rest = lm.rest;
    }
  }
  // 合計: 残りが合計の語だけ(`合計` / `合計 =` / `旅費 = 合計`)。値の行で定義した名前なら変数として読む
  const word = (name !== null && rest.trim() === '' ? name : rest).trim().replace(/[=:]$/u, '').trim();
  if (SUM_WORDS.has(word.toLowerCase()) && !ctx.plain.has(word)) {
    return sumRow(raw, name !== null ? name : null, word, ctx);
  }
  if (name !== null && rest.trim() === '') return text();

  const body = stripGrouping(rest);
  const toks = tokenize(body, ctx.vars);
  if (toks === null) return text();
  if (!toks.some((t) => t.t === 'num' || t.t === 'var')) return text();
  const dropped = dropWords(toks);
  if (dropped === null) return text();
  const core = dropped;
  if (core.length === 0) return text();
  const single = core.length === 1 && (core[0]!.t === 'num' || core[0]!.t === 'var');
  // 文章に数が混じるだけ(単位も名前の定義も演算子も無い)は式にしない。数だけの 1 行は計算する
  const onlyNumber = toks.every((t) => t.t !== 'word');
  if (single && !onlyNumber && name === null && !hasUnitWord(toks)) return text();
  try {
    const p = new Parser(core);
    const v = p.expr();
    if (!p.done()) return errorRow(raw, '式が読めません', name);
    if (!Number.isFinite(v.v)) return errorRow(raw, '数になりません', name);
    return makeValue(raw, v.v, v.pct, name, 'value');
  } catch (e) {
    if (e instanceof Bad) return errorRow(raw, e.message, name);
    throw e;
  }
}

function hasUnitWord(toks: readonly Tok[]): boolean {
  return toks.some((t) => t.t === 'word' && UNIT_HINT.test(t.v));
}

/**
 * 合計の行。塊が空で、同じ名前の合計が前に定義済みなら、その値を引く(`税込 = 合計` が 0 にならない)。
 * ⚠ 名前を付けない `合計` は名前を定義しない ── 次の `合計` が変数の参照に化けない。
 */
function sumRow(raw: string, name: string | null, word: string, ctx: Ctx): SheetRow {
  if (ctx.block.length === 0 && ctx.vars.has(word)) {
    const known = ctx.vars.get(word)!;
    return makeValue(raw, known.v, known.pct, name, 'sum');
  }
  const total = ctx.block.reduce((a, b) => a + b, 0);
  return makeValue(raw, total, false, name, 'sum');
}

// ── ノートへ出す ─────────────────────────────────────────────────────

/** 結果を表(Markdown)にする。空行は捨てる。表にできる行が無ければ `null`。 */
export function sheetToMarkdown(rows: readonly SheetRow[]): string | null {
  const body = rows.filter((r) => r.kind !== 'blank');
  if (body.length === 0) return null;
  return tableToMarkdown([
    { cells: ['式', '結果'], head: true },
    ...body.map((r) => ({ cells: [r.text.trim(), r.display], head: false })),
  ]);
}

/** 結果を「式 → 結果」の行にする(空行はそのまま残す)。 */
export function sheetToText(rows: readonly SheetRow[]): string {
  return rows.map((r) => (r.display === '' ? r.text : `${r.text}  → ${r.display}`)).join('\n');
}

/** 新しいノートの題名。⚠ 日時入りで衝突しない。 */
export function sheetNoteTitle(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `計算メモ ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}
