/**
 * 🔴 **関係グラフの図を組む**(#281 ①)。
 * 見るのは:①手先の数が効く(1 手と 3 手で節点が違う)②全体は辺を持つものだけ・多い順
 * ③上限で切ったら truncated と total が言う ④同じ入力は同じ配置(乱数を使わない)
 * ⑤座標は 0..1 の枠に収まり重なり合わない(全部が 1 点に潰れない)。
 */
import { describe, expect, it } from 'vitest';
import {
  buildGraphView,
  clampGraphDepth,
  GRAPH_DEFAULT_DEPTH,
  GRAPH_GPU_MAX_NODES,
  GRAPH_MAX_DEPTH,
  GRAPH_MAX_NODES,
} from '../../src/features/relation/graph-view';

/** PR-13 の前の `graph-view.ts`(origin/main 07d4fb7)で取った座標の指紋。 */
const GOLDEN_60 = '94e364ce';
const GOLDEN_23 = '5d07e497';

const titles = (lids: string[]) => {
  const m = new Map(lids.map((l) => [l, `題:${l}`]));
  return { has: (l: string) => m.has(l), get: (l: string) => m.get(l) };
};
const e = (a: string, b: string, kind = 'semantic') => ({ fromLid: a, toLid: b, kind });
/** a-b-c-d-e-f の鎖。 */
const chain = ['a', 'b', 'c', 'd', 'e', 'f'];
const chainEdges = chain.slice(1).map((l, i) => e(chain[i]!, l));

describe('手先の数', () => {
  it('1 手と 3 手で届く節点が違う(手先の数が効いている)', () => {
    const t = titles(chain);
    const one = buildGraphView({ center: 'a', depth: 1, edges: chainEdges, titles: t });
    const three = buildGraphView({ center: 'a', depth: 3, edges: chainEdges, titles: t });
    expect(one.nodes.map((n) => n.lid)).toEqual(['a', 'b']);
    expect(three.nodes.map((n) => n.lid)).toEqual(['a', 'b', 'c', 'd']);
    expect(three.nodes.map((n) => n.ring)).toEqual([0, 1, 2, 3]);
    expect(three.truncated).toBe(false);
  });
  it('丸め: 範囲外・NaN', () => {
    expect(clampGraphDepth(0)).toBe(1);
    expect(clampGraphDepth(99)).toBe(GRAPH_MAX_DEPTH);
    expect(clampGraphDepth(Number.NaN)).toBe(GRAPH_DEFAULT_DEPTH);
    expect(clampGraphDepth(2.9)).toBe(2);
  });
  it('消えたノートを中心にすると空', () => {
    const v = buildGraphView({ center: 'zzz', depth: 2, edges: chainEdges, titles: titles(chain) });
    expect(v.nodes).toEqual([]);
  });
  it('片端が消えた辺は辿らない・自分への辺は無視する', () => {
    const v = buildGraphView({
      center: 'a',
      depth: 3,
      edges: [e('a', 'ghost'), e('a', 'a'), e('a', 'b')],
      titles: titles(['a', 'b']),
    });
    expect(v.nodes.map((n) => n.lid)).toEqual(['a', 'b']);
    expect(v.edges).toHaveLength(1);
  });
});

describe('上限', () => {
  const many = Array.from({ length: 10 }, (_, i) => `n${i}`);
  const star = many.map((l) => e('hub', l));
  const t = titles(['hub', ...many]);
  it('中心あり: 上限で切り、切った旨と全体の数を返す', () => {
    const v = buildGraphView({ center: 'hub', depth: 1, edges: star, titles: t, maxNodes: 4 });
    expect(v.nodes).toHaveLength(4);
    expect(v.truncated).toBe(true);
    expect(v.total).toBe(11);
    // 辺は両端が残ったものだけ(宙に浮く線を作らない)
    expect(v.edges).toHaveLength(3);
  });
  it('全体: つながりの多い順に取り、切った旨を返す', () => {
    const v = buildGraphView({ center: null, depth: 2, edges: star, titles: t, maxNodes: 3 });
    expect(v.nodes[0]!.lid).toBe('hub');
    expect(v.nodes).toHaveLength(3);
    expect(v.truncated).toBe(true);
    expect(v.total).toBe(11);
  });
  it('上限に収まれば truncated は偽', () => {
    const v = buildGraphView({ center: null, depth: 2, edges: star, titles: t });
    expect(v.truncated).toBe(false);
    expect(v.nodes).toHaveLength(11);
  });
});

