/**
 * 🔴 **関係グラフの面**(#281 ①。user 指示 2026-08-19
 * 「office、ファイラ兼エクスプローラ、シェル、PDF エディタ、**関連性グラフビューワ**、…は組み込みアプリでリリースしたい」)。
 *
 * ## どこに在るか ── 左の列のタブと、別ウィンドウの面の 2 か所
 *
 * 連絡先 / 録ったものと同じ形(`contacts.ts` の docstring)。⚠ この描画器は同じ document に 2 つ生きうる
 * (左のタブ + 中央の面)ので、`data-pkc-region` を焼かない。見方(全体 / 手先の数)は **state**
 * (`graphView`)が持つ ── 描画器に覚えさせると、片方で変えた結果がもう片方に届かない。
 *
 * ## 情報ペインの「つながりの図」との違い
 *
 * あちらは選んだノートの 2 手先まで(固定・右の列)。こちらは **全体**、または **選んだノートから 1〜6 手先**。
 * 作りは同じ ── 節点は `<button>`(押すとそのノートを開く = 既存の `select-entry`)、辺は 1 枚の `<svg>`。
 * ⚠ 節点を押せることが要件なので、図を PNG の `<img>` に焼かない(焼くと「形は見えるが辿れない図」になる。
 *   `relation-map.ts` と同じ判断)。件数は `GRAPH_MAX_NODES` で打ち切り、**切ったらそう言う**。
 * ⚠ 配置は `features/relation/graph-view.ts`(pure)が決める ── ここは受け取った比を器に当てるだけ。
 *
 * ## 辺の出どころ
 *
 * - 関係(居場所の親子は除く)── 全ノートぶん
 * - 本文のリンク ── **選んでいるノートの分だけ**(出ていく = 開いている本文 / 入ってくる = 被リンク)。
 *   全ノートの本文を舐めるには worker の走査が要り、図を開くたびに走らせない(情報ペインの図と同じ判断)。
 *   ⚠ だから「全体」には本文のリンクが出ない ── 面の注記でそう言う。
 *
 * ## ズーム・パンとボードで開く(v4.0 Phase 2 / PR-10、ビジョン 2-B)
 *
 * - 図は無限キャンバスと同じ計算(`features/canvas/viewport.ts`)で、`Ctrl + ホイール` で拡大・縮小、ドラッグで移動する。
 *   ⚠ 節点の押下(`select-entry` でそのノートを開く)は奪わない ── `DRAG_SLOP` 未満の動きはクリックのまま。
 *   カメラは描画器が覚える(表示の状態。state にも本文にも書かない)。
 * - 「ボードで開く」(`graph-open-board`)は、いま見ている図を `layout: canvas` のボードのノートにして開く
 *   (`features/canvas/graph-to-board.ts`)。図を組むのは `graphViewOf` の 1 本(描画とボードで同じ図)。
 *
 * ## 大規模表示(GPU)と 3D(v4.0 Phase 3 / PR-13、ビジョン 1-C)
 *
 * - バーの「通常 / 大規模 / 3D」で描き方を切り替える。⚠ 描き方は**この描画器だけの表示の状態**
 *   (左のタブと中央の面で別々に選べる。state にも本文にも書かない)。
 * - `通常`(既定)は上の DOM / SVG の図のまま(上限 `GRAPH_MAX_NODES`)── **Three.js を 1 バイトも読まない**。
 * - `大規模` / `3D` は `graph-gpu.ts`(`gpu-lease.ts` から借りた描画面に InstancedMesh で描く)で、上限は `GRAPH_GPU_MAX_NODES`。
 *   通常の図が上限で切れているときは、注記の横に「大規模表示で全部見る」を出す(1 回押せば `大規模` へ)。
 * - 描き方を変える・面から出る(`onHidden`)・捨てる(`dispose`)ときは、前の GPU の図を必ず `dispose()` する。
 */
import type { AppState } from '@adapter/state/app-state';
import { buildGraphView, GRAPH_GPU_MAX_NODES, GRAPH_MAX_DEPTH, type GraphView } from '@features/relation/graph-view';
import { DEFAULT_GRAPH_RENDER_MODE, isGraphRenderMode, type GraphRenderMode } from '@features/relation/graph-gpu-layout';
import {
  CANVAS_ZOOM_STEP,
  DEFAULT_CAMERA,
  panCamera,
  stageTransform,
  zoomAtPoint,
  zoomLabel,
  type CanvasCamera,
} from '@features/canvas/viewport';
import { STRUCTURAL, relationLabel } from '@features/relation/kinds';
import { bodyLinkTargets } from '@features/entry-ref/body-links';
import { BODY_LINK_KIND } from './relation-map';
import { buildPressedButton } from './choice-buttons';
import { GraphGpuView } from './graph-gpu';

