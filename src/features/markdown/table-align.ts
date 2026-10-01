/**
 * 🔴 **Markdown の表の列幅を、原文の上で揃える**(#1171)。
 *
 * > 日本語で書いた表は、原文(`| 名前 | 価格 |`)を見たとき `|` が縦に並ばない。
 * > 描画は崩れないが、**原文を読む・直す**ときに列が追えない。
 *
 * ## 何をするか
 * カーソルの在る表 1 つだけを対象に、各升の**字はそのまま**、`|` の間の空白だけを
 * 足して列ごとに同じ幅へ揃える。区切りの行(`|:---:|`)は寄せの印(`:`)を残して
 * 横線を伸ばす。
 *
 * ## 幅の数え方(裁定: Gemini との合意 A。#1171)
 * 東アジアの文字幅(East Asian Width)── 全角・広い字(W / F)は 2、それ以外は 1、
 * 結合文字は 0。⚠ 「曖昧(A)」は 1 と数える(等幅の欄で `α` `→` `①` が
 * 半角で描かれるのが普通なので)。⚠ 揃うのは**全角が半角 2 つ分の字体**で見ているとき
 * だけ ── 比例字体では原文の見た目は揃わない(描画された表は無関係)。
 *
 * 🔑 **升の見つけ方は 1 本を借りる**(CLAUDE.md §7)── 表の範囲は `mdTableAt`、
 *   升の範囲は `mdCellSpan`(どちらも囲みの中を外し、引用の前置きを読み、`\|` を
 *   区切りにしない。markdown-it と突き合わせ済み)。⚠ `table-assist.ts` の
 *   `parseTableLine` は囲みを見ないので使わない。
 *
 * 🔑 **pure module**。browser API を使わない。
 */
import { quotePrefix } from './source-blocks';
import { mdCellSpan, mdTableAt } from './table-convert';

/**
 * 幅 2 の範囲(East Asian Width = W / F の主な所)。
 * ⚠ 完全な表ではない ── 実在する字を網羅する代わりに、**日本語の文書で出会う**
 *   範囲(かな・漢字・全角記号・ハングル・絵文字)を押さえてある。
 */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // ハングル字母
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // 部首・句読点(全角の「、」「。」「「」)
  [0x3041, 0x33ff], // かな・互換漢字・単位記号
  [0x3400, 0x4dbf], // 漢字拡張 A
  [0x4e00, 0xa4cf], // 漢字・彝文字
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3], // ハングル音節
  [0xf900, 0xfaff], // 互換漢字
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff01, 0xff60], // 全角の英数・記号(半角カナ U+FF61〜FF9F は幅 1)
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], // 漢字拡張 B 以降
  [0x30000, 0x3fffd],
];

/** 幅 0 の範囲(結合文字・ゼロ幅・異体字選択子)。 */
const ZERO: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x20d0, 0x20ff],
  [0x2060, 0x2064],
  [0x3099, 0x309a], // かなの結合濁点・半濁点
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
  [0xe0100, 0xe01ef],
];

function inRanges(cp: number, table: ReadonlyArray<readonly [number, number]>): boolean {
  let lo = 0;
  let hi = table.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = table[mid]!;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * 等幅の欄で、その字列が占める幅(半角 = 1、全角 = 2)。
 *
 * ⚠ **コードポイント単位**で数える(`for…of`)── サロゲートペアの絵文字や
 *   𠮷(U+20BB7)を 2 字と数えない。
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x300) {
      w += 1;
      continue;
    }
    if (inRanges(cp, ZERO)) continue;
    w += inRanges(cp, WIDE) ? 2 : 1;
  }
  return w;
}

