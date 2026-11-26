/**
 * 🔴 **関係グラフの大規模表示(GPU)と 3D の配置・投影・当たり判定**(v4.0 Phase 3 / PR-13、ビジョン 1-C)。
 *
 * 守る主張:
 * 1. 2D の点は `graph-view.ts` の比そのまま(z = 0)、3D の点は決定的(同じ入力は同じ座標)
 * 2. 3D の中心ありは「中心 = 原点・手数が増えるほど外の殻」、全体は平面 + 奥行きへの広がり
 * 3. 投影は 2D なら従来の図と同じ計算(`worldToScreen`)、3D なら `orbit-math` の軌道カメラと同じ向き
 * 4. 当たり判定は半径の内側で**いちばん手前**(奥行き最小)、外れ・画面外・カメラの後ろは `null`
 * 5. 1,000 件でも配置 + 投影 + 当たり判定が速い
 */
import { describe, expect, it } from 'vitest';
import { buildGraphView, GRAPH_GPU_MAX_NODES, type GraphView } from '../../src/features/relation/graph-view';
import {
  buildGraph2dPoints,
  buildGraph3dPoints,
  DEFAULT_GRAPH_RENDER_MODE,
  GRAPH_3D_FOV,
  graphDegrees,
  graphHomeOrbit,
  isGraphRenderMode,
  pickGraphNode,
  projectGraphPoints,
  type GraphPoint3d,
  type ProjectedGraphPoint,
} from '../../src/features/relation/graph-gpu-layout';
import { DEFAULT_CAMERA, worldToScreen } from '../../src/features/canvas/viewport';
import { orbitRotate, orbitZoom, type OrbitState } from '../../src/features/viewer3d/orbit-math';

const titles = (lids: string[]) => {
  const m = new Map(lids.map((l) => [l, `題:${l}`]));
  return { has: (l: string) => m.has(l), get: (l: string) => m.get(l) };
};
const e = (a: string, b: string, kind = 'semantic') => ({ fromLid: a, toLid: b, kind });

function bigGraph(n: number) {
  const lids = Array.from({ length: n }, (_, i) => `n${String(i).padStart(4, '0')}`);
  const edges = lids.flatMap((l, i) => [e(l, lids[(i + 1) % n]!), ...(i % 7 === 0 ? [e(l, lids[(i * 13 + 5) % n]!)] : [])]);
  return { lids, edges, t: titles(lids) };
}

const star: GraphView = buildGraphView({
  center: 'c',
  depth: 3,
  edges: [e('c', 'a'), e('c', 'b'), e('a', 'x'), e('x', 'y'), e('b', 'z')],
  titles: titles(['c', 'a', 'b', 'x', 'y', 'z']),
});

describe('描き方の型', () => {
  it('既定は dom、判定は 3 値だけ', () => {
    expect(DEFAULT_GRAPH_RENDER_MODE).toBe('dom');
    expect(['dom', 'gpu2d', 'gpu3d'].every(isGraphRenderMode)).toBe(true);
    expect(isGraphRenderMode('3d')).toBe(false);
    expect(isGraphRenderMode(null)).toBe(false);
  });
});

describe('2D の点', () => {
  it('graph-view の比そのまま・z = 0・つながりの数を持つ', () => {
    const pts = buildGraph2dPoints(star);
    expect(pts.map((p) => [p.lid, p.x, p.y])).toEqual(star.nodes.map((n) => [n.lid, n.x, n.y]));
    expect(pts.every((p) => p.z === 0)).toBe(true);
    const deg = graphDegrees(star);
    expect(deg.get('c')).toBe(2);
    expect(deg.get('x')).toBe(2);
    expect(pts.find((p) => p.lid === 'y')!.degree).toBe(1);
  });
});

