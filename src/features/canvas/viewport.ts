/**
 * 🔴 **無限キャンバスの共通の計算**(v4.0 Phase 2 / PR-09、ビジョン 2-A)。
 *
 * 付箋のボード(`.pkc-place`)と、次の段(PR-10)で載せる関係グラフが**同じ 1 本**を引く。
 * ⚠ ここは数だけを扱う(DOM もブラウザの API も持たない)── どの画面の要素かを知らない。
 *
 * ## 座標の約束
 *
 * - **ワールド座標** … 付箋の `x=` / `y=` と同じ px(負もある)。
 * - **画面座標** … ビューポート(枠)の左上を 0 にした px。
 * - **カメラ** `{ x, y, zoom }` … 枠の左上に映っているワールド座標(`x`, `y`)と倍率。
 *   画面 = (ワールド − カメラ) × 倍率。ステージ(中身)には
 *   `translate(−x·zoom, −y·zoom) scale(zoom)`(原点は左上)を当てれば、同じ写像になる。
 * 🔑 カメラは**表示の状態**であって本文には書かない(本文の正本は `x=` / `y=` のまま)。
 */

export interface CanvasCamera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface CanvasRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

export const CANVAS_ZOOM_MIN = 0.1;
export const CANVAS_ZOOM_MAX = 4.0;
export const CANVAS_ZOOM_DEFAULT = 1.0;
/** 全体を表示するときの倍率の上限 ── 少ない付箋を画面いっぱいに拡大しない。 */
export const CANVAS_FIT_ZOOM_MAX = 1.0;
/** `+` / `−` の 1 押しの倍率。 */
export const CANVAS_ZOOM_STEP = 1.25;

export const DEFAULT_CAMERA: CanvasCamera = Object.freeze({ x: 0, y: 0, zoom: CANVAS_ZOOM_DEFAULT });

/** 倍率を範囲へ収める。⚠ 数でない値は既定へ(`NaN` を transform に流さない)。 */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return CANVAS_ZOOM_DEFAULT;
  return Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, zoom));
}

export function screenToWorld(cam: CanvasCamera, sx: number, sy: number): CanvasPoint {
  return { x: cam.x + sx / cam.zoom, y: cam.y + sy / cam.zoom };
}

export function worldToScreen(cam: CanvasCamera, wx: number, wy: number): CanvasPoint {
  return { x: (wx - cam.x) * cam.zoom, y: (wy - cam.y) * cam.zoom };
}

/**
 * 🔴 **ポインタの下を動かさずに倍率を変える**。`(screenX, screenY)` に映っているワールドの点は、
 * 倍率を変えた後も同じ画面の点に映る(不動点)。倍率は範囲へ収める。
 */
export function zoomAtPoint(cam: CanvasCamera, nextZoom: number, screenX: number, screenY: number): CanvasCamera {
  const zoom = clampZoom(nextZoom);
  const anchor = screenToWorld(cam, screenX, screenY);
  return { x: anchor.x - screenX / zoom, y: anchor.y - screenY / zoom, zoom };
}

/** 画面の移動量(px)で動かす ── 手で右へ引くと中身も右へ動く(= カメラは左へ)。 */
export function panCamera(cam: CanvasCamera, dx: number, dy: number): CanvasCamera {
  return { x: cam.x - dx / cam.zoom, y: cam.y - dy / cam.zoom, zoom: cam.zoom };
}

/** ステージに当てる transform の字(原点は左上)。⚠ 小数は 3 桁で丸める(字が毎回揺れない)。 */
export function stageTransform(cam: CanvasCamera): string {
  const r = (n: number): number => Math.round(n * 1000) / 1000;
  return `translate3d(${r(-cam.x * cam.zoom)}px, ${r(-cam.y * cam.zoom)}px, 0) scale(${r(cam.zoom)})`;
}

/** 複数の四角の外接四角。空なら `null`。 */
export function boundsOfRects(rects: readonly CanvasRect[]): CanvasRect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * 🔴 **全部の付箋が枠の真ん中に収まるカメラ**。周りに `padding`(画面 px)の余白を取る。
 * 倍率は `CANVAS_FIT_ZOOM_MAX`(1.0)を上限にする ── 付箋が 1 枚のとき、それを画面いっぱいへ拡大しない。
 * ⚠ 枠の大きさが測れない(0)ときは倍率 1 で外接四角の左上を余白ぶん内側に置く。
 */
