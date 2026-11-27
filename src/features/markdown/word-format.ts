/**
 * 🔴 **Word のような書式の操作**(v4.0 Phase 1 / PR-04。ビジョン 3-B)── 下線・文字色・段落の揃え・字下げ・改ページ。
 *
 * > 書式の帯から、描き手(`markdown-render.ts`)が前から読める記法へ、Word のように押して入れる口を付ける。
 *
 * ## 使う記法(**新しい綴りを作らない** ── どれも描き手の既存の正式な記法。CLAUDE.md §2-9 / §7)
 *
 * | 操作 | 記法 | 描き手での名前 |
 * |---|---|---|
 * | 下線 | `:字:underline:` | L-6 簡易 inline(`<span style="text-decoration: underline">`) |
 * | 文字色 | `:字:#e03131:` | L-6 簡易 inline(`<span style="color: …">`) |
 * | 段落の揃え | `:::format{align=center}` 〜 `:::` | v4 §12 装飾箱(`data-pkc-align`) |
 * | 字下げ(段落) | `:::format{indent=2}` 〜 `:::` | 同上(`data-pkc-indent`。1〜4) |
 * | 字下げ(リスト) | 行頭の空白 | 既存のリストの字下げ(`indent-assist.ts` の 1 本) |
 * | 改ページ | `+++` の行 | L-1 section break(`.pkc-section-break`) |
 *
 * ## 片道を作らない(すべて画面から戻せる)
 *
 * - 下線はトグル(もう一度押すと外れる)。文字色は「色を解除」で外れ、別の色を選ぶと**色だけ差し替える**(入れ子にしない)。
 *   下線と色は**同じ 1 つの `:字:…:` の中の属性**として持つ ── `:字:underline, #e03131:`。片方を外しても、もう片方は残る。
 * - 揃えは同じ揃えをもう一度選ぶか「揃えを解除」で外れる。字下げは減らして 0 になると外れる。
 *   揃えと字下げは**同じ `:::format{…}` の開きの行に同居**させる(入れ子の枠を増やさない)。属性が空になったら枠ごと剥がす。
 *
 * ⚠ **pure module**(browser API を使わない)。入口は `text-ops.ts` の `applyFormat`(op)と `applyTextColor`(色)。
 */
import {
  isBlockDirectiveClose,
  parseBlockDirectiveOpen,
} from './block-directive-attrs';
import { classifyDirectiveOpen, isSimpleInlineAttrs, isTextColorToken, splitAttrs } from './directive-open';
import { indentLines } from './indent-assist';
import { lineStart } from './line-start';
import { fenceStep, LIST_LEAD, THEMATIC_BREAK } from './list-renumber';
import { frontmatterLineCount } from './frontmatter';
import type { TextSelection } from './text-ops';

/**
 * 🔴 **断った書き換え**(本文は 1 字も変えず、理由を添えて返す)。⚠ 黙って何もしない形にしない ──
 *   帯の受け手(binder の `applyFormatSaying` / `apply-text-color`)が `refusal` を知らせに出す。
 */
export interface RefusedSelection extends TextSelection {
  readonly refusal: string;
}

/** 断った書き換えか(本文は元のまま)。 */
export function refusalOf(sel: TextSelection): string | null {
  return 'refusal' in sel && typeof (sel as RefusedSelection).refusal === 'string' ? (sel as RefusedSelection).refusal : null;
}

function refuse(sel: TextSelection, refusal: string): RefusedSelection {
  return { text: sel.text, start: sel.start, end: sel.end, refusal };
}

/** 囲んだ字を描き手が 1 つの囲みとして読めないとき(中身に `: red` のような「:」+ 書式の語が並ぶ)。 */
export const INLINE_MARK_REFUSAL =
  '選択した文字の中に「:」と色・書式の名前が続く所があるため、文字色・下線を付けられません(その部分を除いて選択してください)';
/** 段落の枠(`:::`)の境目をまたぐ選択。 */
export const BLOCK_CROSS_REFUSAL =
  'ブロック(::: の行)の境目をまたいで選んでいるため、揃え・字下げを付けられません(1 つのブロックの中の段落だけを選んでください)';
