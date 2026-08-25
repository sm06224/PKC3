/**
 * 🔴 **いま見ているノートのまわりを図で出す**(#186 / A-6)。
 *
 * ## 置き場 ── 右の列(情報ペイン)
 *
 * 🔑 `browse.ts` の表どおり **右 = 選んでいるもの** である。関係の図は
 * 「**選んでいるノートの周り**」なので、そこに置けば**選択に自動で追従する**
 * (別窓に出すと、user が一覧を辿るたびに同期の仕掛けが要る)。
 * ⚠ **中央の面を奪わない**(#300 で user が叱った型)/ **タイルにもしない** ──
 * `tiles.ts` の見分け方「それを閉じたとき user が失うものは何か」に照らすと、
 * これは**ノートの見方**であって「アプリ」ではない(カレンダーと同じ側)。
 *
 * ## ⚠ 依存を 1 つも足さない
 *
 * 局所の図は小さい(既定 1 手)ので、**節点は `<button>`、辺は 1 枚の `<svg>`** で足りる。
 * ⚠ mermaid には**載せられない** ── あちらは不可侵指示(2026-08-03「図は描いたら焼く」)
 * どおり **PNG の `<img>` 1 枚**で埋めるので、**節点を押せない**。
 * 「形は見えるが辿れない図」は、競合の全体グラフが抱えている当の不満そのものである。
 *
 * ⚠ 配置(どこに置くか)は `features/relation/neighbourhood.ts`(pure)が決める ──
 * ここは**受け取った比を器に当てるだけ**。計算をここへ書くと、
 * 判断が「どの test からも実行されない場所」に沈む(CLAUDE.md §2)。
 */

import { buildNeighbourhood, type GraphEdge } from '@features/relation/neighbourhood';
import { relationLabel } from '@features/relation/kinds';

/** 図の器の比(高さ / 幅)。⚠ 正方に近いほうが環が潰れない。 */
const ASPECT = 0.82;

/**
 * 🔴 **本文が張っているリンクの辺**(#186 段③)。
 *
 * ⚠ 関係(`RELATION_KINDS`)とは**別の系統**である ── 関係は user が明示的に
 * 張ったもの、こちらは**本文に `entry:` と書いた結果**。同じ図に出すが、
 * 見分けが付かないと「張った覚えのない関係がある」と読まれる。
 */
export const BODY_LINK_KIND = 'body-link';

/** 凡例の名前。⚠ 知らない種類はそのまま出す(黙って消さない ── `relationLabel` と同じ向き)。 */
function edgeLabel(kind: string): string {
  return kind === BODY_LINK_KIND ? '本文のリンク' : relationLabel(kind);
}

export interface RelationMapInput {
  readonly center: string;
  readonly depth: number;
  readonly edges: readonly GraphEdge[];
  readonly titles: ReadonlyMap<string, string>;
}

/**
 * 器を組み直す。⚠ **毎回 `textContent = ''` から作る** ── 節点の数も位置も
 * 選ぶノートで変わるので、差分更新は割に合わない(カレンダーの升と同じ判断)。
 *
 * @returns 出した節点の数(0 = 何も出していない。呼び側が行ごと畳める)
 */