describe('3D の点', () => {
  it('中心あり: 中心は原点、手数が増えるほど外の殻(半径は手数 / 最大の手数)', () => {
    const pts = buildGraph3dPoints(star, 'c');
    const at = new Map(pts.map((p) => [p.lid, p]));
    expect([at.get('c')!.x, at.get('c')!.y, at.get('c')!.z]).toEqual([0, 0, 0]);
    const r = (p: GraphPoint3d) => Math.hypot(p.x, p.y, p.z);
    const maxRing = Math.max(...pts.map((p) => p.ring));
    for (const p of pts) {
      if (p.ring === 0) continue;
      expect(r(p)).toBeCloseTo(p.ring / maxRing, 9);
    }
    expect(r(at.get('y')!)).toBeGreaterThan(r(at.get('x')!));
    expect(r(at.get('x')!)).toBeGreaterThan(r(at.get('a')!));
  });
  it('中心あり: 同じ殻の節点は重ならない', () => {
    const { lids, edges, t } = bigGraph(300);
    const v = buildGraphView({ center: lids[0]!, depth: 6, edges, titles: t, maxNodes: GRAPH_GPU_MAX_NODES });
    const pts = buildGraph3dPoints(v, lids[0]!);
    const keys = new Set(pts.map((p) => `${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}`));
    expect(keys.size).toBe(pts.length);
  });
  it('全体: x / y は 2D の配置を中心へ寄せた形、つながりの多い節点ほど平面(z = 0)の近く', () => {
    const { edges, t } = bigGraph(200);
    // 1 つだけ、つながりの多いハブを足す
    const hubEdges = [...edges, ...Array.from({ length: 30 }, (_, i) => e('n0000', `n${String(i * 5 + 3).padStart(4, '0')}`))];
    const v = buildGraphView({ center: null, depth: 2, edges: hubEdges, titles: t, maxNodes: GRAPH_GPU_MAX_NODES });
    const pts = buildGraph3dPoints(v, null);
    for (const [i, p] of pts.entries()) {
      expect(p.x).toBeCloseTo((v.nodes[i]!.x - 0.5) * 2, 12);
      expect(p.y).toBeCloseTo((0.5 - v.nodes[i]!.y) * 2, 12);
    }
    const hub = pts.find((p) => p.lid === 'n0000')!;
    const maxZ = Math.max(...pts.map((p) => Math.abs(p.z)));
    expect(Math.abs(hub.z)).toBeLessThanOrEqual(0.15 + 1e-9);
    expect(maxZ).toBeGreaterThan(0.4); // 立体に広がっている(平面に潰れていない)
  });
  it('決定的: 同じ入力は同じ座標(乱数を使わない)', () => {
    const { edges, t } = bigGraph(500);
    const v = buildGraphView({ center: null, depth: 2, edges, titles: t, maxNodes: GRAPH_GPU_MAX_NODES });
    expect(buildGraph3dPoints(v, null)).toEqual(buildGraph3dPoints(v, null));
    expect(buildGraph3dPoints(star, 'c')).toEqual(buildGraph3dPoints(star, 'c'));
  });
  it('中心が図に居なければ全体の置き方にする', () => {
    const pts = buildGraph3dPoints(star, 'missing');
    expect(pts.some((p) => p.x !== 0 || p.y !== 0)).toBe(true);
    expect(pts.find((p) => p.lid === 'c')!.x).toBeCloseTo((star.nodes[0]!.x - 0.5) * 2, 12);
  });
  it('最初の視点は全部の点が画面に映る', () => {
    const pts = buildGraph3dPoints(star, 'c');
    const home = graphHomeOrbit(pts, 400 / 328);
    const pr = projectGraphPoints(pts, home, 400, 328, 'gpu3d', DEFAULT_CAMERA);
    expect(pr.every((p) => p.visible)).toBe(true);
  });
});

describe('投影', () => {
  it('2D は従来の図と同じ計算(x·幅, y·高さ をカメラで写す)', () => {
    const pts = buildGraph2dPoints(star);
    const cam = { x: 30, y: -12, zoom: 1.7 };
    const pr = projectGraphPoints(pts, null, 400, 328, 'gpu2d', cam);
    for (const [i, p] of pts.entries()) {
      const s = worldToScreen(cam, p.x * 400, p.y * 328);
      expect(pr[i]!.sx).toBeCloseTo(s.x, 9);
      expect(pr[i]!.sy).toBeCloseTo(s.y, 9);
      expect(pr[i]!.depth).toBe(0);
    }
  });
  it('2D: 画面の外は visible = false', () => {
    const pts: GraphPoint3d[] = [{ lid: 'a', title: '', ring: 1, degree: 0, x: 0.5, y: 0.5, z: 0 }];
    expect(projectGraphPoints(pts, null, 400, 300, 'gpu2d', DEFAULT_CAMERA)[0]!.visible).toBe(true);
    expect(projectGraphPoints(pts, null, 400, 300, 'gpu2d', { x: 1000, y: 0, zoom: 1 })[0]!.visible).toBe(false);
  });
  it('3D: 注視点は画面の真ん中、手前の点ほど奥行きが小さい', () => {
    const orbit: OrbitState = { target: [0, 0, 0], radius: 5, theta: 0, phi: Math.PI / 2 };
    // theta = 0, phi = π/2 → カメラは +z 側から原点を見る
    const pts: GraphPoint3d[] = [
      { lid: 'mid', title: '', ring: 1, degree: 0, x: 0, y: 0, z: 0 },
      { lid: 'near', title: '', ring: 1, degree: 0, x: 0, y: 0, z: 2 },
      { lid: 'right', title: '', ring: 1, degree: 0, x: 1, y: 0, z: 0 },
      { lid: 'up', title: '', ring: 1, degree: 0, x: 0, y: 1, z: 0 },
      { lid: 'behind', title: '', ring: 1, degree: 0, x: 0, y: 0, z: 9 },
    ];
    const pr = projectGraphPoints(pts, orbit, 400, 300, 'gpu3d', DEFAULT_CAMERA, GRAPH_3D_FOV);
    const at = new Map(pr.map((p) => [p.lid, p]));
    expect(at.get('mid')!.sx).toBeCloseTo(200, 9);
    expect(at.get('mid')!.sy).toBeCloseTo(150, 9);
    expect(at.get('near')!.depth).toBeLessThan(at.get('mid')!.depth);
    expect(at.get('right')!.sx).toBeGreaterThan(200); // 右は右へ
    expect(at.get('up')!.sy).toBeLessThan(150); // 上は上へ
    expect(at.get('behind')!.visible).toBe(false); // カメラの後ろ
  });
  it('3D: orbit-math で回す・寄ると画面の位置が変わる(軌道カメラと連動)', () => {
    const pts = buildGraph3dPoints(star, 'c');
    const home = graphHomeOrbit(pts, 1);
    const a = projectGraphPoints(pts, home, 300, 300, 'gpu3d', DEFAULT_CAMERA);
    const b = projectGraphPoints(pts, orbitRotate(home, 40, 0), 300, 300, 'gpu3d', DEFAULT_CAMERA);
    const c = projectGraphPoints(pts, orbitZoom(home, -300), 300, 300, 'gpu3d', DEFAULT_CAMERA);
    const ay = a.find((p) => p.lid === 'a')!;
    expect(b.find((p) => p.lid === 'a')!.sx).not.toBeCloseTo(ay.sx, 3);
    // 寄ると、中心から離れた点は画面の真ん中からさらに離れる
    const dist = (p: ProjectedGraphPoint) => Math.hypot(p.sx - 150, p.sy - 150);
    expect(dist(c.find((p) => p.lid === 'y')!)).toBeGreaterThan(dist(a.find((p) => p.lid === 'y')!));
  });
});

