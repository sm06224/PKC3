/**
 * 🔴 **付箋のボードを無限キャンバスで見る**(v4.0 Phase 2 / PR-09、ビジョン 2-A)── 配線と表示だけ。
 * 数(カメラ・全体を表示・カリング・ミニマップの写像)は `features/canvas/viewport.ts`(pure)の 1 本を引く。
 *
 * ## 形
 *
 * ```
 * [バー]                    ← 本文の器の手前(通常表示でもキャンバスでも同じ場所)
 * [ビューポート(枠)]         ← キャンバスのときだけ。器を包む(overflow: hidden・点の格子)
 *   └ 本文の器 = ステージ     ← `transform: translate3d(…) scale(…)` だけを動かす
 *   └ ミニマップ(右下)
 * ```
 *
 * ⚠ **塊(付箋)の親子は動かさない** ── ライブエディタと差分描画は塊が器の直下であることを前提にしている
 *   (`place-board.ts` 冒頭)。包むのは**器そのもの**で、塊は器の子のまま。
 * 🔑 器の座標 = 付箋の `x=` / `y=`(ワールド座標)。器を左上原点で拡大・移動するだけなので、
 *   掴む・大きさを変える・線でつなぐは、画面の移動量を倍率で割れば同じ式で動く(`canvasZoomOf` / `boardPointOf`)。
 *
 * ## 定常コスト
 *
 * - 付箋が 1 枚も無いノートでは**何も作らない**(バーもビューポートも監視も無い)。
 * - 通常表示では、バーの押し所 1 つだけ(監視・計算なし)。
 * - パン・ズームの最中は**ステージの transform と点の格子の位置だけ**を書く(本文の書込・DOM の作り直しなし)。
 *   カリングとミニマップは次のコマで 1 回だけ当てる。
 *
 * ## カメラは本文を汚さない
 *
 * 位置・倍率はノートごとにこのタブの中だけで覚える(`cameraMemory`)。本文に書くのは、押して選んだときの
 * `layout: canvas`(いつもキャンバスで開く)だけ。
 */
import {
  boundsOfRects,
  CANVAS_ZOOM_DEFAULT,
  CANVAS_ZOOM_STEP,
  centerCameraOn,
  clampZoom,
  fitCameraToBounds,
  isRectInViewport,
  minimapGeometry,
  minimapPointToWorld,
  panCamera,
  stageTransform,
  zoomAtPoint,
  zoomLabel,
  type CanvasCamera,
  type CanvasRect,
  type MinimapGeometry,
} from '@features/canvas/viewport';
import { isCanvasLayout } from '@features/markdown/document-globals';
import { rotatedBounds } from '@features/markdown/place-rotate';
import { rectOf } from './place-board';

const PLACE_SELECTOR = '.pkc-format-block.pkc-place';

/** キャンバスで見ている器の印(ステージ)。 */
export const CANVAS_ATTR = 'data-pkc-canvas';
/** 画面の外の付箋の印(CSS が `content-visibility: hidden` にする)。 */
export const CULLED_ATTR = 'data-pkc-canvas-culled';
/** 通常表示で、負の位置の付箋が画面の外へ出ないよう器をずらしている印。 */
export const SHIFT_ATTR = 'data-pkc-board-shift';

export const VIEWPORT_FIELD = 'canvas-viewport';
export const BAR_FIELD = 'canvas-bar';
export const MINIMAP_FIELD = 'canvas-minimap';
/** バーのボタンの役目(`data-pkc-canvas-cmd`)。 */
export const CMD_ATTR = 'data-pkc-canvas-cmd';
export type CanvasCommand = 'mode' | 'zoom-out' | 'zoom-reset' | 'zoom-in' | 'fit' | 'minimap' | 'default';

const MINIMAP_W = 200;
const MINIMAP_H = 140;
/** 点の格子の間隔(ワールド px)。⚠ 縮めて詰まりすぎたら倍にする(画面で 12px 未満にしない)。 */
const GRID_STEP = 24;
const GRID_MIN_SCREEN = 12;
/** 押すとドラッグの境目(px)。⚠ `place-drag.ts` と同じ値。 */
const PAN_SLOP = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** ノートごとの表示の選択(このタブの中だけ。本文の `layout: canvas` より優先する)。 */
const modeMemory = new Map<string, boolean>();
/** ノートごとのカメラ(このタブの中だけ。本文には書かない)。 */
const cameraMemory = new Map<string, CanvasCamera>();
/** ミニマップを出すか(タブの中で共通)。 */
let minimapOpen = true;

