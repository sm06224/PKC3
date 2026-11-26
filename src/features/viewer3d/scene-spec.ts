/**
 * 🔴 **` ```3d ` の囲みの中身(JSON のシーン記述)を読む**(v4.0 Phase 3 / PR-12、ビジョン 1-B)。
 *
 * ```3d
 * { "objects": [ { "type": "box", "position": [0, 0.5, 0], "color": "#4a90d9" } ], "grid": true }
 * ```
 *
 * ## 守ること
 *
 * - **例外を投げない**: 書式の誤り・上限超え・外部 URL は `{ ok: false, error }`(日本語の 1 文)で返す。
 *   画面は理由を出して原文を残す(図・グラフの囲みと同じ扱い)。
 * - **ローカル完結**: `model` は `asset:鍵` だけ。`http:` / `https:` / `//` / 相対パス・`data:` も断る
 *   (囲みの中から外へ取りに行く道を作らない)。
 * - **数を抑える**: オブジェクトは 500 個まで。視野角・高さ・不透明度は範囲に収める。
 *
 * ⚠ **pure module**。browser API を使わない。2D の簡易表示に使う投影(`projectScene2d`)もここ。
 */
import { orbitCameraPosition, orbitScreenAxes, type OrbitState, type Vec3 } from './orbit-math';

export const SCENE_MAX_OBJECTS = 500;
export const SCENE_DEFAULT_HEIGHT = 360;
export const SCENE_MIN_HEIGHT = 200;
export const SCENE_MAX_HEIGHT = 720;
export const SCENE_DEFAULT_FOV = 45;
/** 色を書かなかったオブジェクトの色(落ち着いた青。テーマに依らず読める)。 */
export const SCENE_DEFAULT_COLOR = '#5b8bd9';

export type SceneObjectType = 'box' | 'sphere' | 'cylinder' | 'cone' | 'plane' | 'torus';
const OBJECT_TYPES: ReadonlySet<string> = new Set(['box', 'sphere', 'cylinder', 'cone', 'plane', 'torus']);

export interface SceneObjectSpec {
  readonly type: SceneObjectType;
  readonly position: Vec3;
  /** 度数法(x → y → z の順に回す)。 */
  readonly rotation: Vec3;
  readonly scale: Vec3;
  /** 幅・高さ・奥行き(球・円柱・円錐・トーラスは直径を幅・奥行きに、高さを高さに使う)。 */
  readonly size: Vec3;
  /** `#rrggbb`(`#rgb` は広げて持つ)。 */
  readonly color: string;
  readonly wireframe: boolean;
  /** 0.05〜1。 */
  readonly opacity: number;
  readonly label?: string;
}

export interface SceneCameraSpec {
  readonly position?: Vec3;
  readonly target?: Vec3;
  readonly fov: number;
}

export interface SceneSpec {
  /** 添付の鍵(`asset:` を外した物)。 */
  readonly modelKey?: string;
  readonly objects: readonly SceneObjectSpec[];
  readonly camera: SceneCameraSpec;
  readonly grid: boolean;
  readonly axes: boolean;
  readonly wireframe: boolean;
  /** `'theme'` か `#rrggbb`。 */
  readonly background: string;
  readonly height: number;
}

export type SceneParseResult = { ok: true; spec: SceneSpec } | { ok: false; error: string };

class SpecError extends Error {}

