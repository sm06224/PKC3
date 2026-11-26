/** @vitest-environment node */
/** 軌道カメラの純関数(v4.0 PR-12)。 */
import { describe, expect, it } from 'vitest';
import {
  ORBIT_PHI_EPS,
  fitBoundsToOrbit,
  orbitCameraPosition,
  orbitFromPosition,
  orbitPan,
  orbitRotate,
  orbitScreenAxes,
  orbitZoom,
  type OrbitState,
} from '@features/viewer3d/orbit-math';

const base: OrbitState = { target: [0, 0, 0], radius: 10, theta: 0, phi: Math.PI / 2 };

describe('orbit-math', () => {
  it('位置: θ=0, φ=π/2 なら +z 側に radius 離れる', () => {
    const p = orbitCameraPosition(base);
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(0);
    expect(p[2]).toBeCloseTo(10);
    const top = orbitCameraPosition({ ...base, phi: 0, target: [1, 2, 3] });
    expect(top).toEqual([1, 12, 3]);
  });

  it('回す: 距離と注視点は変えない・天頂角は極の手前で止まる', () => {
    const r = orbitRotate(base, 50, 0);
    expect(r.theta).toBeCloseTo(-0.5);
    expect(r.radius).toBe(10);
    expect(r.target).toEqual([0, 0, 0]);
    expect(orbitRotate(base, 0, 100000).phi).toBeCloseTo(ORBIT_PHI_EPS);
    expect(orbitRotate(base, 0, -100000).phi).toBeCloseTo(Math.PI - ORBIT_PHI_EPS);
    expect(orbitRotate(base, Number.NaN, Number.NaN)).toEqual(base);
  });

  it('画面の右と上は互いに直交し、正面からの見え方と一致する', () => {
    const { right, up } = orbitScreenAxes(base);
    expect(right[0]).toBeCloseTo(1);
    expect(up[1]).toBeCloseTo(1);
    const dot = right[0] * up[0] + right[1] * up[1] + right[2] * up[2];
    expect(dot).toBeCloseTo(0);
  });

  it('動かす: 右へドラッグすると注視点は左へ・下へドラッグすると上へ(指に付いてくる)', () => {
    const p = orbitPan(base, 100, 0, 400, 45);
    expect(p.target[0]).toBeLessThan(0);
    expect(p.radius).toBe(10);
    // 1px の長さ = 2·r·tan(fov/2) / h
    const perPx = (2 * 10 * Math.tan((45 * Math.PI) / 360)) / 400;
    expect(p.target[0]).toBeCloseTo(-100 * perPx);
    expect(orbitPan(base, 0, 100, 400, 45).target[1]).toBeCloseTo(100 * perPx);
  });

  it('寄る・引く: 向きと上下限', () => {
    expect(orbitZoom(base, 100).radius).toBeGreaterThan(10);
    expect(orbitZoom(base, -100).radius).toBeLessThan(10);
    // 1 回の量は ±1000 で止める(暴れたホイールで一気に飛ばない): 10 × e^-1
    expect(orbitZoom(base, -1e9).radius).toBeCloseTo(10 * Math.exp(-1));
    let s = base;
    for (let i = 0; i < 100; i++) s = orbitZoom(s, 1000, { minRadius: 2, maxRadius: 50 });
    expect(s.radius).toBe(50);
    for (let i = 0; i < 100; i++) s = orbitZoom(s, -1000, { minRadius: 2, maxRadius: 50 });
    expect(s.radius).toBe(2);
  });

  it('fitBoundsToOrbit: 外接球が視野に収まる距離・中心を見る', () => {
    const o = fitBoundsToOrbit([-1, -1, -1], [1, 3, 1], 45, 1);
    expect(o.target).toEqual([0, 1, 0]);
    const sphere = Math.hypot(2, 4, 2) / 2;
    // 視野の半角の正弦 × 距離 ≥ 外接球の半径
    expect(Math.sin((45 * Math.PI) / 360) * o.radius).toBeGreaterThanOrEqual(sphere);
    // 横長ほど縦の視野で決まり、縦長ほど遠くなる
    expect(fitBoundsToOrbit([-1, -1, -1], [1, 1, 1], 45, 0.3).radius).toBeGreaterThan(fitBoundsToOrbit([-1, -1, -1], [1, 1, 1], 45, 1).radius);
    // 空の箱でも数を返す
    const e = fitBoundsToOrbit([1, 1, 1], [-1, -1, -1], 45, 1);
    expect(Number.isFinite(e.radius)).toBe(true);
    expect(e.target).toEqual([0, 0, 0]);
  });

  it('orbitFromPosition は orbitCameraPosition の逆', () => {
    const o = orbitFromPosition([3, 4, 5], [1, 1, 1]);
    const p = orbitCameraPosition(o);
    expect(p[0]).toBeCloseTo(3);
    expect(p[1]).toBeCloseTo(4);
    expect(p[2]).toBeCloseTo(5);
    expect(orbitFromPosition([1, 1, 1], [1, 1, 1]).radius).toBe(5);
  });
});