describe('🔴 当たり判定(pickGraphNode)', () => {
  const P = (lid: string, sx: number, sy: number, depth: number, visible = true): ProjectedGraphPoint => ({
    lid,
    sx,
    sy,
    depth,
    scale: 1,
    visible,
  });
  it('半径の内側で、いちばん手前(奥行き最小)を返す ── 近さより手前が勝つ', () => {
    const pr = [P('far-but-close', 100, 100, 9), P('near', 106, 100, 2), P('mid', 103, 100, 5)];
    expect(pickGraphNode(pr, 100, 100, 10)).toBe('near');
  });
  it('奥行きが同じなら近いほう', () => {
    const pr = [P('b', 108, 100, 0), P('a', 102, 100, 0)];
    expect(pickGraphNode(pr, 100, 100, 10)).toBe('a');
  });
  it('半径ちょうどは当たり、外は外れ', () => {
    expect(pickGraphNode([P('a', 110, 100, 0)], 100, 100, 10)).toBe('a');
    expect(pickGraphNode([P('a', 110.01, 100, 0)], 100, 100, 10)).toBeNull();
  });
  it('映っていない点(画面外・カメラの後ろ・NaN)は当たらない', () => {
    expect(pickGraphNode([P('a', 100, 100, 0, false)], 100, 100, 10)).toBeNull();
    expect(pickGraphNode([P('a', NaN, NaN, 0)], 100, 100, 10)).toBeNull();
    expect(pickGraphNode([P('a', 100, 100, 0)], NaN, 100, 10)).toBeNull();
  });
  it('3D の実物: 手前の節点が奥の節点に重なる所を押すと、手前が選ばれる', () => {
    const orbit: OrbitState = { target: [0, 0, 0], radius: 5, theta: 0, phi: Math.PI / 2 };
    const pts: GraphPoint3d[] = [
      { lid: 'back', title: '', ring: 1, degree: 0, x: 0, y: 0, z: -1 },
      { lid: 'front', title: '', ring: 1, degree: 0, x: 0, y: 0, z: 1 },
    ];
    const pr = projectGraphPoints(pts, orbit, 400, 300, 'gpu3d', DEFAULT_CAMERA);
    expect(pickGraphNode(pr, 200, 150)).toBe('front');
    // 裏から見れば逆
    const back = projectGraphPoints(pts, { ...orbit, theta: Math.PI }, 400, 300, 'gpu3d', DEFAULT_CAMERA);
    expect(pickGraphNode(back, 200, 150)).toBe('back');
  });
});

describe('1,000 件の速さ', () => {
  it('配置(2D の格子の力学配置)+ 3D の点 + 投影 + 当たり判定が速い', () => {
    const { edges, t } = bigGraph(1000);
    const t0 = performance.now();
    const v = buildGraphView({ center: null, depth: 2, edges, titles: t, maxNodes: GRAPH_GPU_MAX_NODES });
    const t1 = performance.now();
    const pts = buildGraph3dPoints(v, null);
    const home = graphHomeOrbit(pts, 1.2);
    let hit: string | null = null;
    for (let i = 0; i < 60; i += 1) {
      const pr = projectGraphPoints(pts, orbitRotate(home, i, 0), 800, 650, 'gpu3d', DEFAULT_CAMERA);
      hit = pickGraphNode(pr, pr[0]!.sx, pr[0]!.sy) ?? hit;
    }
    const t2 = performance.now();
    expect(v.nodes).toHaveLength(1000);
    expect(hit).not.toBeNull();
    // ⚠ 上限は CI の遅い箱でも通る値。手元の実測は配置 10ms 前後・投影 60 回で数 ms
    expect(t1 - t0).toBeLessThan(400);
    expect((t2 - t1) / 60).toBeLessThan(20);
  });
});