interface Canvas {
  readonly host: HTMLElement;
  readonly vp: HTMLElement;
  readonly minimap: HTMLElement;
  lid: string;
  cam: CanvasCamera;
  /** 付箋の四角(ワールド座標)── 描画のたびに測り直し、パン・ズーム中は測らない。 */
  rects: Array<{ el: HTMLElement; rect: CanvasRect }>;
  frame: number | null;
  geometry: MinimapGeometry | null;
  dispose: () => void;
}

interface BoardView {
  lid: string;
  body: string;
  bar: HTMLElement;
  canvas: Canvas | null;
}

const views = new WeakMap<HTMLElement, BoardView>();

/** 器がキャンバスで見られているか。 */
export function isCanvasHost(host: Element | null): boolean {
  return host instanceof HTMLElement && views.get(host)?.canvas != null;
}

/**
 * 🔴 **器の倍率**(掴む・大きさ・線の移動量を割る数)。キャンバスでなければ 1。
 * 🔑 掴む側(`place-drag.ts`)・つなぐ側(`place-connect.ts`)・右クリックの位置(binder)が**この 1 本**を引く。
 */
export function canvasZoomOf(host: Element | null): number {
  if (!(host instanceof HTMLElement)) return 1;
  return views.get(host)?.canvas?.cam.zoom ?? 1;
}

/** 器のカメラ(キャンバスでなければ `null`)。 */
export function canvasCameraOf(host: Element | null): CanvasCamera | null {
  if (!(host instanceof HTMLElement)) return null;
  return views.get(host)?.canvas?.cam ?? null;
}

/**
 * 🔴 **画面の点 → 器の座標(= 付箋の `x=` / `y=`)**。
 * ⚠ 器の外形(`getBoundingClientRect`)は transform 込みなので、左上は画面上のワールド原点になる ──
 *   残りは倍率で割るだけ(通常表示の倍率は 1 で、今までの式と同じ)。
 */
export function boardPointOf(host: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const r = host.getBoundingClientRect();
  const z = canvasZoomOf(host);
  return {
    x: (clientX - r.left) / z - host.clientLeft + host.scrollLeft,
    y: (clientY - r.top) / z - host.clientTop + host.scrollTop,
  };
}

/** そのノートを、いまキャンバスで見るか(タブの中の選択 > 本文の `layout: canvas`)。 */
export function canvasModeFor(lid: string, body: string): boolean {
  return modeMemory.get(lid) ?? isCanvasLayout(body);
}

/** test 用: タブの中の記憶を消す。 */
export function resetCanvasMemory(): void {
  modeMemory.clear();
  cameraMemory.clear();
  minimapOpen = true;
}

function button(doc: Document, cmd: CanvasCommand, text: string, title: string): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.setAttribute(CMD_ATTR, cmd);
  b.textContent = text;
  b.title = title;
  b.setAttribute('aria-label', title);
  return b;
}

/** バー(通常表示でもキャンバスでも、器の手前の同じ場所)。中身は `syncBar` が当てる。 */
function makeBar(doc: Document): HTMLElement {
  const bar = doc.createElement('div');
  bar.setAttribute('data-pkc-field', BAR_FIELD);
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'ボードの表示');
  bar.append(
    button(doc, 'mode', '無限キャンバス', '付箋のボードを無限キャンバスで表示します。もう一度押すと通常表示に戻ります'),
    button(doc, 'zoom-out', '−', '縮小します(Ctrl + ホイールでも変えられます)'),
    button(doc, 'zoom-reset', '100%', '押すと 100% に戻します'),
    button(doc, 'zoom-in', '+', '拡大します(Ctrl + ホイールでも変えられます)'),
    button(doc, 'fit', '全体を表示', 'すべての付箋が収まるように表示します'),
    button(doc, 'minimap', 'ミニマップ', '右下にミニマップを表示します。押した位置へ移動できます'),
    button(doc, 'default', 'いつもキャンバスで開く', 'このノートを開いたとき、最初から無限キャンバスで表示します(前書きに layout: canvas と書きます)'),
  );
  return bar;
}

function cmdButton(bar: HTMLElement, cmd: CanvasCommand): HTMLButtonElement | null {
  return bar.querySelector<HTMLButtonElement>(`[${CMD_ATTR}="${cmd}"]`);
}

