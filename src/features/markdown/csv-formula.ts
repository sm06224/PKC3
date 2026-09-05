/**
 * 🔴 **表の升の式**(#418 段②)── `=SUM(A1:A10)` を描くときだけ評価する。
 *
 * > user direction(PKC2 2026-06-02、9 項目一括)の 2 番目:
 * > 「**関数 / cell 参照**(`=A1+B1` / `=SUM(A1:A10)`)」
 *
 * ## 決めたこと(どれも「user の字を勝手に変えない」側)
 *
 * - 🔴 **正本は本文**。⚠ 評価は**描くときだけ**で、結果を本文へ書き戻さない
 *   ── 書き戻すと**式が消える**(次に開いたら直せない)
 * - 🔴 **押すと式が出る**(結果ではない)── 段① の `data-pkc-cell-raw` が原文を持つ
 * - 🔴 **`'` で始めると字のまま**(表計算の共通の作法)── これが無いと
 *   「`=` で始まる字」を書く道が**1 つも無くなる**(動線を減らさない)
 * - ⚠ **循環は黙って 0 にしない** ── `#CYCLE!` を升に出す
 *
 * ## ⚠ PKC2 の実装は持ち込まない(丸写し禁止、user 指示 2026-07-30)
 *
 * PKC2 は `SpreadsheetBody`(JSON)を読む形だった。PKC3 の入力は**csv の升の字**
 * (`string[][]`)である ── founding の「JSON 文字列 body を作らない」に従う。
 * 🔑 揃えたのは**user から見えるもの**だけ:対応関数 10 個と、返すエラーの字。
 */

/** 対応する関数(PKC2 と同じ 10 個から始める)。 */
export const FORMULA_FUNCTIONS = [
  'SUM',
  'AVERAGE',
  'MIN',
  'MAX',
  'COUNT',
  'IF',
  'ABS',
  'ROUND',
  'CONCAT',
  'LEN',
] as const;

/** 升に出すエラー。⚠ **黙って 0 にしない**(何が起きたかを升で読ませる)。 */
export type FormulaError = '#ERR!' | '#REF!' | '#NAME?' | '#DIV/0!' | '#CYCLE!';

/** ⚠ 深さの上限。⚠ 循環は**必ず**ここで止まる(無限ループを作らない)。 */
const MAX_DEPTH = 64;

/** 升の字が式か。⚠ **`'` で始まる字は式ではない**(字のまま出す)。 */
export function isFormula(cell: string): boolean {
  return cell.startsWith('=');
}

/**
 * 升の字を**画面に出す形**にする(式でも `'` 付きでもない字はそのまま)。
 * ⚠ これは**描く側だけ**が使う ── 本文はいつも原文のままである。
 */
export function displayCell(
  cell: string,
  rows: readonly (readonly string[])[],
): FormulaResult {
  if (cell.startsWith("'")) return { text: cell.slice(1) };
  if (!isFormula(cell)) return { text: cell };
  return evaluateFormula(cell, rows);
}

/**
 * 🔴 **字を「字のまま」の升にする**(#708 段②)── {@link displayCell} の逆。
 *
 * ⚠ markdown の表に `=B2*C2` と書いていた人がその表を csv の表に変えると、
 *   その升は**式として評価されて数字になる** ── 打った字が画面から消える。
 * 🔑 逃がし方は表計算と同じ `'` の作法(この file の冒頭の裁定)── `displayCell` が
 *   剥がすので、**画面に出る字は 1 文字も変わらない**。
 * ⚠ `'` で始まる字も逃がす ── 逃がさないと `'abc` が `abc` に見える
 *   (剥がす側は「式ではない字」かどうかを見ていない)。
 */
export function csvLiteralCell(text: string): string {
  return text.startsWith('=') || text.startsWith("'") ? `'${text}` : text;
}

type Value = number | string | boolean;

class Fail extends Error {
  constructor(readonly code: FormulaError, readonly why: string) {
    super(`${code} ${why}`);
  }
}

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; row: number; col: number }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'comma' }
  | { t: 'colon' };

/**
 * `A1` / `AB12` を 0 始まりの (行, 列) にする。⚠ **表の中身の 1 行目が 1 行目**
 * である(見出しの有無で番号が動かない ── 動くと `noheader` を切り替えた瞬間に
 * 全部の式がずれる)。
 */
