/**
 * 🔴 **いま見ているノートの「まわり」を切り出す**(#186 / A-6)。
 *
 * ## なぜ全体グラフではないか
 *
 * PKC2 の実体は **PKC-Extension**(`pkc2-graph.html`、約 2,000 行 + Cytoscape +
 * 5 モード + galaxy 3D + Venn)で、**全部の節点**を出す物だった。
 * ⚠ user 指示 2026-08-22「**使っていないものや使えないものまでを実装再現するのは
 * 間違えている**」── そして全体グラフは**増えるほど読めなくなる**(数百で毛玉に
 * なり、押せる物が無くなる)。実際に使われるのは「**いま見ている物の周り**」である。
 *
 * 🔑 だから最初から**近傍だけ**を作る。後から全体を足すことはできるが、
 * 逆は「毛玉を出してしまった」という既定を引きずる。
 *
 * ## ⚠ pure module ── DOM も時計も持たない
 *
 * 配置(どこに置くか)まで**ここで決める**。⚠ 描く側に計算を書くと、
 * **どの test からも実行されない場所**に判断が沈む(CLAUDE.md §2)。
 */

/** 辺 1 本。⚠ 向きは持つ(関係は非対称 ── 「出典」は片方向である)。 */
export interface GraphEdge {
  readonly fromLid: string;
  readonly toLid: string;
  readonly kind: string;
}

/** 置いた節点 1 つ。座標は **0..1 の比**(器の大きさを知らない)。 */
export interface PlacedNode {
  readonly lid: string;
  readonly title: string;
  /** 中心からの手数(0 = 中心)。 */
  readonly ring: number;
  readonly x: number;
  readonly y: number;
}

export interface Neighbourhood {
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly GraphEdge[];
  /**
   * 🔴 **上限で切ったか**。⚠ 黙って切らない ── 呼び側が「多すぎます」と出す。
   * 切ったのに黙ると、user は「これで全部だ」と読む。
   */
  readonly truncated: boolean;
}

/**
 * 出す節点の上限。⚠ **これ以上は読めない**(押せる大きさで並べられない)。
 * 🔑 数で持つ ── 「多すぎたら間引く」を散文の規律にしない(お知らせの上限と同じ作法)。
 */
export const MAX_NODES = 24;

/** 何手先まで出すか。⚠ 2 を超えると近傍ではなくなる(毛玉に戻る)。 */
export const MAX_DEPTH = 2;

/**
 * 中心から `depth` 手で届く節点を集め、環状に置く。
 *
 * ⚠ **向きは無視して辿る**(関係は片方向でも「繋がっている」)が、
 * 辺そのものは**向きを保って**返す ── 矢印を描くのは呼び側である。
 *
 * @param center 中心のノート。⚠ `titles` に無ければ**空を返す**(消えたノート)
 */
export function buildNeighbourhood(input: {
  readonly center: string;
  readonly depth: number;
  readonly edges: readonly GraphEdge[];
  readonly titles: ReadonlyMap<string, string>;
  readonly maxNodes?: number;
}): Neighbourhood {
  const { center, edges, titles } = input;
  const limit = input.maxNodes ?? MAX_NODES;
  if (!titles.has(center) || limit < 1) {
    return { nodes: [], edges: [], truncated: false };
  }
  const depth = Math.max(0, Math.min(MAX_DEPTH, Math.floor(input.depth)));

  /** lid → その lid に触れる辺(向きは無視)。 */
  const touching = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    // ⚠ **自己辺は落とす** ── 環に置きようが無く、線も点にしかならない
    if (e.fromLid === e.toLid) continue;
    // ⚠ 片端でも消えていれば辿らない(消えたノートへ線を引かない)
    if (!titles.has(e.fromLid) || !titles.has(e.toLid)) continue;
    for (const lid of [e.fromLid, e.toLid]) {
      const list = touching.get(lid);
      if (list) list.push(e);
      else touching.set(lid, [e]);
    }
  }

  /** 幅優先。⚠ **手数の浅い順**に埋めるので、切るときに切れるのは遠いほうである。 */
  const ringOf = new Map<string, number>([[center, 0]]);
  const order: string[] = [center];
  let truncated = false;
  for (let i = 0; i < order.length; i += 1) {
    const lid = order[i]!;
    const r = ringOf.get(lid)!;
    if (r >= depth) continue;
    for (const e of touching.get(lid) ?? []) {
      const other = e.fromLid === lid ? e.toLid : e.fromLid;
      if (ringOf.has(other)) continue;
      if (order.length >= limit) {
        truncated = true;
        continue;
      }
      ringOf.set(other, r + 1);
      order.push(other);
    }
  }

  const nodes = placeRings(order, ringOf, titles);
  const kept = new Set(order);
  // ⚠ **両端が出ている辺だけ**返す(片端が切られた辺を描くと、線が宙に浮く)
  const inside = edges.filter(
    (e) => e.fromLid !== e.toLid && kept.has(e.fromLid) && kept.has(e.toLid),
  );
  return { nodes, edges: inside, truncated };
}

/**
 * 環状に置く。中心は真ん中、1 手は内側の環、2 手は外側の環。
 *
 * ⚠ **上を空けない**(12 時から始める)── 最初の 1 件が真上に来るほうが、
 * 「中心から出ている」が読み取りやすい。
 */
function placeRings(
  order: readonly string[],
  ringOf: ReadonlyMap<string, number>,
  titles: ReadonlyMap<string, string>,
): PlacedNode[] {
  /** 環ごとの人数(角度を割るのに要る)。 */
  const counts = new Map<number, number>();
  for (const lid of order) {
    const r = ringOf.get(lid)!;
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  const seen = new Map<number, number>();
  const radius = [0, 0.3, 0.46];
  return order.map((lid) => {
    const r = ringOf.get(lid)!;
    const n = counts.get(r) ?? 1;
    const i = seen.get(r) ?? 0;
    seen.set(r, i + 1);
    if (r === 0) return { lid, title: titles.get(lid) ?? lid, ring: 0, x: 0.5, y: 0.5 };
    // ⚠ 12 時から時計回り(`-Math.PI / 2` が真上)
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    const rad = radius[Math.min(r, radius.length - 1)]!;
    return {
      lid,
      title: titles.get(lid) ?? lid,
      ring: r,
      x: 0.5 + Math.cos(angle) * rad,
      y: 0.5 + Math.sin(angle) * rad,
    };
  });
}