function fail(msg: string): never {
  throw new SpecError(msg);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function num(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where} は数で書いてください`);
  return v;
}

function vec3(v: unknown, where: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) fail(`${where} は [x, y, z] の 3 つの数で書いてください`);
  return [num(v[0], where), num(v[1], where), num(v[2], where)];
}

/** 数 1 つなら 3 軸に同じ値、配列なら 3 つ。 */
function scalarOrVec3(v: unknown, where: string): Vec3 {
  if (typeof v === 'number') {
    const n = num(v, where);
    return [n, n, n];
  }
  return vec3(v, where);
}

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#RGB` / `#RRGGBB` だけ。`#rrggbb`(小文字)へそろえる。 */
export function normalizeSceneColor(v: unknown, where: string): string {
  if (typeof v !== 'string' || !COLOR_RE.test(v)) fail(`${where} は #RGB か #RRGGBB で書いてください`);
  const hex = v.slice(1).toLowerCase();
  return hex.length === 3 ? `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}` : `#${hex}`;
}

function bool(v: unknown, where: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') fail(`${where} は true か false で書いてください`);
  return v;
}

/** `model` の値。⚠ `asset:鍵` だけを通す。 */
function modelKeyOf(v: unknown): string {
  if (typeof v !== 'string') fail('model は "asset:添付の ID" の形で書いてください');
  const s = v.trim();
  if (!/^asset:/i.test(s)) {
    fail('model に書けるのは添付(asset:添付の ID)だけです。外部の URL やファイルの場所からは読み込みません');
  }
  const key = s.slice('asset:'.length).trim();
  // ⚠ 鍵に URL・パスの形が紛れ込むのを止める(`asset:https://…` / `asset:../x`)
  if (key === '' || /[\s/\\:?#]/.test(key)) fail('model の asset: の後ろには添付の ID を書いてください');
  return key;
}

function objectOf(v: unknown, i: number): SceneObjectSpec {
  const where = `objects[${i}]`;
  if (!isObj(v)) fail(`${where} は { "type": … } の形で書いてください`);
  const type = v.type;
  if (typeof type !== 'string' || !OBJECT_TYPES.has(type)) {
    fail(`${where}.type は box / sphere / cylinder / cone / plane / torus のどれかです`);
  }
  const label = v.label;
  if (label !== undefined && typeof label !== 'string') fail(`${where}.label は文字で書いてください`);
  return {
    type: type as SceneObjectType,
    position: v.position === undefined ? [0, 0, 0] : vec3(v.position, `${where}.position`),
    rotation: v.rotation === undefined ? [0, 0, 0] : vec3(v.rotation, `${where}.rotation`),
    scale: v.scale === undefined ? [1, 1, 1] : scalarOrVec3(v.scale, `${where}.scale`),
    size: v.size === undefined ? [1, 1, 1] : scalarOrVec3(v.size, `${where}.size`),
    color: v.color === undefined ? SCENE_DEFAULT_COLOR : normalizeSceneColor(v.color, `${where}.color`),
    wireframe: bool(v.wireframe, `${where}.wireframe`, false),
    opacity: v.opacity === undefined ? 1 : clamp(num(v.opacity, `${where}.opacity`), 0.05, 1),
    ...(typeof label === 'string' && label !== '' ? { label: label.slice(0, 200) } : {}),
  };
}

function cameraOf(v: unknown): SceneCameraSpec {
  if (v === undefined) return { fov: SCENE_DEFAULT_FOV };
  if (!isObj(v)) fail('camera は { "position": …, "target": …, "fov": … } の形で書いてください');
  return {
    ...(v.position === undefined ? {} : { position: vec3(v.position, 'camera.position') }),
    ...(v.target === undefined ? {} : { target: vec3(v.target, 'camera.target') }),
    fov: v.fov === undefined ? SCENE_DEFAULT_FOV : clamp(num(v.fov, 'camera.fov'), 15, 100),
  };
}

/**
 * 🔴 **` ```3d ` の中身を読む**。例外は投げない。
 */
export function parse3dSceneSpec(src: string): SceneParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(src);
  } catch (e) {
    const detail = e instanceof Error ? e.message : '';
    return { ok: false, error: `3D シーンの JSON が読めません${detail ? `(${detail})` : ''}` };
  }
  try {
    if (!isObj(raw)) fail('3D シーンは { … } の形(JSON のオブジェクト)で書いてください');
    const hasModel = raw.model !== undefined;
    const hasObjects = raw.objects !== undefined;
    if (!hasModel && !hasObjects) fail('3D シーンには model か objects のどちらかを書いてください');
    if (hasObjects && !Array.isArray(raw.objects)) fail('objects は [ … ] の配列で書いてください');
    const list = (hasObjects ? raw.objects : []) as unknown[];
    if (list.length > SCENE_MAX_OBJECTS) {
      fail(`オブジェクトが多すぎます(${list.length} 個)。${SCENE_MAX_OBJECTS} 個までにしてください`);
    }
    const background =
      raw.background === undefined || raw.background === 'theme'
        ? 'theme'
        : normalizeSceneColor(raw.background, 'background');
    const height =
      raw.height === undefined
        ? SCENE_DEFAULT_HEIGHT
        : Math.round(clamp(num(raw.height, 'height'), SCENE_MIN_HEIGHT, SCENE_MAX_HEIGHT));
    const spec: SceneSpec = {
      ...(hasModel ? { modelKey: modelKeyOf(raw.model) } : {}),
      objects: list.map((o, i) => objectOf(o, i)),
      camera: cameraOf(raw.camera),
      grid: bool(raw.grid, 'grid', true),
      axes: bool(raw.axes, 'axes', false),
      wireframe: bool(raw.wireframe, 'wireframe', false),
      background,
      height,
    };
    return { ok: true, spec };
  } catch (e) {
    if (e instanceof SpecError) return { ok: false, error: e.message };
    return { ok: false, error: '3D シーンを読めませんでした' };
  }
}

// ───────────────────────────── 2D の簡易表示(GPU が使えない・1 枚にまとめた版)

/** 立体の大きさ(幅・高さ・奥行き)= size × scale。 */
export function objectExtent(o: SceneObjectSpec): Vec3 {
  return [o.size[0] * o.scale[0], o.size[1] * o.scale[1], o.size[2] * o.scale[2]];
}

/** 円周の点(xz 平面、半径 rx / rz、高さ y)。 */
function ring(rx: number, rz: number, y: number, n: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([Math.sin(a) * rx, y, Math.cos(a) * rz]);
  }
  return pts;
}