export function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]+)([0-9]+)$/.exec(ref.toUpperCase());
  if (m === null) return null;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[2]);
  if (row < 1) return null;
  return { row: row - 1, col: col - 1 };
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t') { i += 1; continue; }
    if (ch === '(') { out.push({ t: 'lp' }); i += 1; continue; }
    if (ch === ')') { out.push({ t: 'rp' }); i += 1; continue; }
    if (ch === ',') { out.push({ t: 'comma' }); i += 1; continue; }
    if (ch === ':') { out.push({ t: 'colon' }); i += 1; continue; }
    if (ch === '"') {
      let s = '';
      i += 1;
      while (i < src.length && src[i] !== '"') { s += src[i]; i += 1; }
      if (i >= src.length) throw new Fail('#ERR!', '文字列の `"` が閉じていません');
      i += 1;
      out.push({ t: 'str', v: s });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let s = '';
      while (i < src.length && /[0-9.]/.test(src[i]!)) { s += src[i]; i += 1; }
      const n = Number(s);
      if (!Number.isFinite(n)) throw new Fail('#ERR!', `数として読めません: ${s}`);
      out.push({ t: 'num', v: n });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      /**
       * 🔑 **名前と升の名前は、まとめて 1 つの語として読む**(`A1` を `A` + `1` に
       *   切らない)── 切ると parser の側で組み直すことになり、
       *   **読み手が 2 つ**になる(PKC2 はそうなっていた)。
       */
      let s = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) { s += src[i]; i += 1; }
      const cell = parseCellRef(s);
      if (cell !== null) out.push({ t: 'ref', row: cell.row, col: cell.col });
      else out.push({ t: 'name', v: s.toUpperCase() });
      continue;
    }
    if ('+-*/^'.includes(ch)) { out.push({ t: 'op', v: ch }); i += 1; continue; }
    if (ch === '<' || ch === '>' || ch === '=') {
      const two = src.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '<>') { out.push({ t: 'op', v: two }); i += 2; continue; }
      out.push({ t: 'op', v: ch });
      i += 1;
      continue;
    }
    throw new Fail('#ERR!', `使えない字が入っています: ${ch}`);
  }
  return out;
}

interface Ctx {
  readonly rows: readonly (readonly string[])[];
  /**
   * ⚠ **深さだけで止める**(#418 段②)。
   *
   * 🔴 1 稿目は「いま辿っている升」の集合も持っていたが、**外して実測したら
   *   同じ結果が同じ速さで出た**(`=SUM(A1:B2)` の中で自分を指す形で **2ms**)──
   *   深さ優先なので、breadth が広がる前に深さの上限へ届いて throw が抜ける。
   * 🔑 CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れるのを見る」。
   *   **見たら壊れなかったので外した**(no-op の門を残さない)。
   */
  readonly depth: number;
}

class Parser {
  private pos = 0;
  constructor(private readonly toks: readonly Token[], private readonly ctx: Ctx) {}

  parse(): Value {
    const v = this.expr();
    if (this.pos < this.toks.length) throw new Fail('#ERR!', '式の後ろに余分なものがあります');
    return v;
  }

  private peek(): Token | undefined { return this.toks[this.pos]; }
  private take(): Token { return this.toks[this.pos++]!; }
  private isOp(...ops: string[]): boolean {
    const t = this.peek();
    return t !== undefined && t.t === 'op' && ops.includes(t.v);
  }

  private expr(): Value {
    let left = this.addSub();
    while (this.isOp('<', '>', '=', '<=', '>=', '<>')) {
      const op = (this.take() as { v: string }).v;
      const right = this.addSub();
      left = compare(op, left, right);
    }
    return left;
  }

  private addSub(): Value {
    let left = this.mulDiv();
    while (this.isOp('+', '-')) {
      const op = (this.take() as { v: string }).v;
      const right = this.mulDiv();
      left = op === '+' ? toNum(left) + toNum(right) : toNum(left) - toNum(right);
    }
    return left;
  }

  private mulDiv(): Value {
    let left = this.pow();
    while (this.isOp('*', '/')) {
      const op = (this.take() as { v: string }).v;
      const right = this.pow();
      if (op === '/') {
        const d = toNum(right);
        // ⚠ **0 で割ったことを黙って隠さない**
        if (d === 0) throw new Fail('#DIV/0!', '0 で割っています');
        left = toNum(left) / d;
      } else {
        left = toNum(left) * toNum(right);
      }
    }
    return left;
  }

