/**
 * 🔴 **キャンバスの手書き ── 数の部分**(v4.0 Phase 2 / PR-10、`src/features/canvas/freehand.ts`)。
 *
 * 守る主張: 外接四角 = 線 + 太さの半分 + 余白 12 / 下限 48・上限 2048 / 四角の中への写し /
 * 空のストロークは置かない / 置く付箋の字(透過の地・枠なし・`asset:`)/ 色と太さの表。
 */
import { describe, expect, it } from 'vitest';
import {
  FREEHAND_COLORS,
  FREEHAND_MAX_SIZE,
  FREEHAND_MIN_SIZE,
  FREEHAND_PADDING,
  FREEHAND_WIDTHS,
  freehandBounds,
  freehandPlaceBlock,
  isFreehandColor,
  isFreehandWidth,
  toLocalStrokes,
  usableStrokes,
} from '../../../src/features/canvas/freehand';
import { PLACE_RECT_MAX } from '../../../src/features/markdown/place-rect';
import { addPlaceImage } from '../../../src/features/markdown/place-notation';

const BLACK = FREEHAND_COLORS[0].value;

describe('色と太さの表', () => {
  it('4 色・3 段階(仕様の値)', () => {
    expect(FREEHAND_COLORS.map((c) => c.value)).toEqual(['#1f2937', '#dc2626', '#2563eb', '#15803d']);
    expect(FREEHAND_WIDTHS.map((w) => w.value)).toEqual([2, 4, 8]);
    expect(isFreehandColor('#dc2626')).toBe(true);
    expect(isFreehandColor('red')).toBe(false);
    expect(isFreehandWidth(8)).toBe(true);
    expect(isFreehandWidth(5)).toBe(false);
  });
});

describe('freehandBounds(置く付箋の四角)', () => {
  it('線 + 太さの半分 + 余白 12 の外接四角(整数)', () => {
    const r = freehandBounds([
      { points: [{ x: 100, y: 200 }, { x: 300, y: 260 }], color: BLACK, width: 4 },
    ]);
    expect(r).toEqual({ x: 100 - 2 - FREEHAND_PADDING, y: 200 - 2 - FREEHAND_PADDING, w: 200 + 4 + 24, h: 60 + 4 + 24 });
  });
  it('複数のストローク・負の座標', () => {
    const r = freehandBounds([
      { points: [{ x: -50, y: -40 }], color: BLACK, width: 2 },
      { points: [{ x: 150, y: 60 }], color: BLACK, width: 8 },
    ])!;
    expect(r.x).toBe(-50 - 1 - 12);
    expect(r.y).toBe(-40 - 1 - 12);
    expect(r.x + r.w).toBe(150 + 4 + 12);
    expect(r.y + r.h).toBe(60 + 4 + 12);
  });
  it('点 1 つだけなら、描いた所を真ん中に下限 48 まで広げる', () => {
    const r = freehandBounds([{ points: [{ x: 10, y: 10 }], color: BLACK, width: 2 }])!;
    expect(r.w).toBe(FREEHAND_MIN_SIZE);
    expect(r.h).toBe(FREEHAND_MIN_SIZE);
    expect(r.x).toBe(10 - 24);
    expect(r.y).toBe(10 - 24);
  });
  it('上限 2048 で切る / 位置は ±PLACE_RECT_MAX に収める', () => {
    const r = freehandBounds([
      { points: [{ x: 0, y: 0 }, { x: 5000, y: 3000 }], color: BLACK, width: 2 },
    ])!;
    expect(r.w).toBe(FREEHAND_MAX_SIZE);
    expect(r.h).toBe(FREEHAND_MAX_SIZE);
    const far = freehandBounds([{ points: [{ x: -PLACE_RECT_MAX - 500, y: 0 }], color: BLACK, width: 2 }])!;
    expect(far.x).toBe(-PLACE_RECT_MAX);
  });
  it('🔴 空のストローク・点の無いストローク・数でない点は拒む(null)', () => {
    expect(freehandBounds([])).toBeNull();
    expect(freehandBounds([{ points: [], color: BLACK, width: 4 }])).toBeNull();
    expect(freehandBounds([{ points: [{ x: Number.NaN, y: 1 }], color: BLACK, width: 4 }])).toBeNull();
    expect(usableStrokes([{ points: [{ x: 1, y: Infinity }, { x: 2, y: 3 }], color: BLACK, width: 4 }])[0]!.points).toEqual([{ x: 2, y: 3 }]);
  });
});

describe('toLocalStrokes(四角の中の座標)', () => {
  it('四角の左上を 0 にする(色と太さはそのまま)', () => {
    const local = toLocalStrokes([{ points: [{ x: 110, y: 220 }, { x: 130, y: 250 }], color: BLACK, width: 8 }], { x: 100, y: 200 });
    expect(local).toEqual([{ points: [{ x: 10, y: 20 }, { x: 30, y: 50 }], color: BLACK, width: 8 }]);
  });
});

describe('freehandPlaceBlock / addPlaceImage(置く付箋の本文)', () => {
  it('透過の地・枠なしの付箋に asset: の画像 1 枚', () => {
    expect(freehandPlaceBlock({ x: -12, y: 30, w: 200, h: 120 }, 'ast-abc123')).toBe(
      ':::format{.pkc-place x=-12 y=30 w=200 h=120 fill=transparent stroke=none}\n![手書き](asset:ast-abc123)\n:::\n',
    );
  });
  it('🔴 書けない値は null(key の字・小数・範囲外)', () => {
    expect(freehandPlaceBlock({ x: 0, y: 0, w: 10, h: 10 }, 'ast) ![x](javascript:')).toBeNull();
    expect(freehandPlaceBlock({ x: 0.5, y: 0, w: 10, h: 10 }, 'ast-1')).toBeNull();
    expect(freehandPlaceBlock({ x: 0, y: 0, w: 0, h: 10 }, 'ast-1')).toBeNull();
    expect(freehandPlaceBlock({ x: PLACE_RECT_MAX + 1, y: 0, w: 10, h: 10 }, 'ast-1')).toBeNull();
  });
  it('本文の末尾に 1 枚足す(既存の付箋はそのまま)/ 閉じていない囲いの中へは書かない', () => {
    const body = ':::format{.pkc-place x=0 y=0 w=100 h=50}\nメモ\n:::\n';
    const out = addPlaceImage(body, 40, 60, { asset: 'ast-k1', w: 100, h: 80 })!;
    expect(out.startsWith(body)).toBe(true);
    expect(out).toContain(':::format{.pkc-place x=40 y=60 w=100 h=80 fill=transparent stroke=none}\n![手書き](asset:ast-k1)\n:::\n');
    expect(addPlaceImage('```\nコード', 0, 0, { asset: 'ast-k1', w: 100, h: 80 })).toBeNull();
    expect(addPlaceImage('', 0, 0, { asset: 'ast-k1', w: 100, h: 80 })).toBe(
      ':::format{.pkc-place x=0 y=0 w=100 h=80 fill=transparent stroke=none}\n![手書き](asset:ast-k1)\n:::\n',
    );
  });
});
