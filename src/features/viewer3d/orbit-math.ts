/**
 * 🔴 **球面座標のカメラ(軌道カメラ)の計算**(v4.0 Phase 3 / PR-12)。
 *
 * three の `OrbitControls` を入れずに、ここで純関数として持つ。
 * ⚠ `OrbitControls` は慣性(damping)のために rAF を回し続ける作りで、**静止時の rAF = 0** と
 *   `prefers-reduced-motion`(動きを減らす)を構造的に守れない。ここは「操作 1 回 → 状態 1 つ」で、
 *   動きは呼び側が `invalidate()` を 1 回頼むだけ ── 慣性も自動回転も持たない。
 *
 * 座標の約束は three の `Spherical` と同じ(y が上):
 *   x = r·sinφ·sinθ, y = r·cosφ, z = r·sinφ·cosθ(target からの相対)。
 *
 * ⚠ **pure module**。browser API を使わない。
 */

export type Vec3 = readonly [number, number, number];

export interface OrbitState {
  readonly target: Vec3;
  /** target からカメラまでの距離。 */
  readonly radius: number;
  /** 方位角(y 軸まわり、ラジアン)。 */
  readonly theta: number;
  /** 天頂角(y 軸からの角度、ラジアン)。0 = 真上、π = 真下。 */
  readonly phi: number;
}

export interface OrbitLimits {
  readonly minRadius: number;
  readonly maxRadius: number;
}

/** 1px あたりの回転(ラジアン)。 */
export const ORBIT_ROTATE_PER_PX = 0.01;
/** 極(真上・真下)に張り付かないための余白。 */
export const ORBIT_PHI_EPS = 0.01;
export const DEFAULT_ORBIT_LIMITS: OrbitLimits = { minRadius: 0.01, maxRadius: 100_000 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** target から見たカメラの向き(単位ベクトル)。 */
function offsetDir(state: OrbitState): Vec3 {
  const sp = Math.sin(state.phi);
  return [sp * Math.sin(state.theta), Math.cos(state.phi), sp * Math.cos(state.theta)];
}

/** カメラの位置。 */
export function orbitCameraPosition(state: OrbitState): Vec3 {
  const d = offsetDir(state);
  const [tx, ty, tz] = state.target;
  return [tx + d[0] * state.radius, ty + d[1] * state.radius, tz + d[2] * state.radius];
}

/**
 * ドラッグで回す。右へ動かすと被写体が右へ回る(カメラは左へ回り込む)。
 * ⚠ 天頂角は極の手前で止める(真上を越えて裏返らない)。
 */
export function orbitRotate(state: OrbitState, dxPx: number, dyPx: number): OrbitState {
  const theta = state.theta - finiteOr(dxPx, 0) * ORBIT_ROTATE_PER_PX;
  const phi = clamp(state.phi - finiteOr(dyPx, 0) * ORBIT_ROTATE_PER_PX, ORBIT_PHI_EPS, Math.PI - ORBIT_PHI_EPS);
  return { ...state, theta, phi };
}

/** カメラの右と上(画面の右・上に当たる世界の向き)。 */
export function orbitScreenAxes(state: OrbitState): { right: Vec3; up: Vec3 } {
  const right: Vec3 = [Math.cos(state.theta), 0, -Math.sin(state.theta)];
  const d = offsetDir(state);
  const f: Vec3 = [-d[0], -d[1], -d[2]];
  // up = right × forward
  const up: Vec3 = [
    right[1] * f[2] - right[2] * f[1],
    right[2] * f[0] - right[0] * f[2],
    right[0] * f[1] - right[1] * f[0],
  ];
  return { right, up };
}

/**
 * ドラッグで平行移動する。指の下の点がそのまま指に付いてくる量(target の距離での画面 1px の長さ)だけ動かす。
 */
export function orbitPan(
  state: OrbitState,
  dxPx: number,
  dyPx: number,
  viewportHeight: number,
  fovDeg: number,
): OrbitState {
  const h = Math.max(1, finiteOr(viewportHeight, 1));
  const perPx = (2 * state.radius * Math.tan(((finiteOr(fovDeg, 45) * Math.PI) / 180) / 2)) / h;
  const { right, up } = orbitScreenAxes(state);
  const dx = finiteOr(dxPx, 0) * perPx;
  const dy = finiteOr(dyPx, 0) * perPx;
  const [tx, ty, tz] = state.target;
  return {
    ...state,
    target: [tx - right[0] * dx + up[0] * dy, ty - right[1] * dx + up[1] * dy, tz - right[2] * dx + up[2] * dy],
  };
}

/**
 * ホイール(またはピンチ)で寄る・引く。`wheelDelta > 0` で引く(ブラウザの `deltaY` と同じ向き)。
 * ⚠ 倍率で動かす(遠くでも近くでも同じ手応え)。距離は上下で止める。
 */
export function orbitZoom(state: OrbitState, wheelDelta: number, limits: OrbitLimits = DEFAULT_ORBIT_LIMITS): OrbitState {
  const factor = Math.exp(clamp(finiteOr(wheelDelta, 0), -1000, 1000) * 0.001);
  return { ...state, radius: clamp(state.radius * factor, limits.minRadius, limits.maxRadius) };
}

/**
 * 箱(min / max)が丸ごと画面に収まる視点。斜め上から見下ろす(方位 45°、天頂 60°)。
 * ⚠ 空の箱(min > max・数でない)は原点の単位の大きさで返す。
 */
export function fitBoundsToOrbit(min: Vec3, max: Vec3, fovDeg: number, aspect: number): OrbitState {
  const ok = [0, 1, 2].every((i) => Number.isFinite(min[i]!) && Number.isFinite(max[i]!) && min[i]! <= max[i]!);
  const lo: Vec3 = ok ? min : [-0.5, -0.5, -0.5];
  const hi: Vec3 = ok ? max : [0.5, 0.5, 0.5];
  const center: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const half = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
  const sphere = Math.max(half, 1e-3);
  const vfov = (clamp(finiteOr(fovDeg, 45), 1, 179) * Math.PI) / 180;
  const a = Math.max(1e-3, finiteOr(aspect, 1));
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * a);
  const fov = Math.min(vfov, hfov);
  const radius = (sphere / Math.sin(fov / 2)) * 1.05;
  return { target: center, radius, theta: Math.PI / 4, phi: Math.PI / 3 };
}

/**
 * カメラの位置と注視点から軌道の状態を作る(` ```3d ` の `camera` 指定)。
 * ⚠ 同じ点を指したら、少し離した既定の位置にする(距離 0 で割らない)。
 */
export function orbitFromPosition(position: Vec3, target: Vec3): OrbitState {
  const dx = position[0] - target[0];
  const dy = position[1] - target[1];
  const dz = position[2] - target[2];
  const radius = Math.hypot(dx, dy, dz);
  if (!(radius > 1e-9)) return { target, radius: 5, theta: Math.PI / 4, phi: Math.PI / 3 };
  const phi = clamp(Math.acos(clamp(dy / radius, -1, 1)), ORBIT_PHI_EPS, Math.PI - ORBIT_PHI_EPS);
  const theta = Math.atan2(dx, dz);
  return { target, radius, theta, phi };
}
