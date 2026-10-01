/**
 * 🔴 **掴んで繋ぐ(#530 段③d)の計算** ── どの辺か / ● と ⊕ をどこへ出すか / 離した先はどの板か。
 *
 * > 裁定(🟣 Gemini、2026-10-01、https://github.com/sm06224/PKC3/issues/530#issuecomment-5932857648):
 * > 付箋に乗せたとき、**乗せた辺にだけ ● 1 つとその両隣に ⊕ 2 つ**を出す。⊕ に乗せるとそこが ●
 * > になり、さらに細かく選べる。常時は何も出さない。
 *
 * ## ⚠ ここは計算だけを持つ(features 層)
 *
 * 実際の大きさ(`offsetWidth`)と座標の写し(`getBoundingClientRect`)は描画側が測る ──
 * happy-dom は 0 を返すので、**判断をあちらへ書くと unit から永久に見えない**(CLAUDE.md §2)。
 *
 * ## 🔑 ● と ⊕ は「分母が 2 の冪」の点だけを使う
 *
 * ● が `n/2^k`(n は奇数)なら、その両隣の ⊕ は `(2n∓1)/2^(k+1)`。
 * 真ん中(1/2)の ⊕ は 1/4 と 3/4、1/4 の ⊕ は 1/8 と 3/8 ── **「辺の中点の、さらに中点」**
 * (設計 doc §13.1)が、そのまま操作になる。⚠ 分母は `ANCHOR_DEN_MAX`(64)まで ──
 * 記法が受けない点を ⊕ として見せない(押せるのに本文に書けない、を作らない)。
 */
import {
  ANCHOR_DEN_MAX,
  anchorOf,
  PLACE_EDGES,
  type PlaceAnchor,
  type PlaceEdge,
  type PlaceRect,
} from './place-line';

/**
 * 点(板の左上を基準にしない、器の座標)にいちばん近い辺。
 *
 * ⚠ **同じ距離のときは `PLACE_EDGES` の並び順で決める**(`<` で比べる)── 決めないと、
 *   マウスを動かしていないのに、描き直すたびに出る辺が変わりうる。
 */
export function nearestEdge(r: PlaceRect, px: number, py: number): PlaceEdge {
  const d: Record<PlaceEdge, number> = {
    top: Math.abs(py - r.y),
    right: Math.abs(r.x + r.w - px),
    bottom: Math.abs(r.y + r.h - py),
    left: Math.abs(px - r.x),
  };
  let best: PlaceEdge = PLACE_EDGES[0]!;
  for (const e of PLACE_EDGES) if (d[e] < d[best]) best = e;
  return best;
}

/** 乗せた辺に出す印。`dot` = ●(いま選んでいる点)/ `plus` = ⊕(その両隣。乗せると ● になる)。 */
export interface ConnectHandles {
  readonly dot: PlaceAnchor;
  readonly plus: readonly PlaceAnchor[];
}

/** 分母が 2 の冪で、分子が奇数か(= ● になれる点。1/3 などは受けない)。 */
function isDyadic(a: PlaceAnchor): boolean {
  return a.num % 2 === 1 && a.den >= 2 && (a.den & (a.den - 1)) === 0;
}

/**
 * 辺 `edge` に出す ● と ⊕。`focus` が無ければ ●は辺の真ん中。
 *
 * ⚠ `focus` が別の辺の点・分母が 2 の冪でない点なら**真ん中へ倒す**(内部の組み立て口なので、
 *   必ず 1 組を返す。user が書いた字を読む口ではない)。
 */
export function connectHandles(edge: PlaceEdge, focus: PlaceAnchor | null = null): ConnectHandles {
  const dot = focus !== null && focus.edge === edge && isDyadic(focus) ? focus : anchorOf(edge);
  const den2 = dot.den * 2;
  const plus: PlaceAnchor[] = [];
  if (den2 <= ANCHOR_DEN_MAX) {
    plus.push(anchorOf(edge, dot.num * 2 - 1, den2), anchorOf(edge, dot.num * 2 + 1, den2));
  }
  return { dot, plus };
}

/** 離した先の候補 1 枚。`z` は描画が当てた重なり(無ければ 0)。 */
export interface PlaceDrop<T> {
  readonly item: T;
  readonly rect: PlaceRect;
  readonly z: number;
}

/**
 * 点を含む板のうち**いちばん手前**の 1 枚(重なりが大きい z、同じなら後ろに書いた板)。
 * ⚠ 無ければ `null` = 板の外で離した = **何も書かない**。
 * 🔑 `document.elementFromPoint` を使わない ── 掴んでいる間は掴んだ口が点を捕えている上、
 *   happy-dom が持たないので、**取り違えを unit で見られなくなる**。
 */
export function topPlaceAt<T>(
  cands: readonly PlaceDrop<T>[],
  px: number,
  py: number,
): PlaceDrop<T> | null {
  let best: PlaceDrop<T> | null = null;
  for (const c of cands) {
    const r = c.rect;
    if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) continue;
    if (best === null || c.z >= best.z) best = c;
  }
  return best;
}