/** バーの押し状態と、キャンバスのときだけ出すボタンを当てる(冪等)。 */
function syncBar(view: BoardView): void {
  const on = view.canvas !== null;
  const bar = view.bar;
  bar.toggleAttribute('data-pkc-canvas-on', on);
  cmdButton(bar, 'mode')?.setAttribute('aria-pressed', String(on));
  for (const cmd of ['zoom-out', 'zoom-reset', 'zoom-in', 'fit', 'minimap', 'default'] as const) {
    const b = cmdButton(bar, cmd);
    if (b !== null) b.hidden = !on;
  }
  cmdButton(bar, 'minimap')?.setAttribute('aria-pressed', String(minimapOpen));
  cmdButton(bar, 'default')?.setAttribute('aria-pressed', String(isCanvasLayout(view.body)));
  if (view.canvas !== null) syncZoomLabel(view.canvas, bar);
}

function syncZoomLabel(c: Canvas, bar: HTMLElement): void {
  const b = cmdButton(bar, 'zoom-reset');
  const text = zoomLabel(c.cam.zoom);
  if (b !== null && b.textContent !== text) b.textContent = text;
}

/** 回した付箋は回した外接四角で見る(カリングとミニマップ)。 */
function worldRectOf(el: HTMLElement): CanvasRect {
  const r = rectOf(el);
  return r.rot !== undefined && r.rot !== 0 ? rotatedBounds(r, r.rot) : r;
}

function viewSize(c: Canvas): { w: number; h: number } {
  return { w: c.vp.clientWidth, h: c.vp.clientHeight };
}

/** 点の格子の間隔(画面 px)。 */
function gridStep(zoom: number): number {
  let step = GRID_STEP * zoom;
  while (step < GRID_MIN_SCREEN) step *= 2;
  return step;
}

/**
 * 🔴 **カメラをステージへ当てる**(パン・ズームの 1 コマ)── transform と格子の位置だけ書く。
 * カリングとミニマップは次のコマで 1 回(`scheduleFrame`)。
 */
function applyCamera(c: Canvas, view: BoardView | undefined): void {
  c.host.style.transform = stageTransform(c.cam);
  const step = gridStep(c.cam.zoom);
  const gx = ((-c.cam.x * c.cam.zoom) % step + step) % step;
  const gy = ((-c.cam.y * c.cam.zoom) % step + step) % step;
  c.vp.style.setProperty('--pkc-canvas-grid', `${Math.round(step * 100) / 100}px`);
  c.vp.style.setProperty('--pkc-canvas-grid-x', `${Math.round(gx * 100) / 100}px`);
  c.vp.style.setProperty('--pkc-canvas-grid-y', `${Math.round(gy * 100) / 100}px`);
  cameraMemory.set(c.lid, c.cam);
  if (view !== undefined) syncZoomLabel(c, view.bar);
  scheduleFrame(c);
}

function scheduleFrame(c: Canvas): void {
  if (c.frame !== null) return;
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f: FrameRequestCallback) => setTimeout(() => f(0), 16) as unknown as number;
  c.frame = raf(() => {
    c.frame = null;
    if (!c.vp.isConnected) return;
    applyCulling(c);
    drawMinimapView(c);
  });
}

/**
 * 🔴 **画面の外の付箋に印を付ける**(ビューポートカリング)。
 * ⚠ 線とミニマップは測っておいた四角(`c.rects`)で描くので、印を付けても線は途切れない。
 * ⚠ 測れない所(枠の大きさが 0 = 画面に出ていない)では印を付けない(全部外す)。
 * 🔑 印を付けるときは、外形が変わらないよう測った大きさを `contain-intrinsic-size` へ渡す。
 */
function applyCulling(c: Canvas): number {
  const { w, h } = viewSize(c);
  let culled = 0;
  for (const { el, rect } of c.rects) {
    const out = w > 0 && h > 0 && !isRectInViewport(rect, c.cam, w, h);
    if (out) {
      culled += 1;
      if (!el.hasAttribute(CULLED_ATTR)) {
        el.style.setProperty('--pkc-cull-w', `${Math.round(rect.w)}px`);
        el.style.setProperty('--pkc-cull-h', `${Math.round(rect.h)}px`);
        el.setAttribute(CULLED_ATTR, '1');
      }
    } else if (el.hasAttribute(CULLED_ATTR)) {
      el.removeAttribute(CULLED_ATTR);
      el.style.removeProperty('--pkc-cull-w');
      el.style.removeProperty('--pkc-cull-h');
    }
  }
  return culled;
}

function contentBounds(c: Canvas): CanvasRect | null {
  return boundsOfRects(c.rects.map((r) => r.rect));
}

