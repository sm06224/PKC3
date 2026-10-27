import { unquote } from './code-context';
import { lineStart } from './line-start';
import { advanceFence, fenceStep, stepFence } from './list-renumber';

/**
 * 🔴 **コードの囲み・`$$` の塊の位置を、本文から 1 度だけ全部引く**(#1451 の続き。編集の帯の案内の索引)。
 *
 * `codeContextAt` は「caret の行より前を全部なぞる」ので、打鍵(行が変わる)のたびに全文を走る。大きいノート
 * (1.5MB・囲み 3000)で重い。こちらは**本文が変わったときだけ** 1 回なぞって、位置は二分探索で引く。
 * 🔑 開閉の規則は `code-context.ts` の `blockContextBefore` と同じ部品(`fenceStep` / `advanceFence` / 引用の深さ)を呼ぶ ──
 *   規則を書き写さない。同じ答えになることは `tests/features/caret-hint.test.ts` が生成した文書で突き合わせる。
 */
export interface BlockSpan {
  readonly kind: 'fence' | 'math';
  /** 開き行の頭。 */
  readonly from: number;
  /** 開き行の中で、開きの記号が終わる位置。caret がこれ以降なら開き行も「中」。 */
  readonly openEnd: number;
  /** 閉じ行の頭(閉じていなければ -1)。 */
  readonly closeFrom: number;
  /** この塊の終わり(閉じ行の末尾か、閉じていなければ最後の行の末尾)。 */
  readonly to: number;
  /** 開きの記号の並び(3 個以上の逆引用符 / 波線、または `$$`)── 閉じに書く字。 */
  readonly marker: string;
  /** 囲みの info(`csv` など。無ければ空)。 */
  readonly info: string;
}

interface Open {
  kind: 'fence' | 'math';
  from: number;
  openEnd: number;
  marker: string;
  info: string;
}

export function scanBlockSpans(value: string): BlockSpan[] {
  const out: BlockSpan[] = [];
  if (!value.includes('```') && !value.includes('~~~') && !value.includes('$$')) return out;
  let fence = '';
  let fenceDepth = 0;
  let math = false;
  let cur: Open | null = null;
  let prevEnd = 0;
  const close = (closeFrom: number, to: number): void => {
    if (cur === null) return;
    out.push({ ...cur, closeFrom, to });
    cur = null;
  };
  for (let start = 0; start <= value.length; ) {
    const nl = value.indexOf('\n', start);
    const end = nl === -1 ? value.length : nl;
    const line = value.slice(start, end);
    const { depth, rest } = unquote(line);
    let handled = false;
    if (fence !== '') {
      if (depth > fenceDepth) {
        handled = true;
      } else if (depth === fenceDepth) {
        if (stepFence(fence, rest) === null) {
          // 入れ物が終わって打ち切られた ── 前の囲みは閉じないまま終わり、この行を読み直す
          close(-1, prevEnd);
          fence = '';
        } else {
          fence = fenceStep(fence, rest).next;
          handled = true;
          if (fence === '') close(start, end);
        }
      } else {
        close(-1, prevEnd);
        fence = '';
      }
    }
    if (!handled) {
      if (math) {
        if (rest.trim() === '$$') {
          math = false;
          close(start, end);
        }
      } else {
        const open = advanceFence('', rest);
        if (open !== '') {
          fence = open;
          fenceDepth = depth;
          const marker = /(`{3,}|~{3,})/.exec(line)?.[1] ?? '```';
          const at = line.indexOf(marker);
          cur = {
            kind: 'fence',
            from: start,
            openEnd: start + at + marker.length,
            marker,
            info: line.slice(at + marker.length).trim(),
          };
        } else if (rest.trim() === '$$') {
          math = true;
          const at = line.indexOf('$$');
          cur = { kind: 'math', from: start, openEnd: start + at + 2, marker: '$$', info: '' };
        }
      }
    }
    prevEnd = end;
    if (nl === -1) break;
    start = nl + 1;
  }
  close(-1, value.length);
  return out;
}

/**
 * caret(`caret`)が居る行について、その行を「中」に含む塊(無ければ `null`)。
 * 🔑 `codeContextAt` と同じ意味:行より前で開いた塊の中の行、または開き行で caret が開きの記号の後ろ。
 *   ⚠ 閉じ行は「中」に数えない(閉じ方を案内する場所ではない)。
 */
export function blockSpanAtCaret(spans: readonly BlockSpan[], value: string, caret: number): BlockSpan | null {
  const ls = lineStart(value, caret);
  // from <= ls を満たす最後の塊(二分探索)
  let lo = 0;
  let hi = spans.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.from <= ls) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // 塊は入れ子にならないので、候補は直前の 1 つだけ
  const s = found < 0 ? null : spans[found]!;
  if (s === null) return null;
  if (ls === s.from) return caret >= s.openEnd ? s : null;
  if (s.closeFrom === ls) return null;
  if (s.closeFrom !== -1 && ls > s.closeFrom) return null;
  if (ls > s.to) return null;
  return s;
}
