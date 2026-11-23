/**
 * 🔴 **ツールチップの置き場所を決める純関数**(#1982 A3)。
 *
 * > user 指示 2026-11-22:大きいマウスカーソルでも読めるよう、ツールチップは
 * > **対象とポインタの両方より上**に出す。上に収まらないときは**下へ落とさず、まず横**へ。
 *
 * 優先順: ① 上(`min(対象の上端, ポインタ y) - gap`)② 右 ③ 左 ④ 下(最後の手段)。
 * 横は対象の矩形とポインタの両方を避ける。どの向きも画面内へ収める(clamp)。
 * ⚠ DOM を読まない(寸法は全部引数)── core ← features ← adapter の層を守る。
 */
export interface TipRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}
export type TipSide = 'top' | 'right' | 'left' | 'bottom';
export interface TipPlacement {
  readonly x: number;
  readonly y: number;
  readonly side: TipSide;
}
export interface TipPlacementInput {
  readonly target: TipRect;
  readonly pointer: { readonly x: number; readonly y: number };
  readonly tip: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  /** 対象・ポインタとの隙間(px)。 */
  readonly gap?: number;
  /** 画面の端に残す余白(px)。 */
  readonly margin?: number;
  /** 下へ置くときにポインタ(カーソルの絵)を避ける高さ(px)。 */
  readonly cursorHeight?: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

export function computeTipPlacement(input: TipPlacementInput): TipPlacement {
  const { target, pointer, tip, viewport } = input;
  const gap = input.gap ?? 6;
  const margin = input.margin ?? 4;
  const cursorHeight = input.cursorHeight ?? 24;
  const maxX = Math.max(margin, viewport.width - margin - tip.width);
  const maxY = Math.max(margin, viewport.height - margin - tip.height);
  const centerX = (target.left + target.right) / 2;
  const centerY = (target.top + target.bottom) / 2;

  // ① 上: 対象とポインタの両方より上
  const topY = Math.min(target.top, pointer.y) - gap - tip.height;
  if (topY >= margin) {
    return { x: clamp(centerX - tip.width / 2, margin, maxX), y: topY, side: 'top' };
  }

  // ②③ 横: 対象とポインタの両方を避ける。縦は対象の中央に合わせて画面内へ
  const sideY = clamp(centerY - tip.height / 2, margin, maxY);
  const rightX = Math.max(target.right, pointer.x) + gap;
  if (rightX + tip.width <= viewport.width - margin) {
    return { x: rightX, y: sideY, side: 'right' };
  }
  const leftX = Math.min(target.left, pointer.x) - gap - tip.width;
  if (leftX >= margin) {
    return { x: leftX, y: sideY, side: 'left' };
  }

  // ④ 最後の手段: 下(ポインタの絵と対象の両方の下)
  const bottomY = Math.max(target.bottom, pointer.y + cursorHeight) + gap;
  return {
    x: clamp(centerX - tip.width / 2, margin, maxX),
    y: clamp(bottomY, margin, maxY),
    side: 'bottom',
  };
}