/** ミニマップの付箋のシルエット(描画のたびに 1 回)。⚠ ワールド座標で描き、写像は `<g>` の transform 1 つで当てる。 */
function drawMinimapCards(c: Canvas): void {
  const svg = c.minimap.querySelector('svg');
  const g = svg?.querySelector('g');
  if (g == null) return;
  const doc = c.minimap.ownerDocument;
  const next: Element[] = [];
  for (const { rect } of c.rects) {
    const r = doc.createElementNS(SVG_NS, 'rect');
    r.setAttribute('x', String(rect.x));
    r.setAttribute('y', String(rect.y));
    r.setAttribute('width', String(Math.max(1, rect.w)));
    r.setAttribute('height', String(Math.max(1, rect.h)));
    r.setAttribute('data-pkc-minimap-card', '');
    next.push(r);
  }
  g.replaceChildren(...next);
  drawMinimapView(c);
}

/** ミニマップの写像と、いま映っている所の四角(パン・ズームのたび)。 */
function drawMinimapView(c: Canvas): void {
  c.minimap.hidden = !minimapOpen;
  if (!minimapOpen) return;
  const { w, h } = viewSize(c);
  const g = minimapGeometry(contentBounds(c), c.cam, w, h, MINIMAP_W, MINIMAP_H);
  c.geometry = g;
  const svg = c.minimap.querySelector('svg');
  const group = svg?.querySelector('g');
  const viewRect = svg?.querySelector('[data-pkc-minimap-view]');
  if (group == null || viewRect == null) return;
  const r = (n: number): number => Math.round(n * 100) / 100;
  group.setAttribute('transform', `scale(${r(g.scale)}) translate(${r(-g.originX)} ${r(-g.originY)})`);
  viewRect.setAttribute('x', String(r(g.view.x)));
  viewRect.setAttribute('y', String(r(g.view.y)));
  viewRect.setAttribute('width', String(Math.max(1, r(g.view.w))));
  viewRect.setAttribute('height', String(Math.max(1, r(g.view.h))));
}

function makeMinimap(doc: Document): HTMLElement {
  const box = doc.createElement('div');
  box.setAttribute('data-pkc-field', MINIMAP_FIELD);
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', 'ミニマップ。押した位置へ移動します');
  box.title = 'ミニマップ。押した位置へ移動します';
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(MINIMAP_W));
  svg.setAttribute('height', String(MINIMAP_H));
  svg.setAttribute('viewBox', `0 0 ${MINIMAP_W} ${MINIMAP_H}`);
  const g = doc.createElementNS(SVG_NS, 'g');
  const view = doc.createElementNS(SVG_NS, 'rect');
  view.setAttribute('data-pkc-minimap-view', '');
  svg.append(g, view);
  box.append(svg);
  return box;
}

/** 文字を打つ所か(Space・+ / − を奪わない)。 */
function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  return t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null;
}