export function renderRelationMap(box: HTMLElement, input: RelationMapInput): number {
  box.textContent = '';
  const n = buildNeighbourhood({
    center: input.center,
    depth: input.depth,
    edges: input.edges,
    titles: input.titles,
  });
  // ⚠ 中心しか居なければ**図にしない**(点 1 つを図と呼ばない)
  if (n.nodes.length <= 1) return 0;

  const fig = document.createElement('div');
  fig.setAttribute('data-pkc-field', 'relation-map');
  fig.style.position = 'relative';
  fig.style.width = '100%';
  fig.style.aspectRatio = `1 / ${ASPECT}`;

  /**
   * 🔴 **辺は装飾**(押すのは節点だけ)── だから `pointer-events: none` で
   * 下に敷く。⚠ 敷かないと、線の上で節点が押せなくなる。
   */
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 100 ${100 * ASPECT}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('data-pkc-field', 'relation-map-edges');
  svg.style.position = 'absolute';
  svg.style.inset = '0';
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.pointerEvents = 'none';

  const at = new Map(n.nodes.map((p) => [p.lid, p]));
  for (const e of n.edges) {
    const a = at.get(e.fromLid);
    const b = at.get(e.toLid);
    // ⚠ 片端が出ていない辺は `buildNeighbourhood` が既に落としているが、
    //    ここでも見る(宙に浮く線を「たぶん無い」で通さない)
    if (!a || !b) continue;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(a.x * 100));
    line.setAttribute('y1', String(a.y * 100 * ASPECT));
    line.setAttribute('x2', String(b.x * 100));
    line.setAttribute('y2', String(b.y * 100 * ASPECT));
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '0.6');
    line.setAttribute('opacity', '0.45');
    /**
     * 🔑 **本文のリンクは破線**にする ── 色で分けない。
     * ⚠ 色だけで意味を分けると、色覚の違いと**無彩色のテーマ**で読めなくなる
     *   (「地は無彩色、色は情報にだけ使う」= 色数を増やす向きへ倒さない)。
     */
    if (e.kind === BODY_LINK_KIND) line.setAttribute('stroke-dasharray', '2 1.5');
    line.setAttribute('data-pkc-field', 'relation-map-edge');
    line.setAttribute('data-pkc-relation-kind', e.kind);
    svg.append(line);
  }
  fig.append(svg);

  for (const p of n.nodes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    // ⚠ **既存の規約に合わせる**(`select-entry` は `data-pkc-entry` を読む)──
    //    ここで別名を作ると、押しても動かない導線になる
    btn.setAttribute('data-pkc-action', 'select-entry');
    btn.setAttribute('data-pkc-entry', p.lid);
    btn.setAttribute('data-pkc-field', p.ring === 0 ? 'relation-map-center' : 'relation-map-node');
    btn.setAttribute('data-pkc-ring', String(p.ring));
    btn.textContent = p.title;
    // 🔑 **題名が長くても図が崩れない**ように器の側で切る(title に全文を残す)
    btn.title = p.title;
    btn.style.position = 'absolute';
    btn.style.left = `${p.x * 100}%`;
    btn.style.top = `${p.y * 100}%`;
    btn.style.transform = 'translate(-50%, -50%)';
    btn.style.maxWidth = '42%';
    btn.style.overflow = 'hidden';
    btn.style.textOverflow = 'ellipsis';
    btn.style.whiteSpace = 'nowrap';
    fig.append(btn);
  }
  box.append(fig);

  /**
   * 🔴 **切ったら、そう言う**(黙って切ると user は「これで全部」と読む)。
   * ⚠ 件数まで出す ── 「一部です」だけだと、どれくらい隠れたか分からない。
   */
  if (n.truncated) {
    const more = document.createElement('p');
    more.setAttribute('data-pkc-field', 'relation-map-truncated');
    more.textContent = `つながりが多いので ${n.nodes.length} 件までにしています`;
    box.append(more);
  }

  /**
   * ⚠ **図だけにしない** ── 図は形を見る物で、**種類の名前は読めない**
   * (線に字を書くと狭い列で潰れる)。関係の一覧は同じ面の「関係」行が既に出しており、
   * ここでは**種類の内訳**だけ添える(何の線が何本か)。
   */
  const kinds = new Map<string, number>();
  for (const e of n.edges) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  if (kinds.size > 0) {
    const legend = document.createElement('p');
    legend.setAttribute('data-pkc-field', 'relation-map-legend');
    legend.textContent = [...kinds]
      .map(([kind, count]) => `${edgeLabel(kind)} ${count}`)
      .join(' / ');
    box.append(legend);
  }
  return n.nodes.length;
}
