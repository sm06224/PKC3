/**
 * 🔴 **関係グラフ → 無限キャンバスのボード**(v4.0 Phase 2 / PR-10、`src/features/canvas/graph-to-board.ts`)。
 *
 * 守る主張: 前書き `layout: canvas` / 全ノードが `entry=` の付箋 / 全エッジが `.pkc-line`(同じ 2 枚の間は 1 本)/
 * 付箋は重ならない / 開き行を壊す lid は書かない / 0 件でも壊れない / 本文は既存の読み手(`place-notation`)でそのまま読める。
 */
import { describe, expect, it } from 'vitest';
import {
  GRAPH_BOARD_CARD_H,
  GRAPH_BOARD_CARD_W,
  graphViewToBoardMarkdown,
} from '../../../src/features/canvas/graph-to-board';
import type { GraphView } from '../../../src/features/relation/graph-view';
import { isCanvasLayout } from '../../../src/features/markdown/document-globals';

function view(n: number, edges: Array<[number, number]> = []): GraphView {
  const nodes = Array.from({ length: n }, (_, i) => ({
    lid: `L${i}`,
    title: `題名${i}`,
    ring: i === 0 ? 0 : 1,
    // わざと同じ所に寄せる(重なりの解消を試す)
    x: i % 3 === 0 ? 0.5 : (i * 0.137) % 1,
    y: i % 3 === 0 ? 0.5 : (i * 0.291) % 1,
  }));
  return {
    nodes,
    edges: edges.map(([a, b]) => ({ fromLid: `L${a}`, toLid: `L${b}`, kind: 'semantic' })),
    truncated: false,
    total: n,
  };
}

const PLACE_RE = /^:::format\{#(n\d+) \.pkc-place x=(-?\d+) y=(-?\d+) w=(\d+) h=(\d+) entry=([A-Za-z0-9_-]+)\}$/;

describe('graphViewToBoardMarkdown', () => {
  it('前書き layout: canvas を付け、全ノードを entry= の付箋に、全エッジを .pkc-line にする', () => {
    const md = graphViewToBoardMarkdown(view(4, [[0, 1], [0, 2], [2, 3]]));
    expect(md.startsWith('---\nlayout: canvas\n---\n')).toBe(true);
    expect(isCanvasLayout(md)).toBe(true);
    const places = md.split('\n').filter((l) => l.includes('.pkc-place'));
    expect(places).toHaveLength(4);
    for (const l of places) expect(l).toMatch(PLACE_RE);
    expect(places.map((l) => PLACE_RE.exec(l)![6]).sort()).toEqual(['L0', 'L1', 'L2', 'L3']);
    const lines = md.split('\n').filter((l) => l.includes('.pkc-line'));
    expect(lines).toEqual([
      ':::format{.pkc-line from=n1 to=n2}',
      ':::format{.pkc-line from=n1 to=n3}',
      ':::format{.pkc-line from=n3 to=n4}',
    ]);
    // 囲いはすべて閉じている
    expect(md.split('\n').filter((l) => l === ':::').length).toBe(7);
  });

  it('🔴 60 件でも付箋が重ならない(大きさは 220 × 100)', () => {
    const md = graphViewToBoardMarkdown(view(60));
    const rects = md
      .split('\n')
      .map((l) => PLACE_RE.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]) }));
    expect(rects).toHaveLength(60);
    for (const r of rects) {
      expect(r.w).toBe(GRAPH_BOARD_CARD_W);
      expect(r.h).toBe(GRAPH_BOARD_CARD_H);
    }
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap, `${i} と ${j}`).toBe(false);
      }
    }
  });

  it('同じ 2 枚の間の辺は 1 本(向き・種類が違っても)/ 自分への辺・図に無い節点への辺は書かない', () => {
    const v = view(3, [[0, 1], [1, 0], [0, 1], [2, 2]]);
    const md = graphViewToBoardMarkdown({ ...v, edges: [...v.edges, { fromLid: 'L0', toLid: 'ghost', kind: 'x' }] });
    expect(md.split('\n').filter((l) => l.includes('.pkc-line'))).toEqual([':::format{.pkc-line from=n1 to=n2}']);
  });

  it('特殊文字: 開き行を壊す lid は書かない(その辺も書かない)/ 題名は本文に写さない', () => {
    const v: GraphView = {
      nodes: [
        { lid: 'ok1', title: '} :::format{.evil}', ring: 0, x: 0.1, y: 0.1 },
        { lid: 'bad} x=1', title: '悪い', ring: 1, x: 0.9, y: 0.9 },
        { lid: 'ok2', title: '---\nlayout: a4', ring: 1, x: 0.5, y: 0.5 },
      ],
      edges: [
        { fromLid: 'ok1', toLid: 'bad} x=1', kind: 'r' },
        { fromLid: 'ok1', toLid: 'ok2', kind: 'r' },
      ],
      truncated: false,
      total: 3,
    };
    const md = graphViewToBoardMarkdown(v, { title: '} 題名 :::' });
    expect(md).not.toContain('bad');
    expect(md).not.toContain('evil');
    expect(md).not.toContain('題名');
    expect(md).not.toContain('a4');
    expect(md.split('\n').filter((l) => l.includes('.pkc-place'))).toHaveLength(2);
    expect(md).toContain(':::format{.pkc-line from=n1 to=n2}');
  });

  it('0 ノードでも壊れない(前書きだけの空のボード)', () => {
    const md = graphViewToBoardMarkdown({ nodes: [], edges: [], truncated: false, total: 0 });
    expect(md).toBe('---\nlayout: canvas\n---\n');
    expect(isCanvasLayout(md)).toBe(true);
  });

  it('同じ図は同じ本文(時計も乱数も使わない)', () => {
    expect(graphViewToBoardMarkdown(view(12, [[0, 5]]))).toBe(graphViewToBoardMarkdown(view(12, [[0, 5]])));
  });
});