/** コードブロックの中。 */
export const IN_CODE_REFUSAL = 'コードブロックの中には、揃え・字下げ・改ページを入れられません';
/** 本文の先頭の情報(`---` 〜 `---`)の中。 */
export const IN_FRONTMATTER_REFUSAL = '本文の先頭の情報(--- の間)の中には、揃え・字下げ・改ページを入れられません';
/** 表の行の中。 */
export const IN_TABLE_REFUSAL = '表の行の中には改ページを入れられません(表の前か後ろの行で押してください)';

// ── 文字色の見本 ──────────────────────────────────────────────

/**
 * 🔴 **文字色の見本**(書式の帯の「文字色 ▾」の一覧。並び順もここが正本)。
 * ⚠ 値は**明るいテーマ・暗いテーマのどちらの地でも読める中間の濃さ**に寄せてある
 *   (白地でも黒に近い地でもコントラストがおおむね 4:1 前後)。黄は白地で読めないので入れない。
 * ⚠ 本文に入るのは `#rrggbb` の字(描き手が `isValidColor` で受ける形)。
 */
export const TEXT_COLORS = [
  { id: 'red', label: '赤', value: '#e03131' },
  { id: 'orange', label: '橙', value: '#d9480f' },
  { id: 'green', label: '緑', value: '#2b8a3e' },
  { id: 'blue', label: '青', value: '#1c7ed6' },
  { id: 'purple', label: '紫', value: '#ae3ec9' },
  { id: 'gray', label: '灰', value: '#6c757d' },
] as const;

export type TextColorId = (typeof TEXT_COLORS)[number]['id'];

/** 見本の id から値(`#rrggbb`)。⚠ 知らない id は `null`。 */
export function textColorValue(id: string): string | null {
  return TEXT_COLORS.find((c) => c.id === id)?.value ?? null;
}

// ── `:字:属性:`(L-6)を読む ───────────────────────────────────

/** 本文の中の 1 つの `:字:属性:`。位置はすべて本文の先頭からの字数。 */
export interface InlineMark {
  /** 開きの `:` の位置。 */
  readonly start: number;
  readonly contentStart: number;
  /** 中身の終わり(= 属性の前の `:` の位置)。 */
  readonly contentEnd: number;
  /** 閉じの `:` の次。 */
  readonly end: number;
  /** 属性の語(`underline` / `#e03131` / `bold` …)。 */
  readonly tokens: readonly string[];
}

/**
 * 🔴 **1 行の中の `:字:属性:` を左から拾う**(描き手の `findSimpleInline` と同じ読み方)。
 * - `:` ごとに、次の `:属性:` の境界を探す(属性は `isSimpleInlineAttrs` ── 描き手と同じ 1 本)。
 * - 中身が空の境界は飛ばして次を探す(描き手と同じ)。当たったら閉じの次から読み直す。
 * - ⚠ 行内のコード(`` `…` ``)の中は読まない(描き手もコードを先に切る)。
 */
export function inlineMarksIn(text: string, from: number, to: number): InlineMark[] {
  const out: InlineMark[] = [];
  let i = from;
  while (i < to) {
    const ch = text[i];
    if (ch === '`') {
      let n = 0;
      while (i + n < to && text[i + n] === '`') n += 1;
      const run = '`'.repeat(n);
      const close = text.indexOf(run, i + n);
      i = close === -1 || close >= to ? i + n : close + n;
      continue;
    }
    if (ch !== ':') {
      i += 1;
      continue;
    }
    let hit: InlineMark | null = null;
    for (let j = i + 1; j < to; j += 1) {
      if (text[j] !== ':') continue;
      const close = text.indexOf(':', j + 1);
      if (close === -1 || close >= to) break;
      const attrs = text.slice(j + 1, close);
      if (!isSimpleInlineAttrs(attrs)) continue;
      if (j === i + 1) continue; // 中身が空 ── 次の境界を探す(描き手と同じ)
      hit = { start: i, contentStart: i + 1, contentEnd: j, end: close + 1, tokens: splitAttrs(attrs) };
      break;
    }
    if (hit === null) {
      i += 1;
      continue;
    }
    out.push(hit);
    i = hit.end;
  }
  return out;
}