/** 揃えた結果。`from`〜`to` は**元の本文の**範囲(表の行だけ)、`insert` がその差し替え。 */
export interface AlignDone {
  /** 揃えたあとの本文全体。 */
  readonly text: string;
  /** 揃えたあとのカーソル位置(同じ升の同じ字の手前へ写す)。 */
  readonly caret: number;
  /** 差し替える範囲(元の本文の文字位置。表の最初の行頭 〜 最後の行の行末)。 */
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

/** 揃えなかった理由。`outside` = 表の外 / `already` = もう揃っている。 */
export interface AlignRefused {
  readonly reason: 'outside' | 'already';
}

/** 区切りの行の升の最小幅(`---`)。⚠ 内容が狭くても、これより細い横線にはしない。 */
const MIN_DELIM = 3;

interface Cell {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface Row {
  /** 引用の前置き + 字下げ(行頭から、先頭の `|` の手前まで)。 */
  readonly prefix: string;
  readonly lead: boolean;
  readonly trail: boolean;
  /** 行末の空白(原文のまま返す)。 */
  readonly tailWs: string;
  readonly cells: readonly Cell[];
  readonly line: string;
}

function readRow(line: string): Row {
  const q = quotePrefix(line).length;
  const rest = line.slice(q);
  const indent = rest.length - rest.trimStart().length;
  const prefix = line.slice(0, q + indent);
  const body = rest.trimEnd();
  const tailWs = rest.slice(body.length);
  const cells: Cell[] = [];
  for (let c = 0; ; c += 1) {
    const span = mdCellSpan(line, c);
    if (span === null) break;
    cells.push({ start: span.start, end: span.end, text: line.slice(span.start, span.end) });
  }
  const trimmed = body.trimStart();
  return {
    prefix,
    lead: trimmed.startsWith('|'),
    // ⚠ `\|` は区切りではなく升の字(`mdCellSpan` と同じ規則)
    trail: trimmed.length > 1 && trimmed.endsWith('|') && !trimmed.endsWith('\\|'),
    tailWs,
    cells,
    line,
  };
}

/**
 * カーソルの在る表 1 つの列幅を揃える。
 *
 * @param body  本文(欄の中身そのまま)
 * @param caret カーソルの文字位置(`selectionStart`)
 */
export function alignMdTable(body: string, caret: number): AlignDone | AlignRefused {
  const raw = body.split('\n');
  // ⚠ 行末の `\r` は行の字ではなく改行の一部 ── 外して読み、書き戻すときに付け直す
  const eols = raw.map((l) => (l.endsWith('\r') ? '\r' : ''));
  const lines = raw.map((l, i) => (eols[i] === '\r' ? l.slice(0, -1) : l));
  const starts: number[] = [];
  let acc = 0;
  for (const l of raw) {
    starts.push(acc);
    acc += l.length + 1;
  }
  if (!Number.isInteger(caret) || caret < 0 || caret > body.length) return { reason: 'outside' };
  let caretLine = 0;
  while (caretLine + 1 < starts.length && starts[caretLine + 1]! <= caret) caretLine += 1;

  const at = mdTableAt(body, caretLine);
  if (at === null) return { reason: 'outside' };

  const rows: Row[] = [];
  for (let i = at.start; i <= at.end; i += 1) rows.push(readRow(lines[i]!));
  const delimAt = 1; // ⚠ 表の 2 行目は必ず区切りの行(`mdTableAt` の門)

  // 列ごとの幅(区切りの行は内容として数えない)
  const widths: number[] = [];
  rows.forEach((r, ri) => {
    if (ri === delimAt) return;
    r.cells.forEach((c, ci) => {
      widths[ci] = Math.max(widths[ci] ?? 0, displayWidth(c.text));
    });
  });
  const delimCols = rows[delimAt]!.cells.length;
  for (let ci = 0; ci < delimCols; ci += 1) widths[ci] = Math.max(widths[ci] ?? 0, MIN_DELIM);

  const outLines: string[] = [];
  /** 各行の「升ごとの新しい範囲」── カーソルを写すのに使う。 */
  const newCells: Array<Array<{ start: number; end: number }>> = [];
  rows.forEach((r, ri) => {
    if (r.cells.length === 0) {
      outLines.push(r.line);
      newCells.push([]);
      return;
    }
    let out = r.prefix + (r.lead ? '| ' : '');
    const spans: Array<{ start: number; end: number }> = [];
    r.cells.forEach((c, ci) => {
      const w = widths[ci]!;
      let shown = c.text;
      if (ri === delimAt) {
        const left = c.text.startsWith(':');
        const right = c.text.endsWith(':') && c.text.length > 1;
        shown = (left ? ':' : '') + '-'.repeat(w - (left ? 1 : 0) - (right ? 1 : 0)) + (right ? ':' : '');
      }
      spans.push({ start: out.length, end: out.length + shown.length });
      out += shown;
      const last = ci === r.cells.length - 1;
      if (last && !r.trail) return;
      if (ri !== delimAt) out += ' '.repeat(w - displayWidth(c.text));
      out += last ? ' |' : ' | ';
    });
    // ⚠ 区切りの行を伸ばした升の字は `shown` で組んだので、行末の空白だけ戻す
    out += r.tailWs;
    outLines.push(out);
    newCells.push(spans);
  });

  const parts: string[] = [];
  outLines.forEach((l, k) => {
    const i = at.start + k;
    parts.push(l + (i < at.end ? eols[i]! + '\n' : ''));
  });
  // ⚠ 最後の行の `\r` は範囲の外(= 元のまま残る)ので、ここへは付けない
  const insert = parts.join('');
  const from = starts[at.start]!;
  const to = starts[at.end]! + lines[at.end]!.length;
  const text = body.slice(0, from) + insert + body.slice(to);
  if (text === body) return { reason: 'already' };

  // ── カーソルを同じ升・同じ字へ写す
  const k = caretLine - at.start;
  const col = caret - starts[caretLine]!;
  const old = rows[k]!;
  const fresh = newCells[k]!;
  let newCol: number;
  if (old.cells.length === 0) {
    newCol = Math.min(col, outLines[k]!.length);
  } else {
    // その字を含む升(端も含める)。無ければ直前の升の端 / 先頭の升の手前
    let hit = -1;
    for (let c = 0; c < old.cells.length; c += 1) {
      if (col >= old.cells[c]!.start && col <= old.cells[c]!.end) {
        hit = c;
        break;
      }
    }
    if (hit >= 0) {
      newCol = fresh[hit]!.start + (col - old.cells[hit]!.start);
    } else if (col < old.cells[0]!.start) {
      newCol = Math.min(col, fresh[0]!.start);
    } else {
      // 升と升のあいだ(`␣|␣`)── 近いほうの升の端へ寄せる
      let prev = 0;
      for (let c = 0; c < old.cells.length; c += 1) if (old.cells[c]!.end < col) prev = c;
      const next = prev + 1;
      if (next < old.cells.length && old.cells[next]!.start - col < col - old.cells[prev]!.end) {
        newCol = fresh[next]!.start - (old.cells[next]!.start - col);
      } else {
        newCol = fresh[prev]!.end + (col - old.cells[prev]!.end);
      }
    }
    newCol = Math.max(0, Math.min(newCol, outLines[k]!.length));
  }
  let newCaret = from;
  for (let j = 0; j < k; j += 1) newCaret += outLines[j]!.length + eols[at.start + j]!.length + 1;
  newCaret += newCol;
  return { text, caret: newCaret, from, to, insert };
}
