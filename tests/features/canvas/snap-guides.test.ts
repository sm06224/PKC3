/**
 * 🔴 **スナップ補助線**(Polish PR-C、`src/features/canvas/snap-guides.ts`)。
 *
 * 守る主張: X / Y を別々に、端・中央の組でいちばん近い所へ吸い付く / 閾値ちょうどは吸い付き、越えたら吸い付かない /
 * 補助線は吸い付いた後に揃っている線(同じ位置は 1 本、両方の付箋にまたがる長さ)/ 同じ入力は同じ結果 / 倍率で閾値が変わる。
 */
import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  computeSnapGuides,
  SNAP_THRESHOLD_PX,
  snapThresholdFor,
} from '../../../src/features/canvas/snap-guides';

const B = { x: 300, y: 100, w: 200, h: 100 }; // 左 300 / 中央 400 / 右 500、上 100 / 中央 150 / 下 200

describe('computeSnapGuides', () => {
  it('🔴 左端どうし(X)── 差 4 で吸い付き、縦の補助線を両方にまたがる長さで出す', () => {
    const r = computeSnapGuides({ x: 304, y: 400, w: 80, h: 40 }, [B]);
    expect(r.snapDx).toBe(-4);
    expect(r.snapDy).toBe(0);
    expect(r.guides).toEqual([{ axis: 'x', pos: 300, from: 100, to: 440 }]);
  });

  it('🔴 中央どうし(Y)と右端→左端(X)を同時に', () => {
    // 動かす四角: 右端 297(→ B の左 300 へ +3)、中央 y 147(→ 150 へ +3)
    const r = computeSnapGuides({ x: 197, y: 127, w: 100, h: 40 }, [B]);
    expect(r.snapDx).toBe(3);
    expect(r.snapDy).toBe(3);
    expect(r.guides.map((g) => [g.axis, g.pos])).toEqual([
      ['x', 300],
      ['y', 150],
    ]);
  });

  it('下端 → 上端(Y)', () => {
    const r = computeSnapGuides({ x: 0, y: 0, w: 50, h: 95 }, [B]);
    expect(r.snapDy).toBe(5);
    expect(r.guides).toEqual([{ axis: 'y', pos: 100, from: 0, to: 500 }]);
  });

  it('🔴 閾値ちょうどは吸い付く / 1 越えたら吸い付かない', () => {
    expect(computeSnapGuides({ x: 300 + SNAP_THRESHOLD_PX, y: 900, w: 10, h: 10 }, [B]).snapDx).toBe(-SNAP_THRESHOLD_PX);
    const far = computeSnapGuides({ x: 300 + SNAP_THRESHOLD_PX + 1, y: 900, w: 10, h: 10 }, [B]);
    expect(far).toEqual({ snapDx: 0, snapDy: 0, guides: [] });
  });

  it('🔴 候補が複数なら、いちばん近い付箋の線を選ぶ', () => {
    const near = { x: 1000, y: 0, w: 50, h: 50 }; // 左 1000
    const r = computeSnapGuides({ x: 998, y: 500, w: 10, h: 10 }, [B, near]);
    expect(r.snapDx).toBe(2);
    expect(r.guides).toEqual([{ axis: 'x', pos: 1000, from: 0, to: 510 }]);
    const r2 = computeSnapGuides({ x: 994, y: 500, w: 2, h: 10 }, [{ x: 999, y: 0, w: 1, h: 1 }, near]); // 右端 996: 999 まで 3 / 1000 まで 4 → 999
    expect(r2.snapDx).toBe(3);
  });

  it('同じ位置に揃う付箋が 2 枚なら、補助線は 1 本で、全員にまたがる', () => {
    const a = { x: 100, y: 0, w: 50, h: 20 };
    const b = { x: 100, y: 300, w: 80, h: 20 };
    const r = computeSnapGuides({ x: 102, y: 100, w: 30, h: 30 }, [a, b]);
    expect(r.guides).toEqual([{ axis: 'x', pos: 100, from: 0, to: 320 }]);
  });

  it('決定的: 同じ入力は同じ結果(並び順も同じ)', () => {
    const others = [B, { x: 0, y: 150, w: 10, h: 10 }, { x: 600, y: 140, w: 20, h: 20 }];
    const m = { x: 296, y: 128, w: 208, h: 44 };
    expect(computeSnapGuides(m, others)).toEqual(computeSnapGuides(m, others));
  });

  it('相手が居なければ何もしない / 負の座標でも吸い付く', () => {
    expect(computeSnapGuides(B, [])).toEqual({ snapDx: 0, snapDy: 0, guides: [] });
    const r = computeSnapGuides({ x: -203, y: -50, w: 100, h: 10 }, [{ x: -200, y: -500, w: 40, h: 40 }]);
    expect(r.snapDx).toBe(3);
  });

  it('🔴 倍率で閾値を割り戻す(縮小するとワールドでは広く、拡大すると狭く)', () => {
    expect(snapThresholdFor(1)).toBe(6);
    expect(snapThresholdFor(0.5)).toBe(12);
    expect(snapThresholdFor(2)).toBe(3);
    expect(snapThresholdFor(0)).toBe(6);
    expect(snapThresholdFor(Number.NaN)).toBe(6);
    const m = { x: 310, y: 900, w: 10, h: 10 };
    expect(computeSnapGuides(m, [B], snapThresholdFor(0.5)).snapDx).toBe(-10);
    expect(computeSnapGuides(m, [B], snapThresholdFor(1)).snapDx).toBe(0);
  });
});

describe('boundsOf', () => {
  it('外接四角 / 空は null', () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([B, { x: -10, y: 150, w: 20, h: 100 }])).toEqual({ x: -10, y: 100, w: 510, h: 150 });
  });
});