/** 付箋の中で、その向きにまだ送れる所か(ホイールを付箋の中のスクロールに譲る)。 */
function scrollsInside(target: EventTarget | null, host: HTMLElement, dx: number, dy: number): boolean {
  let el = target instanceof Element ? target : null;
  while (el !== null && el !== host) {
    if (el instanceof HTMLElement) {
      if (dy !== 0 && el.scrollHeight > el.clientHeight + 1) {
        if ((dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) || (dy < 0 && el.scrollTop > 0)) return true;
      }
      if (dx !== 0 && el.scrollWidth > el.clientWidth + 1) {
        if ((dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) || (dx < 0 && el.scrollLeft > 0)) return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

/** 画面の点 → 枠の中の点(px)。 */
function vpPoint(c: Canvas, clientX: number, clientY: number): { x: number; y: number } {
  const r = c.vp.getBoundingClientRect();
  return { x: clientX - r.left - c.vp.clientLeft, y: clientY - r.top - c.vp.clientTop };
}

/** 倍率を枠の真ん中で変える(バーの + / − / 100%)。 */
function zoomCentered(c: Canvas, view: BoardView, nextZoom: number): void {
  const { w, h } = viewSize(c);
  c.cam = zoomAtPoint(c.cam, nextZoom, w / 2, h / 2);
  applyCamera(c, view);
}

/** 全体を表示する。⚠ 付箋が無ければ原点へ。 */
function fitAll(c: Canvas, view: BoardView): void {
  const b = contentBounds(c);
  const { w, h } = viewSize(c);
  c.cam = b === null ? { x: 0, y: 0, zoom: CANVAS_ZOOM_DEFAULT } : fitCameraToBounds(b, w, h);
  applyCamera(c, view);
}

/**
 * 🔴 **枠の中の手の配線**(キャンバスのときだけ。枠そのものに付けるので、通常のノートは 1 つも払わない)。
 *
 * - パン: 中ボタンのドラッグ / Space を押しながら左ドラッグ / **背景(付箋の外)の**左ドラッグ。
 *   ⚠ 付箋の上の押す・文字を選ぶ・⠿ のドラッグ・線の右クリックは奪わない ── 背景とは器そのものか枠そのもの。
 * - ズーム: Ctrl + ホイール(トラックパッドのつまみも同じ)── ポインタの下を動かさない。
 * - ホイール(Ctrl なし)はパン。⚠ 付箋の中で送れる所なら譲る。
 * - キーボード(枠かバーにフォーカスがあるとき): `+` / `−` / `0`(100%)/ `Shift + 1`(全体を表示)。
 */
function wire(c: Canvas, viewOf: () => BoardView | undefined): () => void {
  const { vp, host, minimap } = c;
  const doc = vp.ownerDocument;
  let pan: { id: number; x: number; y: number; moved: boolean; sx: number; sy: number } | null = null;
  let mini: number | null = null;
  let space = false;
  let swallow = false;

  const onKey = (e: KeyboardEvent): void => {
    if (!vp.isConnected) {
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('keyup', onKey, true);
      return;
    }
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (isTyping(e.target)) return;
    const down = e.type === 'keydown';
    if (down === space) {
      if (down) e.preventDefault(); // 押し続けで画面が流れないように
      return;
    }
    space = down;
    vp.toggleAttribute('data-pkc-canvas-space', down);
    if (down) e.preventDefault();
  };
  const onEnter = (): void => {
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('keyup', onKey, true);
  };
  const onLeave = (): void => {
    if (pan !== null) return;
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('keyup', onKey, true);
    space = false;
    vp.removeAttribute('data-pkc-canvas-space');
  };

  const centerAt = (e: PointerEvent): void => {
    const g = c.geometry;
    if (g === null) return;
    const r = minimap.getBoundingClientRect();
    const sx = MINIMAP_W / Math.max(1, r.width || MINIMAP_W);
    const sy = MINIMAP_H / Math.max(1, r.height || MINIMAP_H);
    const p = minimapPointToWorld(g, (e.clientX - r.left) * sx, (e.clientY - r.top) * sy);
    const { w, h } = viewSize(c);
    c.cam = centerCameraOn(c.cam, p.x, p.y, w, h);
    applyCamera(c, viewOf());
  };

  const onDown = (e: PointerEvent): void => {
    swallow = false;
    const t = e.target as Element | null;
    if (t !== null && minimap.contains(t)) {
      if (e.button !== 0) return;
      mini = e.pointerId;
      try {
        minimap.setPointerCapture(e.pointerId);
      } catch {
        // 捕まえられない環境でも pointermove は枠から届く
      }
      centerAt(e);
      e.preventDefault();
      return;
    }
    const background = t === host || t === vp;
    const wants = e.button === 1 || (e.button === 0 && (space || background));
    if (!wants || pan !== null) return;
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, sx: e.clientX, sy: e.clientY };
    try {
      vp.setPointerCapture(e.pointerId);
    } catch {
      // 同上
    }
    vp.setAttribute('data-pkc-canvas-panning', '');
    e.preventDefault();
  };
  const onMove = (e: PointerEvent): void => {
    if (mini !== null && e.pointerId === mini) {
      centerAt(e);
      return;
    }
    if (pan === null || e.pointerId !== pan.id) return;
    if (!pan.moved && Math.abs(e.clientX - pan.sx) < PAN_SLOP && Math.abs(e.clientY - pan.sy) < PAN_SLOP) return;
    pan.moved = true;
    c.cam = panCamera(c.cam, e.clientX - pan.x, e.clientY - pan.y);
    pan.x = e.clientX;
    pan.y = e.clientY;
    applyCamera(c, viewOf());
  };
  const onUp = (e: PointerEvent): void => {
    if (mini !== null && e.pointerId === mini) {
      mini = null;
      return;
    }
    if (pan === null || e.pointerId !== pan.id) return;
    swallow = pan.moved;
    pan = null;
    vp.removeAttribute('data-pkc-canvas-panning');
  };
  const onClick = (e: MouseEvent): void => {
    if (!swallow) return;
    swallow = false;
    e.stopPropagation();
    e.preventDefault();
  };
  // 中ボタンの押下でブラウザの自動スクロールを出さない
  const onAux = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault();
  };
  const onWheel = (e: WheelEvent): void => {
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewSize(c).h : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const p = vpPoint(c, e.clientX, e.clientY);
      c.cam = zoomAtPoint(c.cam, c.cam.zoom * Math.exp(-dy * 0.0015), p.x, p.y);
      applyCamera(c, viewOf());
      return;
    }
    if (scrollsInside(e.target, host, dx, dy)) return;
    e.preventDefault();
    // 🔑 Shift + ホイールは横へ(マウスのホイールしか無い人のため)
    c.cam = e.shiftKey && dx === 0 ? panCamera(c.cam, -dy, 0) : panCamera(c.cam, -dx, -dy);
    applyCamera(c, viewOf());
  };

  vp.addEventListener('pointerenter', onEnter);
  vp.addEventListener('pointerleave', onLeave);
  vp.addEventListener('pointerdown', onDown);
  vp.addEventListener('pointermove', onMove);
  vp.addEventListener('pointerup', onUp);
  vp.addEventListener('pointercancel', onUp);
  vp.addEventListener('click', onClick, true);
  vp.addEventListener('auxclick', onAux);
  vp.addEventListener('mousedown', onAux);
  vp.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    vp.removeEventListener('pointerenter', onEnter);
    vp.removeEventListener('pointerleave', onLeave);
    vp.removeEventListener('pointerdown', onDown);
    vp.removeEventListener('pointermove', onMove);
    vp.removeEventListener('pointerup', onUp);
    vp.removeEventListener('pointercancel', onUp);
    vp.removeEventListener('click', onClick, true);
    vp.removeEventListener('auxclick', onAux);
    vp.removeEventListener('mousedown', onAux);
    vp.removeEventListener('wheel', onWheel);
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('keyup', onKey, true);
  };
}