/** 行頭の印(引用・見出し・リスト・チェック)。囲みはこの後ろから付ける(`toggleWrap` と同じ形)。 */
const LINE_HEAD = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;

/** 下線・色のどちらを変えるか。 */
type InlineEdit = { readonly kind: 'underline' } | { readonly kind: 'color'; readonly color: string | null };

function editTokens(tokens: readonly string[], edit: InlineEdit, wantUnderline: boolean): string[] {
  if (edit.kind === 'underline') {
    const rest = tokens.filter((t) => t !== 'underline');
    return wantUnderline ? [...rest, 'underline'] : rest;
  }
  const rest = tokens.filter((t) => !isTextColorToken(t));
  return edit.color === null ? rest : [...rest, edit.color];
}

function markText(content: string, tokens: readonly string[]): string {
  return tokens.length === 0 ? content : `:${content}:${tokens.join(', ')}:`;
}

/** 選んだ範囲の、行ごとの区間(行頭の印と前後の空白を除く)。⚠ 表の行を含むなら `null`(表を壊さない)。 */
function lineSegments(text: string, start: number, end: number): { start: number; end: number; lineFrom: number; lineTo: number }[] | null {
  const out: { start: number; end: number; lineFrom: number; lineTo: number }[] = [];
  let at = lineStart(text, start);
  while (at <= end && at <= text.length) {
    const nl = text.indexOf('\n', at);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(at, lineEnd);
    let s0 = Math.max(at, start);
    const e0 = Math.min(lineEnd, end);
    if (s0 < e0) {
      const bar = line.search(/\S/);
      if (bar !== -1 && line[bar] === '|' && s0 <= at + bar) return null;
      s0 = Math.max(s0, at + LINE_HEAD.exec(line)![0].length);
      let s1 = s0;
      let e1 = e0;
      while (s1 < e1 && /[ \t\u3000\r]/u.test(text[s1]!)) s1 += 1;
      while (e1 > s1 && /[ \t\u3000\r]/u.test(text[e1 - 1]!)) e1 -= 1;
      if (s1 < e1) out.push({ start: s1, end: e1, lineFrom: at, lineTo: lineEnd });
    }
    if (nl === -1) break;
    at = nl + 1;
  }
  return out;
}

/** 区間をすっぽり包む `:字:属性:`(印ごと選んでいても、中身の一部でもよい)。 */
function enclosingMark(marks: readonly InlineMark[], start: number, end: number): InlineMark | null {
  return marks.find((m) => m.start <= start && end <= m.end && !(start === end && (start === m.start || start === m.end))) ?? null;
}

/**
 * 1 区間を書き換える。@returns 置き換える範囲・字・新しい中身の位置(置き換えの先頭からの字数)。変えないなら `null`。
 * 🔑 入れ子にしない:
 *   - 区間を包む `:字:属性:` が在れば、その属性だけを書き換える
 *   - 区間に一部だけ掛かる `:字:属性:` は区間を広げて丸ごと含める
 *   - 区間の中の `:字:属性:` は外して 1 つに畳む(属性は寄せ集める)
 */
function editSegment(
  text: string,
  seg: { start: number; end: number },
  marks: readonly InlineMark[],
  edit: InlineEdit,
  wantUnderline: boolean,
): { from: number; to: number; insert: string; contentAt: number; contentLen: number } | null {
  const enc = enclosingMark(marks, seg.start, seg.end);
  if (enc !== null) {
    const content = text.slice(enc.contentStart, enc.contentEnd);
    const tokens = editTokens(enc.tokens, edit, wantUnderline);
    const insert = markText(content, tokens);
    return { from: enc.start, to: enc.end, insert, contentAt: tokens.length === 0 ? 0 : 1, contentLen: content.length };
  }
  let s = seg.start;
  let e = seg.end;
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of marks) {
      if (m.start < e && m.end > s && (m.start < s || m.end > e)) {
        s = Math.min(s, m.start);
        e = Math.max(e, m.end);
        changed = true;
      }
    }
  }
  const inner = marks.filter((m) => m.start >= s && m.end <= e);
  if (edit.kind === 'color' && edit.color === null && inner.length === 0) return null;
  let content = '';
  let at = s;
  const base: string[] = [];
  for (const m of inner) {
    content += text.slice(at, m.start) + text.slice(m.contentStart, m.contentEnd);
    for (const t of m.tokens) if (!base.includes(t)) base.push(t);
    at = m.end;
  }
  content += text.slice(at, e);
  const tokens = editTokens(base, edit, wantUnderline);
  const insert = markText(content, tokens);
  return { from: s, to: e, insert, contentAt: tokens.length === 0 ? 0 : 1, contentLen: content.length };
}