function loopEdges(pts: readonly Vec3[], out: Array<[Vec3, Vec3]>): void {
  for (let i = 0; i < pts.length; i++) out.push([pts[i]!, pts[(i + 1) % pts.length]!]);
}

/** 立体の線分(自分の座標、原点が中心)。 */
export function primitiveEdges(o: SceneObjectSpec): Array<[Vec3, Vec3]> {
  const [w, h, d] = objectExtent(o);
  const hw = w / 2;
  const hh = h / 2;
  const hd = d / 2;
  const out: Array<[Vec3, Vec3]> = [];
  switch (o.type) {
    case 'box': {
      const c = (x: number, y: number, z: number): Vec3 => [x * hw, y * hh, z * hd];
      const v = [c(-1, -1, -1), c(1, -1, -1), c(1, 1, -1), c(-1, 1, -1), c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)];
      for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]] as const) {
        out.push([v[a]!, v[b]!]);
      }
      break;
    }
    case 'sphere': {
      for (const t of [-0.66, 0, 0.66]) {
        const k = Math.sqrt(1 - t * t);
        loopEdges(ring(hw * k, hd * k, t * hh, 24), out);
      }
      // 経線 2 本
      const n = 24;
      for (const rot of [0, Math.PI / 2]) {
        const pts: Vec3[] = [];
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const x = Math.sin(a) * Math.cos(rot) * hw;
          const z = Math.sin(a) * Math.sin(rot) * hd;
          pts.push([x, Math.cos(a) * hh, z]);
        }
        loopEdges(pts, out);
      }
      break;
    }
    case 'cylinder':
    case 'cone': {
      const bottom = ring(hw, hd, -hh, 24);
      loopEdges(bottom, out);
      if (o.type === 'cylinder') {
        const top = ring(hw, hd, hh, 24);
        loopEdges(top, out);
        for (let i = 0; i < 24; i += 6) out.push([bottom[i]!, top[i]!]);
      } else {
        for (let i = 0; i < 24; i += 6) out.push([bottom[i]!, [0, hh, 0]]);
      }
      break;
    }
    case 'plane': {
      // three の PlaneGeometry と同じく xy 平面(奥行きなし)
      const v: Vec3[] = [[-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0], [-hw, hh, 0]];
      loopEdges(v, out);
      break;
    }
    case 'torus': {
      // 環の中心の半径 = 幅の 0.35、管の半径 = 0.15(three の TorusGeometry(0.35, 0.15) を寝かせた物と同じ形)
      const R = 0.35;
      const r = 0.15;
      loopEdges(ring((R + r) * w, (R + r) * d, 0, 32), out);
      loopEdges(ring((R - r) * w, (R - r) * d, 0, 32), out);
      loopEdges(ring(R * w, R * d, r * h, 32), out);
      loopEdges(ring(R * w, R * d, -r * h, 32), out);
      break;
    }
  }
  return out;
}

/** 度数法の回転(x → y → z の順。three の Euler 'XYZ' と同じ合成)を点に当てる。 */
export function rotateXYZ(p: Vec3, rotDeg: Vec3): Vec3 {
  const [ax, ay, az] = rotDeg.map((d) => (d * Math.PI) / 180) as [number, number, number];
  // three の Euler 'XYZ' の行列は Rx·Ry·Rz ── 点には z → y → x の順に当てる
  let [x, y, z] = p;
  // z
  let c = Math.cos(az);
  let s = Math.sin(az);
  [x, y] = [x * c - y * s, x * s + y * c];
  // y
  c = Math.cos(ay);
  s = Math.sin(ay);
  [x, z] = [x * c + z * s, -x * s + z * c];
  // x
  c = Math.cos(ax);
  s = Math.sin(ax);
  [y, z] = [y * c - z * s, y * s + z * c];
  return [x, y, z];
}

