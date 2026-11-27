/**
 * 🔴 **関係グラフの大規模表示(GPU)と 3D 表示**(v4.0 Phase 3 / PR-13、ビジョン 1-C)。
 *
 * 従来の図(`graph.ts` の DOM / SVG。上限 60 件)では描き切れない大きな関係グラフ(最大 1,000 件)を、
 * `gpu-lease.ts` から借りた描画面に **節点 1 回 + 辺 2 回の draw call** で描く。
 *
 * ## 守ること
 *
 * 1. **描くのは `gpu-lease.ts` の `createGpuSurface` だけ**。renderer を自分で作らない・rAF を自分で回さない。
 *    描き直しは「最初・データの更新・操作・ホバーの節点が変わった・大きさの変化(値が変わったときだけ)・
 *    テーマの属性の変化」のときだけ `invalidate()` を 1 回頼む(静止時の rAF = 0)。ドラッグ中は `setPinned(true)`。
 * 2. **節点は `InstancedMesh` 1 つ**(位置・大きさは `setMatrixAt`、色は `setColorAt`)。
 *    辺は `LineSegments` を関係 / 本文のリンクの 2 つにまとめる。色は地が無彩色、選んだ節点とホバーの節点だけ `--accent`。
 * 3. **押した節点は既存の `select-entry` で開く**(新しい action を作らない)。当たり判定は
 *    `features/relation/graph-gpu-layout.ts` の `pickGraphNode`(GPU でも 2D の Canvas でも同じ計算)。
 *    `GRAPH_DRAG_SLOP` を越えて動かした手では開かない。
 * 4. **畳んでも空白にしない**: `capturePoster()` で 1 コマ描いて PNG に焼く(ObjectURL の revoke は gpu-lease)。
 * 5. **GPU が使えない・1 枚にまとめた版**: 同じ点・同じ当たり判定で 2D の Canvas に描き、理由を控えめに 1 行添える。
 * 6. **後始末**: `session.dispose()` で InstancedMesh・LineSegments・BufferGeometry・Material を返し、
 *    `dispose()` で listener・`ResizeObserver`・`MutationObserver`・描画面を全部外す。
 * 7. **動きを減らす設定に止める物が無い**: 慣性も自動回転も持たない(操作 1 回 → 1 コマ)。
 *
 * ⚠ この module 自身は Three.js を静的に読まない(型だけ)── 実物は描画面を借りたときに gpu-lease が読む。
 *   関係グラフの既定(`dom`)ではこの class を作らないので、Three.js は 1 バイトも読まれない。
 */
import type * as ThreeModule from 'three';
import {
  createGpuSurface,
  type GpuContext,
  type GpuFrameSize,
  type GpuSession,
  type GpuSurface,
  type GpuSurfaceOptions,
  type Three,
} from '@adapter/platform/render/gpu-lease';
import {
  CANVAS_ZOOM_STEP,
  DEFAULT_CAMERA,
  panCamera,
  zoomAtPoint,
  zoomLabel,
  type CanvasCamera,
} from '@features/canvas/viewport';
import {
  orbitPan,
  orbitRotate,
  orbitZoom,
  orbitCameraPosition,
  wheelDeltaPx,
  wheelZoomsStage,
  type OrbitState,
} from '@features/viewer3d/orbit-math';
import type { GraphView } from '@features/relation/graph-view';
import {
  GRAPH_3D_FOV,
  GRAPH_HIT_RADIUS_PX,
  buildGraph2dPoints,
  buildGraph3dPoints,
  graphHomeOrbit,
  pickGraphNode,
  projectGraphPoints,
  type GraphPoint3d,
  type GraphRenderMode,
  type ProjectedGraphPoint,
} from '@features/relation/graph-gpu-layout';
import { cssColorToHex } from './css-color';
import { BODY_LINK_KIND } from './relation-map';

/** 押すとドラッグの境目(px)── `graph.ts` の `GRAPH_DRAG_SLOP` と同じ値(循環 import を避けて写す)。 */
const DRAG_SLOP = 4;

/** 2D の節点の半径(px、倍率 1 のとき)。 */
const NODE_PX = 4;
const NODE_PX_STRONG = 7;
/** 3D の節点の半径(ワールドの長さ)。 */
const NODE_3D = 0.022;
const NODE_3D_STRONG = 0.04;