function applyInline(sel: TextSelection, edit: InlineEdit): TextSelection {
  const { text } = sel;
  const lineFrom = lineStart(text, sel.start);
  const nl = text.indexOf('\n', sel.start);
  const lineTo = nl === -1 ? text.length : nl;
  if (sel.start === sel.end) {
    // 🔑 カーソルだけ: 包む `:字:属性:` があればその属性を変える。無ければ空の囲みを入れて間にカーソルを置く
    const marks = inlineMarksIn(text, lineFrom, lineTo);
    const enc = marks.find((m) => m.contentStart <= sel.start && sel.start <= m.contentEnd) ?? null;
    if (enc !== null) {
      const want = edit.kind === 'underline' ? !enc.tokens.includes('underline') : false;
      const r = editSegment(text, { start: enc.contentStart, end: enc.contentEnd }, marks, edit, want)!;
      const next = text.slice(0, r.from) + r.insert + text.slice(r.to);
      if (!markReadsBack(next, r.from, r.insert, r.contentAt, r.contentLen)) return refuse(sel, INLINE_MARK_REFUSAL);
      const caret = r.from + r.contentAt + (sel.start - enc.contentStart);
      return { text: next, start: caret, end: caret };
    }
    if (edit.kind === 'color' && edit.color === null) return sel;
    const tokens = editTokens([], edit, true);
    const insert = `::${tokens.join(', ')}:`;
    const next = text.slice(0, sel.start) + insert + text.slice(sel.end);
    return { text: next, start: sel.start + 1, end: sel.start + 1 };
  }
  const segs = lineSegments(text, sel.start, sel.end);
  if (segs === null || segs.length === 0) return sel;
  const marksByLine = new Map<number, InlineMark[]>();
  const marksOf = (sg: { lineFrom: number; lineTo: number }): InlineMark[] => {
    let m = marksByLine.get(sg.lineFrom);
    if (m === undefined) {
      m = inlineMarksIn(text, sg.lineFrom, sg.lineTo);
      marksByLine.set(sg.lineFrom, m);
    }
    return m;
  };
  // 🔑 下線は「全部の区間がもう下線なら外す、そうでなければ揃えて付ける」(`toggleWrap` と同じトグルの対称)
  const wantUnderline =
    edit.kind === 'underline' &&
    !segs.every((sg) => enclosingMark(marksOf(sg), sg.start, sg.end)?.tokens.includes('underline') === true);
  const edits = segs.map((sg) => editSegment(text, sg, marksOf(sg), edit, wantUnderline));
  if (edits.every((e) => e === null)) return sel;
  let out = text;
  let firstStart = -1;
  let lastEnd = -1;
  // 後ろの区間から書き換える(前の位置がずれない)。選択は「最初の中身の頭 〜 最後の中身の終わり」
  let shiftAfter = 0;
  const applied: { from: number; insert: string; contentAt: number; contentLen: number; delta: number }[] = [];
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const r = edits[i];
    if (r === null || r === undefined) continue;
    out = out.slice(0, r.from) + r.insert + out.slice(r.to);
    applied.unshift({ from: r.from, insert: r.insert, contentAt: r.contentAt, contentLen: r.contentLen, delta: r.insert.length - (r.to - r.from) });
  }
  for (const a of applied) {
    const at = a.from + shiftAfter;
    // 🔴 描き手が同じ 1 つの囲みとして読み戻せるか(中身の `: red` などで境目がずれるなら断る)
    if (!markReadsBack(out, at, a.insert, a.contentAt, a.contentLen)) return refuse(sel, INLINE_MARK_REFUSAL);
    if (firstStart === -1) firstStart = at + a.contentAt;
    lastEnd = at + a.contentAt + a.contentLen;
    shiftAfter += a.delta;
  }
  return { text: out, start: firstStart, end: lastEnd };
}

