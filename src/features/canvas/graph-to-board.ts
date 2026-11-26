/**
 * 🔴 **関係グラフ → 無限キャンバスのボード**(v4.0 Phase 2 / PR-10、ビジョン 2-B)── 本文の字を作るだけ。
 *
 * 関係グラフで見ている図を、そのまま並べ替え・書き足しのできるボード(PKC-Markdown)にする。
 * 新しいデータ形式は作らない ── ノートは `entry=` の付箋(`.pkc-place`)、つながりは線(`.pkc-line`)。
 *
 * ```
 * ---
 * layout: canvas
 * ---
 *
 * :::format{#n1 .pkc-place x=… y=… w=220 h=100 entry=<lid>}
 * :::
 *
 * :::format{.pkc-line from=n1 to=n2}
 * :::
 * ```
 *
 * ## 配置
 *
 * 図の節点は 0..1 の比で来る(`features/relation/graph-view.ts`)。これを枡目(付箋 1 枚より大きい升)へ
 * 当てて、**同じ升に 2 枚置かない**(空いた升を近い順に探す)── だから付箋は重ならない。
 * 升の数は節点の数で広げる(60 件でも詰め込まない)。
 *
 * ⚠ pure module ── 時計も乱数も使わない(同じ図は同じ本文になる)。
 * ⚠ 題名は本文へ書かない(付箋は `entry=` でノートを指すので、題名は描画のたびにノートから引く ──
 *   本文に写すと、ノートの題名を直したときに古い字が残る)。`opts.title` は呼び側がノートの題名に使う既定値。
 */
import type { GraphView } from '@features/relation/graph-view';

/** 付箋 1 枚の大きさ(ワールド px)。 */
export const GRAPH_BOARD_CARD_W = 220;
export const GRAPH_BOARD_CARD_H = 100;
/** 升の大きさ(付箋 + 余白)。⚠ 付箋より大きい ── 升 1 つに 1 枚なら重ならない。 */
const CELL_W = 280;
const CELL_H = 160;
/** 既定の広さ(升の数で 900 × 720 前後)。節点が多ければ広げる。 */
const MIN_COLS = 4;
const MIN_ROWS = 5;

/** ボードを作るときの既定の題名。 */
export const GRAPH_BOARD_DEFAULT_TITLE = '関係グラフのボード';

/** 開き行に書ける lid か(英数・`_`・`-`。`addPlaceEntry` と同じ門 ── 札の並びを壊さない)。 */
function isSafeLid(lid: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(lid);
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

/** 0..1 の比の節点を、重ならない升へ当てる。返すのは升の (列, 行)。 */
function placeOnGrid(points: ReadonlyArray<{ x: number; y: number }>): Array<{ col: number; row: number }> {
  const n = points.length;
  const cols = Math.max(MIN_COLS, Math.ceil(Math.sqrt(n * 1.6)));
  const rows = Math.max(MIN_ROWS, Math.ceil(n / cols) + 2);
  const taken = new Set<string>();
  const out: Array<{ col: number; row: number }> = [];
  for (const p of points) {
    const c0 = Math.round(clamp01(p.x) * (cols - 1));
    const r0 = Math.round(clamp01(p.y) * (rows - 1));
    let found: { col: number; row: number } | null = null;
    // 🔑 近い升から順に探す(四角い輪を 1 つずつ広げる)── 決まった順なので結果は毎回同じ
    for (let ring = 0; found === null; ring += 1) {
      for (let dr = -ring; dr <= ring && found === null; dr += 1) {
        for (let dc = -ring; dc <= ring && found === null; dc += 1) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const col = c0 + dc;
          const row = r0 + dr;
          if (col < 0 || row < 0) continue;
          const k = `${col},${row}`;
          if (taken.has(k)) continue;
          taken.add(k);
          found = { col, row };
        }
      }
    }
    out.push(found);
  }
  return out;
}

/**
 * 🔴 **関係グラフの図をボードの本文にする**。
 * - 節点 → `entry=` の付箋(`#n1`, `#n2`, … を順に付ける)。
 * - 辺 → `.pkc-line`(同じ 2 枚の間は 1 本。自分自身への辺・図に無い節点への辺は書かない)。
 * - 節点が 0 件でも、前書き(`layout: canvas`)だけの本文を返す(空のボード)。
 * ⚠ 開き行に書けない lid(英数・`_`・`-` 以外の字を含む)の節点は書かない(札の並びを壊さない)。
 */
export function graphViewToBoardMarkdown(view: GraphView, opts?: { title?: string }): string {
  void opts; // 題名は本文に書かない(上の docstring)
  const nodes = view.nodes.filter((n) => isSafeLid(n.lid));
  const cells = placeOnGrid(nodes);
  const ids = new Map<string, string>();
  const blocks: string[] = [];
  nodes.forEach((n, i) => {
    if (ids.has(n.lid)) return; // 同じノートを 2 枚置かない
    const id = `n${ids.size + 1}`;
    ids.set(n.lid, id);
    const cell = cells[i]!;
    const x = cell.col * CELL_W;
    const y = cell.row * CELL_H;
    blocks.push(
      `:::format{#${id} .pkc-place x=${x} y=${y} w=${GRAPH_BOARD_CARD_W} h=${GRAPH_BOARD_CARD_H} entry=${n.lid}}\n:::`,
    );
  });
  const seen = new Set<string>();
  for (const e of view.edges) {
    const a = ids.get(e.fromLid);
    const b = ids.get(e.toLid);
    if (a === undefined || b === undefined || a === b) continue;
    const k = `${a}>${b}`;
    if (seen.has(k) || seen.has(`${b}>${a}`)) continue;
    seen.add(k);
    blocks.push(`:::format{.pkc-line from=${a} to=${b}}\n:::`);
  }
  const head = '---\nlayout: canvas\n---\n';
  return blocks.length === 0 ? head : `${head}\n${blocks.join('\n\n')}\n`;
}
