/**
 * 🔴 付箋の負座標と、無限キャンバスでのグループ移動(v4.0 Phase 2 / PR-09)。
 *
 * - `clampGroupDelta`: 通常表示は左上 0 で止める(今までと同じ)/ もう負の所に居る付箋は 0 へ跳ばさない /
 *   無限キャンバスは負の端(−100000)まで / どちらも上限 100000 で止める / 全員で同じだけ(形を崩さない)
 * - `movePlace` / `movePlaces` / `setPlaceRect` は負の x / y を書ける(開き行の札だけが変わる)
 */
import { describe, expect, it } from 'vitest';
import { clampGroupDelta, movePlace, movePlaces, setPlaceRect } from '../../../src/features/markdown/place-notation';
import { PLACE_RECT_MAX } from '../../../src/features/markdown/place-rect';

describe('clampGroupDelta(通常表示)', () => {
  it('🔴 1 枚だけなら今までの max(0, start + d) と同じ', () => {
    for (const [s, d] of [[10, -50], [10, -10], [10, 5], [0, -1], [0, 7], [300, -299]] as const) {
      const c = clampGroupDelta([{ x: s, y: s }], d, d);
      expect(s + c.dx).toBe(Math.max(0, s + d));
      expect(s + c.dy).toBe(Math.max(0, s + d));
    }
  });
  it('🔴 もう負の所に居る付箋は、それ以上は左・上へ行かないだけ(掴んだ瞬間に 0 へ跳ばさない)', () => {
    expect(clampGroupDelta([{ x: -120, y: -40 }], -10, -10)).toEqual({ dx: 0, dy: 0 });
    expect(clampGroupDelta([{ x: -120, y: -40 }], 30, 5)).toEqual({ dx: 30, dy: 5 });
  });
});

describe('clampGroupDelta(無限キャンバス)', () => {
  it('🔴 下限 0 で止めず、負の所へ動かせる', () => {
    expect(clampGroupDelta([{ x: 10, y: 20 }], -500, -700, { infinite: true })).toEqual({ dx: -500, dy: -700 });
  });
  it('🔴 グループは全員で同じだけ ── いちばん左上の付箋が −100000 に着いたら全員止まる', () => {
    const starts = [{ x: -99990, y: 0 }, { x: 500, y: -99995 }];
    const c = clampGroupDelta(starts, -100, -100, { infinite: true });
    expect(c).toEqual({ dx: -10, dy: -5 });
    // 形(2 枚の間の距離)は崩れない
    expect(starts[1]!.x + c.dx - (starts[0]!.x + c.dx)).toBe(500 - -99990);
  });
  it('上限 100000 を越えない(通常表示も同じ)', () => {
    expect(clampGroupDelta([{ x: PLACE_RECT_MAX - 5, y: 0 }], 50, 0, { infinite: true })).toEqual({ dx: 5, dy: 0 });
    expect(clampGroupDelta([{ x: PLACE_RECT_MAX - 5, y: 0 }], 50, 0)).toEqual({ dx: 5, dy: 0 });
  });
  it('空なら量をそのまま返す', () => {
    expect(clampGroupDelta([], -3, 4, { infinite: true })).toEqual({ dx: -3, dy: 4 });
  });
});

describe('負の位置を本文へ書く', () => {
  const A = ':::format{#a .pkc-place x=10 y=20 w=100 h=60}';
  const B = ':::format{#b .pkc-place x=200 y=20 w=100 h=60}';
  const body = [A, 'a', ':::', '', B, 'b', ':::', '', '本文'].join('\n');

  it('🔴 movePlace: x= / y= だけが負の値になる(他の行は 1 byte も変わらない)', () => {
    const out = movePlace(body, { line: 0, openLine: A, x: -320, y: -15 })!;
    const lines = out.split('\n');
    expect(lines[0]).toBe(':::format{#a .pkc-place x=-320 y=-15 w=100 h=60}');
    expect(lines.slice(1)).toEqual(body.split('\n').slice(1));
  });
  it('🔴 movePlaces: 無限キャンバスのグループ移動を 1 回で書く', () => {
    const c = clampGroupDelta([{ x: 10, y: 20 }, { x: 200, y: 20 }], -400, -100, { infinite: true });
    const out = movePlaces(body, [
      { line: 0, openLine: A, x: 10 + c.dx, y: 20 + c.dy },
      { line: 4, openLine: B, x: 200 + c.dx, y: 20 + c.dy },
    ])!;
    expect(out.split('\n')[0]).toContain('x=-390 y=-80');
    expect(out.split('\n')[4]).toContain('x=-200 y=-80');
  });
  it('setPlaceRect: 負の x / y を書け、範囲の外は全体を断る', () => {
    expect(setPlaceRect(body, { line: 0, openLine: A }, { x: -1, y: -2 })!.split('\n')[0]).toContain('x=-1 y=-2');
    expect(setPlaceRect(body, { line: 0, openLine: A }, { x: -1, y: -PLACE_RECT_MAX - 1 })).toBeNull();
  });
});
