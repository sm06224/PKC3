/**
 * 🔴 **関係グラフの大規模表示(GPU)と 3D 表示の配置・投影・当たり判定**(v4.0 Phase 3 / PR-13、ビジョン 1-C)。
 *
 * `graph-view.ts` が組んだ図(`GraphView`)を、GPU で描く 2D の平面 / 3D の空間の座標に置き直す **単一の正本**。
 * 描画(`adapter/ui/render/graph-gpu.ts`)は GPU(Three.js の InstancedMesh)と 2D の Canvas の 2 通りがあり、
 * どちらも **ここの `projectGraphPoints` と `pickGraphNode` を通して**押された節点を決める
 * ── 描き方が違っても、押して当たる節点は 1 つの計算で決まる(Three.js 抜きで test できる)。
 *
 * ## 座標の約束
 *
 * - 2D(`gpu2d`): `x, y` は 0..1 の比(`graph-view.ts` の配置そのまま)、`z = 0`。画面では
 *   `(x·幅, y·高さ)` をワールドの px とし、カメラ(`CanvasCamera`)で `(ワールド − カメラ)·倍率` へ写す
 *   ── 従来の DOM の図(`stageTransform`)と同じ計算。
 * - 3D(`gpu3d`): 原点のまわり、半径およそ 1 の空間。y が上(three と同じ)。カメラは `orbit-math.ts` の軌道カメラ。
 *
 * ⚠ **pure module** ── browser API・時計・乱数を使わない(同じ入力は同じ座標)。
 */
import type { CanvasCamera } from '@features/canvas/viewport';
import {
  fitBoundsToOrbit,
  orbitCameraPosition,
  orbitScreenAxes,
  type OrbitState,
  type Vec3,
} from '@features/viewer3d/orbit-math';
import type { GraphView } from './graph-view';

/** 関係グラフの描き方。`dom` = 従来の 2D(上限 60 件・Three.js を読まない)。 */
export type GraphRenderMode = 'dom' | 'gpu2d' | 'gpu3d';
export const DEFAULT_GRAPH_RENDER_MODE: GraphRenderMode = 'dom';
/** 3D 表示の視野角(度)。 */
export const GRAPH_3D_FOV = 50;
/** 当たり判定の半径(px)── 小さな点でも指で押せる大きさ。 */
export const GRAPH_HIT_RADIUS_PX = 10;

export function isGraphRenderMode(v: unknown): v is GraphRenderMode {
  return v === 'dom' || v === 'gpu2d' || v === 'gpu3d';
}

