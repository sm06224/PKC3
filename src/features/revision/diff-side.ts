/**
 * 🔴 **差分を左右に並べる**(#1231 段①)。**左 = 相手 / 右 = この版**。
 *
 * > user の物語: 縦 1 列の +/− だと、消えた行と足した行が**離れて**並び、
 * > 「あの行がこの行に変わった」が目で追えない。
 *
 * 入力は `diffRows(相手, この版)` の行 ── `del` = **相手にだけ在る行**(左だけ)、
 * `add` = **この版にだけ在る行**(右だけ)、`same` = 両方、`gap` = 畳み(両列にまたがる)。
 * 🔑 描画器は**映すだけ** ── 対応付けと字単位の強調の判断は全部ここにある。
 * 🔑 **pure module**。DOM も store も知らない。
 */
import { charDiff, charDiffCost } from './char-diff';
import type { DiffRow } from './diff-view';

/** 行の中の 1 かたまり。`changed` = 字単位で見て変わった字(濃くする)。 */
export interface SidePart {
  text: string;
  changed: boolean;
}

export interface SideCell {
  kind: 'same' | 'add' | 'del';
  text: string;
  /** 字単位の強調の材料。`null` = 行ごと塗る(対になる行が無い / 長すぎる / 予算切れ)。 */
  parts: SidePart[] | null;
}

export type SideRow =
  | { kind: 'gap'; skipped: number }
  /** `left` / `right` が `null` = その側は**空の升**(消えた行は右が、足した行は左が空く)。 */
  | { kind: 'pair'; left: SideCell | null; right: SideCell | null };

/**
 * 字単位の比較に使う**総量の上限**(`charDiffCost` の和)。⚠ 行の長さの上限(`CHAR_DIFF_MAX_CHARS`)だけでは、
 * 長い行が何百本も入れ替わった差分で**主スレッドが止まる**(1 対ごとは軽くても足し算で重い)。
 * 超えた後の対は行ごと塗る。
 */
export const CHAR_DIFF_TOTAL_BUDGET = 4_000_000;

/**
 * @param rows `diffRows(相手, この版)` の結果
 *
 * ⚠ **字単位の強調は「del の塊の直後に add が同じ数だけ続く」ときだけ** ── 数が違うと
 *   どの行がどの行に変わったのか決められない(推測で対にしない)。そのときも**左右は同じ行に並べる**
 *   (前から順に。余った側は反対が空の升)。
 */
export function sideRows(rows: readonly DiffRow[]): SideRow[] {
  const out: SideRow[] = [];
  let budget = CHAR_DIFF_TOTAL_BUDGET;
  let i = 0;
  while (i < rows.length) {
    const row = rows[i]!;
    if (row.kind === 'gap') {
      out.push({ kind: 'gap', skipped: row.skipped ?? 0 });
      i++;
    } else if (row.kind === 'same') {
      const cell: SideCell = { kind: 'same', text: row.text, parts: null };
      out.push({ kind: 'pair', left: cell, right: { ...cell } });
      i++;
    } else {
      // 変わった塊: 続く `del` を集め、その直後の `add` を集める
      const dels: string[] = [];
      const adds: string[] = [];
      while (i < rows.length && rows[i]!.kind === 'del') dels.push(rows[i++]!.text);
      while (i < rows.length && rows[i]!.kind === 'add') adds.push(rows[i++]!.text);
      const replaced = dels.length > 0 && dels.length === adds.length;
      for (let n = 0; n < Math.max(dels.length, adds.length); n++) {
        const a = dels[n];
        const b = adds[n];
        let left: SideCell | null = a === undefined ? null : { kind: 'del', text: a, parts: null };
        let right: SideCell | null = b === undefined ? null : { kind: 'add', text: b, parts: null };
        if (replaced && left !== null && right !== null) {
          const cost = charDiffCost(a!, b!);
          if (cost <= budget) {
            const segs = charDiff(a!, b!);
            if (segs !== null) {
              budget -= cost;
              left = { ...left, parts: segs.filter((s) => s.kind !== 'add').map((s) => ({ text: s.text, changed: s.kind === 'del' })) };
              right = { ...right, parts: segs.filter((s) => s.kind !== 'del').map((s) => ({ text: s.text, changed: s.kind === 'add' })) };
            }
          }
        }
        out.push({ kind: 'pair', left, right });
      }
    }
  }
  return out;
}