export type GraphGpuMode = Exclude<GraphRenderMode, 'dom'>;
/** 状態の印(`data-pkc-graph-gpu-state`)。 */
export type GraphGpuState = 'loading' | 'ready' | 'fallback' | 'disposed';

export interface GraphGpuInput {
  readonly view: GraphView;
  /** 中心のノート(全体の図では `null`)。 */
  readonly centerLid: string | null;
  readonly selectedLid: string | null;
}

export interface GraphGpuViewOptions extends GraphGpuInput {
  readonly host: HTMLElement;
  readonly mode: GraphGpuMode;
  /** 2D のカメラの初期値(従来の図と共有する)。 */
  readonly camera2d?: CanvasCamera;
  /** 2D のカメラが変わった(従来の図へ戻ったときに持ち越すため)。 */
  readonly onCamera2d?: (cam: CanvasCamera) => void;
  /** 視点が変わった(バーの倍率の字を合わせ直すため)。 */
  readonly onViewChange?: () => void;
}

let surfaceFactory: (opts: GpuSurfaceOptions) => GpuSurface = createGpuSurface;

/** test 用: 描画面の作り方を差し替える(`null` で実物へ戻す)。 */
export function setGraphGpuTestHooks(hooks: { createSurface?: (opts: GpuSurfaceOptions) => GpuSurface } | null): void {
  surfaceFactory = hooks?.createSurface ?? createGpuSurface;
}

interface ThemeColors {
  surface: string | null;
  muted: string;
  accent: string;
}

function readTheme(el: HTMLElement): ThemeColors {
  const doc = el.ownerDocument;
  const cs = doc.defaultView?.getComputedStyle(el);
  const get = (name: string): string => cs?.getPropertyValue(name) ?? '';
  return {
    surface: cssColorToHex(doc, get('--surface')),
    muted: cssColorToHex(doc, get('--text-muted')) ?? cssColorToHex(doc, get('--muted')) ?? '#888888',
    accent: cssColorToHex(doc, get('--accent')) ?? '#2f6fde',
  };
}

const BACKEND_LABEL: Readonly<Record<string, string>> = { webgpu: 'WebGPU', webgl2: 'WebGL2', '2d': '2D 簡易表示' };

export class GraphGpuView {
  readonly element: HTMLElement;
  readonly stage: HTMLElement;
  /** ホバーの節点の札。⚠ 押した節点を開くのもこの `select-entry` のボタン(開く口を増やさない)。 */
  readonly hoverButton: HTMLButtonElement;
  readonly note: HTMLElement;
  readonly mode: GraphGpuMode;

  private input: GraphGpuInput;
  private points: readonly GraphPoint3d[] = [];
  private pointIndex = new Map<string, number>();
  private degrees = new Map<string, number>();
  /** データの世代(描画中の場面が作り直すかの判断)。 */
  private dataGen = 0;
  private lidKey = '';

  private surface: GpuSurface | null = null;
  private stateValue: GraphGpuState = 'loading';
  private cam2d: CanvasCamera;
  private orbitValue: OrbitState | null = null;
  private home: OrbitState | null = null;
  private hover: string | null = null;
  /** 🔴 描画面を「有効」にしたか(クリックで入り、Esc・外側のクリックで抜ける)。有効の間だけ、ただのホイールでもズームする。 */
  private active = false;
  private canvas2d: HTMLCanvasElement | null = null;
  private readonly cleanups: Array<() => void> = [];
  private readonly onCamera2d: ((cam: CanvasCamera) => void) | undefined;
  private readonly onViewChange: (() => void) | undefined;

