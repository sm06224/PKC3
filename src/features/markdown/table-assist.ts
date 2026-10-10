/**
 * 🔴 **Markdown 表の編集アシスト (Tab / Shift+Tab)** (#1093)。
 *
 * ## user がやりたいこと
 *
 * ノートの編集欄で Markdown の表 (`| 列1 | 列2 |`) を書いているときの
 * Tab キーの挙動をスプレッドシート感覚にします。
 *
 * - セル内で Tab: 次の列のセルへカーソル移動(セルの内容を選択)
 * - セル内で Shift+Tab: 前の列のセルへカーソル移動
 * - 表の最後のセルで Tab: 新しい空行 (`|   |   |`) を自動追加してその 1 列目へ
 * - 表の外(通常の段落やコードブロックなど)では何もしない(通常インデント等に委ねる)
 *
 * 🔑 **pure module**。DOM も textarea も知らず、本文の値と caret / shift だけを見る。
 */

import { lineStart } from './line-start';

export type TableTabAction =
  /** セル間の移動のみ(選択範囲を start〜end に設定) */
  | { readonly kind: 'navigate'; readonly start: number; readonly end: number }
  /** 新しい行を追加してその第1セルへ移動 */
  | {
      readonly kind: 'insert-row';
      readonly insertPos: number;
      readonly text: string;
      readonly start: number;
      readonly end: number;
    };

interface CellRange {
  readonly cellIndex: number;
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly contentStart: number;
  readonly contentEnd: number;
}

interface TableLineInfo {
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly line: string;
  readonly indent: string;
  readonly isDelimiter: boolean;
  readonly cells: readonly CellRange[];
}

/**
 * 行内のエスケープされていないパイプ (`|`) のインデックスを抽出する。
 *
 * 🔴 **画面に描く読み手(markdown-it の `escapedSplit`)と同じ規則**(#1426)──
 *   直前の 1 字が `\` なら区切りではない(本数の偶奇は数えない)。
 *   ⚠ 偶奇で数えていた頃は、`| a\\|b | c |` を画面は 2 列、ここは 3 列と読み、
 *   Tab で移る升がその行だけずれていた。升へ割る側(`table-convert.ts` の `splitRowSpans`)も同じ規則。
 */
function unescapedPipeIndices(line: string): number[] {
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '|' && line[i - 1] !== '\\') pipes.push(i);
  }
  return pipes;
}

/**
 * 行が表の行であるか解析し、セル情報を構築する。表の行でなければ null。
 */
function parseTableLine(value: string, lineStart: number, lineEnd: number): TableLineInfo | null {
  const line = value.slice(lineStart, lineEnd);
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|') || trimmed.length < 2) {
    return null;
  }
  const pipes = unescapedPipeIndices(line);
  if (pipes.length < 2) return null;

  const indentMatch = /^\s*/.exec(line);
  const indent = indentMatch ? indentMatch[0] : '';

  const cells: CellRange[] = [];
  let isDelimiter = true;

  for (let i = 0; i < pipes.length - 1; i += 1) {
    const rawStart = lineStart + pipes[i]! + 1;
    const rawEnd = lineStart + pipes[i + 1]!;
    const rawContent = value.slice(rawStart, rawEnd);
    const trimmedContent = rawContent.trim();

    // 区切り行の判定: 全セルが : と - と空白のみで構成されているか
    if (!/^:?-+:?$/.test(trimmedContent)) {
      isDelimiter = false;
    }

    let contentStart = rawStart;
    let contentEnd = rawEnd;

    if (trimmedContent.length > 0) {
      const leading = rawContent.length - rawContent.trimStart().length;
      const trailing = rawContent.length - rawContent.trimEnd().length;
      contentStart = rawStart + leading;
      contentEnd = rawEnd - trailing;
    } else {
      // 空白のみ、または空の場合
      if (rawContent.length > 0) {
        contentStart = rawStart + 1;
        contentEnd = rawStart + 1;
      }
    }

    cells.push({
      cellIndex: i,
      rawStart,
      rawEnd,
      contentStart,
      contentEnd,
    });
  }

  return {
    lineStart,
    lineEnd,
    line,
    indent,
    isDelimiter,
    cells,
  };
}

function getLineRange(value: string, pos: number): { start: number; end: number } {
  const start = lineStart(value, pos);
  const nl = value.indexOf('\n', pos);
  const end = nl === -1 ? value.length : nl;
  return { start, end };
}

