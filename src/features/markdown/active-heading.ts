/**
 * いま読んでいる見出しを選ぶ(#1168)── クイック目次の「現在地」の強調に使う。
 *
 * Features 層 ── DOM を知らない。位置の採寸は呼び側(`quick-toc.ts`)が持つ。
 */

/**
 * ⚠ 端数の許容(px)。見出しへ飛んだ直後は、サブピクセルの丸めで
 *   見出しが線の 1px 下に居ることがある ── 許さないと**飛んだ先が 1 つ前に光る**。
 */
export const ACTIVE_HEADING_TOLERANCE = 2;

/**
 * 「線(`probe`)を越えた最後の見出し」の添字を返す。
 *
 * @param positions 見出しの位置。**昇順**(文書の並び順)であること。
 *   縦なら「器の上端からの距離」、段組みなら「器の左端からの距離」のように、
 *   呼び側が同じ原点で揃えて渡す。
 * @param probe 現在地の線。`position <= probe + 許容` の見出しが「もう読み始めた」物。
 * @returns 添字。**1 つも越えていなければ `-1`**(まだ最初の見出しの手前)。
 */
export function activeHeadingIndex(positions: readonly number[], probe: number): number {
  const limit = probe + ACTIVE_HEADING_TOLERANCE;
  let lo = 0;
  let hi = positions.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((positions[mid] as number) <= limit) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