/**
 * 🔴 **書いた囲みを、描き手と同じ読み方で読み戻せるか**(着地前レビュー)。
 * ⚠ 描き手は先頭の `:` から**最初の**有効な `:属性:` を境目にする ── 中身に `Note: red` のような
 *   「`:` + 書式の語」が在ると、そこで切れて残りが字のまま出る。帯の再読(`inlineMarksIn`)も同じ誤読をする。
 *   行ぜんたいを読み直し、書いた位置にちょうど 1 つの囲みが在ることを確かめる(前の行の字に食われる形も拾う)。
 */
function markReadsBack(text: string, at: number, insert: string, contentAt: number, contentLen: number): boolean {
  if (contentAt === 0 || contentLen === 0) return true; // 囲みを剥がした / 中身が空(まだ打っていない)
  const from = lineStart(text, at);
  const nl = text.indexOf('\n', at);
  const to = nl === -1 ? text.length : nl;
  return inlineMarksIn(text, from, to).some(
    (m) => m.start === at && m.end === at + insert.length && m.contentEnd - m.contentStart === contentLen,
  );
}

/** 🔴 **下線**(トグル)。`:字:underline:` ── 既に色の付いた `:字:#…:` の中なら、属性に足す / 外す。 */
export function toggleUnderline(sel: TextSelection): TextSelection {
  return applyInline(sel, { kind: 'underline' });
}

/**
 * 🔴 **文字色**(`color` = `#rrggbb` / `null` = 色を解除)。
 * 既に `:字:色:` で囲まれていれば**色だけ差し替える**(入れ子にしない)。解除は色の属性だけを外し、残りが無ければ囲みごと剥がす。
 */
export function applyTextColor(sel: TextSelection, color: string | null): TextSelection {
  return applyInline(sel, { kind: 'color', color });
}

// ── 段落の揃え・字下げ(`:::format{…}`) ─────────────────────────

export type ParagraphAlign = 'left' | 'center' | 'right';

/** 段落の字下げの上限(描き手の CSS が 1〜4 段を持つ ── `app.css` の `.pkc-format-block[data-pkc-indent]`)。 */
export const PARAGRAPH_INDENT_MAX = 4;

interface Lines {
  readonly lines: string[];
  readonly starts: number[];
}

function splitWithStarts(text: string): Lines {
  const lines = text.split('\n');
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  return { lines, starts };
}

function lineIndexAt(ls: Lines, pos: number): number {
  let i = ls.starts.length - 1;
  while (i > 0 && ls.starts[i]! > pos) i -= 1;
  return i;
}

/** 選んだ範囲が触れている行(終わりが行頭なら、その行は含めない ── `lineRange` と同じ)。 */
function selectedLines(ls: Lines, sel: TextSelection): [number, number] {
  const first = lineIndexAt(ls, sel.start);
  const lastPos = sel.end > sel.start && sel.text[sel.end - 1] === '\n' ? sel.end - 1 : sel.end;
  return [first, Math.max(first, lineIndexAt(ls, lastPos))];
}

const FORMAT_OPEN = /^:::format(?:\{([^}]*)\})?\s*$/;

/**
 * 🔴 **`:::format` の枠の対(開きの行・閉じの行)を全部拾う**。
 * ⚠ 入れ子の深さは `:::` の開き全種で数える(他人の閉じを自分の閉じとして食わない ── 描き手の `scanContainerDirective` と同じ)。
 * ⚠ コードブロックの中の `:::` は数えない。閉じの無い枠は拾わない(どこまでが中身か決まらない)。
 */
