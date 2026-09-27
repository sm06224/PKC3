/**
 * 🔴 チェックリスト（Todo）の完了項目整理 (#1108)。
 *
 * ## user がやりたいこと
 *
 * 日常の作業ログやタスク管理ノートでチェックリスト（`- [ ]`, `- [x]`）を
 * 運用していると、完了したタスクがリストの各所に散らばり、
 * 「いま何が残っているか（未完了タスク）」が一目で把握しづらくなる。
 *
 * ワンアクションで「完了済みの項目（`- [x]`）」をリストの末尾へ集約し、
 * 未完了タスクがリストの前方にまとまるように整列する。
 *
 * ## 規律
 *
 * 1. 🔑 **pure module**: DOM やエディタを知らない。
 * 2. 🔑 **安定ソート (stable sort)**:
 *    - 未完了タスクどうし、完了タスクどうしの相対順序は崩さない。
 * 3. 🔑 **子階層（インデント行）の連動**:
 *    - タスクの配下にぶら下がるインデントされた子タスクや説明行は、
 *      親タスクと一緒に移動する。子リスト内でも同様に完了項目が下へ整理される。
 * 4. 🔑 **fence の中は触らない**:
 *    - ``` や ~~~ の中のテキストは 1 バイトも触らない。
 * 5. 🔑 **変化がなければ完全同一の参照/文字列を返す**:
 *    - 整理の必要がない場合は、呼び出し側が無反応にならず
 *      「完了項目は既に末尾に揃っています」と通知できるようにする。
 */

/**
 * リストマーカーのパターン（箇条書き記号または番号付きリスト）。
 */
const LIST_MARKER = /^(\s*)(?:[-*+]|\d+[.)])\s+/;

/**
 * タスク項目の開始行パターン。
 * [ xX] の中身で完了/未完了を判定する。
 */
const TASK_MARKER = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\](?:\s+.*|$)/;

/**
 * コードブロック（fence）の開始/終了。字下げ 3 文字以内の ``` または ~~~。
 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * 1 つのリスト項目とその配下行。
 */
interface ItemChunk {
  readonly indentLen: number;
  readonly isDone: boolean;
  readonly lines: string[];
}

/**
 * 与えられた文字列の先頭の空白の長さ（タブは 2 文字相当で換算）。
 */
function leadingIndentWidth(s: string): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === ' ') w += 1;
    else if (ch === '\t') w += 2;
    else break;
  }
  return w;
}

/**
 * 連続するリストブロックの行群を受け取り、完了項目を末尾に寄せた行群を返す。
 * 子リストが含まれる場合は再帰的にソートする。
 */
function sortListBlockLines(lines: readonly string[]): string[] {
  if (lines.length === 0) return [];

  // このブロック内で最も浅いリスト項目のインデント幅を探す
  let minIndent = Infinity;
  for (const line of lines) {
    if (LIST_MARKER.test(line)) {
      const w = leadingIndentWidth(line);
      if (w < minIndent) minIndent = w;
    }
  }

  if (minIndent === Infinity) {
    // リスト項目が 1 つも無ければそのまま返す
    return [...lines];
  }

  // minIndent を持つリスト項目ごとにチャンクを分割
  const chunks: ItemChunk[] = [];
  let currentChunk: ItemChunk | null = null;
  const prefixLines: string[] = []; // 最初のリスト項目より前にある行（通常は無いはずだが安全策）

  for (const line of lines) {
    const isItemHeader = LIST_MARKER.test(line) && leadingIndentWidth(line) === minIndent;
    if (isItemHeader) {
      if (currentChunk !== null) {
        chunks.push(currentChunk);
      }
      const taskMatch = TASK_MARKER.exec(line);
      const isDone = taskMatch !== null && (taskMatch[2] === 'x' || taskMatch[2] === 'X');
      currentChunk = {
        indentLen: minIndent,
        isDone,
        lines: [line],
      };
    } else {
      if (currentChunk !== null) {
        currentChunk.lines.push(line);
      } else {
        prefixLines.push(line);
      }
    }
  }

  if (currentChunk !== null) {
    chunks.push(currentChunk);
  }

  if (chunks.length === 0) {
    return [...lines];
  }

  // 各チャンク配下の子行について、子リストがあれば再帰的にソート
  for (const chunk of chunks) {
    if (chunk.lines.length > 1) {
      const header = chunk.lines[0]!;
      const subLines = chunk.lines.slice(1);
      const sortedSubLines = sortListBlockLines(subLines);
      chunk.lines.length = 0;
      chunk.lines.push(header, ...sortedSubLines);
    }
  }

  // チャンク群を 未完了/通常項目 -> 完了項目 の順に安定ソート
  const uncompleted = chunks.filter((c) => !c.isDone);
  const completed = chunks.filter((c) => c.isDone);
  const sortedChunks = [...uncompleted, ...completed];

  const resultLines: string[] = [...prefixLines];
  for (const chunk of sortedChunks) {
    resultLines.push(...chunk.lines);
  }

  return resultLines;
}

/**
 * 本文（Markdown）内のチェックリストを走査し、
 * 各リストブロックごとに完了したタスク項目（`- [x]`）を末尾に寄せて返す。
 *
 * @param body 対象の Markdown 本文
 * @returns 整理後の Markdown 本文。変更がなければ元の文字列をそのまま返す
 */
export function sortTasksByStatus(body: string): string {
  if (body === '' || !body.includes('[')) {
    return body;
  }

  const lines = body.split('\n');
  const out: string[] = [];

  let fence: { readonly ch: string; readonly len: number } | null = null;
  let currentListBlock: string[] = [];

  const flushListBlock = (): void => {
    if (currentListBlock.length === 0) return;
    const sorted = sortListBlockLines(currentListBlock);
    out.push(...sorted);
    currentListBlock = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // 1. コードブロック (fence) の判定
    const f = FENCE.exec(line);
    if (f !== null) {
      flushListBlock();
      const mark = f[1]!;
      if (fence === null) {
        fence = { ch: mark[0]!, len: mark.length };
      } else if (mark[0] === fence.ch && mark.length >= fence.len) {
        fence = null;
      }
      out.push(line);
      continue;
    }

    if (fence !== null) {
      // fence の中は一切触らない
      out.push(line);
      continue;
    }

    // 2. 空行はリストブロックの終端
    if (line.trim() === '') {
      flushListBlock();
      out.push(line);
      continue;
    }

    // 3. リスト行の判定
    const isListItem = LIST_MARKER.test(line);
    if (isListItem) {
      currentListBlock.push(line);
    } else {
      // リスト項目ではない行
      // 直前がリストブロックで、かつインデントされた継続行であればリストブロックに含める
      if (currentListBlock.length > 0 && /^\s+/.test(line)) {
        currentListBlock.push(line);
      } else {
        flushListBlock();
        out.push(line);
      }
    }
  }

  flushListBlock();

  const nextBody = out.join('\n');
  return nextBody === body ? body : nextBody;
}