/**
 * 🔴 **caret が表の行の上に在るか**(#1451。編集の帯の「Tab で次のセル」を出す判定)。
 *
 * ⚠ 答えは `tableOnTab` が `null` でない場合と**同じ**(Tab が実際にセルを移す行 = 表の行)。
 *   第二の正本を作らず、行の読み(`parseTableLine`)を共有する。
 *   fence の中でも `tableOnTab` は移すので、ここも除外しない(ヒントは実際の挙動に合わせる)。
 *   半角 `|` だけが区切り(全角 `｜` は表の行ではない ── 読み手も同じ)。
 */
export function caretInTableRow(value: string, caret: number): boolean {
  const { start, end } = getLineRange(value, caret);
  const line = parseTableLine(value, start, end);
  return line !== null && line.cells.length > 0;
}

/**
 * Tab / Shift+Tab が押された時の表の移動・行追加アクションを決定する。
 *
 * @param value 本文全体
 * @param caret 現在のカーソル位置(または選択開始位置)
 * @param shift Shift キーが押されているか
 * @returns 実行すべきアクション、表外なら null
 */
export function tableOnTab(
  value: string,
  caret: number,
  shift: boolean,
): TableTabAction | null {
  const { start: curLineStart, end: curLineEnd } = getLineRange(value, caret);
  const curLine = parseTableLine(value, curLineStart, curLineEnd);
  if (curLine === null || curLine.cells.length === 0) {
    return null;
  }

  // 現在カーソルがどのセルにあるか探す
  let col = -1;
  for (let i = 0; i < curLine.cells.length; i += 1) {
    const c = curLine.cells[i]!;
    if (caret >= c.rawStart - 1 && caret <= c.rawEnd) {
      col = i;
      break;
    }
  }
  if (col === -1) {
    col = caret < curLine.cells[0]!.rawStart ? 0 : curLine.cells.length - 1;
  }

  if (shift) {
    // ── Shift+Tab: 前のセルへ ──────────────────────────────
    if (col > 0) {
      const target = curLine.cells[col - 1]!;
      return { kind: 'navigate', start: target.contentStart, end: target.contentEnd };
    }
    // 行の先頭セル: 前の行へ
    if (curLine.lineStart > 0) {
      const prevRange = getLineRange(value, curLine.lineStart - 1);
      let prevLine = parseTableLine(value, prevRange.start, prevRange.end);
      if (prevLine !== null && prevLine.isDelimiter) {
        // 区切り行ならさらに前の行(ヘッダー行)へ
        if (prevRange.start > 0) {
          const prevPrevRange = getLineRange(value, prevRange.start - 1);
          prevLine = parseTableLine(value, prevPrevRange.start, prevPrevRange.end);
        } else {
          prevLine = null;
        }
      }
      if (prevLine !== null && prevLine.cells.length > 0) {
        const target = prevLine.cells[prevLine.cells.length - 1]!;
        return { kind: 'navigate', start: target.contentStart, end: target.contentEnd };
      }
    }
    // 表の最初より前には行かない(通常のフォーカス移動等に委ねる)
    return null;
  }

  // ── Tab: 次のセルへ / 新しい行の追加 ────────────────────
  if (col < curLine.cells.length - 1) {
    const target = curLine.cells[col + 1]!;
    return { kind: 'navigate', start: target.contentStart, end: target.contentEnd };
  }

  // 行の末尾セル: 次の行へ
  if (curLine.lineEnd < value.length) {
    const nextRange = getLineRange(value, curLine.lineEnd + 1);
    let nextLine = parseTableLine(value, nextRange.start, nextRange.end);
    if (nextLine !== null && nextLine.isDelimiter) {
      // 区切り行ならさらに次の行(第1データ行)へ
      if (nextRange.end < value.length) {
        const nextNextRange = getLineRange(value, nextRange.end + 1);
        nextLine = parseTableLine(value, nextNextRange.start, nextNextRange.end);
      } else {
        nextLine = null;
      }
    }
    if (nextLine !== null && nextLine.cells.length > 0) {
      const target = nextLine.cells[0]!;
      return { kind: 'navigate', start: target.contentStart, end: target.contentEnd };
    }
  }

  // 次の行が表行でない(または文書末尾)── 新しい行を追加する！
  const numCols = curLine.cells.length;
  const cells = Array.from({ length: numCols }, () => ' ').join(' | ');
  const newRow = `${curLine.indent}| ${cells} |`;
  const insertText = `\n${newRow}`;
  const insertPos = curLine.lineEnd;
  // 新しい行の第1セルの空白位置にキャレットを合わせる
  const firstCellOffset = curLine.indent.length + 2; // '| ' の直後
  const newCaret = insertPos + 1 + firstCellOffset;

  return {
    kind: 'insert-row',
    insertPos,
    text: insertText,
    start: newCaret,
    end: newCaret,
  };
}
