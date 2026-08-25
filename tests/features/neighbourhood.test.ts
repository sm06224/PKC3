/**
 * 🔴 **いま見ているノートのまわり**(#186 / A-6)。
 *
 * ⚠ 見るのは 4 つ:①手数で切れる ②上限で切ったら**そう言う** ③消えたノートへ
 * 線を引かない ④置いた場所が**環になっている**(重ならない)。
 */
import { describe, expect, it } from 'vitest';
import {
  buildNeighbourhood,
  MAX_DEPTH,
  MAX_NODES,
  type GraphEdge,
} from '../../src/features/relation/neighbourhood';

const t = (...lids: string[]): Map<string, string> =>
  new Map(lids.map((l) => [l, `題:${l}`]));

const e = (fromLid: string, toLid: string, kind = 'semantic'): GraphEdge => ({
  fromLid,
  toLid,
  kind,
});

describe('近傍の切り出し', () => {
  it('1 手なら隣だけ、2 手なら隣の隣まで', () => {
    const edges = [e('a', 'b'), e('b', 'c'), e('c', 'd')];
    const titles = t('a', 'b', 'c', 'd');
    const one = buildNeighbourhood({ center: 'a', depth: 1, edges, titles });
    expect(one.nodes.map((n) => n.lid).sort()).toEqual(['a', 'b']);
    const two = buildNeighbourhood({ center: 'a', depth: 2, edges, titles });
    expect(two.nodes.map((n) => n.lid).sort()).toEqual(['a', 'b', 'c']);
  });

  it('🔴 向きは無視して辿るが、辺は向きを保って返す(矢印を描けるように)', () => {
    // ⚠ `b → a` は**入ってくる**辺 ── これを辿らないと「参照されている側」が消える
    const r = buildNeighbourhood({
      center: 'a',
      depth: 1,
      edges: [e('b', 'a', 'provenance')],
      titles: t('a', 'b'),
    });
    expect(r.nodes.map((n) => n.lid).sort()).toEqual(['a', 'b']);
    expect(r.edges).toEqual([{ fromLid: 'b', toLid: 'a', kind: 'provenance' }]);
  });

  /**
   * 🔴 **上限で切ったら、そう言う**(黙って切ると user は「これで全部」と読む)。
   * ⚠ 空振り防止に**切っていない場合も**見る ── `truncated` が常に true でないこと。
   */
  it('🔴 上限で切ったら truncated を立てる / 収まるなら立てない', () => {
    const many = Array.from({ length: 30 }, (_, i) => e('a', `n${i}`));
    const titles = t('a', ...many.map((x) => x.toLid));
    const cut = buildNeighbourhood({ center: 'a', depth: 1, edges: many, titles, maxNodes: 5 });
    expect(cut.nodes).toHaveLength(5);
    expect(cut.truncated, '切ったのに黙っている').toBe(true);

    const fits = buildNeighbourhood({
      center: 'a',
      depth: 1,
      edges: [e('a', 'b')],
      titles: t('a', 'b'),
    });
    expect(fits.truncated, '切っていないのに切ったと言っている').toBe(false);
  });

  it('🔴 切られた側へ線を引かない(宙に浮く線を作らない)', () => {
    const many = Array.from({ length: 10 }, (_, i) => e('a', `n${i}`));
    const titles = t('a', ...many.map((x) => x.toLid));
    const cut = buildNeighbourhood({ center: 'a', depth: 1, edges: many, titles, maxNodes: 3 });
    const kept = new Set(cut.nodes.map((n) => n.lid));
    for (const edge of cut.edges) {
      expect(kept.has(edge.fromLid) && kept.has(edge.toLid), '片端が出ていない辺が在る').toBe(
        true,
      );
    }
  });

  it('🔴 消えたノートは辿らない(題名を持たない lid)', () => {
    const r = buildNeighbourhood({
      center: 'a',
      depth: 2,
      // ⚠ `gone` は `titles` に無い ── 消えたノート
      edges: [e('a', 'gone'), e('gone', 'c'), e('a', 'b')],
      titles: t('a', 'b', 'c'),
    });
    expect(r.nodes.map((n) => n.lid).sort(), '消えたノート越しに辿った').toEqual(['a', 'b']);
    expect(JSON.stringify(r.edges), '消えたノートへ線を引いた').not.toContain('gone');
  });

  it('自己辺は落とす(環に置きようが無い)', () => {
    const r = buildNeighbourhood({
      center: 'a',
      depth: 1,
      edges: [e('a', 'a'), e('a', 'b')],
      titles: t('a', 'b'),
    });
    expect(r.edges).toEqual([{ fromLid: 'a', toLid: 'b', kind: 'semantic' }]);
  });

  it('中心が消えていれば空を返す', () => {
    const r = buildNeighbourhood({
      center: 'gone',
      depth: 1,
      edges: [e('a', 'b')],
      titles: t('a', 'b'),
    });
    expect(r.nodes).toEqual([]);
    expect(r.edges).toEqual([]);
  });
});

