import { describe, expect, it } from 'vitest';
import { computeTipPlacement, type TipRect } from '@features/tooltip/placement';

const vp = { width: 1000, height: 700 };
const tip = { width: 120, height: 30 };
const rect = (left: number, top: number, w = 40, h = 30): TipRect => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});
const overlaps = (p: { x: number; y: number }, r: TipRect): boolean =>
  p.x < r.right && p.x + tip.width > r.left && p.y < r.bottom && p.y + tip.height > r.top;

describe('computeTipPlacement', () => {
  it('対象とポインタの両方より上に出す(ポインタが対象より上のとき)', () => {
    const target = rect(400, 300);
    const r = computeTipPlacement({ target, pointer: { x: 410, y: 290 }, tip, viewport: vp });
    expect(r.side).toBe('top');
    expect(r.y + tip.height).toBeLessThanOrEqual(290 - 1);
  });
  it('ポインタが対象の中なら対象の上端が基準', () => {
    const r = computeTipPlacement({ target: rect(400, 300), pointer: { x: 410, y: 320 }, tip, viewport: vp });
    expect(r.side).toBe('top');
    expect(r.y + tip.height).toBeLessThanOrEqual(300);
  });
  it('上に収まらない左の縦のバーでは、下へ落とさず右の横へ', () => {
    const target = rect(0, 10, 44, 40);
    const pointer = { x: 20, y: 25 };
    const r = computeTipPlacement({ target, pointer, tip, viewport: vp });
    expect(r.side).toBe('right');
    expect(r.x).toBeGreaterThanOrEqual(target.right);
    expect(r.x).toBeGreaterThan(pointer.x);
    expect(overlaps(r, target)).toBe(false);
    expect(r.y).toBeGreaterThanOrEqual(0);
  });
  it('右上の隅では左の横へ', () => {
    const target = rect(950, 5, 40, 30);
    const r = computeTipPlacement({ target, pointer: { x: 970, y: 20 }, tip, viewport: vp });
    expect(r.side).toBe('left');
    expect(r.x + tip.width).toBeLessThanOrEqual(950);
    expect(overlaps(r, target)).toBe(false);
  });
  it('横にも収まらない(画面いっぱいの対象)ときだけ下へ、ポインタの下', () => {
    const target = rect(0, 0, 1000, 20);
    const r = computeTipPlacement({ target, pointer: { x: 500, y: 10 }, tip, viewport: vp });
    expect(r.side).toBe('bottom');
    expect(r.y).toBeGreaterThanOrEqual(20);
    expect(r.y).toBeGreaterThanOrEqual(10 + 24);
  });
  it('画面内へ収める(左右の端・下端)', () => {
    const left = computeTipPlacement({ target: rect(0, 300), pointer: { x: 5, y: 310 }, tip, viewport: vp });
    expect(left.side).toBe('top');
    expect(left.x).toBeGreaterThanOrEqual(0);
    const right = computeTipPlacement({ target: rect(970, 300), pointer: { x: 980, y: 310 }, tip, viewport: vp });
    expect(right.x + tip.width).toBeLessThanOrEqual(vp.width);
    const bottom = computeTipPlacement({
      target: rect(0, 0, 1000, 20),
      pointer: { x: 500, y: 690 },
      tip,
      viewport: { width: 1000, height: 40 },
    });
    expect(bottom.y + tip.height).toBeLessThanOrEqual(40);
  });
  it('横に置くとき縦は画面内へ収める', () => {
    const r = computeTipPlacement({ target: rect(0, 0, 44, 10), pointer: { x: 10, y: 5 }, tip, viewport: vp });
    expect(r.side).toBe('right');
    expect(r.y).toBeGreaterThanOrEqual(0);
  });
});