/** 付箋の四角を測り直す(描画のたび)。 */
function measure(c: Canvas): void {
  c.rects = [...c.host.querySelectorAll<HTMLElement>(PLACE_SELECTOR)].map((el) => ({ el, rect: worldRectOf(el) }));
}

/** キャンバスを作る(器を枠で包む)。 */
function openCanvas(view: BoardView, host: HTMLElement): Canvas {
  const doc = host.ownerDocument;
  const vp = doc.createElement('div');
  vp.setAttribute('data-pkc-field', VIEWPORT_FIELD);
  vp.setAttribute('tabindex', '0');
  vp.setAttribute('aria-label', '無限キャンバス。背景をドラッグ・中ボタンのドラッグ・Space を押しながらのドラッグで移動、Ctrl + ホイールで拡大と縮小をします');
  const minimap = makeMinimap(doc);
  host.before(vp);
  vp.append(host, minimap);
  host.setAttribute(CANVAS_ATTR, '');
  const c: Canvas = {
    host,
    vp,
    minimap,
    lid: view.lid,
    cam: { x: 0, y: 0, zoom: CANVAS_ZOOM_DEFAULT },
    rects: [],
    frame: null,
    geometry: null,
    dispose: () => {},
  };
  c.dispose = wire(c, () => views.get(host));
  vp.addEventListener('keydown', (e) => onCanvasKey(e, host));
  measure(c);
  const remembered = cameraMemory.get(view.lid);
  if (remembered !== undefined) {
    c.cam = remembered;
  } else {
    // 🔑 初めて開くときは全体を表示(負の所の付箋も画面に入る)
    const b = contentBounds(c);
    const { w, h } = viewSize(c);
    c.cam = b === null ? { x: 0, y: 0, zoom: CANVAS_ZOOM_DEFAULT } : fitCameraToBounds(b, w, h);
  }
  return c;
}

