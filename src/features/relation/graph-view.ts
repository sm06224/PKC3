/**
 * 🔴 **関係グラフ ── 組み込みアプリの図を組む**(#281 ①。user 指示 2026-08-19
 * 「…**関連性グラフビューワ**、カレンダー、カンバン、連絡先、タイマー、アラートは組み込みアプリでリリースしたい」)。
 *
 * ## 情報ペインの「つながりの図」(`neighbourhood.ts`)との違い
 *
 * | | 情報ペインの図 | この図(アプリ) |
 * |---|---|---|
 * | 範囲 | 選んだノートの **2 手先まで**(固定) | **全体**、または選んだノートから **N 手先**(手先の数を変えられる) |
 * | 置き場 | 右の列(選択に追従) | 左の列のタブ + 別ウィンドウ |
 * | 配置 | 環状 | 中心あり = 手数ごとの環 / 全体 = 力学配置(つながりの多い順に上限まで) |
 *
 * 🔑 「どの辺を張るか」「題名」は呼び側が渡す(この module は state も DOM も知らない)。
 *   ⚠ 上限を超えたら**そう言う**(`truncated` と `total`)── 黙って切ると「これで全部」と読まれる。
 * ⚠ **pure module** ── 時計も乱数も使わない(同じ入力は同じ配置になる。test できる)。
 */
import type { GraphEdge, PlacedNode, TitleLookup } from './neighbourhood';

/** 図に出す節点の上限。⚠ これ以上は押せる大きさで並べられない。 */
export const GRAPH_MAX_NODES = 60;
/**
 * 🔴 **大規模表示(GPU の 2D / 3D)の節点の上限**(v4.0 Phase 3 / PR-13、ビジョン 1-C)。
 * ⚠ 節点は `<button>` ではなく 1 回の draw call の絵 + 当たり判定(`graph-gpu-layout.ts` の `pickGraphNode`)で押す。
 */
export const GRAPH_GPU_MAX_NODES = 1000;
/** 手先の数の上限(画面の増減ボタンの範囲)。 */
export const GRAPH_MAX_DEPTH = 6;
/** 手先の数の既定(情報ペインの図と同じ 2)。 */
export const GRAPH_DEFAULT_DEPTH = 2;

export interface GraphView {
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly GraphEdge[];
  /** 上限で切ったか。⚠ 切ったら呼び側が必ず言う。 */
  readonly truncated: boolean;
  /** 切る前に、この範囲で図になりえた節点の数(切ったときの「N 件中 M 件」に使う)。 */
  readonly total: number;
}

const EMPTY: GraphView = { nodes: [], edges: [], truncated: false, total: 0 };

/** 手先の数を 1..GRAPH_MAX_DEPTH に丸める(NaN は既定)。 */
export function clampGraphDepth(n: number): number {
  if (!Number.isFinite(n)) return GRAPH_DEFAULT_DEPTH;
  return Math.max(1, Math.min(GRAPH_MAX_DEPTH, Math.floor(n)));
}

/**
 * 図を組む。
 *
 * @param center `null` = 全体。ノートの lid = そこから `depth` 手先まで
 *   (`titles` に無い lid は空を返す = 消えたノート)
 */
export function buildGraphView(input: {
  readonly center: string | null;
  readonly depth: number;
  readonly edges: readonly GraphEdge[];
  readonly titles: TitleLookup;
  readonly maxNodes?: number;
}): GraphView {
  const limit = input.maxNodes ?? GRAPH_MAX_NODES;
  if (limit < 1) return EMPTY;
  // ⚠ 片端でも消えている辺・自分自身への辺は最初に落とす(宙に浮く線を作らない)
  const live = input.edges.filter(
    (e) => e.fromLid !== e.toLid && input.titles.has(e.fromLid) && input.titles.has(e.toLid),
  );
  return input.center === null
    ? wholeGraph(live, input.titles, limit)
    : aroundNote(input.center, clampGraphDepth(input.depth), live, input.titles, limit);
}

function touchingMap(edges: readonly GraphEdge[]): Map<string, GraphEdge[]> {
  const touching = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    for (const lid of [e.fromLid, e.toLid]) {
      const list = touching.get(lid);
      if (list) list.push(e);
      else touching.set(lid, [e]);
    }
  }
  return touching;
}