/** 図の器の比(高さ / 幅)。 */
const ASPECT = 0.82;
/** 押すとドラッグの境目(px)── これ未満の動きは節点の押下のまま(`place-drag.ts` と同じ値)。 */
export const GRAPH_DRAG_SLOP = 4;
/** ズームの押し所の印(`data-pkc-graph-zoom="out|reset|in"`)── 描画器が自分で受ける(表示だけ)。 */
export const GRAPH_ZOOM_ATTR = 'data-pkc-graph-zoom';
/** 描き方の押し所の印(`data-pkc-graph-mode="dom|gpu2d|gpu3d"`)── 描画器が自分で受ける(表示だけ)。 */
export const GRAPH_MODE_ATTR = 'data-pkc-graph-mode';

const MODE_BUTTONS: ReadonlyArray<{ mode: GraphRenderMode; label: string; title: string }> = [
  { mode: 'dom', label: '通常', title: 'ノートの題名を並べた図で描きます(最大 60 件)' },
  {
    mode: 'gpu2d',
    label: '大規模',
    title: `GPU で多くのノートを一度に描きます(最大 ${GRAPH_GPU_MAX_NODES.toLocaleString('ja-JP')} 件)。点を押すとそのノートを開きます`,
  },
  {
    mode: 'gpu3d',
    label: '3D',
    title: `つながりを立体で描きます(最大 ${GRAPH_GPU_MAX_NODES.toLocaleString('ja-JP')} 件)。ドラッグで回転、ホイールで拡大・縮小します`,
  },
];

/**
 * 🔴 **いまの見方の図**(描画と「ボードで開く」が同じ 1 本を引く)。
 * @returns 図にならない(ノートを選んでいない・選んだノートが無い)ときは `null`
 */
export function graphViewOf(state: AppState, opts: { readonly maxNodes?: number } = {}): GraphView | null {
  const { all, depth } = state.graphView;
  const center = all ? null : state.selectedLid;
  if (!all && (center === null || !state.entryMetas.has(center))) return null;
  const openBody = center !== null && state.openBody?.lid === center ? state.openBody.body : null;
  const back = center !== null && state.backlinks?.lid === center ? state.backlinks : null;
  const edges: { fromLid: string; toLid: string; kind: string }[] = state.relations
    .filter((r) => r.kind !== STRUCTURAL)
    .map((r) => ({ fromLid: r.fromLid, toLid: r.toLid, kind: r.kind }));
  if (center !== null) {
    if (openBody !== null) {
      for (const to of bodyLinkTargets(openBody, state.cid)) {
        edges.push({ fromLid: center, toLid: to, kind: BODY_LINK_KIND });
      }
    }
    if (back !== null) {
      for (const from of back.lids) {
        edges.push({ fromLid: from, toLid: center, kind: BODY_LINK_KIND });
      }
    }
  }
  const metas = state.entryMetas;
  return buildGraphView({
    center,
    depth,
    edges,
    titles: { has: (lid) => metas.has(lid), get: (lid) => metas.get(lid)?.title },
    ...(opts.maxNodes !== undefined ? { maxNodes: opts.maxNodes } : {}),
  });
}

function edgeLabel(kind: string): string {
  return kind === BODY_LINK_KIND ? '本文のリンク' : relationLabel(kind);
}

