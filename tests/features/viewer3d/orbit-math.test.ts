/** @vitest-environment node */
/** 軌道カメラの純関数(v4.0 PR-12)。 */
import { describe, expect, it } from 'vitest';
import {
  ORBIT_PHI_EPS,
  ORBIT_PRESETS,
  ORBIT_ZOOM_STEP,
  wheelDeltaPx,
  wheelZoomsStage,
  orbitPreset,
  orbitZoomStep,
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

describe('orbit-math: プリセット・ズーム段・ホイール判定', () => {
  const s: OrbitState = { target: [1, 2, 3], radius: 7, theta: 2, phi: 1 };

  it('プリセットは注視点と距離を変えず、向きだけを決める', () => {
    for (const p of ORBIT_PRESETS) {
      const r = orbitPreset(s, p);
      expect(r.target).toEqual([1, 2, 3]);
      expect(r.radius).toBe(7);
    }
    expect(orbitPreset(s, 'oblique')).toMatchObject({ theta: Math.PI / 4, phi: Math.PI / 3 });
    expect(orbitPreset(s, 'front')).toMatchObject({ theta: 0, phi: Math.PI / 2 });
    expect(orbitPreset(s, 'top')).toMatchObject({ theta: 0, phi: ORBIT_PHI_EPS });
  });

  it('正面はカメラが +z 側の水平、上面は真上(ほぼ)', () => {
    const f = orbitCameraPosition(orbitPreset({ ...s, target: [0, 0, 0] }, 'front'));
    expect(f[0]).toBeCloseTo(0);
    expect(f[1]).toBeCloseTo(0);
    expect(f[2]).toBeCloseTo(7);
    const t = orbitCameraPosition(orbitPreset({ ...s, target: [0, 0, 0] }, 'top'));
    expect(t[1]).toBeGreaterThan(6.99);
    expect(Math.hypot(t[0], t[2])).toBeLessThan(0.1);
  });

  it('3 つのプリセットは互いに違う向き', () => {
    const keys = new Set(ORBIT_PRESETS.map((p) => JSON.stringify([orbitPreset(s, p).theta, orbitPreset(s, p).phi])));
    expect(keys.size).toBe(3);
  });

  it('ズームの段: +1 で寄り、-1 で引く(逆向きで元に戻る)', () => {
    const near = orbitZoomStep(s, 1);
    const far = orbitZoomStep(s, -1);
    expect(near.radius).toBeLessThan(s.radius);
    expect(far.radius).toBeGreaterThan(s.radius);
    expect(orbitZoomStep(near, -1).radius).toBeCloseTo(s.radius);
    expect(near.radius).toBeCloseTo(s.radius * Math.exp(-ORBIT_ZOOM_STEP * 0.001));
  });

  it('ホイール判定: Ctrl/⌘ か有効化済みのときだけズームする', () => {
    expect(wheelZoomsStage(false, false)).toBe(false);
    expect(wheelZoomsStage(true, false)).toBe(true);
    expect(wheelZoomsStage(false, true)).toBe(true);
    expect(wheelZoomsStage(true, true)).toBe(true);
  });

  it('deltaY の単位換算', () => {
    expect(wheelDeltaPx(10, 0)).toBe(10);
    expect(wheelDeltaPx(3, 1)).toBe(48);
    expect(wheelDeltaPx(1, 2)).toBe(100);
    expect(wheelDeltaPx(Number.NaN, 0)).toBe(0);
  });
});