/** 選んだノートから `depth` 手先まで(向きは無視して辿る。浅い順に埋めるので、切れるのは遠いほう)。 */
function aroundNote(
  center: string,
  depth: number,
  edges: readonly GraphEdge[],
  titles: TitleLookup,
  limit: number,
): GraphView {
  if (!titles.has(center)) return EMPTY;
  const touching = touchingMap(edges);
  const ringOf = new Map<string, number>([[center, 0]]);
  const order: string[] = [center];
  /** 切らなければ届いたはずの節点(切った分も数える)。 */
  let reached = 1;
  for (let i = 0; i < order.length; i += 1) {
    const lid = order[i]!;
    const r = ringOf.get(lid)!;
    if (r >= depth) continue;
    for (const e of touching.get(lid) ?? []) {
      const other = e.fromLid === lid ? e.toLid : e.fromLid;
      if (ringOf.has(other)) continue;
      if (order.length >= limit) {
        // 数えるために「届いたこと」だけ記録する(置かない)。深い所の数え漏れを避けて浅い順のまま続ける
        ringOf.set(other, -1);
        reached += 1;
        continue;
      }
      ringOf.set(other, r + 1);
      order.push(other);
      reached += 1;
    }
  }
  // 数えるためだけに入れた -1 は置く対象ではない(`order` に居ない)
  const maxRing = Math.max(1, ...order.map((l) => ringOf.get(l)!));
  const counts = new Map<number, number>();
  for (const lid of order) counts.set(ringOf.get(lid)!, (counts.get(ringOf.get(lid)!) ?? 0) + 1);
  const seen = new Map<number, number>();
  const nodes: PlacedNode[] = order.map((lid) => {
    const r = ringOf.get(lid)!;
    const title = titles.get(lid) ?? lid;
    if (r === 0) return { lid, title, ring: 0, x: 0.5, y: 0.5 };
    const n = counts.get(r) ?? 1;
    const i = seen.get(r) ?? 0;
    seen.set(r, i + 1);
    // ⚠ 12 時から時計回り。環が 1 つだけなら 0.3(情報ペインの図と同じ)、複数なら外へ向けて等間隔
    //    (隣の環の節点が重ならないよう、環ごとに半歩ずらす)
    const angle = ((i + (r % 2 === 0 ? 0.5 : 0)) / n) * Math.PI * 2 - Math.PI / 2;
    const rad = maxRing === 1 ? 0.3 : 0.12 + (0.34 * (r - 1)) / (maxRing - 1 || 1);
    return { lid, title, ring: r, x: 0.5 + Math.cos(angle) * rad, y: 0.5 + Math.sin(angle) * rad };
  });
  const kept = new Set(order);
  return {
    nodes,
    edges: edges.filter((e) => kept.has(e.fromLid) && kept.has(e.toLid)),
    truncated: reached > order.length,
    total: reached,
  };
}

