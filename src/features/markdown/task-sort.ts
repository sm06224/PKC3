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

/** 番号付き項目の頭(字下げ / 数 / 区切りと空白)。位置の番号を保つために使う。 */
const NUMBERED = /^(\s*)(\d+)([.)]\s+)/;

import { fenceStep } from './list-renumber';
import { TASK_LINE } from './task-line';

/**
 * 🔴 **「触らない行」の地図**(#1087)。fence(字下げ付きも含む。判定の正本は `advanceFence`)と、
 *   `$$` だけの行で開いて `$$` だけの行で閉じる数式の塊(`markdown-render.ts` の `pkc_math_block` と同じ読み方。
 *   閉じが無ければ段落なので opaque にしない)の行に、塊ごとの番号(1 から)を振る。他の行は 0。
 *   ⚠ HTML の `<pre>` は対象外 ── 描画が `html: false` なので、ただの段落である。
 */
function opaqueRegions(lines: readonly string[]): number[] {
  const ids: number[] = new Array<number>(lines.length).fill(0);
  let fence = '';
  let id = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const st = fenceStep(fence, line);
    const next = st.next;
    if (st.inside) {
      if (fence === '') id += 1;
      ids[i] = id;
      fence = next;
      continue;
    }
    fence = next;
    if (line.trim() === '$$') {
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() !== '$$') j++;
      if (j < lines.length) {
        id += 1;
        for (let k = i; k <= j; k++) ids[k] = id;
        i = j;
      }
    }
  }
  return ids;
}

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

  const opaque = opaqueRegions(lines);

  // このブロック内で最も浅いリスト項目のインデント幅を探す
  let minIndent = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (opaque[i] === 0 && LIST_MARKER.test(line)) {
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

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const isItemHeader = opaque[li] === 0 && LIST_MARKER.test(line) && leadingIndentWidth(line) === minIndent;
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

  /**
   * 🔴 **項目の後ろの空行は、並べ替えても元の位置に残す**(#1087)── ゆるいリスト(項目の間に空行)は
   *   空行ごと項目に付いて動くと、末尾に余計な空行が出たり、間が詰まったりする。
   *   「何番目の項目の後ろに空行が何行」を位置で持ち、並べ替えた後の同じ位置へ戻す。
   */
  const gaps: string[][] = [];
  for (const chunk of chunks) {
    const gap: string[] = [];
    while (chunk.lines.length > 1 && chunk.lines[chunk.lines.length - 1]!.trim() === '') {
      gap.unshift(chunk.lines.pop()!);
    }
    gaps.push(gap);
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
  sortedChunks.forEach((chunk, i) => {
    // 🔴 番号付きは**位置の番号を保つ**(#1087)── `1. [x]` / `2. [ ]` を入れ替えて `2.` / `1.` にしない
    const slot = NUMBERED.exec(chunks[i]!.lines[0]!);
    const own = NUMBERED.exec(chunk.lines[0]!);
    if (slot !== null && own !== null && slot[2] !== own[2]) {
      resultLines.push(`${own[1]}${slot[2]}${own[3]}${chunk.lines[0]!.slice(own[0].length)}`, ...chunk.lines.slice(1));
    } else {
      resultLines.push(...chunk.lines);
    }
    resultLines.push(...gaps[i]!);
  });

  return resultLines;
}

/**
 * 引用の頭(行頭の `>` の並び)。⚠ **行頭(字下げ 0)の `>` だけ**を引用の塊として扱う ──
 * 字下げした `>` はリスト項目の続きの行であることが多く、塊として切り出すと項目の構造を壊す。
 * 行頭の `>` はリストを必ず閉じる(markdown-it も同じ)ので、切り出しても意味が変わらない。
 */
const QUOTE_HEAD = /^(>(?:[ \t]*>)*)([ \t]?)(.*)$/s;

/** 1 つの区間(引用ではない行の連なり)を並べ替える。`only` が数なら、その行を含むリストだけ。 */
function sortSegment(lines: readonly string[], only: number | null): { lines: string[]; hit: boolean } {
  const out: string[] = [];
  const opaque = opaqueRegions(lines);
  /** 触らない塊が、いま開いているリスト項目の配下(字下げ付き)に在るか。在れば塊ごと項目に付いて動く。 */
  let opaqueInBlock = false;
  let currentListBlock: string[] = [];
  /** いま開いているリストの、区間の中での最初と最後の行。 */
  let blockFirst = 0;
  let blockLast = 0;
  let hit = false;

  const add = (idx: number): void => {
    if (currentListBlock.length === 0) blockFirst = idx;
    currentListBlock.push(lines[idx]!);
    blockLast = idx;
  };

  const flushListBlock = (): void => {
    if (currentListBlock.length === 0) return;
    const block = currentListBlock;
    currentListBlock = [];
    // 🔴 カーソルのあるリストだけ(依頼 87-2)── それ以外のリストは 1 バイトも動かさない
    const inScope = only === null || (only >= blockFirst && only <= blockLast);
    if (!inScope) {
      out.push(...block);
      return;
    }
    const sorted = sortListBlockLines(block);
    // 並べ替える相手に、チェック項目が 1 つも無ければ「当たった」に数えない(カーソルがただの箇条書きに在るとき)
    if (only !== null && block.some((l) => TASK_MARKER.test(l))) hit = true;
    out.push(...sorted);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // 1. 触らない塊(fence / `$$`)。字下げ付きでリスト項目の配下なら項目の一部、そうでなければ素通し
    if (opaque[i] !== 0) {
      if (i === 0 || opaque[i - 1] !== opaque[i]) {
        opaqueInBlock = currentListBlock.length > 0 && /^\s+/.test(line);
        if (!opaqueInBlock) flushListBlock();
      }
      if (opaqueInBlock) add(i);
      else out.push(line);
      continue;
    }

    // 2. 空行はリストブロックの終端
    if (line.trim() === '') {
      /**
       * 🔴 **空行のあとにまたリスト項目が続くなら、同じリスト(ゆるいリスト)**(#1087)── 空行で切ると
       *   項目の間に空行を入れた書き方は 1 つも並べ替わらず、「揃っています」と偽を言っていた。
       *   ⚠ 空行のあとが見出しや段落なら、これまでどおりそこで切る(別のリスト)。
       */
      if (currentListBlock.length > 0) {
        let j = i;
        while (j < lines.length && lines[j]!.trim() === '') j += 1;
        const nextLine = lines[j];
        if (nextLine !== undefined && opaque[j] === 0 && LIST_MARKER.test(nextLine)) {
          for (; i < j; i++) add(i);
          i = j - 1;
          continue;
        }
      }
      flushListBlock();
      out.push(line);
      continue;
    }

    // 3. リスト行の判定
    const isListItem = LIST_MARKER.test(line);
    if (isListItem) {
      add(i);
    } else {
      // リスト項目ではない行
      // 直前がリストブロックで、かつインデントされた継続行であればリストブロックに含める
      if (currentListBlock.length > 0 && /^\s+/.test(line)) {
        add(i);
      } else {
        flushListBlock();
        out.push(line);
      }
    }
  }

  flushListBlock();
  return { lines: out, hit };
}

/**
 * 全体の走査。引用(`> - [ ] …`)の塊は **`>` を外して**同じ規則で並べ替え、同じ `>` を付け直す(依頼 159。推薦 ②)。
 * @param only カーソルの行(0 始まり)。`null` なら全部のリスト
 */
function sortAll(body: string, only: number | null): { text: string; hit: boolean } {
  const lines = body.split('\n');
  const opaque = opaqueRegions(lines);
  const out: string[] = [];
  let hit = false;
  let seg: string[] = [];
  let segFirst = 0;

  const flushSeg = (): void => {
    if (seg.length === 0) return;
    const local = only === null ? null : only >= segFirst && only < segFirst + seg.length ? only - segFirst : -1;
    const r = sortSegment(seg, local);
    out.push(...r.lines);
    if (r.hit) hit = true;
    seg = [];
  };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (opaque[i] === 0 && line.startsWith('>')) {
      // 引用の塊 = 行頭が `>` の行の連なり。⚠ 頭の `>` の並びが全部同じ行だけを 1 つの塊にする(深さの違う行は塊を分ける)
      const head = QUOTE_HEAD.exec(line)!;
      const key = head[1]!.replace(/[ \t]/g, '');
      let j = i;
      const inner: string[] = [];
      let space = '';
      while (j < lines.length && opaque[j] === 0) {
        const m = QUOTE_HEAD.exec(lines[j]!);
        if (m === null || m[1]!.replace(/[ \t]/g, '') !== key) break;
        if (space === '' && m[3] !== '') space = m[2]!;
        inner.push(m[3]!);
        j += 1;
      }
      flushSeg();
      const local = only === null ? null : only >= i && only < j ? only - i : -1;
      const r = sortSegment(inner, local);
      if (r.hit) hit = true;
      const same = r.lines.length === inner.length && r.lines.every((l, k) => l === inner[k]);
      if (same) {
        for (let k = i; k < j; k++) out.push(lines[k]!);
      } else {
        for (const l of r.lines) out.push(l === '' ? head[1]! : `${head[1]!}${space === '' ? ' ' : space}${l}`);
      }
      i = j;
      continue;
    }
    if (seg.length === 0) segFirst = i;
    seg.push(line);
    i += 1;
  }
  flushSeg();
  return { text: out.join('\n'), hit };
}

