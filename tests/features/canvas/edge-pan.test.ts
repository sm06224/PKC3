/**
 * 🔴 **ドラッグ端のオートパン**(Polish PR-C、`src/features/canvas/edge-pan.ts`)。
 *
 * 守る主張: 帯(40px)の外は 0 / 4 辺で向きが正しい / 端に近いほど速い / 枠の外は最高速で止める / 角は両軸 / 狭い枠で両端の帯が重ならない。
 */
import { describe, expect, it } from 'vitest';
import { computeEdgePanVelocity, EDGE_PAN_MARGIN_PX, EDGE_PAN_MAX_SPEED } from '../../../src/features/canvas/edge-pan';

const R = { left: 100, top: 50, width: 800, height: 600 }; // 右 900 / 下 650

describe('computeEdgePanVelocity', () => {
  it('🔴 真ん中・帯の境目ちょうどは 0', () => {
    expect(computeEdgePanVelocity(500, 350, R)).toEqual({ vx: 0, vy: 0 });
    expect(computeEdgePanVelocity(100 + EDGE_PAN_MARGIN_PX, 50 + EDGE_PAN_MARGIN_PX, R)).toEqual({ vx: 0, vy: 0 });
    expect(computeEdgePanVelocity(900 - EDGE_PAN_MARGIN_PX, 650 - EDGE_PAN_MARGIN_PX, R)).toEqual({ vx: 0, vy: 0 });
  });

  it('🔴 4 辺: 左・上は負、右・下は正', () => {
    expect(computeEdgePanVelocity(105, 350, R).vx).toBeLessThan(0);
    expect(computeEdgePanVelocity(895, 350, R).vx).toBeGreaterThan(0);
    expect(computeEdgePanVelocity(500, 55, R).vy).toBeLessThan(0);
    expect(computeEdgePanVelocity(500, 645, R).vy).toBeGreaterThan(0);
    expect(computeEdgePanVelocity(895, 350, R).vy).toBe(0);
  });

  it('🔴 端に近いほど速い(滑らかに増える)/ 端ちょうどで最高速', () => {
    const a = computeEdgePanVelocity(870, 350, R).vx; // 帯に 10px
    const b = computeEdgePanVelocity(880, 350, R).vx; // 20px
    const c = computeEdgePanVelocity(890, 350, R).vx; // 30px
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(computeEdgePanVelocity(900, 350, R).vx).toBe(EDGE_PAN_MAX_SPEED);
    expect(b).toBeCloseTo(EDGE_PAN_MAX_SPEED * 0.25, 1);
  });

  it('🔴 枠の外へ出ても最高速で止める(クランプ)', () => {
    expect(computeEdgePanVelocity(5000, 350, R).vx).toBe(EDGE_PAN_MAX_SPEED);
    expect(computeEdgePanVelocity(-5000, -5000, R)).toEqual({ vx: -EDGE_PAN_MAX_SPEED, vy: -EDGE_PAN_MAX_SPEED });
  });

  it('角は両軸とも送る', () => {
    const v = computeEdgePanVelocity(898, 648, R);
    expect(v.vx).toBeGreaterThan(0);
    expect(v.vy).toBeGreaterThan(0);
  });

  it('帯と最高速は引数で変えられる / 0 や負の枠では送らない', () => {
    expect(computeEdgePanVelocity(890, 350, R, 10, 5).vx).toBe(0);
    expect(computeEdgePanVelocity(900, 350, R, 10, 5).vx).toBe(5);
    expect(computeEdgePanVelocity(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ vx: 0, vy: 0 });
  });

  it('狭い枠(帯 2 本より狭い)では帯を半分に縮め、真ん中は 0', () => {
    const narrow = { left: 0, top: 0, width: 60, height: 60 };
    expect(computeEdgePanVelocity(30, 30, narrow)).toEqual({ vx: 0, vy: 0 });
    expect(computeEdgePanVelocity(2, 30, narrow).vx).toBeLessThan(0);
    expect(computeEdgePanVelocity(58, 30, narrow).vx).toBeGreaterThan(0);
  });
});