/** キャンバスを畳む(器を元の場所へ戻し、印と transform を外す)。 */
function closeCanvas(c: Canvas): void {
  c.dispose();
  if (c.frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(c.frame);
  c.frame = null;
  const { host, vp } = c;
  if (vp.parentNode !== null) {
    vp.before(host);
    vp.remove();
  }
  host.removeAttribute(CANVAS_ATTR);
  host.style.removeProperty('transform');
  for (const el of host.querySelectorAll<HTMLElement>(`[${CULLED_ATTR}]`)) {
    el.removeAttribute(CULLED_ATTR);
    el.style.removeProperty('--pkc-cull-w');
    el.style.removeProperty('--pkc-cull-h');
  }
}

/**
 * 🔴 **通常表示で、負の位置の付箋を画面の中へ寄せる**。いちばん左上の付箋が 0 に来るまで器ごとずらす。
 * ⚠ 正の位置だけのボードでは何も書かない(1px も変わらない)。
 * 🔑 ずらすのは器の transform なので、掴む・つなぐ・右クリックの位置は `getBoundingClientRect` から同じ式で読める。
 */
function applyNormalShift(host: HTMLElement): void {
  let minX = 0;
  let minY = 0;
  for (const el of host.querySelectorAll<HTMLElement>(PLACE_SELECTOR)) {
    const r = worldRectOf(el);
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
  }
  if (minX >= 0 && minY >= 0) {
    clearNormalShift(host);
    return;
  }
  host.setAttribute(SHIFT_ATTR, '');
  host.style.setProperty('--pkc-board-shift-x', `${Math.round(-minX)}px`);
  host.style.setProperty('--pkc-board-shift-y', `${Math.round(-minY)}px`);
}

function clearNormalShift(host: HTMLElement): void {
  if (!host.hasAttribute(SHIFT_ATTR)) return;
  host.removeAttribute(SHIFT_ATTR);
  host.style.removeProperty('--pkc-board-shift-x');
  host.style.removeProperty('--pkc-board-shift-y');
}

/** 器の見え方を外す(付箋が無くなった / 器が使われなくなった)。 */
function teardown(host: HTMLElement, view: BoardView): void {
  if (view.canvas !== null) closeCanvas(view.canvas);
  view.canvas = null;
  view.bar.remove();
  clearNormalShift(host);
  views.delete(host);
}

/**
 * 🔴 **板の見え方を当てる**(`applyPlaceLayout` の**後**に、描画のたびに呼ぶ。冪等)。
 * - 付箋が無い器: 何もしない(前に作った物は外す)。
 * - 付箋がある器: バーを置き、選ばれた見え方(キャンバス / 通常)を当てる。
 * @returns キャンバスで見ているか
 */
export function syncBoardView(host: HTMLElement, lid: string, body: string): boolean {
  let view = views.get(host);
  const hasPlaces = host.querySelector(PLACE_SELECTOR) !== null;
  if (!hasPlaces) {
    if (view !== undefined) teardown(host, view);
    return false;
  }
  if (view === undefined) {
    view = { lid, body, bar: makeBar(host.ownerDocument), canvas: null };
    views.set(host, view);
  }
  // 🔑 器が別のノートへ使い回されたら、前のノートのカメラを持ち越さない
  if (view.lid !== lid && view.canvas !== null) {
    closeCanvas(view.canvas);
    view.canvas = null;
  }
  view.lid = lid;
  view.body = body;
  const want = canvasModeFor(lid, body);
  if (want) {
    clearNormalShift(host);
    if (view.canvas === null || !view.canvas.vp.contains(host)) view.canvas = openCanvas(view, host);
    const c = view.canvas;
    c.lid = lid;
    measure(c);
    applyCamera(c, undefined);
    drawMinimapCards(c);
    applyCulling(c);
  } else {
    if (view.canvas !== null) closeCanvas(view.canvas);
    view.canvas = null;
    applyNormalShift(host);
  }
  // バーは器(キャンバスなら枠)の手前 ── モードで場所を変えない
  const anchor = view.canvas?.vp ?? host;
  if (anchor.previousElementSibling !== view.bar) anchor.before(view.bar);
  syncBar(view);
  return view.canvas !== null;
}

/**
 * 次のコマを待たずに、カリングとミニマップを当てる(test と、すぐ結果を読みたい呼び手用)。
 * @returns 画面の外として印を付けた付箋の数(キャンバスでなければ 0)
 */
export function flushCanvasFrame(host: HTMLElement): number {
  const c = views.get(host)?.canvas;
  if (c == null) return 0;
  if (c.frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(c.frame);
  c.frame = null;
  const n = applyCulling(c);
  drawMinimapView(c);
  return n;
}

/** 器から板の見え方を外す(器を捨てるとき)。 */
export function disposeBoardView(host: HTMLElement): void {
  const view = views.get(host);
  if (view !== undefined) teardown(host, view);
}

/** バーのボタンが指す器(バーの直後の器、または枠の中の器)。 */
function hostOfBar(bar: Element): HTMLElement | null {
  const next = bar.nextElementSibling;
  if (!(next instanceof HTMLElement)) return null;
  if (next.getAttribute('data-pkc-field') === VIEWPORT_FIELD) {
    return next.querySelector<HTMLElement>(`:scope > [${CANVAS_ATTR}]`);
  }
  return views.has(next) ? next : null;
}

/** 枠の中のキー(+ / − / 0 / Shift + 1)。 */
function onCanvasKey(e: KeyboardEvent, host: HTMLElement): void {
  if (e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
  const view = views.get(host);
  const c = view?.canvas;
  if (view === undefined || c == null) return;
  // ⚠ 付箋の ⠿ の矢印キー(`place-drag.ts`)は奪わない ── ここは + / − / 0 / Shift + 1 だけ
  if (e.key === '+' || e.key === '=' || e.key === ';') zoomCentered(c, view, c.cam.zoom * CANVAS_ZOOM_STEP);
  else if (e.key === '-' || e.key === '_') zoomCentered(c, view, c.cam.zoom / CANVAS_ZOOM_STEP);
  else if (e.key === '0') zoomCentered(c, view, CANVAS_ZOOM_DEFAULT);
  else if (e.shiftKey && e.code === 'Digit1') fitAll(c, view);
  else return;
  e.preventDefault();
}

/**
 * 🔴 **バーのボタンを押したとき**(`installCanvasViewport` の 1 本が受ける)。
 * 表示だけの物(見え方・倍率・ミニマップ)はここで済ませ、本文を書く物(`default`)は `onDefault` へ渡す。
 * @returns 受けた(押し所がバーのボタンだった)か
 */
export function runCanvasCommand(
  btn: Element,
  onDefault: (lid: string, on: boolean) => void,
): boolean {
  const cmd = btn.getAttribute(CMD_ATTR) as CanvasCommand | null;
  const bar = btn.closest(`[data-pkc-field="${BAR_FIELD}"]`);
  if (cmd === null || bar === null) return false;
  const host = hostOfBar(bar);
  const view = host === null ? undefined : views.get(host);
  if (host === null || view === undefined) return false;
  const c = view.canvas;
  switch (cmd) {
    case 'mode':
      modeMemory.set(view.lid, c === null);
      syncBoardView(host, view.lid, view.body);
      return true;
    case 'zoom-out':
      if (c !== null) zoomCentered(c, view, clampZoom(c.cam.zoom / CANVAS_ZOOM_STEP));
      return true;
    case 'zoom-in':
      if (c !== null) zoomCentered(c, view, clampZoom(c.cam.zoom * CANVAS_ZOOM_STEP));
      return true;
    case 'zoom-reset':
      if (c !== null) zoomCentered(c, view, CANVAS_ZOOM_DEFAULT);
      return true;
    case 'fit':
      if (c !== null) fitAll(c, view);
      return true;
    case 'minimap':
      minimapOpen = !minimapOpen;
      if (c !== null) drawMinimapView(c);
      syncBar(view);
      return true;
    case 'default':
      onDefault(view.lid, !isCanvasLayout(view.body));
      return true;
    default:
      return false;
  }
}

/**
 * root へ 1 度だけ配線する(`installPlaceDrag` と同じ作法)── バーのボタンの押下だけを受ける。
 * ⚠ 手の配線(パン・ズーム)は枠そのものに付く(`wire`)── 通常のノートは押下 1 回ごとに `closest` 1 回しか払わない。
 * @param setDefault 「いつもキャンバスで開く」を本文へ書く(`SET_CANVAS_LAYOUT`)
 */
export function installCanvasViewport(
  root: HTMLElement,
  setDefault: (lid: string, on: boolean) => void,
): () => void {
  const doc = root.ownerDocument;
  const onClick = (e: MouseEvent): void => {
    const btn = (e.target as Element | null)?.closest?.(`[${CMD_ATTR}]`);
    if (btn == null) return;
    if (runCanvasCommand(btn, setDefault)) e.preventDefault();
  };
  doc.addEventListener('click', onClick);
  return () => doc.removeEventListener('click', onClick);
}

/**
 * 🔴 **キャンバスの背景(枠そのもの)を押した物を、器を押したと読み替える**(右クリックのメニュー)。
 * ⚠ 器の外形は付箋の範囲より狭い(負の所・縮小して見えた右の広がり)── 枠そのものを押したら器を返す。
 *   それ以外(付箋・本文の字・ミニマップ・バー)はそのまま返す。
 */
export function canvasBackgroundTarget(el: Element): Element {
  if (el.getAttribute('data-pkc-field') !== VIEWPORT_FIELD) return el;
  return el.querySelector(`:scope > [${CANVAS_ATTR}]`) ?? el;
}