export interface GraphPoint3d {
  readonly lid: string;
  readonly title: string;
  /** 中心からの手数(全体の図では 1)。 */
  readonly ring: number;
  /** つながりの数(図の中の辺の数)。 */
  readonly degree: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 図の中の辺の数(節点ごと)。 */
export function graphDegrees(view: GraphView): Map<string, number> {
  const deg = new Map<string, number>();
  for (const n of view.nodes) deg.set(n.lid, 0);
  for (const e of view.edges) {
    if (deg.has(e.fromLid)) deg.set(e.fromLid, deg.get(e.fromLid)! + 1);
    if (deg.has(e.toLid)) deg.set(e.toLid, deg.get(e.toLid)! + 1);
  }
  return deg;
}

/** 2D の平面(`z = 0`)の点。`x, y` は `graph-view.ts` の比のまま。 */
export function buildGraph2dPoints(view: GraphView): readonly GraphPoint3d[] {
  const deg = graphDegrees(view);
  return view.nodes.map((n) => ({
    lid: n.lid,
    title: n.title,
    ring: n.ring,
    degree: deg.get(n.lid) ?? 0,
    x: n.x,
    y: n.y,
    z: 0,
  }));
}

const GOLDEN = 2.399963229728653;

/**
 * 3D の空間の点。
 *
 * - **中心あり**(`centerLid` が図に在る): 中心は原点。手数 `r` の節点は半径 `r / 最大の手数` の球殻に、
 *   フィボナッチ球(黄金角)で等しく散らす ── 遠いほど外側の殻。
 * - **全体**(`centerLid === null`): 2D の配置を中心へ寄せて xy の平面に置き、つながりの多い節点ほど平面の近く、
 *   少ない節点ほど黄金角の位相で奥行き(z)へ広げる ── 中心の塊が見通せる立体にする。
 */
export function buildGraph3dPoints(view: GraphView, centerLid: string | null): readonly GraphPoint3d[] {
  const deg = graphDegrees(view);
  const hasCenter = centerLid !== null && view.nodes.some((n) => n.lid === centerLid);
  if (hasCenter) {
    const maxRing = Math.max(1, ...view.nodes.map((n) => n.ring));
    const counts = new Map<number, number>();
    for (const n of view.nodes) counts.set(n.ring, (counts.get(n.ring) ?? 0) + 1);
    const seen = new Map<number, number>();
    return view.nodes.map((n) => {
      const d = deg.get(n.lid) ?? 0;
      if (n.lid === centerLid || n.ring === 0) {
        return { lid: n.lid, title: n.title, ring: 0, degree: d, x: 0, y: 0, z: 0 };
      }
      const total = counts.get(n.ring) ?? 1;
      const i = seen.get(n.ring) ?? 0;
      seen.set(n.ring, i + 1);
      const radius = n.ring / maxRing;
      // フィボナッチ球: 高さを等間隔に刻み、方位を黄金角で回す(殻ごとに半歩ずらす)
      const h = total === 1 ? 0 : 1 - (2 * (i + 0.5)) / total;
      const ring = Math.sqrt(Math.max(0, 1 - h * h));
      const a = (i + (n.ring % 2 === 0 ? 0.5 : 0)) * GOLDEN;
      return {
        lid: n.lid,
        title: n.title,
        ring: n.ring,
        degree: d,
        x: Math.cos(a) * ring * radius,
        y: h * radius,
        z: Math.sin(a) * ring * radius,
      };
    });
  }
  const maxDeg = Math.max(1, ...view.nodes.map((n) => deg.get(n.lid) ?? 0));
  return view.nodes.map((n, i) => {
    const d = deg.get(n.lid) ?? 0;
    // 0 = いちばんつながりが多い、1 = いちばん少ない
    const loose = 1 - d / maxDeg;
    return {
      lid: n.lid,
      title: n.title,
      ring: n.ring,
      degree: d,
      x: (n.x - 0.5) * 2,
      // ⚠ 画面の下向き(y)を、上向き(three の y)へ返す
      y: (0.5 - n.y) * 2,
      z: Math.sin(i * GOLDEN) * (0.15 + 0.6 * loose),
    };
  });
}

/** 3D の点が丸ごと収まる最初の視点。 */
export function graphHomeOrbit(points: readonly GraphPoint3d[], aspect: number): OrbitState {
  if (points.length === 0) return fitBoundsToOrbit([-1, -1, -1], [1, 1, 1], GRAPH_3D_FOV, aspect);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    const v = [p.x, p.y, p.z];
    for (let k = 0; k < 3; k += 1) {
      if (v[k]! < min[k]!) min[k] = v[k]!;
      if (v[k]! > max[k]!) max[k] = v[k]!;
    }
  }
  return fitBoundsToOrbit(min, max, GRAPH_3D_FOV, aspect);
}

export interface ProjectedGraphPoint {
  readonly lid: string;
  /** 画面の座標(px、描画面の左上が原点)。 */
  readonly sx: number;
  readonly sy: number;
  /** 奥行き(小さいほど手前)。2D は 0。 */
  readonly depth: number;
  /** 1px あたりのワールドの長さの逆数(3D の遠近で点の大きさを変えるのに使う)。2D は倍率。 */
  readonly scale: number;
  /** 画面に映るか(カメラの後ろ・画面の外は `false`)。 */
  readonly visible: boolean;
}

