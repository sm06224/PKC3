/**
 * 🔴 **caret の在る行の範囲と、その行の縦の箱**(#2001 段 4 ── 現在行の強調)── 純関数。
 *
 * 行は**論理行**(`\n` で区切る行)。折り返して何行にも見える行は、まとめて 1 本の箱にする
 * (左端の線が、折り返しの全行に届く)。測るのは adapter(`render/current-line.ts`)で、ここは字と数だけ。
 * ⚠ **pure module**。
 */
import { lineStart } from './line-start';

/** caret の在る論理行の `[from, to)`。`to` は行末(`\n` の位置 / 本文の終わり)で、`\n` は含まない。 */
export function currentLineRange(value: string, caret: number): { from: number; to: number } {
  const c = Math.max(0, Math.min(caret, value.length));
  const from = lineStart(value, c);
  const nl = value.indexOf('\n', c);
  return { from, to: nl === -1 ? value.length : nl };
}

export interface VBox {
  readonly top: number;
  readonly height: number;
}

/**
 * 行を覆う矩形(上端・下端)の集まりから、縦の箱を作る(上端の最小〜下端の最大)。
 * 高さ 0 の矩形(測れなかった)は無いものとして扱い、全部そうなら `null`。
 */
export function boxOfRects(rects: ReadonlyArray<{ readonly top: number; readonly bottom: number }>): VBox | null {
  let top = Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    if (!(r.bottom - r.top > 0)) continue;
    if (r.top < top) top = r.top;
    if (r.bottom > bottom) bottom = r.bottom;
  }
  return bottom > top ? { top, height: bottom - top } : null;
}