function formatPairs(ls: Lines): { open: number; close: number }[] {
  const out: { open: number; close: number }[] = [];
  const stack: { line: number; format: boolean }[] = [];
  let fence = '';
  for (let i = 0; i < ls.lines.length; i += 1) {
    const line = ls.lines[i]!;
    const st = fenceStep(fence, line);
    fence = st.next;
    if (st.inside) continue;
    if (isBlockDirectiveClose(line)) {
      const top = stack.pop();
      if (top !== undefined && top.format) out.push({ open: top.line, close: i });
      continue;
    }
    const kind = classifyDirectiveOpen(line);
    if (kind === 'container') {
      stack.push({ line: i, format: parseBlockDirectiveOpen(line)?.name === 'format' && FORMAT_OPEN.test(line) });
    } else if (kind === 'self-contained' && i + 1 < ls.lines.length && isBlockDirectiveClose(ls.lines[i + 1]!)) {
      i += 1;
    }
  }
  return out;
}

/** 選んだ行をすっぽり包む、いちばん内側の `:::format` の枠。 */
function enclosingFormat(ls: Lines, first: number, last: number): { open: number; close: number } | null {
  let best: { open: number; close: number } | null = null;
  for (const p of formatPairs(ls)) {
    if (p.open <= first && last <= p.close && (best === null || p.open > best.open)) best = p;
  }
  return best;
}

/** `{…}` の中を語に分ける(引用符の中の空白は切らない)。 */
function attrTokens(inner: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: string | null = null;
  for (const c of inner) {
    if (quote !== null) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (buf !== '') out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf !== '') out.push(buf);
  return out;
}