  private pow(): Value {
    const left = this.unary();
    if (this.isOp('^')) {
      this.take();
      // ⚠ 右結合(`2^3^2` = 512)
      return toNum(left) ** toNum(this.pow());
    }
    return left;
  }

  private unary(): Value {
    if (this.isOp('-')) { this.take(); return -toNum(this.unary()); }
    if (this.isOp('+')) { this.take(); return this.unary(); }
    return this.primary();
  }

  /**
   * 範囲(`A1:B2`)は関数の中でだけ意味を持つので、値の列として返す。
   * 🔴 **範囲から来たかどうかを覚えておく** ── 表計算では
   *   **範囲の中の字は無視**する(`SUM(A1:A9)` に「あ」が混ざっても足せる)が、
   *   **直接書いた字**は誤りである(`SUM(1,"あ")`)。⚠ ここを区別しないと、
   *   どちらかが user を裏切る。
   */
  private rangeOrValue(): Arg {
    const t = this.peek();
    if (t !== undefined && t.t === 'ref' && this.toks[this.pos + 1]?.t === 'colon') {
      this.take();
      this.take();
      const end = this.peek();
      if (end === undefined || end.t !== 'ref') throw new Fail('#REF!', '範囲の終わりがセルの名前ではありません');
      this.take();
      const out: Value[] = [];
      for (let r = Math.min(t.row, end.row); r <= Math.max(t.row, end.row); r += 1) {
        for (let c = Math.min(t.col, end.col); c <= Math.max(t.col, end.col); c += 1) {
          out.push(cellValue(this.ctx, r, c));
        }
      }
      return { values: out, fromRange: true };
    }
    return { values: [this.expr()], fromRange: false };
  }

  private primary(): Value {
    const t = this.peek();
    if (t === undefined) throw new Fail('#ERR!', '式が途中で終わっています');
    if (t.t === 'num') { this.take(); return t.v; }
    if (t.t === 'str') { this.take(); return t.v; }
    if (t.t === 'lp') {
      this.take();
      const v = this.expr();
      if (this.peek()?.t !== 'rp') throw new Fail('#ERR!', '`)` が足りません');
      this.take();
      return v;
    }
    if (t.t === 'ref') { this.take(); return cellValue(this.ctx, t.row, t.col); }
    if (t.t === 'name') {
      this.take();
      if (this.peek()?.t !== 'lp') throw new Fail('#NAME?', `${t.v} は使えません`);
      this.take();
      const args: Arg[] = [];
      if (this.peek()?.t !== 'rp') {
        args.push(this.rangeOrValue());
        while (this.peek()?.t === 'comma') { this.take(); args.push(this.rangeOrValue()); }
      }
      if (this.peek()?.t !== 'rp') throw new Fail('#ERR!', `${t.v} の \`)\` が足りません`);
      this.take();
      return callFn(t.v, args);
    }
    throw new Fail('#ERR!', '式として読めません');
  }
}

function toNum(v: Value): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v.trim() === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Fail('#ERR!', `数として読めません: ${v}`);
  return n;
}

function compare(op: string, a: Value, b: Value): boolean {
  // ⚠ 字どうしは字として、数が混ざれば数として比べる(表計算の作法)
  const both = typeof a === 'string' && typeof b === 'string';
  const x: Value = both ? a : toNum(a);
  const y: Value = both ? b : toNum(b);
  switch (op) {
    case '<': return x < y;
    case '>': return x > y;
    case '<=': return x <= y;
    case '>=': return x >= y;
    case '=': return x === y;
    default: return x !== y;
  }
}

/** 関数の引数 1 つ。⚠ 範囲から来たかを覚えておく(上の `rangeOrValue` の理由)。 */
interface Arg {
  readonly values: readonly Value[];
  readonly fromRange: boolean;
}