/** 全体。辺を 1 本でも持つ節点をつながりの多い順(同数は lid 順)に上限まで取り、力学配置で置く。 */
function wholeGraph(edges: readonly GraphEdge[], titles: TitleLookup, limit: number): GraphView {
  const touching = touchingMap(edges);
  const ranked = [...touching.keys()].sort(
    (a, b) => touching.get(b)!.length - touching.get(a)!.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  if (ranked.length === 0) return EMPTY;
  const order = ranked.slice(0, limit);
  const kept = new Set(order);
  const inside = edges.filter((e) => kept.has(e.fromLid) && kept.has(e.toLid));
  // 🔴 上限(60)を超える節点は O(N²) の力学配置に通さない ── 格子で近所だけ押し合う配置へ分ける
  //    (⚠ 60 以下は今までの配置を 1 バイトも変えない)
  const pos = order.length > GRAPH_MAX_NODES ? gridForceLayout(order, inside) : forceLayout(order, inside);
  const nodes: PlacedNode[] = order.map((lid, i) => ({
    lid,
    title: titles.get(lid) ?? lid,
    // 全体には中心が無い。いちばんつながりの多い 1 つだけ ring 0(大きく出す印)にしない ── 全部 1
    ring: 1,
    x: pos[i]![0],
    y: pos[i]![1],
  }));
  return { nodes, edges: inside, truncated: ranked.length > order.length, total: ranked.length };
}

/**
 * Fruchterman-Reingold 法を固定回数。⚠ 乱数を使わない ── 初期配置は渦巻き(黄金角)で、
 * 同じ入力は同じ座標になる。出力は 0.06..0.94 の枠へ正規化する。
 */
function forceLayout(
  order: readonly string[],
  edges: readonly GraphEdge[],
): [number, number][] {
  const n = order.length;
  const index = new Map(order.map((l, i) => [l, i]));
  const p: [number, number][] = order.map((_, i) => {
    const a = i * 2.399963; // 黄金角
    const r = 0.1 + (0.35 * Math.sqrt(i + 1)) / Math.sqrt(n);
    return [0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r];
  });
  if (n === 1) return [[0.5, 0.5]];
  const k = Math.sqrt(1 / n) * 0.9;
  const pairs = edges
    .map((e) => [index.get(e.fromLid)!, index.get(e.toLid)!] as const)
    .filter(([a, b]) => a !== undefined && b !== undefined);
  const ITER = 120;
  for (let it = 0; it < ITER; it += 1) {
    const t = 0.1 * (1 - it / ITER) + 0.002;
    const d: [number, number][] = p.map(() => [0, 0]);
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let dx = p[i]![0] - p[j]![0];
        let dy = p[i]![1] - p[j]![1];
        let dist = Math.hypot(dx, dy);
        if (dist < 1e-4) {
          // 重なったら決まった向きにずらす(乱数を使わない)
          dx = 1e-3 * ((i + j) % 2 === 0 ? 1 : -1);
          dy = 1e-3;
          dist = Math.hypot(dx, dy);
        }
        const f = (k * k) / dist;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        d[i]![0] += fx;
        d[i]![1] += fy;
        d[j]![0] -= fx;
        d[j]![1] -= fy;
      }
    }
    for (const [a, b] of pairs) {
      const dx = p[a]![0] - p[b]![0];
      const dy = p[a]![1] - p[b]![1];
      const dist = Math.max(Math.hypot(dx, dy), 1e-4);
      const f = (dist * dist) / k;
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;
      d[a]![0] -= fx;
      d[a]![1] -= fy;
      d[b]![0] += fx;
      d[b]![1] += fy;
    }
    for (let i = 0; i < n; i += 1) {
      const len = Math.max(Math.hypot(d[i]![0], d[i]![1]), 1e-9);
      const step = Math.min(len, t);
      p[i]![0] += (d[i]![0] / len) * step;
      p[i]![1] += (d[i]![1] / len) * step;
    }
  }
  return normalizeToFrame(p);
}

/** 枠へ正規化(縦横を別々に伸ばすと形が歪むので、長いほうに合わせて同じ倍率)。出力は 0.06..0.94。 */
function normalizeToFrame(p: readonly (readonly [number, number])[]): [number, number][] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of p) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const scale = 0.88 / span;
  const offX = 0.5 - ((minX + maxX) / 2) * scale;
  const offY = 0.5 - ((minY + maxY) / 2) * scale;
  return p.map(([x, y]) => [x * scale + offX, y * scale + offY]);
}

/** 格子の配置の反復回数(固定 ── 同じ入力は同じ座標)。 */
const GRID_LAYOUT_ITER = 60;

/**
 * 🔴 **大規模の配置**(v4.0 Phase 3 / PR-13)── 節点が `GRAPH_MAX_NODES` を超えたときだけ使う。
 *
 * `forceLayout` は全組の押し合い(O(N²) × 120 回)で、1,000 件では数秒メインスレッドを止める。
 * ここは同じ考え方(押し合い + ばね)を **格子に分けた近所だけ**で行う:
 * - 押し合いは、同じ升と周り 8 升に居る節点とだけ(升の幅 = 押し合いの届く距離 2k)
 * - ばねは辺の数だけ(O(E))
 * - 固定 60 回・温度は線形に下げる
 * ⚠ **乱数を使わない**(初期配置は `forceLayout` と同じ黄金角の渦巻き。升の走査順も決まっている)。
 */