/**
 * 本文（Markdown）内のチェックリストを走査し、
 * 各リストブロックごとに完了したタスク項目（`- [x]`）を末尾に寄せて返す。
 * 引用の中のリスト(`> - [x] …`)も同じ規則で並べ替える(台帳 #1852 I2 / 依頼 159。Gemini 回答 = 推薦 ②)。
 *
 * @param body 対象の Markdown 本文
 * @returns 整理後の Markdown 本文。変更がなければ元の文字列をそのまま返す
 */
export function sortTasksByStatus(body: string): string {
  if (body === '' || !body.includes('[')) {
    return body;
  }
  const next = sortAll(body, null).text;
  return next === body ? body : next;
}

/**
 * 🔴 **カーソルのあるリストだけ**を並べ替える(台帳 #1852 I2 / 依頼 87-2。Gemini 回答 = 推薦 A)。
 *
 * 押した場所と効く範囲をそろえる ── 3 つリストが在るノートで、カーソルのある 1 つだけが動く。
 * ⚠ **カーソルがチェックリストの外**(段落の上・ノートの末尾など)にあるときは、これまでどおり
 *   すべてのリストを並べ替える(`scope: 'all'`)。何も起きない行き止まりにしない。
 * @param caretLine カーソルのある行(0 始まり)
 */