describe('全体の配置', () => {
  const lids = Array.from({ length: 12 }, (_, i) => `n${i}`);
  const edges = lids.slice(1).map((l, i) => e(lids[i]!, l));
  const view = () => buildGraphView({ center: null, depth: 2, edges, titles: titles(lids) });
  it('辺を持たないノートは出ない', () => {
    const v = buildGraphView({ center: null, depth: 2, edges: [e('a', 'b')], titles: titles(['a', 'b', 'lonely']) });
    expect(v.nodes.map((n) => n.lid).sort()).toEqual(['a', 'b']);
    expect(buildGraphView({ center: null, depth: 2, edges: [], titles: titles(['a']) }).nodes).toEqual([]);
  });
  it('同じ入力は同じ座標(乱数を使わない)', () => {
    expect(view()).toEqual(view());
  });
  it('座標は枠に収まり、節点は 1 点に潰れない', () => {
    const v = view();
    for (const n of v.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(1);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(1);
    }
    let min = Infinity;
    for (let i = 0; i < v.nodes.length; i += 1)
      for (let j = i + 1; j < v.nodes.length; j += 1)
        min = Math.min(min, Math.hypot(v.nodes[i]!.x - v.nodes[j]!.x, v.nodes[i]!.y - v.nodes[j]!.y));
    expect(min, '2 つの節点が重なっている').toBeGreaterThan(0.01);
    // 枠いっぱいに広がっている(対照: 全部が中央に固まっていない)
    const xs = v.nodes.map((n) => n.x);
    const ys = v.nodes.map((n) => n.y);
    expect(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))).toBeGreaterThan(0.6);
  });
  it('1 本だけの辺でも 2 節点が別の場所に出る', () => {
    const v = buildGraphView({ center: null, depth: 2, edges: [e('a', 'b')], titles: titles(['a', 'b']) });
    expect(v.nodes).toHaveLength(2);
    expect(v.nodes[0]!.x === v.nodes[1]!.x && v.nodes[0]!.y === v.nodes[1]!.y).toBe(false);
  });
});

/** 決まった形の大きな図(n 節点の環 + 弦)。乱数を使わない。 */
function bigGraph(n: number) {
  const lids = Array.from({ length: n }, (_, i) => `n${String(i).padStart(4, '0')}`);
  const edges = lids.flatMap((l, i) => [e(l, lids[(i + 1) % n]!), ...(i % 7 === 0 ? [e(l, lids[(i * 13 + 5) % n]!)] : [])]);
  return { lids, edges, t: titles(lids) };
}

/** 座標の指紋(FNV-1a。小数 9 桁で丸める)。 */
function digest(view: { nodes: readonly { lid: string; x: number; y: number }[] }): string {
  let h = 0x811c9dc5;
  for (const c of view.nodes.map((p) => `${p.lid}:${p.x.toFixed(9)},${p.y.toFixed(9)}`).join('|')) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

describe('🔴 大規模表示の上限(v4.0 PR-13)', () => {
  it('GRAPH_GPU_MAX_NODES は 1000、既定の上限は 60 のまま', () => {
    expect(GRAPH_GPU_MAX_NODES).toBe(1000);
    expect(GRAPH_MAX_NODES).toBe(60);
  });
  it('既定では 60 件で切り、maxNodes = GRAPH_GPU_MAX_NODES なら 1000 件まで描く(切った旨も言う)', () => {
    const { edges, t } = bigGraph(1200);
    const small = buildGraphView({ center: null, depth: 2, edges, titles: t });
    expect(small.nodes).toHaveLength(60);
    expect(small.truncated).toBe(true);
    const big = buildGraphView({ center: null, depth: 2, edges, titles: t, maxNodes: GRAPH_GPU_MAX_NODES });
    expect(big.nodes).toHaveLength(1000);
    expect(big.truncated).toBe(true);
    expect(big.total).toBe(1200);
  });
  it('🔴 60 件以下の配置は従来の力学配置のまま(origin/main の座標の指紋と一致)', () => {
    // ⚠ 指紋は PR-13 の前の graph-view.ts で取った値 ── 1 バイトでも配置が変われば落ちる
    const { edges, t } = bigGraph(60);
    expect(digest(buildGraphView({ center: null, depth: 2, edges, titles: t }))).toBe(GOLDEN_60);
    const { edges: e2, t: t2 } = bigGraph(23);
    expect(digest(buildGraphView({ center: null, depth: 2, edges: e2, titles: t2 }))).toBe(GOLDEN_23);
  });
  it('61 件以上は格子の配置: 1000 件でも速く、決定的、枠に収まり、1 点に潰れない', () => {
    const { edges, t } = bigGraph(1000);
    const t0 = performance.now();
    const a = buildGraphView({ center: null, depth: 2, edges, titles: t, maxNodes: GRAPH_GPU_MAX_NODES });
    const ms = performance.now() - t0;
    const b = buildGraphView({ center: null, depth: 2, edges, titles: t, maxNodes: GRAPH_GPU_MAX_NODES });
    expect(a.nodes).toHaveLength(1000);
    expect(digest(a)).toBe(digest(b));
    // ⚠ CI の遅い箱でも通る上限(手元の実測は 10ms 前後)。O(N²)×120 の力学配置なら数秒かかる
    expect(ms).toBeLessThan(400);
    for (const p of a.nodes) {
      expect(p.x).toBeGreaterThanOrEqual(0.05);
      expect(p.x).toBeLessThanOrEqual(0.95);
      expect(p.y).toBeGreaterThanOrEqual(0.05);
      expect(p.y).toBeLessThanOrEqual(0.95);
    }
    const distinct = new Set(a.nodes.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`));
    expect(distinct.size).toBeGreaterThan(990);
  });
  it('中心ありの 1000 件も環の配置で枠に収まる', () => {
    const { lids, edges, t } = bigGraph(1000);
    const v = buildGraphView({ center: lids[0]!, depth: 6, edges, titles: t, maxNodes: GRAPH_GPU_MAX_NODES });
    expect(v.nodes.length).toBeGreaterThan(10);
    for (const p of v.nodes) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
    }
  });
});
