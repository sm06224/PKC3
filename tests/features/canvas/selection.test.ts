/**
 * 🔴 **無限キャンバスの複数選択と整列**(v4.0 Phase 2 / PR-10、`src/features/canvas/selection.ts`)。
 *
 * 守る主張: 範囲選択は重なる付箋だけを選ぶ(接するだけは選ばない・逆向きに引いてもよい)/
 * 整列 8 種は外接四角の辺・中央・隙間で揃える / 2 枚(等間隔は 3 枚)に満たなければ何も動かさない /
 * 結果は整数で `±PLACE_RECT_MAX` の中。
 */
import { describe, expect, it } from 'vitest';
import {
  ALIGN_KINDS,
  ALIGN_LABELS,
  alignCanvasRects,
  alignMinCount,
  isAlignKind,
  selectRectsInBox,
  type IndexedRect,
} from '../../../src/features/canvas/selection';
import { PLACE_RECT_MAX } from '../../../src/features/markdown/place-rect';

const A: IndexedRect = { key: 'a', x: 0, y: 0, w: 100, h: 50 };
const B: IndexedRect = { key: 'b', x: 300, y: 100, w: 200, h: 80 };
const C: IndexedRect = { key: 'c', x: 150, y: 400, w: 50, h: 40 };

describe('selectRectsInBox(範囲選択)', () => {
  it('引いた四角と重なる付箋だけを、渡した順で返す', () => {
    expect(selectRectsInBox([A, B, C], { x: 50, y: 20, w: 300, h: 100 })).toEqual(['a', 'b']);
    expect(selectRectsInBox([A, B, C], { x: 140, y: 390, w: 20, h: 20 })).toEqual(['c']);
  });
  it('逆向き(右下から左上)に引いても同じ', () => {
    expect(selectRectsInBox([A, B, C], { x: 350, y: 120, w: -300, h: -100 })).toEqual(['a', 'b']);
  });
  it('辺がちょうど接するだけは選ばない / 何も無い所は空', () => {
    expect(selectRectsInBox([A], { x: 100, y: 0, w: 50, h: 50 })).toEqual([]);
    expect(selectRectsInBox([A, B, C], { x: 1000, y: 1000, w: 10, h: 10 })).toEqual([]);
  });
  it('負の座標の付箋も選べる', () => {
    const N: IndexedRect = { key: 'n', x: -500, y: -300, w: 100, h: 100 };
    expect(selectRectsInBox([N, A], { x: -450, y: -250, w: 10, h: 10 })).toEqual(['n']);
  });
});

describe('alignCanvasRects(整列)', () => {
  it('8 種と名前と最少枚数がそろっている', () => {
    expect(ALIGN_KINDS).toHaveLength(8);
    for (const k of ALIGN_KINDS) {
      expect(isAlignKind(k)).toBe(true);
      expect(ALIGN_LABELS[k]).not.toBe('');
    }
    expect(isAlignKind('diagonal')).toBe(false);
    expect(alignMinCount('left')).toBe(2);
    expect(alignMinCount('distribute-x')).toBe(3);
    expect(alignMinCount('distribute-y')).toBe(3);
  });

  it('2 枚: 左 / 右 / 左右中央 / 上 / 下 / 上下中央', () => {
    const two = [A, B];
    expect(Object.fromEntries(alignCanvasRects(two, 'left'))).toEqual({ a: { x: 0, y: 0 }, b: { x: 0, y: 100 } });
    expect(Object.fromEntries(alignCanvasRects(two, 'right'))).toEqual({ a: { x: 400, y: 0 }, b: { x: 300, y: 100 } });
    // 外接四角 0..500 の中央 250
    expect(Object.fromEntries(alignCanvasRects(two, 'center-x'))).toEqual({ a: { x: 200, y: 0 }, b: { x: 150, y: 100 } });
    expect(Object.fromEntries(alignCanvasRects(two, 'top'))).toEqual({ a: { x: 0, y: 0 }, b: { x: 300, y: 0 } });
    expect(Object.fromEntries(alignCanvasRects(two, 'bottom'))).toEqual({ a: { x: 0, y: 130 }, b: { x: 300, y: 100 } });
    // 外接四角 0..180 の中央 90
    expect(Object.fromEntries(alignCanvasRects(two, 'center-y'))).toEqual({ a: { x: 0, y: 65 }, b: { x: 300, y: 50 } });
  });

  it('1 枚では揃えない / 2 枚では等間隔にしない(空の Map)', () => {
    expect(alignCanvasRects([A], 'left').size).toBe(0);
    expect(alignCanvasRects([A, B], 'distribute-x').size).toBe(0);
    expect(alignCanvasRects([A, B], 'distribute-y').size).toBe(0);
  });

  it('3 枚: 左右に等間隔 ── 両端は動かさず、隙間を等しくする(大きさが違っても隙間で揃える)', () => {
    const r = alignCanvasRects([B, A, C], 'distribute-x');
    // 並び: A(0..100) C(150..200) B(300..500)。全幅 500、大きさの合計 350 → 隙間 75
    expect(r.get('a')).toEqual({ x: 0, y: 0 });
    expect(r.get('c')).toEqual({ x: 175, y: 400 });
    expect(r.get('b')).toEqual({ x: 300, y: 100 });
  });

  it('3 枚: 上下に等間隔', () => {
    const r = alignCanvasRects([A, B, C], 'distribute-y');
    // 並び: A(0..50) B(100..180) C(400..440)。全高 440、合計 170 → 隙間 135
    expect(r.get('a')).toEqual({ x: 0, y: 0 });
    expect(r.get('b')).toEqual({ x: 300, y: 185 });
    expect(r.get('c')).toEqual({ x: 150, y: 400 });
  });

  it('負の座標でも同じ式(左揃えは負の端へ)', () => {
    const N: IndexedRect = { key: 'n', x: -250, y: -80, w: 100, h: 40 };
    const r = alignCanvasRects([N, A], 'left');
    expect(r.get('a')).toEqual({ x: -250, y: 0 });
    expect(r.get('n')).toEqual({ x: -250, y: -80 });
  });

  it('結果は整数で ±PLACE_RECT_MAX の中(はみ出す値・小数を書かない)', () => {
    const far: IndexedRect = { key: 'f', x: PLACE_RECT_MAX - 10, y: 0, w: 300, h: 10 };
    const odd: IndexedRect = { key: 'o', x: 0, y: 0.4, w: 101, h: 11 };
    const right = alignCanvasRects([far, odd], 'right');
    for (const v of right.values()) {
      expect(Number.isInteger(v.x) && Number.isInteger(v.y)).toBe(true);
      expect(Math.abs(v.x)).toBeLessThanOrEqual(PLACE_RECT_MAX);
    }
    expect(right.get('f')!.x).toBe(PLACE_RECT_MAX - 10);
    const neg: IndexedRect = { key: 'g', x: -PLACE_RECT_MAX, y: 0, w: 10, h: 10 };
    const wide: IndexedRect = { key: 'w', x: 0, y: 0, w: 500, h: 10 };
    // 左右中央: g の中央は -PLACE_RECT_MAX - … → 下限で止まる
    const c = alignCanvasRects([neg, wide], 'center-x');
    expect(c.get('w')!.x).toBeGreaterThanOrEqual(-PLACE_RECT_MAX);
    expect(Object.is(c.get('g')!.y, -0)).toBe(false);
  });
});