export function sortTasksAtCaret(body: string, caretLine: number): { text: string; scope: 'caret' | 'all' } {
  if (body === '' || !body.includes('[')) return { text: body, scope: 'all' };
  const here = sortAll(body, caretLine);
  if (here.hit) return { text: here.text === body ? body : here.text, scope: 'caret' };
  const all = sortAll(body, null).text;
  return { text: all === body ? body : all, scope: 'all' };
}

/** カーソルの行(0 始まり)。 */
export function caretLineOf(text: string, caret: number): number {
  let n = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < caret; i = text.indexOf('\n', i + 1)) n += 1;
  return n;
}

/**
 * 本文にチェック項目(`- [ ]` / `- [x]`。引用の中の `> - [ ]` も)が 1 つでも在るか。⚠ 読み方は `sortTasksByStatus` と同じ
 * (fence の中は数えない)── 「無いから変わらなかった」と「揃っているから変わらなかった」を言い分ける。
 * 🔴 引用の中も数える(依頼 159 で並べ替えの対象にしたので、揃っているのに「ありません」と偽を言わない)。
 */
export function hasTaskItems(body: string): boolean {
  if (body === '' || !body.includes('[')) return false;
  const lines = body.split('\n');
  const opaque = opaqueRegions(lines);
  return lines.some((line, i) => opaque[i] === 0 && TASK_LINE.test(line));
}

/**
 * 🔴 **並べ替えた後のカーソルを、押す前にいた行へ戻す**(#1163 の依頼 100-2。Gemini の裁定:推薦どおり = A)。
 *
 * ⚠ 直す前は、置き換えた範囲の終わり(長いノートでは下のほう)へ飛び、押した場所を見失った。
 * 🔑 並べ替えは行の数を変えない ── 「同じ行番号・同じ桁」へ置く(行が短くなっていたら行末)。
 *   行の数が変わっていたら(想定外)、元の位置を字数の範囲に収めるだけにする。
 * @param pos 押す前のカーソル位置(字数)
 */
export function caretAfterReplace(before: string, after: string, pos: number): number {
  const at = Math.min(Math.max(pos, 0), before.length);
  const lineNo = before.slice(0, at).split('\n').length - 1;
  const col = at - ((at === 0 ? -1 : before.lastIndexOf('\n', at - 1)) + 1);
  const afterLines = after.split('\n');
  if (afterLines.length !== before.split('\n').length) return Math.min(at, after.length);
  let start = 0;
  for (let i = 0; i < lineNo; i++) start += afterLines[i]!.length + 1;
  return start + Math.min(col, afterLines[lineNo]!.length);
}