export function fitCameraToBounds(
  bounds: CanvasRect,
  viewW: number,
  viewH: number,
  padding = 48,
): CanvasCamera {
  const availW = viewW - padding * 2;
  const availH = viewH - padding * 2;
  if (availW <= 0 || availH <= 0) {
    return { x: bounds.x - padding, y: bounds.y - padding, zoom: CANVAS_ZOOM_DEFAULT };
  }
  const fit = Math.min(
    bounds.w > 0 ? availW / bounds.w : CANVAS_FIT_ZOOM_MAX,
    bounds.h > 0 ? availH / bounds.h : CANVAS_FIT_ZOOM_MAX,
  );
  const zoom = clampZoom(Math.min(CANVAS_FIT_ZOOM_MAX, fit));
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  return { x: cx - viewW / 2 / zoom, y: cy - viewH / 2 / zoom, zoom };
}

/** 枠に映っているワールドの四角。 */
export function viewportWorldRect(cam: CanvasCamera, viewW: number, viewH: number): CanvasRect {
  return { x: cam.x, y: cam.y, w: viewW / cam.zoom, h: viewH / cam.zoom };
}

/**
 * 🔴 **画面に映るか**(ビューポートカリング)── 枠の周り `marginPx`(画面 px)まで含めて、
 * 四角が少しでも重なれば真。⚠ 辺がちょうど接するだけ(幅 0 の重なり)は映らない扱い。
 */
export function isRectInViewport(
  rect: CanvasRect,
  cam: CanvasCamera,
  viewW: number,
  viewH: number,
  marginPx = 240,
): boolean {
  const m = marginPx / cam.zoom;
  const v = viewportWorldRect(cam, viewW, viewH);
  return (
    rect.x < v.x + v.w + m &&
    rect.x + rect.w > v.x - m &&
    rect.y < v.y + v.h + m &&
    rect.y + rect.h > v.y - m
  );
}

/** ミニマップの写像(ワールド → ミニマップ px)。 */
export interface MinimapGeometry {
  /** 1 ワールド px がミニマップの何 px か。 */
  readonly scale: number;
  /** ミニマップの (0, 0) に当たるワールド座標(真ん中寄せの余白込み)。 */
  readonly originX: number;
  readonly originY: number;
  /** いま枠に映っている所の四角(ミニマップ px)。 */
  readonly view: CanvasRect;
}

/**
 * 🔴 **ミニマップの写像**。全部の付箋と、いま映っている所(ビューポート枠)の**両方**が収まるように縮める。
 * ⚠ 付箋の外を見ているとき、枠がミニマップからはみ出さない(どこを見ているかが分からなくなる)。
 */
export function minimapGeometry(
  contentBounds: CanvasRect | null,
  cam: CanvasCamera,
  viewW: number,
  viewH: number,
  mapW: number,
  mapH: number,
): MinimapGeometry {
  const v = viewportWorldRect(cam, viewW, viewH);
  const all = boundsOfRects(contentBounds === null ? [v] : [contentBounds, v])!;
  const w = Math.max(1, all.w);
  const h = Math.max(1, all.h);
  const scale = Math.min(mapW / w, mapH / h);
  // 🔑 余った向きは真ん中へ寄せる
  const originX = all.x - (mapW / scale - w) / 2;
  const originY = all.y - (mapH / scale - h) / 2;
  return {
    scale,
    originX,
    originY,
    view: { x: (v.x - originX) * scale, y: (v.y - originY) * scale, w: v.w * scale, h: v.h * scale },
  };
}

/** ワールドの四角をミニマップ px へ。 */
export function worldRectToMinimap(g: MinimapGeometry, r: CanvasRect): CanvasRect {
  return { x: (r.x - g.originX) * g.scale, y: (r.y - g.originY) * g.scale, w: r.w * g.scale, h: r.h * g.scale };
}

/** ミニマップを押した所(ミニマップ px)が指すワールド座標(`minimapGeometry` の逆)。 */
export function minimapPointToWorld(g: MinimapGeometry, mx: number, my: number): CanvasPoint {
  return { x: g.originX + mx / g.scale, y: g.originY + my / g.scale };
}

/** ワールドの点を枠の真ん中に映すカメラ(倍率はそのまま)。 */
export function centerCameraOn(cam: CanvasCamera, wx: number, wy: number, viewW: number, viewH: number): CanvasCamera {
  return { x: wx - viewW / 2 / cam.zoom, y: wy - viewH / 2 / cam.zoom, zoom: cam.zoom };
}

/** 倍率を画面に出す字(`100%`)。 */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