function getKv(tokens: readonly string[], key: string): string | null {
  const t = tokens.find((x) => x.startsWith(`${key}=`));
  return t === undefined ? null : t.slice(key.length + 1).replace(/^["']|["']$/g, '');
}

function setKv(tokens: readonly string[], key: string, value: string | null): string[] {
  const at = tokens.findIndex((x) => x.startsWith(`${key}=`));
  if (value === null) return tokens.filter((x) => !x.startsWith(`${key}=`));
  if (at === -1) return [...tokens, `${key}=${value}`];
  return tokens.map((x, i) => (i === at ? `${key}=${value}` : x));
}

/** 位置の写し(行の差し替えで本文がずれる分を、選択へ当てる)。 */
function shiftPos(pos: number, at: number, delta: number, removedFrom = at, removedTo = at): number {
  if (pos < removedFrom) return pos;
  if (pos < removedTo) return removedFrom;
  return pos + delta;
}

/**
 * 枠の開きの行の属性を書き換える。属性が空になったら**枠ごと剥がす**(開きの行と閉じの行を消す)。
 */
function rewriteFormat(sel: TextSelection, ls: Lines, pair: { open: number; close: number }, tokens: readonly string[]): TextSelection {
  const { text } = sel;
  if (tokens.length === 0) {
    // 閉じの行(改行ごと)を先に消し、次に開きの行(改行ごと)を消す
    const closeFrom = ls.starts[pair.close]!;
    const closeHasNext = pair.close + 1 < ls.lines.length;
    const cFrom = closeHasNext ? closeFrom : Math.max(0, closeFrom - 1);
    const cTo = closeHasNext ? ls.starts[pair.close + 1]! : text.length;
    let out = text.slice(0, cFrom) + text.slice(cTo);
    const oFrom = ls.starts[pair.open]!;
    const oTo = ls.starts[pair.open + 1]!;
    out = out.slice(0, oFrom) + out.slice(oTo);
    const map = (p: number): number => {
      const afterClose = shiftPos(p, cFrom, -(cTo - cFrom), cFrom, cTo);
      return shiftPos(afterClose, oFrom, -(oTo - oFrom), oFrom, oTo);
    };
    return { text: out, start: map(sel.start), end: map(sel.end) };
  }
  const openLine = `:::format{${tokens.join(' ')}}`;
  const from = ls.starts[pair.open]!;
  const to = from + ls.lines[pair.open]!.length;
  const delta = openLine.length - (to - from);
  const out = text.slice(0, from) + openLine + text.slice(to);
  const map = (p: number): number => (p <= from ? p : p < to ? Math.min(p, from + openLine.length) : p + delta);
  return { text: out, start: map(sel.start), end: map(sel.end) };
}

/** 各行の前の時点で、コードブロックの中か(`fenceStep` ── 記号の種類と長さを見る正本)。 */
function fenceInsideBefore(ls: Lines): boolean[] {
  const out: boolean[] = [];
  let fence = '';
  for (const line of ls.lines) {
    out.push(fence !== '');
    fence = fenceStep(fence, line).next;
  }
  out.push(fence !== '');
  return out;
}

/**
 * 🔴 **段落を囲む / 改ページを入れる前の構造の検査**(着地前レビュー)。断るなら理由、入れてよいなら `null`。
 * - 本文の先頭の情報(`---` 〜 `---`)の中 ── 前に `:::format` を入れると先頭の情報として読まれなくなる
 * - コードブロックの中 ── 字としてコードに混ざる(空行を挟んだコードの 2 つ目の塊も、ここで拾う)
 * - 囲む範囲に `:::` の行が在る ── 枠の境目をまたぐと、閉じの `:::` が別の枠を閉じて無関係な段落の配置が変わる
 */
function structureRefusal(ls: Lines, from: number, to: number, crossCheck: boolean): string | null {
  const fm = frontmatterLineCount(ls.lines.join('\n'));
  if (fm > 0 && from < fm) return IN_FRONTMATTER_REFUSAL;
  const inside = fenceInsideBefore(ls);
  if (inside[from] === true || inside[to + 1] === true) return IN_CODE_REFUSAL;
  if (crossCheck && ls.lines.slice(from, to + 1).some((l) => /^\s*:::/.test(l))) return BLOCK_CROSS_REFUSAL;
  return null;
}

/** 段落の境(空行・`:::` の行・見出し)。 */
function isParagraphBoundary(line: string): boolean {
  return line.trim() === '' || /^\s*:::/.test(line) || /^#{1,6}[ \t]/.test(line);
}

/**
 * 選んだ行を含む段落を `:::format{…}` で囲む。⚠ カーソルが空行に居るときは、空の枠を入れて中にカーソルを置く。
 */
function wrapParagraph(sel: TextSelection, ls: Lines, first: number, last: number, tokens: readonly string[]): TextSelection {
  const { text } = sel;
  const openLine = `:::format{${tokens.join(' ')}}`;
  const blank = ls.lines.slice(first, last + 1).every((l) => l.trim() === '');
  if (blank) {
    const why = structureRefusal(ls, first, last, false);
    if (why !== null) return refuse(sel, why);
    const from = ls.starts[first]!;
    const to = from + ls.lines[first]!.length;
    const insert = `${openLine}\n\n:::`;
    const out = text.slice(0, from) + insert + text.slice(to);
    const caret = from + openLine.length + 1;
    return { text: out, start: caret, end: caret };
  }
  let a = first;
  let b = last;
  // ⚠ 先頭の情報(--- の間)は段落ではない ── その直後の行から上へは広げない
  const fmEnd = frontmatterLineCount(sel.text);
  while (a > fmEnd && !/^#{1,6}[ \t]/.test(ls.lines[a]!) && !isParagraphBoundary(ls.lines[a - 1]!)) a -= 1;
  while (b + 1 < ls.lines.length && !/^#{1,6}[ \t]/.test(ls.lines[b]!) && !isParagraphBoundary(ls.lines[b + 1]!)) b += 1;
  const why = structureRefusal(ls, a, b, true);
  if (why !== null) return refuse(sel, why);
  const from = ls.starts[a]!;
  const to = ls.starts[b]! + ls.lines[b]!.length;
  const out = `${text.slice(0, from)}${openLine}\n${text.slice(from, to)}\n:::${text.slice(to)}`;
  const shift = openLine.length + 1;
  const map = (p: number): number => (p < from ? p : p + shift);
  return { text: out, start: map(sel.start), end: map(sel.end) };
}

/**
 * 🔴 **段落の揃え**(`align` = 左 / 中央 / 右、`null` = 揃えを解除)。
 * - 段落が既に `:::format{…}` の中なら、その開きの行の `align=` だけを書き換える(入れ子にしない)。
 * - 同じ揃えをもう一度選ぶか、`null` なら `align=` を外す。ほかの属性が無ければ枠ごと剥がす(片道にしない)。
 * - 枠が無ければ段落を `:::format{align=…}` で囲む(`null` なら何もしない)。
 */
export function applyParagraphAlign(sel: TextSelection, align: ParagraphAlign | null): TextSelection {
  const ls = splitWithStarts(sel.text);
  const [first, last] = selectedLines(ls, sel);
  const pair = enclosingFormat(ls, first, last);
  if (pair !== null) {
    const tokens = attrTokens(FORMAT_OPEN.exec(ls.lines[pair.open]!)![1] ?? '');
    const cur = getKv(tokens, 'align');
    const next = align === null || align === cur ? setKv(tokens, 'align', null) : setKv(tokens, 'align', align);
    return rewriteFormat(sel, ls, pair, next);
  }
  if (align === null) return sel;
  return wrapParagraph(sel, ls, first, last, [`align=${align}`]);
}

/** リストの行か(箇条書き・番号・チェック。区切り線 `---` は含めない)。 */
function isListLine(line: string): boolean {
  return LIST_LEAD.test(line) && !THEMATIC_BREAK.test(line);
}

/**
 * 🔴 **字下げを増やす / 減らす**(`dir` = 1 / -1)。
 * - 選んだ行が**全部リストの行**なら、行頭の空白で 1 段ずつ(既存のリストの字下げ `indentLines` の 1 本)。
 * - それ以外の段落は `:::format{indent=1..4}` の段を増減する。既に枠の中なら同じ開きの行の `indent=` を書き換え、
 *   0 になったら `indent=` を外す(ほかの属性が無ければ枠ごと剥がす)。上限は {@link PARAGRAPH_INDENT_MAX}。
 */
export function changeParagraphIndent(sel: TextSelection, dir: 1 | -1): TextSelection {
  const ls = splitWithStarts(sel.text);
  const [first, last] = selectedLines(ls, sel);
  const body = ls.lines.slice(first, last + 1).filter((l) => l.trim() !== '');
  if (body.length > 0 && body.every(isListLine)) {
    const r = indentLines(sel, dir, { explicit: true });
    return r === null ? sel : { text: r.text, start: r.start, end: r.end };
  }
  const pair = enclosingFormat(ls, first, last);
  if (pair !== null) {
    const tokens = attrTokens(FORMAT_OPEN.exec(ls.lines[pair.open]!)![1] ?? '');
    const cur = Math.max(0, Math.min(PARAGRAPH_INDENT_MAX, Number.parseInt(getKv(tokens, 'indent') ?? '0', 10) || 0));
    const n = Math.max(0, Math.min(PARAGRAPH_INDENT_MAX, cur + dir));
    if (n === cur) return sel;
    return rewriteFormat(sel, ls, pair, setKv(tokens, 'indent', n === 0 ? null : String(n)));
  }
  if (dir === -1) return sel;
  return wrapParagraph(sel, ls, first, last, ['indent=1']);
}

// ── 改ページ ─────────────────────────────────────────────────

/** 改ページの行(描き手の L-1 section break)。 */
export const PAGE_BREAK_LINE = '+++';

/**
 * 🔴 **改ページを入れる**(`+++` を独り立ちの行として、前後に空行を整えて入れる)。
 * ⚠ 選んでいる字は消さない(選んだ範囲の頭に入れる)。カーソルは改ページの次の行の頭へ置く(続けて打てる)。
 */
export function insertPageBreak(sel: TextSelection): TextSelection {
  const { text } = sel;
  const at = Math.min(sel.start, sel.end);
  // 🔴 先頭の情報・コードブロック・表の行の中には入れない(着地前レビュー)
  const ls = splitWithStarts(text);
  const li = lineIndexAt(ls, at);
  const why = structureRefusal(ls, li, li, false);
  if (why !== null) return refuse(sel, why);
  const lineHere = ls.lines[li]!;
  const col = at - ls.starts[li]!;
  if (/^\s*\|/.test(lineHere) && col > lineHere.search(/\S|$/) && col < lineHere.length) return refuse(sel, IN_TABLE_REFUSAL);
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const tail = after === '' ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const insert = `${lead}${PAGE_BREAK_LINE}${tail}`;
  const caret = at + insert.length + (after.startsWith('\n\n') ? 2 : after.startsWith('\n') ? 1 : 0);
  return { text: before + insert + after, start: Math.min(caret, before.length + insert.length + after.length), end: Math.min(caret, before.length + insert.length + after.length) };
}
