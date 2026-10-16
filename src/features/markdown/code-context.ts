import { lineStart } from './line-start';
import { advanceFence } from './list-renumber';

/**
 * 🔴 **その位置は、コード・数式の中か**(#1087)。
 *
 * 入力補助(Enter でリストを続ける / 貼り付けの変換 / リンク化)は、
 * **コードや数式の中では何もしない**のが作法である ── コードの中の `- ` や `**` はコードの字だからだ。
 * 🔑 判定の正本はここ 1 か所(§7)。Enter の規則(`quote-assist.ts`)と貼り付けの規則
 *   (`text-ops.ts` / binder)が同じ答えを返す。
 *
 * 見るもの:
 *  - fenced code(` ``` ` / `~~~`)。⚠ **引用の中の fence**(`> ```` ``)も数える
 *  - `$$` だけの行で開閉する数式の塊(閉じ忘れも「開いている」とみなす ── 打っている途中だから)
 *  - 同じ行の中の `` `…` ``(caret より前の「`」の連なりが奇数個なら中)
 */

export type CodeContext = 'fence' | 'math' | 'inline' | null;

/** 行頭の `>` の連なりを剥がす。 */
function unquote(line: string): { depth: number; rest: string } {
  const m = /^((?:\s*>)+ ?)(.*)$/.exec(line);
  if (m === null) return { depth: 0, rest: line };
  return { depth: (m[1]!.match(/>/g) ?? []).length, rest: m[2]! };
}

/** `end`(行頭の位置)より前の行を追って、ブロックのコード・数式の中かを返す。 */
function blockContextBefore(value: string, end: number): 'fence' | 'math' | null {
  let fence = '';
  let fenceDepth = 0;
  let math = false;
  for (const l of value.slice(0, end).split('\n')) {
    const { depth, rest } = unquote(l);
    if (fence !== '') {
      // ⚠ 引用の深さが違う行は、この fence の閉じとして読まない
      if (depth === fenceDepth) fence = advanceFence(fence, rest);
      continue;
    }
    if (math) {
      if (rest.trim() === '$$') math = false;
      continue;
    }
    const open = advanceFence('', rest);
    if (open !== '') {
      fence = open;
      fenceDepth = depth;
    } else if (rest.trim() === '$$') {
      math = true;
    }
  }
  return fence !== '' ? 'fence' : math ? 'math' : null;
}

/** `pos` の行より前が、fenced code か数式の塊の中か(行ごとに開閉を追う)。 */
export function insideBlockCode(value: string, pos: number): boolean {
  return blockContextBefore(value, lineStart(value, pos)) !== null;
}

/** `pos` が fence・数式の塊・行内コードのどれかの中か。 */
export function codeContextAt(value: string, pos: number): CodeContext {
  const start = lineStart(value, pos);
  const block = blockContextBefore(value, start);
  if (block !== null) return block;
  const before = value.slice(start, pos);
  // 開きの fence 行そのものの上(`` ```ts `` の後ろ)も、コードの入口なので中とみなす
  if (advanceFence('', unquote(before).rest) !== '') return 'fence';
  if (unquote(before).rest.trim() === '$$') return 'math';
  const runs = before.match(/`+/g);
  return runs !== null && runs.length % 2 === 1 ? 'inline' : null;
}

/** `pos` がコード・数式の中なら true(貼り付けの変換を止める目印)。 */
export function insideCodeOrMath(value: string, pos: number): boolean {
  return codeContextAt(value, pos) !== null;
}