  constructor(opts: GraphGpuViewOptions) {
    const doc = opts.host.ownerDocument;
    this.mode = opts.mode;
    this.input = { view: opts.view, centerLid: opts.centerLid, selectedLid: opts.selectedLid };
    this.cam2d = opts.camera2d ?? DEFAULT_CAMERA;
    this.onCamera2d = opts.onCamera2d;
    this.onViewChange = opts.onViewChange;

    this.element = doc.createElement('div');
    this.element.setAttribute('data-pkc-field', 'graph-gpu');
    this.element.setAttribute('data-pkc-graph-gpu-mode', opts.mode);
    this.element.setAttribute('data-pkc-graph-gpu-state', 'loading');

    this.stage = doc.createElement('div');
    this.stage.setAttribute('data-pkc-field', 'graph-gpu-stage');
    this.stage.tabIndex = 0;
    this.stage.setAttribute('role', 'application');
    this.stage.setAttribute(
      'aria-label',
      opts.mode === 'gpu3d'
        ? '関係グラフ(3D)。ドラッグで回転、Shift + ドラッグか右ドラッグで移動、Ctrl + ホイールで拡大・縮小(クリックして有効にするとホイールだけでも)、矢印キーでも回せます。0 で視点をリセット、Enter でポインタの下のノートを開きます'
        : '関係グラフ(大規模表示)。ドラッグで移動、Ctrl + ホイールで拡大・縮小(クリックして有効にするとホイールだけでも)、矢印キーでも動かせます。0 で 100% に戻し、Enter でポインタの下のノートを開きます',
    );

    this.hoverButton = doc.createElement('button');
    this.hoverButton.type = 'button';
    this.hoverButton.tabIndex = -1;
    this.hoverButton.setAttribute('data-pkc-action', 'select-entry');
    this.hoverButton.setAttribute('data-pkc-field', 'graph-gpu-hover');
    this.hoverButton.hidden = true;
    this.stage.append(this.hoverButton);

    this.note = doc.createElement('p');
    this.note.setAttribute('data-pkc-field', 'graph-gpu-note');
    this.note.hidden = true;

    this.element.append(this.stage, this.note);
    opts.host.append(this.element);
    this.setData(this.input);
    this.bindEvents();
    this.start();
  }

  // ── 観測点(test・バーの字)

  get state(): GraphGpuState {
    return this.stateValue;
  }
  get camera2d(): CanvasCamera {
    return this.cam2d;
  }
  get orbit(): OrbitState | null {
    return this.orbitValue;
  }
  get hoverLid(): string | null {
    return this.hover;
  }
  get graphPoints(): readonly GraphPoint3d[] {
    return this.points;
  }

  /** バーの倍率の字(2D は従来の図と同じ、3D は最初の視点からの寄り具合)。 */
  zoomText(): string {
    if (this.mode === 'gpu2d') return zoomLabel(this.cam2d.zoom);
    if (this.home === null || this.orbitValue === null) return '100%';
    return `${Math.round((this.home.radius / this.orbitValue.radius) * 100)}%`;
  }

  /** 画面の点へ写す(当たり判定と札の位置)。 */
  project(): ProjectedGraphPoint[] {
    const { w, h } = this.size();
    return projectGraphPoints(this.points, this.orbitValue, w, h, this.mode, this.cam2d, GRAPH_3D_FOV);
  }

  /** ポインタ(描画面の左上が原点の px)の下の節点。 */
  pickAt(x: number, y: number): string | null {
    return pickGraphNode(this.project(), x, y, GRAPH_HIT_RADIUS_PX);
  }

  // ── データ

  /** 図を差し替える(同じ描画面のまま。GPU を借り直さない)。 */
  update(input: GraphGpuInput): void {
    if (this.stateValue === 'disposed') return;
    this.setData(input);
    this.requestDraw();
  }

  private setData(input: GraphGpuInput): void {
    this.input = input;
    this.points =
      this.mode === 'gpu3d' ? buildGraph3dPoints(input.view, input.centerLid) : buildGraph2dPoints(input.view);
    this.pointIndex = new Map(this.points.map((p, i) => [p.lid, i]));
    this.degrees = new Map(this.points.map((p) => [p.lid, p.degree]));
    this.dataGen += 1;
    const key = `${input.centerLid ?? ''}\n${this.points.map((p) => p.lid).join('\n')}`;
    if (key !== this.lidKey) {
      this.lidKey = key;
      if (this.mode === 'gpu3d') {
        const { w, h } = this.size();
        this.home = graphHomeOrbit(this.points, w / h);
        this.orbitValue = this.home;
      }
    }
    if (this.hover !== null && !this.pointIndex.has(this.hover)) this.setHover(null);
  }

  private size(): { w: number; h: number } {
    return { w: Math.max(1, this.stage.clientWidth || 1), h: Math.max(1, this.stage.clientHeight || 1) };
  }

  private setState(s: GraphGpuState): void {
    this.stateValue = s;
    this.element.setAttribute('data-pkc-graph-gpu-state', s);
  }

  /** 描き直しを頼む(GPU なら `invalidate()`、2D ならその場で描く)。 */
  requestDraw(): void {
    if (this.stateValue === 'disposed') return;
    if (this.stateValue === 'fallback') {
      this.draw2d();
      return;
    }
    this.surface?.invalidate();
  }

  // ── カメラ(バーのボタン・キーボード)