/** 画面の外でも、節点の半径ぶんは「映る」とみなす余白(px)。 */
const VIEW_MARGIN_PX = 24;

/**
 * 🔴 **点を画面へ写す**(GPU の描画・2D の Canvas・当たり判定が共有する 1 本)。
 *
 * @param orbit `gpu3d` の軌道カメラ(`gpu2d` では使わない)
 * @param camera2d `gpu2d` のカメラ(`gpu3d` では使わない)
 */
export function projectGraphPoints(
  points: readonly GraphPoint3d[],
  orbit: OrbitState | null,
  width: number,
  height: number,
  mode: Exclude<GraphRenderMode, 'dom'>,
  camera2d: CanvasCamera,
  fovDeg: number = GRAPH_3D_FOV,
): ProjectedGraphPoint[] {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const inView = (sx: number, sy: number): boolean =>
    sx >= -VIEW_MARGIN_PX && sx <= w + VIEW_MARGIN_PX && sy >= -VIEW_MARGIN_PX && sy <= h + VIEW_MARGIN_PX;
  if (mode === 'gpu2d' || orbit === null) {
    const z = camera2d.zoom;
    return points.map((p) => {
      const sx = (p.x * w - camera2d.x) * z;
      const sy = (p.y * h - camera2d.y) * z;
      return { lid: p.lid, sx, sy, depth: 0, scale: z, visible: Number.isFinite(sx + sy) && inView(sx, sy) };
    });
  }
  const fov = (Math.min(179, Math.max(1, fovDeg)) * Math.PI) / 180;
  const f = h / 2 / Math.tan(fov / 2);
  const cam = orbitCameraPosition(orbit);
  const { right, up } = orbitScreenAxes(orbit);
  const t = orbit.target;
  const fl = Math.hypot(t[0] - cam[0], t[1] - cam[1], t[2] - cam[2]) || 1;
  const fwd: Vec3 = [(t[0] - cam[0]) / fl, (t[1] - cam[1]) / fl, (t[2] - cam[2]) / fl];
  const near = Math.max(1e-4, orbit.radius * 1e-3);
  return points.map((p) => {
    const d0 = p.x - cam[0];
    const d1 = p.y - cam[1];
    const d2 = p.z - cam[2];
    const cx = d0 * right[0] + d1 * right[1] + d2 * right[2];
    const cy = d0 * up[0] + d1 * up[1] + d2 * up[2];
    const cz = d0 * fwd[0] + d1 * fwd[1] + d2 * fwd[2];
    if (!(cz > near)) return { lid: p.lid, sx: NaN, sy: NaN, depth: cz, scale: 0, visible: false };
    const sx = w / 2 + (cx * f) / cz;
    const sy = h / 2 - (cy * f) / cz;
    return { lid: p.lid, sx, sy, depth: cz, scale: f / cz, visible: inView(sx, sy) };
  });
}

/**
 * 🔴 **ポインタの下の節点**。`hitRadiusPx` 以内で、いちばん手前(奥行きが最小)の節点の lid。
 * 奥行きが同じなら近いほう、それも同じなら先に在るほう。無ければ `null`。
 */
export function pickGraphNode(
  projected: readonly ProjectedGraphPoint[],
  pointerX: number,
  pointerY: number,
  hitRadiusPx: number = GRAPH_HIT_RADIUS_PX,
): string | null {
  if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) return null;
  const r2 = hitRadiusPx * hitRadiusPx;
  let best: ProjectedGraphPoint | null = null;
  let bestD2 = Infinity;
  for (const p of projected) {
    if (!p.visible) continue;
    const dx = p.sx - pointerX;
    const dy = p.sy - pointerY;
    const d2 = dx * dx + dy * dy;
    if (!(d2 <= r2)) continue;
    if (best === null || p.depth < best.depth || (p.depth === best.depth && d2 < bestD2)) {
      best = p;
      bestD2 = d2;
    }
  }
  return best?.lid ?? null;
}
