/**
 * 🔴 **チェック項目として読まない行**(#1087)── **読む側と書く側が同じ 1 本を引く**。
 *
 * ## なぜ要るか
 *
 * ノートに見えていない行(隠しメモ・コード・数式)のチェック項目が、予定表・通知・
 * 「N / M 完了」に出ていた。`task-count.ts` の走査が fence と引用しか除いていなかったためである。
 *
 * ## 🔑 同じ集合を 2 か所で使う(CLAUDE.md §7)
 *
 * - 読む側:`task-count.ts` の `walkTaskLines`(カンバン・予定表・通知・完了数の元)
 * - 書く側:`body-rewrite.ts` の印の書換・日付の書換・繰り返しの書換
 * ⚠ 片方だけが知っていると、「画面に出ない項目を書き換える」か「出た項目が押せない」が起きる。
 *
 * ## 隠れる行
 *
 * 1. **隠しメモ**:`%%%…%%%` / `:::comment…:::`。⚠ 規則は `markdown-render.ts` の
 *    `stripComments` と同じ状態機械(`tests/features/task-hidden.test.ts` が突き合わせる)。
 *    閉じの無い `:::comment` は描く側が本文として戻すので、隠さない。
 * 2. **コード**:fence(引用の中の fence を含む)/ 字下げコード(空行の後の字下げ 4 以上。
 *    リストの続きの字下げは除く)。
 * 3. **数式の塊**:`$$` だけの行から、閉じの `$$` だけの行まで(閉じが無ければ段落なので隠さない)。
 *
 * ⚠ 「多く数える」側に倒す規則は `task-count.ts` の頭のとおり ── ここは**描く側が隠す物だけ**を
 *   隠す。迷う形(HTML ブロックなど)は隠さない。
 *
 * 🔑 **pure module**。markdown-it を持ち込まない(storage worker の束に入る)。
 */
import { advanceFence } from './list-renumber';

/** 行頭の引用記号(`>` の連なり)。 */
const QUOTE = /^(\s*>)+\s?/;
/** fence の開き(字下げは 3 まで。`task-count.ts` の注釈のとおり)。 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_LEAD = /^(\s*)([-*+]|\d+[.)])(\s+)/;

function indentCols(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += 4 - (n % 4);
    else break;
  }
  return n;
}

/**
 * 隠しメモで消える行。⚠ `stripComments` の写し(出力に残らない行 = 隠れる)。
 * 閉じの無い `:::comment` は描く側が戻すので `false` に戻す。
 */
function commentMask(lines: readonly string[]): boolean[] {
  const hidden: boolean[] = new Array<boolean>(lines.length).fill(false);
  let fence = '';
  let inBlock = false;
  let inDirective = false;
  const buffer: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const was = fence !== '';
    fence = advanceFence(fence, line);
    // 開き・閉じの行と中身は全部 fence の一部(描く側の `isFenceContent` と同じ)
    const isFenceContent = was || fence !== '';
    if (isFenceContent) {
      if (inBlock || inDirective) hidden[i] = true;
      continue;
    }
    if (inDirective) {
      hidden[i] = true;
      if (/^[ \t]*:::[ \t]*$/.test(line)) {
        inDirective = false;
        buffer.length = 0;
      } else buffer.push(i);
      continue;
    }
    const trimmed = line.replace(/^[ \t]+/, '');
    if (inBlock) {
      hidden[i] = true;
      if (line.trimEnd().endsWith('%%%')) inBlock = false;
      continue;
    }
    if (/^[ \t]*:::comment(?:\{[^}]*\})?[ \t]*$/.test(line)) {
      inDirective = true;
      hidden[i] = true;
      buffer.push(i);
      continue;
    }
    if (trimmed.startsWith('%%%')) {
      hidden[i] = true;
      if (/^[ \t]*%%%[ \t]*$/.test(line)) {
        inBlock = true;
        continue;
      }
      if (!trimmed.slice(3).replace(/[ \t]+$/, '').endsWith('%%%')) inBlock = true;
    }
  }
  // 閉じの無い `:::comment` は本文として戻る(描く側の挽回処理)。⚠ 中の fence の行は戻らない
  if (inDirective) for (const i of buffer) hidden[i] = false;
  return hidden;
}

/**
 * 各行が「チェック項目として読まない行」か。
 *
 * @param lines `splitLines(body)` の行(改行の `\r` を落とした字)
 */
export function hiddenTaskMask(lines: readonly string[]): boolean[] {
  const hidden = commentMask(lines);
  /** 開いている fence。`depth` = 開いた行の引用の深さ。 */
  let fence: { readonly ch: string; readonly len: number; readonly depth: number } | null = null;
  let prevBlank = true; // 文書の先頭は「空行の後」と同じ(段落の途中ではない)
  let prevCode = false;
  /** リストの本文の字下げの列(外側が先)。 */
  const stack: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const q = QUOTE.exec(raw);
    const inner = q === null ? raw : raw.slice(q[0].length);
    const depth = q === null ? 0 : (q[0].match(/>/g) ?? []).length;
    if (fence !== null && depth < fence.depth) fence = null; // 引用が終われば fence も終わる
    const f = FENCE.exec(inner);
    if (f !== null) {
      const mark = f[1]!;
      if (fence === null) fence = { ch: mark[0]!, len: mark.length, depth };
      else if (mark[0] === fence.ch && mark.length >= fence.len) fence = null;
      hidden[i] = true;
      prevBlank = true;
      prevCode = false;
      continue;
    }
    if (fence !== null) {
      hidden[i] = true;
      continue;
    }
    if (hidden[i]) {
      prevBlank = true;
      prevCode = false;
      continue;
    }
    // 数式の塊:`$$` だけの行 … 閉じの `$$` だけの行(閉じが無ければ段落 = 隠さない)
    if (inner.trim() === '$$' && indentCols(inner) < 4) {
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j]!;
        const qj = QUOTE.exec(l);
        if ((qj === null ? l : l.slice(qj[0].length)).trim() === '$$') break;
      }
      if (j < lines.length) {
        for (let k = i; k <= j; k++) hidden[k] = true;
        i = j;
        prevBlank = true;
        prevCode = false;
        continue;
      }
    }
    if (inner.trim() === '') {
      prevBlank = true;
      continue;
    }
    const indent = indentCols(inner);
    const lead = LIST_LEAD.exec(inner);
    // 字下げコード(空行の後。コードの続きも)── リストの続きの字下げは除く
    if (prevBlank || prevCode) {
      while (stack.length > 0 && indent < stack[stack.length - 1]!) {
        if (prevCode) break;
        stack.pop();
      }
      const base = stack.length > 0 && indent >= stack[stack.length - 1]! ? stack[stack.length - 1]! : 0;
      if (indent - base >= 4) {
        hidden[i] = true;
        prevBlank = false;
        prevCode = true;
        continue;
      }
    }
    if (lead !== null) {
      while (stack.length > 0 && indent < stack[stack.length - 1]!) stack.pop();
      stack.push(indent + lead[2]!.length + 1);
    }
    prevBlank = false;
    prevCode = false;
  }
  return hidden;
}
