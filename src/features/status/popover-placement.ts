/**
 * 🔴 **簡易メッセージ履歴(ポップオーバー)の置き場所を決める純関数**。
 *
 * 優先順: ① 押し所の**右**(左端の縦のバーから横へ開く。下端を押し所の下端へ揃え、画面内へ収める)
 * ② 右に収まらないとき(スマホ幅の上の帯)は、画面の上半分にある押し所なら**下**、下半分なら**上**へ、
 * 横は押し所の右端へ揃えて画面内へ収める。⚠ DOM を読まない(寸法は全部引数。`tooltip/placement.ts` と同じ作法)。
 */
export interface PopoverRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}
export type PopoverSide = 'right' | 'bottom' | 'top';
export interface PopoverPlacement {
  readonly x: number;
  readonly y: number;
  readonly side: PopoverSide;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

export function computePopoverPlacement(input: {
  readonly anchor: PopoverRect;
  readonly size: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly gap?: number;
  readonly margin?: number;
}): PopoverPlacement {
  const { anchor, size, viewport } = input;
  const gap = input.gap ?? 8;
  const margin = input.margin ?? 8;
  const maxX = Math.max(margin, viewport.width - margin - size.width);
  const maxY = Math.max(margin, viewport.height - margin - size.height);
  const rightX = anchor.right + gap;
  if (rightX + size.width <= viewport.width - margin) {
    // 左端のバーの下のほうにある押し所は、下端を揃えて上へ伸ばす。上のほうなら上端を揃える
    const lower = (anchor.top + anchor.bottom) / 2 > viewport.height / 2;
    const y = lower ? anchor.bottom - size.height : anchor.top;
    return { x: rightX, y: clamp(y, margin, maxY), side: 'right' };
  }
  const x = clamp(anchor.right - size.width, margin, maxX);
  const upper = (anchor.top + anchor.bottom) / 2 <= viewport.height / 2;
  if (upper) return { x, y: clamp(anchor.bottom + gap, margin, maxY), side: 'bottom' };
  return { x, y: clamp(anchor.top - gap - size.height, margin, maxY), side: 'top' };
}