function callFn(fn: string, args: readonly Arg[]): Value {
  const flat = args.flatMap((a) => [...a.values]);
  /**
   * 🔴 **数として集めるとき、範囲の中の字は飛ばす**(表計算の作法)。
   * ⚠ **直接書いた字は飛ばさない** ── `SUM(1,"あ")` は誤りである
   *   (飛ばすと、打ち間違いが黙って 0 として足される)。
   */
  const nums = (): number[] =>
    args.flatMap((a) =>
      a.fromRange
        ? a.values.filter(isNumeric).map((v) => toNum(v))
        : [...a.values].map((v) => toNum(v)),
    );
  switch (fn) {
    case 'SUM': return nums().reduce((a, b) => a + b, 0);
    case 'AVERAGE': {
      const n = nums();
      if (n.length === 0) throw new Fail('#DIV/0!', '数が 1 つもありません');
      return n.reduce((a, b) => a + b, 0) / n.length;
    }
    case 'MIN': { const n = nums(); return n.length === 0 ? 0 : Math.min(...n); }
    case 'MAX': { const n = nums(); return n.length === 0 ? 0 : Math.max(...n); }
    // ⚠ COUNT は**数として読めるものだけ**を数える(表計算の作法)
    case 'COUNT': return flat.filter(isNumeric).length;
    case 'IF': {
      if (args.length < 2) throw new Fail('#ERR!', 'IF は「条件, そのとき, そうでないとき」です');
      const cond = args[0]!.values[0];
      const yes = args[1]!.values[0] ?? '';
      const no = args[2]?.values[0] ?? '';
      return truthy(cond) ? yes : no;
    }
    case 'ABS': return Math.abs(toNum(flat[0] ?? 0));
    case 'ROUND': {
      const digits = flat.length > 1 ? Math.trunc(toNum(flat[1]!)) : 0;
      const f = 10 ** digits;
      return Math.round(toNum(flat[0] ?? 0) * f) / f;
    }
    case 'CONCAT': return flat.map((v) => fmt(v)).join('');
    case 'LEN': return fmt(flat[0] ?? '').length;
    default:
      throw new Fail('#NAME?', `${fn} は使えません(使えるのは ${FORMULA_FUNCTIONS.join(' / ')})`);
  }
}

/** 数として読めるか。⚠ 空文字は**数ではない**(0 として数えない)。 */
function isNumeric(v: Value): boolean {
  if (typeof v === 'number') return true;
  if (typeof v === 'boolean') return false;
  return v.trim() !== '' && Number.isFinite(Number(v));
}

function truthy(v: Value | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return v.trim() !== '' && v.toUpperCase() !== 'FALSE';
}

/** 画面に出す形。⚠ **丸めない**(勝手に桁を落とさない)。 */
function fmt(v: Value): string {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Fail('#ERR!', '数になりません');
    // ⚠ 浮動小数の刻みが見えないよう、意味のある桁で丸めてから落とす
    return String(Number(v.toPrecision(12)));
  }
  return v;
}

function cellValue(ctx: Ctx, row: number, col: number): Value {
  const raw = ctx.rows[row]?.[col];
  if (raw === undefined) return '';
  if (raw.startsWith("'")) return raw.slice(1);
  if (!isFormula(raw)) return raw;
  // 🔴 **循環は黙って 0 にしない**(升に `#CYCLE!` を出す)
  if (ctx.depth >= MAX_DEPTH) {
    throw new Fail('#CYCLE!', `セルどうしがぐるぐる参照しているか、${MAX_DEPTH} 段より深く辿っています`);
  }
  return new Parser(tokenize(raw.slice(1)), { rows: ctx.rows, depth: ctx.depth + 1 }).parse();
}

/** 式の答え。⚠ `why` は**誤ったときだけ**入る(画面では升の `title` に出る)。 */
export interface FormulaResult {
  readonly text: string;
  readonly why?: string;
}

/**
 * 式を評価して、**画面に出す字**を返す。⚠ 失敗しても投げない ──
 * 升には `#ERR!` などの字が出る(1 つの升の誤りで表全体が消えない)。
 *
 * 🔴 **理由も返す** ── `#NAME?` の 5 文字だけでは、**どの関数が駄目なのか**が
 *   分からない。⚠ 1 稿目は理由を作っておきながら**捨てて**いた
 *   (誰も読まない値は、そのうち嘘になる)。
 */
export function evaluateFormula(
  formula: string,
  rows: readonly (readonly string[])[],
): FormulaResult {
  try {
    return { text: fmt(new Parser(tokenize(formula.slice(1)), { rows, depth: 0 }).parse()) };
  } catch (e) {
    if (e instanceof Fail) return { text: e.code, why: e.why };
    return { text: '#ERR!', why: '式として読めません' };
  }
}