/** 世界座標の線分(色つき)。 */
export interface WorldSegment {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly color: string;
}

/** シーンの全線分(世界座標)。 */
export function sceneWorldSegments(spec: SceneSpec): WorldSegment[] {
  const out: WorldSegment[] = [];
  for (const o of spec.objects) {
    for (const [a, b] of primitiveEdges(o)) {
      const ra = rotateXYZ(a, o.rotation);
      const rb = rotateXYZ(b, o.rotation);
      out.push({
        a: [ra[0] + o.position[0], ra[1] + o.position[1], ra[2] + o.position[2]],
        b: [rb[0] + o.position[0], rb[1] + o.position[1], rb[2] + o.position[2]],
        color: o.color,
      });
    }
  }
  return out;
}

/** シーンの外接箱。オブジェクトが無ければ `null`。 */
export function sceneBounds(spec: SceneSpec): { min: Vec3; max: Vec3 } | null {
  const segs = sceneWorldSegments(spec);
  if (segs.length === 0) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const s of segs) {
    for (const p of [s.a, s.b]) {
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i]!, p[i]!);
        max[i] = Math.max(max[i]!, p[i]!);
      }
    }
  }
  return { min: min as unknown as Vec3, max: max as unknown as Vec3 };
}

/** 2D に落とした線分(画面の px)。 */
export interface ProjectedSegment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly color: string;
}

/** グリッドの線(y = 0 の床、外接箱に合わせた広さ)。 */
export function gridWorldSegments(extent: number, divisions = 10): WorldSegment[] {
  const half = extent / 2;
  const out: WorldSegment[] = [];
  for (let i = 0; i <= divisions; i++) {
    const t = -half + (extent * i) / divisions;
    out.push({ a: [t, 0, -half], b: [t, 0, half], color: '' });
    out.push({ a: [-half, 0, t], b: [half, 0, t], color: '' });
  }
  return out;
}

/**
 * 🔑 **2D の簡易表示の投影**(透視)。カメラの手前(近い面より前)に掛かる線分は落とす。
 *
 * @param orbit いまの視点(GPU の描画と同じ状態を使う ── 2D でもドラッグで回せる)。
 * @param fovDeg 縦の視野角。
 * @param extra 足す線分(グリッドなど)。色が空の線は `gridColor`。
 */
export function projectScene2d(
  spec: SceneSpec,
  width: number,
  height: number,
  orbit: OrbitState,
  opts: { fovDeg?: number; extra?: readonly WorldSegment[]; gridColor?: string } = {},
): ProjectedSegment[] {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const fov = ((opts.fovDeg ?? spec.camera.fov) * Math.PI) / 180;
  const f = h / 2 / Math.tan(fov / 2);
  const cam = orbitCameraPosition(orbit);
  const { right, up } = orbitScreenAxes(orbit);
  const t = orbit.target;
  const fwdLen = Math.hypot(t[0] - cam[0], t[1] - cam[1], t[2] - cam[2]) || 1;
  const fwd: Vec3 = [(t[0] - cam[0]) / fwdLen, (t[1] - cam[1]) / fwdLen, (t[2] - cam[2]) / fwdLen];
  const near = Math.max(1e-3, orbit.radius * 1e-3);
  const toCam = (p: Vec3): Vec3 => {
    const d: Vec3 = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]];
    return [
      d[0] * right[0] + d[1] * right[1] + d[2] * right[2],
      d[0] * up[0] + d[1] * up[1] + d[2] * up[2],
      d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2],
    ];
  };
  const out: ProjectedSegment[] = [];
  const segs = [...(opts.extra ?? []), ...sceneWorldSegments(spec)];
  for (const s of segs) {
    let a = toCam(s.a);
    let b = toCam(s.b);
    if (a[2] < near && b[2] < near) continue;
    // 近い面で切る(片方だけ手前にあるとき)
    if (a[2] < near || b[2] < near) {
      const k = (near - a[2]) / (b[2] - a[2]);
      const m: Vec3 = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, near];
      if (a[2] < near) a = m;
      else b = m;
    }
    out.push({
      x1: w / 2 + (a[0] / a[2]) * f,
      y1: h / 2 - (a[1] / a[2]) * f,
      x2: w / 2 + (b[0] / b[2]) * f,
      y2: h / 2 - (b[1] / b[2]) * f,
      color: s.color === '' ? (opts.gridColor ?? '#888888') : s.color,
    });
  }
  return out;
}