describe('置き方', () => {
  it('中心は真ん中、隣は環の上に等間隔で並ぶ', () => {
    const r = buildNeighbourhood({
      center: 'a',
      depth: 1,
      edges: [e('a', 'b'), e('a', 'c'), e('a', 'd'), e('a', 'f')],
      titles: t('a', 'b', 'c', 'd', 'f'),
    });
    const center = r.nodes.find((n) => n.lid === 'a')!;
    expect([center.x, center.y]).toEqual([0.5, 0.5]);
    const ring = r.nodes.filter((n) => n.ring === 1);
    expect(ring).toHaveLength(4);
    // ⚠ **中心からの距離が全部同じ**(環になっている)
    for (const n of ring) {
      const d = Math.hypot(n.x - 0.5, n.y - 0.5);
      expect(d).toBeCloseTo(0.3, 6);
    }
    // 🔑 最初の 1 件は**真上**(「中心から出ている」が読み取りやすい)
    expect(ring[0]!.x).toBeCloseTo(0.5, 6);
    expect(ring[0]!.y).toBeLessThan(0.5);
  });

  it('🔴 2 手先は外側の環に出る(内側と重ならない)', () => {
    const r = buildNeighbourhood({
      center: 'a',
      depth: 2,
      edges: [e('a', 'b'), e('b', 'c')],
      titles: t('a', 'b', 'c'),
    });
    const inner = r.nodes.find((n) => n.lid === 'b')!;
    const outer = r.nodes.find((n) => n.lid === 'c')!;
    const dIn = Math.hypot(inner.x - 0.5, inner.y - 0.5);
    const dOut = Math.hypot(outer.x - 0.5, outer.y - 0.5);
    expect(dOut, '2 手先が内側に置かれている').toBeGreaterThan(dIn);
  });

  it('⚠ 置いた場所は器の中に収まる(0..1)', () => {
    const many = Array.from({ length: 20 }, (_, i) => e('a', `n${i}`));
    const r = buildNeighbourhood({
      center: 'a',
      depth: 1,
      edges: many,
      titles: t('a', ...many.map((x) => x.toLid)),
    });
    for (const n of r.nodes) {
      expect(n.x, `${n.lid} が器の外`).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(1);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(1);
    }
  });

  it('手数は 2 で頭打ち(近傍が毛玉に戻らない)', () => {
    const edges = [e('a', 'b'), e('b', 'c'), e('c', 'd'), e('d', 'x')];
    const titles = t('a', 'b', 'c', 'd', 'x');
    const deep = buildNeighbourhood({ center: 'a', depth: 9, edges, titles });
    expect(deep.nodes.map((n) => n.lid).sort()).toEqual(['a', 'b', 'c']);
    expect(MAX_DEPTH).toBe(2);
    expect(MAX_NODES).toBeGreaterThan(0);
  });
});