  zoomIn(): void {
    this.zoomBy(1);
  }
  zoomOut(): void {
    this.zoomBy(-1);
  }

  private zoomBy(dir: 1 | -1): void {
    if (this.mode === 'gpu2d') {
      const { w, h } = this.size();
      const z = dir > 0 ? this.cam2d.zoom * CANVAS_ZOOM_STEP : this.cam2d.zoom / CANVAS_ZOOM_STEP;
      this.setCam2d(zoomAtPoint(this.cam2d, z, w / 2, h / 2));
    } else if (this.orbitValue !== null) {
      this.orbitValue = orbitZoom(this.orbitValue, dir > 0 ? -200 : 200);
    }
    this.afterCamera();
  }

  resetView(): void {
    if (this.mode === 'gpu2d') this.setCam2d(DEFAULT_CAMERA);
    else this.orbitValue = this.home;
    this.afterCamera();
  }

  private setCam2d(cam: CanvasCamera): void {
    this.cam2d = cam;
    this.onCamera2d?.(cam);
  }

  /** 描画面の有効 / 無効(ホイールでのズームの許可)。 */
  private setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    if (on) this.stage.setAttribute('data-pkc-graph-active', '');
    else this.stage.removeAttribute('data-pkc-graph-active');
  }

  private afterCamera(): void {
    this.placeHover();
    this.onViewChange?.();
    this.requestDraw();
  }

  // ── ホバーと開く

  private setHover(lid: string | null): void {
    if (lid === this.hover) return;
    this.hover = lid;
    this.stage.style.cursor = lid === null ? '' : 'pointer';
    const b = this.hoverButton;
    if (lid === null) {
      b.hidden = true;
      b.removeAttribute('data-pkc-entry');
      b.textContent = '';
      return;
    }
    const p = this.points[this.pointIndex.get(lid)!]!;
    b.setAttribute('data-pkc-entry', lid);
    b.textContent = `${p.title === '' ? '(無題)' : p.title} (つながり ${this.degrees.get(lid) ?? 0} 件)`;
    b.title = p.title;
    b.hidden = false;
    this.placeHover();
  }

  private placeHover(): void {
    if (this.hover === null) return;
    const i = this.pointIndex.get(this.hover);
    const p = i === undefined ? undefined : this.project()[i];
    if (p === undefined || !p.visible) {
      this.hoverButton.hidden = true;
      return;
    }
    this.hoverButton.hidden = false;
    this.hoverButton.style.left = `${Math.round(p.sx)}px`;
    this.hoverButton.style.top = `${Math.round(p.sy)}px`;
  }

  /** 🔴 節点を開く ── 既存の `select-entry` のボタンを押す(binder の 1 本に乗る)。 */
  open(lid: string): void {
    if (!this.pointIndex.has(lid)) return;
    this.setHover(lid);
    this.hoverButton.setAttribute('data-pkc-entry', lid);
    this.hoverButton.click();
  }

  // ── 操作

  private on<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void {
    el.addEventListener(type, fn as EventListener, opts);
    this.cleanups.push(() => el.removeEventListener(type, fn as EventListener, opts));
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bindEvents(): void {
    const stage = this.stage;
    let drag: { id: number; x: number; y: number; sx: number; sy: number; moved: boolean; button: number } | null = null;
    this.on(stage, 'contextmenu', (e) => e.preventDefault());
    this.on(stage, 'dblclick', (e) => e.stopPropagation());
    // ⚠ 札(`select-entry`)を直に押した click は binder へ通す。描画面の click は自分で決める(下の pointerup)
    this.on(stage, 'click', (e) => {
      if (e.target !== this.hoverButton) e.stopPropagation();
    });
    const doc = stage.ownerDocument;
    const onOutside = (e: Event): void => {
      if (e.target instanceof Node && stage.contains(e.target)) return;
      this.setActive(false);
    };
    doc.addEventListener('pointerdown', onOutside, true);
    this.cleanups.push(() => doc.removeEventListener('pointerdown', onOutside, true));
    this.on(stage, 'pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
      this.setActive(true);
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, button: e.button };
      this.surface?.setPinned(true);
      if (e.button === 1) e.preventDefault();
      // 🔑 ポスターの上で触ったら、静かに GPU へ戻す
      if (this.surface !== null && this.surface.state === 'idle') this.requestDraw();
    });
    this.on(stage, 'pointermove', (e) => {
      if (drag === null || e.pointerId !== drag.id) {
        if (drag !== null) return;
        const p = this.local(e);
        const lid = this.pickAt(p.x, p.y);
        if (lid !== this.hover) {
          this.setHover(lid);
          this.requestDraw();
        }
        return;
      }
      if (!drag.moved) {
        if (Math.abs(e.clientX - drag.sx) < DRAG_SLOP && Math.abs(e.clientY - drag.sy) < DRAG_SLOP) return;
        drag.moved = true;
        this.element.setAttribute('data-pkc-graph-panning', '');
        try {
          stage.setPointerCapture?.(e.pointerId);
        } catch {
          /* 捕まえられなくても器から届く */
        }
        if (this.hover !== null) this.setHover(null);
      }
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (dx === 0 && dy === 0) return;
      if (this.mode === 'gpu2d') {
        this.setCam2d(panCamera(this.cam2d, dx, dy));
      } else if (this.orbitValue !== null) {
        const panMode = e.shiftKey || drag.button === 2 || drag.button === 1 || (e.buttons & 6) !== 0;
        this.orbitValue = panMode
          ? orbitPan(this.orbitValue, dx, dy, this.size().h, GRAPH_3D_FOV)
          : orbitRotate(this.orbitValue, dx, dy);
      }
      this.afterCamera();
    });
    const end = (e: PointerEvent, cancelled: boolean): void => {
      if (drag === null || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      this.element.removeAttribute('data-pkc-graph-panning');
      this.surface?.setPinned(false);
      // 🔴 動かした手では開かない(`DRAG_SLOP` 未満の押下だけがクリック)
      if (cancelled || d.moved || d.button !== 0) return;
      const p = this.local(e);
      const lid = this.pickAt(p.x, p.y);
      if (lid !== null) this.open(lid);
    };
    this.on(stage, 'pointerup', (e) => end(e, false));
    this.on(stage, 'pointercancel', (e) => end(e, true));
    this.on(stage, 'pointerleave', () => {
      if (drag === null && this.hover !== null) {
        this.setHover(null);
        this.requestDraw();
      }
    });
    this.on(
      stage,
      'wheel',
      (e) => {
        // 🔴 スクロールの取り合いを 0 にする: Ctrl/⌘ + ホイール(ピンチ含む)か有効なときだけ奪う。
        //   それ以外は `preventDefault` せず親のスクロールへ流す(⚠ 奪う経路があるので非 passive で登録する)
        if (!wheelZoomsStage(e.ctrlKey || e.metaKey, this.active)) return;
        if (this.mode === 'gpu2d') {
          e.preventDefault();
          const p = this.local(e);
          this.setCam2d(zoomAtPoint(this.cam2d, this.cam2d.zoom * Math.exp(-wheelDeltaPx(e.deltaY, e.deltaMode) * 0.0015), p.x, p.y));
        } else {
          e.preventDefault();
          if (this.orbitValue !== null) this.orbitValue = orbitZoom(this.orbitValue, wheelDeltaPx(e.deltaY, e.deltaMode));
        }
        this.afterCamera();
      },
      { passive: false },
    );
    this.on(stage, 'keydown', (e) => {
      if (e.key === 'Escape' && this.active) {
        // 有効を抜ける(⚠ 背後のノート選択解除などへ Esc を流さない)
        this.setActive(false);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const step = 20;
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          if (this.mode === 'gpu2d') this.setCam2d(panCamera(this.cam2d, -dx * 2, -dy * 2));
          else if (this.orbitValue !== null) {
            this.orbitValue = e.shiftKey
              ? orbitPan(this.orbitValue, dx, dy, this.size().h, GRAPH_3D_FOV)
              : orbitRotate(this.orbitValue, dx, dy);
          }
          this.afterCamera();
          break;
        }
        case '+':
        case '=':
          this.zoomIn();
          break;
        case '-':
        case '_':
          this.zoomOut();
          break;
        case '0':
          this.resetView();
          break;
        case 'Enter':
          if (this.hover === null) return;
          this.open(this.hover);
          break;
        default:
          return;
      }
      e.preventDefault();
      // ⚠ 描画面で受けた矢印・+ / − / 0 / Enter を、一覧の移動などの全体のショートカットへ流さない
      e.stopPropagation();
    });

    // 大きさが本当に変わったときだけ描き直す(同じ大きさの報告で畳んだ GPU を借り直さない)
    const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (RO !== undefined) {
      let lastW = -1;
      let lastH = -1;
      const ro = new RO((entries) => {
        const r = entries[entries.length - 1]?.contentRect;
        const w = Math.round(r?.width ?? stage.clientWidth);
        const h = Math.round(r?.height ?? stage.clientHeight);
        if (w === lastW && h === lastH) return;
        const first = lastW < 0;
        lastW = w;
        lastH = h;
        if (!first || this.stateValue === 'fallback') {
          this.placeHover();
          this.requestDraw();
        }
      });
      ro.observe(stage);
      this.cleanups.push(() => ro.disconnect());
    }
    // テーマが変わったら描き直す(⚠ 配色の 3 属性だけ ── `viewer-3d.ts` と同じ)
    const html = stage.ownerDocument.documentElement;
    const MO = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
    if (MO !== undefined && html !== null) {
      const mo = new MO(() => this.requestDraw());
      mo.observe(html, { attributes: true, attributeFilter: ['data-pkc-theme', 'data-pkc-tone', 'data-pkc-accent'] });
      this.cleanups.push(() => mo.disconnect());
    }
  }

  // ── GPU

  private start(): void {
    this.surface = surfaceFactory({
      host: this.stage,
      onAcquire: (ctx) => this.acquire(ctx),
      onFallback2d: (_host, reason) => this.enterFallback2d(reason),
    });
    // 最初の 1 コマ(見えるまでは gpu-lease が待つ)
    this.surface.invalidate();
  }

  /** 節点の大きさ(2D は px、3D はワールドの長さ)。選んだ・中心・ホバーの節点はやや大きく。 */
  private nodeRadius(p: GraphPoint3d): number {
    const strong = p.lid === this.input.selectedLid || p.lid === this.hover || p.ring === 0;
    const grow = 1 + Math.min(1, p.degree / 12) * 0.5;
    if (this.mode === 'gpu3d') return (strong ? NODE_3D_STRONG : NODE_3D) * grow;
    // ⚠ 倍率の平方根で大きくする(縮小しても点が消えない・拡大しても塗りつぶさない)
    return ((strong ? NODE_PX_STRONG : NODE_PX) * grow) / Math.sqrt(this.cam2d.zoom);
  }

  private isAccent(lid: string): boolean {
    return lid === this.input.selectedLid || lid === this.hover;
  }

  private acquire(ctx: GpuContext): GpuSession {
    const T = ctx.three as Three;
    const is3d = this.mode === 'gpu3d';
    const scene = new T.Scene();
    const persp = is3d ? new T.PerspectiveCamera(GRAPH_3D_FOV, 1, 0.001, 100) : null;
    const ortho = is3d ? null : new T.OrthographicCamera(0, 1, 0, -1, -10, 10);
    if (ortho !== null) ortho.position.set(0, 0, 5);
    const nodeGeo: ThreeModule.BufferGeometry = is3d ? new T.IcosahedronGeometry(1, 1) : new T.CircleGeometry(1, 20);
    const nodeMat = new T.MeshBasicMaterial({ color: 0xffffff });
    const relMat = new T.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.45 });
    const linkMat = new T.LineDashedMaterial({
      color: 0x888888,
      transparent: true,
      opacity: 0.45,
      dashSize: is3d ? 0.03 : 6,
      gapSize: is3d ? 0.02 : 4,
    });
    let mesh: ThreeModule.InstancedMesh | null = null;
    let rel: ThreeModule.LineSegments | null = null;
    let link: ThreeModule.LineSegments | null = null;
    /** 形(InstancedMesh・辺)を作った時の鍵(データの世代・2D は大きさ)。 */
    let builtKey = '';
    /** 位置・大きさを書いた時の鍵(上 + 倍率・選んだ節点・ホバー)。 */
    let matrixKey = '';
    const m4 = new T.Matrix4();
    const col = new T.Color();

    const dropBuilt = (): void => {
      if (mesh !== null) {
        scene.remove(mesh);
        mesh.dispose();
        mesh = null;
      }
      for (const l of [rel, link]) {
        if (l === null) continue;
        scene.remove(l);
        l.geometry.dispose();
      }
      rel = null;
      link = null;
      builtKey = '';
      matrixKey = '';
    };

    /** ワールドの座標(2D は px で y を返す、3D はそのまま)。 */
    const world = (p: GraphPoint3d, w: number, h: number): [number, number, number] =>
      is3d ? [p.x, p.y, p.z] : [p.x * w, -(p.y * h), 0];

    /** 🔴 形を作る(データか 2D の大きさが変わったときだけ)── 節点 1 つの InstancedMesh + 辺 2 つの LineSegments。 */
    const build = (w: number, h: number): void => {
      const key = `${this.dataGen}|${is3d ? '' : `${w}x${h}`}`;
      if (key === builtKey) return;
      dropBuilt();
      builtKey = key;
      const pts = this.points;
      const n = pts.length;
      const im = new T.InstancedMesh(nodeGeo, nodeMat, Math.max(1, n));
      im.count = n;
      im.frustumCulled = false;
      mesh = im;
      scene.add(im);
      const relPos: number[] = [];
      const linkPos: number[] = [];
      for (const e of this.input.view.edges) {
        const a = this.pointIndex.get(e.fromLid);
        const b = this.pointIndex.get(e.toLid);
        if (a === undefined || b === undefined) continue;
        const target = e.kind === BODY_LINK_KIND ? linkPos : relPos;
        target.push(...world(pts[a]!, w, h), ...world(pts[b]!, w, h));
      }
      const mkLines = (
        pos: number[],
        mat: ThreeModule.LineBasicMaterial | ThreeModule.LineDashedMaterial,
      ): ThreeModule.LineSegments | null => {
        if (pos.length === 0) return null;
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3));
        const l = new T.LineSegments(g, mat);
        l.frustumCulled = false;
        if (mat === linkMat) l.computeLineDistances();
        scene.add(l);
        return l;
      };
      rel = mkLines(relPos, relMat);
      link = mkLines(linkPos, linkMat);
    };

    /** 位置・大きさを書く(形はそのまま ── ホバーや倍率の変化で GPU の buffer を作り直さない)。 */
    const writeMatrices = (w: number, h: number): void => {
      if (mesh === null) return;
      const key = `${builtKey}|${is3d ? '' : this.cam2d.zoom}|${this.input.selectedLid ?? ''}|${this.hover ?? ''}`;
      if (key === matrixKey) return;
      matrixKey = key;
      const pts = this.points;
      for (let i = 0; i < pts.length; i += 1) {
        const p = pts[i]!;
        const [x, y, z] = world(p, w, h);
        const r = this.nodeRadius(p);
        m4.makeScale(r, r, r);
        m4.setPosition(x, y, is3d ? z : 1);
        mesh.setMatrixAt(i, m4);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };

    const paintColors = (theme: ThemeColors): void => {
      if (mesh === null) return;
      const pts = this.points;
      for (let i = 0; i < pts.length; i += 1) {
        col.set(this.isAccent(pts[i]!.lid) ? theme.accent : theme.muted);
        mesh.setColorAt(i, col);
      }
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      relMat.color.set(theme.muted);
      linkMat.color.set(theme.muted);
    };

    let lastSize: GpuFrameSize = { width: 1, height: 1, pixelRatio: 1 };
    const render = (size: GpuFrameSize): void => {
      lastSize = size;
      const w = size.width;
      const h = size.height;
      const theme = readTheme(this.stage);
      scene.background = theme.surface === null ? null : new T.Color(theme.surface);
      build(w, h);
      writeMatrices(w, h);
      paintColors(theme);
      let camera: ThreeModule.Camera;
      if (persp !== null) {
        const o = this.orbitValue ?? this.home ?? graphHomeOrbit(this.points, w / h);
        const p = orbitCameraPosition(o);
        persp.aspect = w / Math.max(1, h);
        persp.near = Math.max(1e-4, o.radius / 1000);
        persp.far = Math.max(10, o.radius * 100);
        persp.position.set(p[0], p[1], p[2]);
        persp.lookAt(o.target[0], o.target[1], o.target[2]);
        persp.updateProjectionMatrix();
        camera = persp;
      } else {
        const c = this.cam2d;
        const cam = ortho!;
        cam.left = c.x;
        cam.right = c.x + w / c.zoom;
        cam.top = -c.y;
        cam.bottom = -(c.y + h / c.zoom);
        cam.updateProjectionMatrix();
        camera = cam;
      }
      (ctx.renderer as unknown as { render(s: ThreeModule.Scene, c: ThreeModule.Camera): void }).render(scene, camera);
    };

    if (this.stateValue === 'loading') this.setState('ready');
    this.element.setAttribute('data-pkc-graph-gpu-backend', ctx.backend);
    this.stage.setAttribute('data-pkc-graph-gpu-backend-label', BACKEND_LABEL[ctx.backend] ?? ctx.backend);
    return {
      render,
      capturePoster: () => {
        // ⚠ WebGL は描画バッファを残さない ── 1 コマ描いてから同じ処理の中で焼く
        render(lastSize);
        return new Promise<Blob | null>((resolve) => {
          try {
            ctx.canvas.toBlob((b) => resolve(b), 'image/png');
          } catch {
            resolve(null);
          }
        });
      },
      dispose: () => {
        dropBuilt();
        nodeGeo.dispose();
        nodeMat.dispose();
        relMat.dispose();
        linkMat.dispose();
      },
    };
  }

  // ── 2D の簡易表示(GPU が使えない・1 枚にまとめた版)

  private enterFallback2d(reason: string): void {
    if (this.stateValue === 'disposed') return;
    this.setState('fallback');
    this.element.setAttribute('data-pkc-graph-gpu-backend', '2d');
    this.note.textContent = reason;
    this.note.hidden = false;
    const canvas = this.stage.ownerDocument.createElement('canvas');
    canvas.setAttribute('data-pkc-field', 'graph-gpu-canvas2d');
    this.stage.insertBefore(canvas, this.hoverButton);
    this.canvas2d = canvas;
    this.draw2d();
  }

  /** 2D の Canvas に一括で描く(辺 → 節点の順。選んだ節点・ホバーの節点はアクセント色で最後に重ねる)。 */
  draw2d(): void {
    const canvas = this.canvas2d;
    if (canvas === null) return;
    const { w, h } = this.size();
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    let g: CanvasRenderingContext2D | null;
    try {
      g = canvas.getContext('2d');
    } catch {
      g = null;
    }
    if (g === null) return;
    const theme = readTheme(this.stage);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (theme.surface !== null) {
      g.fillStyle = theme.surface;
      g.fillRect(0, 0, w, h);
    }
    const pr = this.project();
    g.lineWidth = 1;
    g.strokeStyle = theme.muted;
    g.globalAlpha = 0.45;
    for (const dashed of [false, true]) {
      g.setLineDash?.(dashed ? [6, 4] : []);
      g.beginPath();
      for (const e of this.input.view.edges) {
        if ((e.kind === BODY_LINK_KIND) !== dashed) continue;
        const a = pr[this.pointIndex.get(e.fromLid) ?? -1];
        const b = pr[this.pointIndex.get(e.toLid) ?? -1];
        if (a === undefined || b === undefined || !Number.isFinite(a.sx + b.sx + a.sy + b.sy)) continue;
        g.moveTo(a.sx, a.sy);
        g.lineTo(b.sx, b.sy);
      }
      g.stroke();
    }
    g.setLineDash?.([]);
    g.globalAlpha = 1;
    // 奥から手前へ(3D の投影でも手前の節点が上に重なる)
    const order = pr.map((_, i) => i).filter((i) => pr[i]!.visible);
    order.sort((a, b) => pr[b]!.depth - pr[a]!.depth);
    const accents: number[] = [];
    g.fillStyle = theme.muted;
    g.beginPath();
    for (const i of order) {
      const p = this.points[i]!;
      if (this.isAccent(p.lid)) {
        accents.push(i);
        continue;
      }
      const r = this.radiusPx(p, pr[i]!);
      g.moveTo(pr[i]!.sx + r, pr[i]!.sy);
      g.arc(pr[i]!.sx, pr[i]!.sy, r, 0, Math.PI * 2);
    }
    g.fill();
    g.fillStyle = theme.accent;
    for (const i of accents) {
      const r = this.radiusPx(this.points[i]!, pr[i]!);
      g.beginPath();
      g.arc(pr[i]!.sx, pr[i]!.sy, r, 0, Math.PI * 2);
      g.fill();
    }
  }

  private radiusPx(p: GraphPoint3d, pr: ProjectedGraphPoint): number {
    if (this.mode === 'gpu2d') return this.nodeRadius(p) * pr.scale;
    return Math.max(2, Math.min(14, this.nodeRadius(p) * pr.scale));
  }

  // ── 後始末

  dispose(): void {
    if (this.stateValue === 'disposed') return;
    this.setState('disposed');
    for (const c of this.cleanups.splice(0)) c();
    const s = this.surface;
    this.surface = null;
    s?.dispose();
    this.canvas2d = null;
    this.element.remove();
  }
}