export class GraphRenderer {
  private readonly host: HTMLElement;
  private bar: HTMLElement | null = null;
  private note: HTMLElement | null = null;
  private box: HTMLElement | null = null;
  private last: unknown[] = [];
  /** 🔴 図のカメラ(表示の状態)。見方を変えても持ち越す。 */
  private cam: CanvasCamera = DEFAULT_CAMERA;
  private fig: HTMLElement | null = null;
  /** 🔴 描き方(表示の状態。描画器ごと ── 左のタブと中央の面で別々)。 */
  private mode: GraphRenderMode = DEFAULT_GRAPH_RENDER_MODE;
  /** 大規模 / 3D の図(`dom` のときは常に `null`)。 */
  private gpu: GraphGpuView | null = null;
  /** 最後に描いた state(描き方を変えたときに描き直す)。 */
  private lastState: AppState | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  private ensureFrame(): void {
    if (this.box !== null) return;
    const bar = document.createElement('div');
    bar.setAttribute('data-pkc-field', 'graph-bar');
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'graph-note');
    const box = document.createElement('div');
    box.setAttribute('data-pkc-field', 'graph-body');
    this.host.append(bar, note, box);
    this.bar = bar;
    this.note = note;
    this.box = box;
    this.wire(bar, box);
  }

  /** 図のカメラ(test 用)。 */
  get camera(): CanvasCamera {
    return this.cam;
  }

  /** いまの描き方(test 用)。 */
  get renderMode(): GraphRenderMode {
    return this.mode;
  }

  /** 大規模 / 3D の図(test 用。`dom` のときは `null`)。 */
  get gpuView(): GraphGpuView | null {
    return this.gpu;
  }

  /** 描き方を変える(同じなら何もしない)。⚠ 前の GPU の図はここで必ず返す。 */
  setRenderMode(mode: GraphRenderMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.disposeGpu();
    this.last = [];
    if (this.lastState !== null) this.render(this.lastState);
  }

  /** 面から出た(タブを切り替えた)── GPU の図を返す。戻ったら `render` が組み直す。 */
  onHidden(): void {
    this.disposeGpu();
    this.last = [];
  }

  /** すべて返す。 */
  dispose(): void {
    this.onHidden();
    this.lastState = null;
  }

  private disposeGpu(): void {
    const g = this.gpu;
    this.gpu = null;
    g?.dispose();
  }

  private applyCamera(): void {
    if (this.gpu !== null) {
      const b = this.bar?.querySelector<HTMLButtonElement>(`[${GRAPH_ZOOM_ATTR}="reset"]`);
      const text = this.gpu.zoomText();
      if (b != null && b.textContent !== text) b.textContent = text;
      return;
    }
    if (this.fig !== null) {
      if (this.cam.zoom === 1 && this.cam.x === 0 && this.cam.y === 0) this.fig.style.removeProperty('transform');
      else this.fig.style.transform = stageTransform(this.cam);
    }
    const b = this.bar?.querySelector<HTMLButtonElement>(`[${GRAPH_ZOOM_ATTR}="reset"]`);
    const text = zoomLabel(this.cam.zoom);
    if (b != null && b.textContent !== text) b.textContent = text;
  }

  /** 図の中の点(px)。 */
  private viewPoint(clientX: number, clientY: number): { x: number; y: number; w: number; h: number } {
    const vp = this.box?.querySelector<HTMLElement>('[data-pkc-field="graph-viewport"]');
    const r = vp?.getBoundingClientRect();
    return {
      x: clientX - (r?.left ?? 0),
      y: clientY - (r?.top ?? 0),
      w: vp?.clientWidth ?? 0,
      h: vp?.clientHeight ?? 0,
    };
  }

  /**
   * 🔴 **ズーム・パンの配線**(器に 1 度だけ)。
   * - `Ctrl` / `⌘` + ホイール: ポインタの下を動かさずに拡大・縮小(ホイールだけなら画面のスクロールのまま)。
   * - ドラッグ(左・中ボタン): 移動。⚠ `GRAPH_DRAG_SLOP` を越えるまでは何もしない ── 節点の押下を奪わない。
   *   越えたら離した後の `click` を 1 回捨てる(動かした手で節点を開かない)。
   * - バーの `−` / 倍率 / `+`: 図の真ん中で拡大・縮小、倍率を押すと 100% に戻す。
   */
  private wire(bar: HTMLElement, box: HTMLElement): void {
    let drag: { id: number; x: number; y: number; sx: number; sy: number; moved: boolean } | null = null;
    let swallow = false;
    const modeClick = (e: Event): void => {
      const m = (e.target as Element | null)?.closest?.(`[${GRAPH_MODE_ATTR}]`);
      if (m == null) return;
      e.preventDefault();
      const v = m.getAttribute(GRAPH_MODE_ATTR);
      if (isGraphRenderMode(v)) this.setRenderMode(v);
    };
    // 注記の「大規模表示で全部見る」も同じ印で受ける
    this.note?.addEventListener('click', modeClick);
    bar.addEventListener('click', (e) => {
      modeClick(e);
      const b = (e.target as Element | null)?.closest?.(`[${GRAPH_ZOOM_ATTR}]`);
      if (b == null) return;
      e.preventDefault();
      const kind = b.getAttribute(GRAPH_ZOOM_ATTR);
      const gpu = this.gpu;
      if (gpu !== null) {
        if (kind === 'reset') gpu.resetView();
        else if (kind === 'in') gpu.zoomIn();
        else if (kind === 'out') gpu.zoomOut();
        this.applyCamera();
        return;
      }
      const { w, h } = this.viewPoint(0, 0);
      if (kind === 'reset') this.cam = DEFAULT_CAMERA;
      else if (kind === 'in') this.cam = zoomAtPoint(this.cam, this.cam.zoom * CANVAS_ZOOM_STEP, w / 2, h / 2);
      else if (kind === 'out') this.cam = zoomAtPoint(this.cam, this.cam.zoom / CANVAS_ZOOM_STEP, w / 2, h / 2);
      this.applyCamera();
    });
    box.addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || e.metaKey) || this.fig === null) return;
        e.preventDefault();
        const p = this.viewPoint(e.clientX, e.clientY);
        const unit = e.deltaMode === 1 ? 16 : 1;
        this.cam = zoomAtPoint(this.cam, this.cam.zoom * Math.exp(-e.deltaY * unit * 0.0015), p.x, p.y);
        this.applyCamera();
      },
      { passive: false },
    );
    box.addEventListener('pointerdown', (e) => {
      swallow = false;
      if ((e.button !== 0 && e.button !== 1) || this.fig === null) return;
      if (!(e.target instanceof Element) || !this.fig.contains(e.target)) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
      // ⚠ ここでは捕まえない・既定を止めない(節点のフォーカスと click をそのまま通す)
      if (e.button === 1) e.preventDefault();
    });
    box.addEventListener('pointermove', (e) => {
      if (drag === null || e.pointerId !== drag.id) return;
      if (!drag.moved) {
        if (Math.abs(e.clientX - drag.sx) < GRAPH_DRAG_SLOP && Math.abs(e.clientY - drag.sy) < GRAPH_DRAG_SLOP) return;
        drag.moved = true;
        box.setAttribute('data-pkc-graph-panning', '');
        try {
          box.setPointerCapture(e.pointerId);
        } catch {
          // 捕まえられない環境でも pointermove は器から届く
        }
      }
      this.cam = panCamera(this.cam, e.clientX - drag.x, e.clientY - drag.y);
      drag.x = e.clientX;
      drag.y = e.clientY;
      this.applyCamera();
    });
    const end = (e: PointerEvent): void => {
      if (drag === null || e.pointerId !== drag.id) return;
      swallow = drag.moved;
      drag = null;
      box.removeAttribute('data-pkc-graph-panning');
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
    box.addEventListener(
      'click',
      (e) => {
        if (!swallow) return;
        swallow = false;
        e.stopPropagation();
        e.preventDefault();
      },
      true,
    );
  }

  render(state: AppState): void {
    this.ensureFrame();
    this.lastState = state;
    const gpuMode = this.mode !== 'dom';
    const { all, depth } = state.graphView;
    const center = all ? null : state.selectedLid;
    // 本文のリンクは選んでいるノートの分だけ(上の docstring)
    const openBody =
      center !== null && state.openBody?.lid === center ? state.openBody.body : null;
    const back = center !== null && state.backlinks?.lid === center ? state.backlinks : null;
    // ⚠ 指紋は参照で見る(全ノートぶんの写しを作らない)。同じなら触らない
    const key: unknown[] = [
      all,
      depth,
      center,
      state.relations,
      state.entryMetas,
      state.cid,
      openBody,
      back,
      this.mode,
      // 大規模 / 3D は選んだノートの色を変える(通常の図は今までどおり)
      gpuMode ? state.selectedLid : null,
    ];
    if (key.length === this.last.length && key.every((v, i) => v === this.last[i])) return;
    this.last = key;

    const metas = state.entryMetas;
    const view = graphViewOf(state, gpuMode ? { maxNodes: GRAPH_GPU_MAX_NODES } : {}) ?? {
      nodes: [],
      edges: [],
      truncated: false,
      total: 0,
    };
    this.paintBar(all, depth, view.nodes.length);

    const box = this.box!;
    const note = this.note!;
    const drawable = (all || (center !== null && metas.has(center))) && view.nodes.length > 1;
    // 🔑 大規模 / 3D の図は、描ける間は同じ描画面のまま中身だけ差し替える(GPU を借り直さない)
    if (gpuMode && drawable && this.gpu !== null && box.contains(this.gpu.element)) {
      note.replaceChildren(this.noteText(all, view));
      this.gpu.update({ view, centerLid: center, selectedLid: state.selectedLid });
      box.querySelector('[data-pkc-field="graph-legend"]')?.remove();
      this.appendLegend(box, view);
      this.applyCamera();
      return;
    }
    this.disposeGpu();
    box.textContent = '';
    this.fig = null;
    if (!all && center === null) {
      note.textContent = 'ノートを選ぶと、そのノートからつながりを描きます(「全体」でノート全部のつながりも見られます)';
      return;
    }
    if (!all && !metas.has(center!)) {
      note.textContent = '選んだノートが見つかりません';
      return;
    }
    if (view.nodes.length <= 1) {
      note.textContent = all
        ? 'つながり(関係)を持つノートがまだありません'
        : 'このノートにはつながり(関係・本文のリンク)がありません';
      return;
    }
    note.replaceChildren(this.noteText(all, view));
    if (view.truncated && this.mode === 'dom') {
      // 🔑 切れているときだけ、大規模表示への導線を控えめに添える(1 回押せば `大規模` へ)
      const more = document.createElement('button');
      more.type = 'button';
      more.setAttribute(GRAPH_MODE_ATTR, 'gpu2d');
      more.setAttribute('data-pkc-field', 'graph-more');
      more.textContent = `大規模表示で全部見る(最大 ${GRAPH_GPU_MAX_NODES.toLocaleString('ja-JP')} 件)`;
      more.title = 'GPU で多くのノートを一度に描く表示に切り替えます';
      note.append(' ', more);
    }

    if (gpuMode) {
      this.gpu = new GraphGpuView({
        host: box,
        mode: this.mode as 'gpu2d' | 'gpu3d',
        view,
        centerLid: center,
        selectedLid: state.selectedLid,
        camera2d: this.cam,
        onCamera2d: (cam) => {
          this.cam = cam;
        },
        onViewChange: () => this.applyCamera(),
      });
      this.applyCamera();
      this.appendLegend(box, view);
      return;
    }

    // 🔑 枠(はみ出しを切る)の中で図だけを transform で動かす(無限キャンバスと同じ形)
    const viewport = document.createElement('div');
    viewport.setAttribute('data-pkc-field', 'graph-viewport');
    const fig = document.createElement('div');
    fig.setAttribute('data-pkc-field', 'graph-map');
    fig.style.position = 'relative';
    fig.style.width = '100%';
    fig.style.aspectRatio = `1 / ${ASPECT}`;
    fig.style.transformOrigin = '0 0';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 100 ${100 * ASPECT}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('data-pkc-field', 'graph-edges');
    svg.style.position = 'absolute';
    svg.style.inset = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    const at = new Map(view.nodes.map((p) => [p.lid, p]));
    for (const e of view.edges) {
      const a = at.get(e.fromLid);
      const b = at.get(e.toLid);
      if (!a || !b) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(a.x * 100));
      line.setAttribute('y1', String(a.y * 100 * ASPECT));
      line.setAttribute('x2', String(b.x * 100));
      line.setAttribute('y2', String(b.y * 100 * ASPECT));
      line.setAttribute('stroke', 'currentColor');
      line.setAttribute('stroke-width', '0.4');
      line.setAttribute('opacity', '0.45');
      // 本文のリンクは色ではなく破線で分ける(地は無彩色)
      if (e.kind === BODY_LINK_KIND) line.setAttribute('stroke-dasharray', '2 1.5');
      line.setAttribute('data-pkc-field', 'graph-edge');
      line.setAttribute('data-pkc-relation-kind', e.kind);
      svg.append(line);
    }
    fig.append(svg);
    for (const p of view.nodes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      // ⚠ 既存の `select-entry` に乗る(開く口を増やさない)
      btn.setAttribute('data-pkc-action', 'select-entry');
      btn.setAttribute('data-pkc-entry', p.lid);
      btn.setAttribute('data-pkc-field', p.lid === state.selectedLid ? 'graph-node-current' : 'graph-node');
      btn.setAttribute('data-pkc-ring', String(p.ring));
      if (p.lid === state.selectedLid) btn.setAttribute('aria-current', 'true');
      btn.textContent = p.title === '' ? '(無題)' : p.title;
      btn.title = p.title;
      btn.style.position = 'absolute';
      btn.style.left = `${p.x * 100}%`;
      btn.style.top = `${p.y * 100}%`;
      btn.style.transform = 'translate(-50%, -50%)';
      btn.style.maxWidth = all ? '24%' : '42%';
      btn.style.overflow = 'hidden';
      btn.style.textOverflow = 'ellipsis';
      btn.style.whiteSpace = 'nowrap';
      fig.append(btn);
    }
    viewport.append(fig);
    box.append(viewport);
    this.fig = fig;
    this.applyCamera();
    this.appendLegend(box, view);
  }

  /** 注記の字(件数と、切ったときの断り)。 */
  private noteText(all: boolean, view: GraphView): string {
    const cut = view.truncated
      ? `つながりが多いので ${view.nodes.length} 件までにしています(全部で ${view.total} 件${all ? '。つながりの多い順' : '。近い順'})`
      : '';
    return [
      all
        ? `全体 ${view.nodes.length} 件 / 本文のリンクは、ノートを選んだ見方でだけ出ます`
        : `${view.nodes.length} 件`,
      cut,
    ]
      .filter((t) => t !== '')
      .join('。');
  }

  /** 凡例(辺の種類ごとの数)。 */
  private appendLegend(box: HTMLElement, view: GraphView): void {
    const kinds = new Map<string, number>();
    for (const e of view.edges) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    if (kinds.size > 0) {
      const legend = document.createElement('p');
      legend.setAttribute('data-pkc-field', 'graph-legend');
      legend.textContent = [...kinds].map(([k, n]) => `${edgeLabel(k)} ${n}`).join(' / ');
      box.append(legend);
    }
  }

  /** 見方のボタン(全体 / 選んだノートから + 手先の数)。state が正で、毎回合わせ直す。 */
  private paintBar(all: boolean, depth: number, nodeCount: number): void {
    const bar = this.bar!;
    bar.textContent = '';
    bar.append(
      buildPressedButton({
        action: 'graph-scope',
        dataAttr: 'data-pkc-graph-scope',
        value: 'selected',
        label: '選んだノートから',
        pressed: !all,
        title: '選んでいるノートを中心に、つながりを手先の数だけたどって描きます',
      }),
      buildPressedButton({
        action: 'graph-scope',
        dataAttr: 'data-pkc-graph-scope',
        value: 'all',
        label: '全体',
        pressed: all,
        title: 'つながり(関係)を持つノートを、つながりの多い順に上限まで描きます',
      }),
    );
    if (!all) {
      for (let n = 1; n <= GRAPH_MAX_DEPTH; n += 1) {
        bar.append(
          buildPressedButton({
            action: 'graph-depth',
            dataAttr: 'data-pkc-graph-depth',
            value: String(n),
            label: `${n} 手`,
            pressed: n === depth,
            title: `選んだノートから ${n} 手先までたどります`,
          }),
        );
      }
    }
    bar.append(this.modes(), this.tools(nodeCount));
  }

  /** 描き方(通常 / 大規模 / 3D)── 描画器が自分で受ける(state を変えない)。 */
  private modes(): HTMLElement {
    const g = document.createElement('span');
    g.setAttribute('data-pkc-field', 'graph-modes');
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', '描き方');
    for (const m of MODE_BUTTONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute(GRAPH_MODE_ATTR, m.mode);
      b.setAttribute('aria-pressed', String(m.mode === this.mode));
      b.textContent = m.label;
      b.title = m.title;
      g.append(b);
    }
    return g;
  }

  /**
   * 🔴 **ズームと「ボードで開く」**(v4.0 Phase 2 / PR-10)── 見方のボタンの後ろに控えめに並べる。
   * ⚠ 「ボードで開く」は節点が 1 件以上あるときだけ押せる(空のボードを作らない)。
   */
  private tools(nodeCount: number): HTMLElement {
    const g = document.createElement('span');
    g.setAttribute('data-pkc-field', 'graph-tools');
    const zoom = (kind: 'out' | 'reset' | 'in', text: string, title: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute(GRAPH_ZOOM_ATTR, kind);
      b.textContent = text;
      b.title = title;
      b.setAttribute('aria-label', title);
      return b;
    };
    const open = document.createElement('button');
    open.type = 'button';
    open.setAttribute('data-pkc-action', 'graph-open-board');
    open.textContent = 'ボードで開く';
    open.title = 'いまの図を、並べ替えや書き足しができるボード(無限キャンバス)の新しいノートにして開きます';
    open.disabled = nodeCount === 0;
    g.append(
      zoom('out', '−', '図を縮小します(Ctrl + ホイールでも変えられます)'),
      zoom('reset', zoomLabel(this.cam.zoom), '押すと 100% に戻します'),
      zoom('in', '+', '図を拡大します(Ctrl + ホイールでも変えられます)'),
      open,
    );
    return g;
  }
}