function gridForceLayout(order: readonly string[], edges: readonly GraphEdge[]): [number, number][] {
  const n = order.length;
  const index = new Map(order.map((l, i) => [l, i]));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = i * 2.399963; // 黄金角(つながりの多い順に内側から)
    const r = 0.02 + (0.46 * Math.sqrt(i + 1)) / Math.sqrt(n);
    xs[i] = 0.5 + Math.cos(a) * r;
    ys[i] = 0.5 + Math.sin(a) * r;
  }
  const k = Math.sqrt(1 / n) * 0.9;
  const reach = 2 * k;
  const reach2 = reach * reach;
  const pairs: number[] = [];
  for (const e of edges) {
    const a = index.get(e.fromLid);
    const b = index.get(e.toLid);
    if (a !== undefined && b !== undefined && a !== b) pairs.push(a, b);
  }
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const cellOf = new Int32Array(n);
  const next = new Int32Array(n);
  for (let it = 0; it < GRID_LAYOUT_ITER; it += 1) {
    const t = 0.05 * (1 - it / GRID_LAYOUT_ITER) + 0.001;
    dx.fill(0);
    dy.fill(0);
    // 升へ分ける(連結リスト。⚠ 升の数は節点の数と同じ桁に抑える)
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i += 1) {
      if (xs[i]! < minX) minX = xs[i]!;
      if (xs[i]! > maxX) maxX = xs[i]!;
      if (ys[i]! < minY) minY = ys[i]!;
      if (ys[i]! > maxY) maxY = ys[i]!;
    }
    const cols = Math.max(1, Math.min(256, Math.ceil((maxX - minX) / reach) + 1));
    const rows = Math.max(1, Math.min(256, Math.ceil((maxY - minY) / reach) + 1));
    const head = new Int32Array(cols * rows).fill(-1);
    for (let i = n - 1; i >= 0; i -= 1) {
      const cx = Math.min(cols - 1, Math.floor((xs[i]! - minX) / reach));
      const cy = Math.min(rows - 1, Math.floor((ys[i]! - minY) / reach));
      const c = cy * cols + cx;
      cellOf[i] = c;
      next[i] = head[c]!;
      head[c] = i;
    }
    for (let i = 0; i < n; i += 1) {
      const c = cellOf[i]!;
      const cx = c % cols;
      const cy = (c - cx) / cols;
      for (let oy = -1; oy <= 1; oy += 1) {
        const yy = cy + oy;
        if (yy < 0 || yy >= rows) continue;
        for (let ox = -1; ox <= 1; ox += 1) {
          const xx = cx + ox;
          if (xx < 0 || xx >= cols) continue;
          for (let j = head[yy * cols + xx]!; j !== -1; j = next[j]!) {
            if (j <= i) continue; // 1 組を 1 回だけ
            let ddx = xs[i]! - xs[j]!;
            let ddy = ys[i]! - ys[j]!;
            let d2 = ddx * ddx + ddy * ddy;
            if (d2 > reach2) continue;
            if (d2 < 1e-10) {
              ddx = 1e-3 * ((i + j) % 2 === 0 ? 1 : -1);
              ddy = 1e-3;
              d2 = ddx * ddx + ddy * ddy;
            }
            const dist = Math.sqrt(d2);
            const f = (k * k) / dist;
            const fx = (ddx / dist) * f;
            const fy = (ddy / dist) * f;
            dx[i] = dx[i]! + fx;
            dy[i] = dy[i]! + fy;
            dx[j] = dx[j]! - fx;
            dy[j] = dy[j]! - fy;
          }
        }
      }
    }
    for (let q = 0; q < pairs.length; q += 2) {
      const a = pairs[q]!;
      const b = pairs[q + 1]!;
      const ddx = xs[a]! - xs[b]!;
      const ddy = ys[a]! - ys[b]!;
      const dist = Math.max(Math.sqrt(ddx * ddx + ddy * ddy), 1e-4);
      const f = (dist * dist) / k;
      const fx = (ddx / dist) * f;
      const fy = (ddy / dist) * f;
      dx[a] = dx[a]! - fx;
      dy[a] = dy[a]! - fy;
      dx[b] = dx[b]! + fx;
      dy[b] = dy[b]! + fy;
    }
    // 弱い重力(つながっていない島が遠くへ飛ばない)
    for (let i = 0; i < n; i += 1) {
      dx[i] = dx[i]! + (0.5 - xs[i]!) * k * 0.5;
      dy[i] = dy[i]! + (0.5 - ys[i]!) * k * 0.5;
      const len = Math.max(Math.hypot(dx[i]!, dy[i]!), 1e-9);
      const step = Math.min(len, t);
      xs[i] = xs[i]! + (dx[i]! / len) * step;
      ys[i] = ys[i]! + (dy[i]! / len) * step;
    }
  }
  const out: [number, number][] = [];
  for (let i = 0; i < n; i += 1) out.push([xs[i]!, ys[i]!]);
  return normalizeToFrame(out);
}
