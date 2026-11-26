/**
 * 🔴 **キャンバスに直接手書きする**(v4.0 Phase 2 / PR-10、ビジョン 2-B)── 描く面と小さな操作バー。
 *
 * 無限キャンバスのバーの「手書き」を押すと、枠の上に描く面(`<canvas>`)と操作バー
 * (ペンの色 4 色・太さ 3 段階・1 手戻す・ボードに置く・やめる)を重ねる。
 * 「ボードに置く」を押すと、描いた線の外接四角だけを**透過 PNG に焼き**(「図は描いたら焼く」)、
 * 呼び側(`canvas-viewport.ts` → `main.ts`)が既存の添付の経路(`attachOne`)で保存して、描いた場所へ付箋を 1 枚置く。
 *
 * ## 定常コスト 0
 *
 * - 手書きを始めるまで、描く面は**DOM に無い**(作るのは押したとき)。
 * - 「やめる」・`Escape`・置き終わり・キャンバスを閉じたときに、面ごと DOM から外して `<canvas>` の画素を手放す
 *   (`width = 0`)。焼くための作業用の `<canvas>` も焼き終わったら同じく手放す。
 *
 * ## 座標
 *
 * 線は**ワールド座標**(付箋の `x=` / `y=` と同じ px)で持つ ── 焼いた付箋がちょうど描いた場所に重なる。
 * 描く面に映すときはカメラで画面へ写す(`worldToScreen`)。描いている間はパン・ズームを止める(ホイールを飲む)。
 * 数(外接四角・四角の中への写し・色と太さの表)は `features/canvas/freehand.ts`(pure)の 1 本。
 */
import {
  FREEHAND_COLORS,
  FREEHAND_DEFAULT_COLOR,
  FREEHAND_DEFAULT_WIDTH,
  FREEHAND_WIDTHS,
  freehandBounds,
  toLocalStrokes,
  type FreehandStroke,
} from '@features/canvas/freehand';
import { markPrimary } from './icons';
import type { CanvasCamera, CanvasPoint, CanvasRect } from '@features/canvas/viewport';

export const DRAW_FIELD = 'canvas-draw';
export const DRAW_SURFACE_FIELD = 'canvas-draw-surface';
export const DRAW_BAR_FIELD = 'canvas-draw-bar';
/** 操作バーのボタンの役目。 */
export const DRAW_CMD_ATTR = 'data-pkc-draw-cmd';
export const DRAW_COLOR_ATTR = 'data-pkc-draw-color';
export const DRAW_WIDTH_ATTR = 'data-pkc-draw-width';

/** 焼くときの倍率(高精細の画面でもにじまない)。⚠ 一辺は `FREEHAND_MAX_SIZE × 2` を超えない。 */
const RASTER_SCALE = 2;

export interface FreehandSession {
  /** 描いた線(ワールド座標)。test が読む。 */
  readonly strokes: readonly FreehandStroke[];
  /** 面を閉じる(何も保存しない)。冪等。 */
  close(): void;
  /** 「ボードに置く」と同じ(test 用)。 */
  place(): Promise<boolean>;
}

export interface FreehandOptions {
  /** 枠(ビューポート)。面はこの上に重ねる。 */
  readonly vp: HTMLElement;
  /** いまのカメラ(線の太さの倍率に使う)。 */
  readonly camera: () => CanvasCamera;
  /**
   * 🔴 **画面の点(client)→ ワールド座標**。⚠ カメラの式ではなく器の実際の位置から引く(`boardPointOf`)──
   *   器に外から余白が当たっていても、描いた所と置いた付箋がずれない(掴む・つなぐと同じ 1 本)。
   */
  readonly toWorld: (clientX: number, clientY: number) => CanvasPoint;
  /** ワールド座標 → 画面の点(client)。`toWorld` の逆。 */
  readonly toClient: (p: CanvasPoint) => CanvasPoint;
  /**
   * 🔴 焼いた PNG と置く四角(ワールド座標)を渡す。保存して付箋を置けたら `true`(面を閉じる)。
   * ⚠ `false` なら面を閉じない(描いた線を失わせない ── 理由は呼び側が出す)。
   */
  readonly onPlace: (png: Blob, rect: CanvasRect) => Promise<boolean>;
  /** 面が閉じた(置いた・やめた)。 */
  readonly onClose: () => void;
}

/** 線を描く(1 点だけの線は丸い点)。`map` で座標を写し、`scale` で太さを掛ける。 */
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: readonly FreehandStroke[],
  map: (p: CanvasPoint) => CanvasPoint,
  scale: number,
): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    const pts = s.points.map(map);
    if (pts.length === 0) continue;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width * scale;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0]!.x, pts[0]!.y, (s.width * scale) / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    ctx.stroke();
  }
}

/**
 * 🔴 **描いた線を透過 PNG に焼く**(四角の中だけ)。焼き終わったら作業用の `<canvas>` の画素を手放す。
 * @returns 焼けなければ `null`(2D の描画ができない・PNG にできない環境)
 */
export async function rasterizeFreehand(
  doc: Document,
  strokes: readonly FreehandStroke[],
  rect: CanvasRect,
): Promise<Blob | null> {
  const cv = doc.createElement('canvas');
  cv.width = Math.max(1, Math.round(rect.w * RASTER_SCALE));
  cv.height = Math.max(1, Math.round(rect.h * RASTER_SCALE));
  try {
    const ctx = cv.getContext('2d');
    if (ctx === null || typeof cv.toBlob !== 'function') return null;
    // 🔑 地は塗らない(透過)── 付箋も `fill=transparent` なので、ボードの格子・下の付箋が透けて見える
    drawStrokes(
      ctx,
      toLocalStrokes(strokes, { x: rect.x, y: rect.y }),
      (p) => ({ x: p.x * RASTER_SCALE, y: p.y * RASTER_SCALE }),
      RASTER_SCALE,
    );
    return await new Promise<Blob | null>((resolve) => cv.toBlob((b) => resolve(b), 'image/png'));
  } catch {
    return null;
  } finally {
    cv.width = 0;
    cv.height = 0;
  }
}

function pressed(btn: HTMLElement, on: boolean): void {
  btn.setAttribute('aria-pressed', String(on));
}

/**
 * 🔴 **手書きの面を開く**。閉じるまで枠の上に重なる。
 * ⚠ 呼び側は 1 枚の枠に 1 つしか開かない(`canvas-viewport.ts` が持つ)。
 */
export function openFreehand(opts: FreehandOptions): FreehandSession {
  const { vp } = opts;
  const doc = vp.ownerDocument;
  const win = doc.defaultView;
  const strokes: FreehandStroke[] = [];
  let color: string = FREEHAND_DEFAULT_COLOR;
  let width: number = FREEHAND_DEFAULT_WIDTH;
  let current: { id: number; points: CanvasPoint[] } | null = null;
  let closed = false;
  let busy = false;

  const layer = doc.createElement('div');
  layer.setAttribute('data-pkc-field', DRAW_FIELD);
  const surface = doc.createElement('canvas');
  surface.setAttribute('data-pkc-field', DRAW_SURFACE_FIELD);
  surface.setAttribute('aria-label', '手書きの領域。ドラッグして線を描きます');
  surface.setAttribute('role', 'img');
  const bar = doc.createElement('div');
  bar.setAttribute('data-pkc-field', DRAW_BAR_FIELD);
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '手書き');

  const mk = (text: string, title: string): HTMLButtonElement => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    return b;
  };
  const colorBtns = FREEHAND_COLORS.map((c) => {
    const b = mk('', `ペンの色: ${c.label}`);
    b.setAttribute(DRAW_COLOR_ATTR, c.value);
    b.style.setProperty('--pkc-draw-swatch', c.value);
    pressed(b, c.value === color);
    return b;
  });
  const widthBtns = FREEHAND_WIDTHS.map((w) => {
    const b = mk(w.label, `ペンの太さ: ${w.label}(${w.value}px)`);
    b.setAttribute(DRAW_WIDTH_ATTR, String(w.value));
    pressed(b, w.value === width);
    return b;
  });
  const undo = mk('1 手戻す', '最後に描いた線を 1 本消します');
  undo.setAttribute(DRAW_CMD_ATTR, 'undo');
  const place = mk('ボードに置く', '描いた線を画像にして、描いた場所へ付箋として置きます');
  place.setAttribute(DRAW_CMD_ATTR, 'place');
  markPrimary(place);
  const cancel = mk('やめる', '保存せずに手書きを終わります(Esc)');
  cancel.setAttribute(DRAW_CMD_ATTR, 'cancel');
  bar.append(...colorBtns, ...widthBtns, undo, place, cancel);
  layer.append(surface, bar);
  vp.append(layer);

  const syncButtons = (): void => {
    undo.disabled = strokes.length === 0 || busy;
    place.disabled = strokes.length === 0 || busy;
  };

  /** 描く面の画素を枠の大きさに合わせ、線を描き直す。 */
  const paint = (): void => {
    const dpr = win?.devicePixelRatio ?? 1;
    const w = Math.max(1, Math.round(vp.clientWidth * dpr));
    const h = Math.max(1, Math.round(vp.clientHeight * dpr));
    if (surface.width !== w) surface.width = w;
    if (surface.height !== h) surface.height = h;
    const ctx = surface.getContext?.('2d') ?? null;
    if (ctx === null) return;
    ctx.clearRect(0, 0, w, h);
    const cam = opts.camera();
    const all: FreehandStroke[] = current === null ? strokes : [...strokes, { points: current.points, color, width }];
    const r = surface.getBoundingClientRect();
    drawStrokes(
      ctx,
      all,
      (p) => {
        const c = opts.toClient(p);
        return { x: (c.x - r.left) * dpr, y: (c.y - r.top) * dpr };
      },
      cam.zoom * dpr,
    );
  };

  const worldOf = (e: PointerEvent): CanvasPoint => opts.toWorld(e.clientX, e.clientY);

  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || current !== null || busy) return;
    e.preventDefault();
    e.stopPropagation();
    current = { id: e.pointerId, points: [worldOf(e)] };
    try {
      surface.setPointerCapture(e.pointerId);
    } catch {
      // 捕まえられない環境でも pointermove は面から届く
    }
    paint();
  };
  const onMove = (e: PointerEvent): void => {
    if (current === null || e.pointerId !== current.id) return;
    e.preventDefault();
    current.points.push(worldOf(e));
    paint();
  };
  const onUp = (e: PointerEvent): void => {
    if (current === null || e.pointerId !== current.id) return;
    strokes.push({ points: current.points, color, width });
    current = null;
    paint();
    syncButtons();
  };
  // 🔑 描いている間はパン・ズームしない(線はワールド座標なので、動かすと描いた所がずれて見える)
  const swallow = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  const stop = (e: Event): void => e.stopPropagation();

  const doPlace = async (): Promise<boolean> => {
    if (busy || closed) return false;
    const rect = freehandBounds(strokes);
    if (rect === null) return false;
    busy = true;
    syncButtons();
    try {
      const png = await rasterizeFreehand(doc, strokes, rect);
      if (png === null || closed) return false;
      const ok = await opts.onPlace(png, rect);
      if (ok) close();
      return ok;
    } finally {
      busy = false;
      if (!closed) syncButtons();
    }
  };

  const onBarClick = (e: MouseEvent): void => {
    const t = e.target as Element | null;
    e.stopPropagation();
    const c = t?.closest<HTMLElement>(`[${DRAW_COLOR_ATTR}]`);
    if (c != null) {
      color = c.getAttribute(DRAW_COLOR_ATTR) ?? color;
      for (const b of colorBtns) pressed(b, b === c);
      return;
    }
    const w = t?.closest<HTMLElement>(`[${DRAW_WIDTH_ATTR}]`);
    if (w != null) {
      width = Number(w.getAttribute(DRAW_WIDTH_ATTR)) || width;
      for (const b of widthBtns) pressed(b, b === w);
      return;
    }
    const cmd = t?.closest<HTMLElement>(`[${DRAW_CMD_ATTR}]`)?.getAttribute(DRAW_CMD_ATTR);
    if (cmd === 'undo') {
      strokes.pop();
      paint();
      syncButtons();
    } else if (cmd === 'place') {
      void doPlace();
    } else if (cmd === 'cancel') {
      close();
    }
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    // ⚠ 開いているノートの選択解除などへ Esc を渡さない(手書きだけを閉じる)
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  };
  const onResize = (): void => paint();

  surface.addEventListener('pointerdown', onDown);
  surface.addEventListener('pointermove', onMove);
  surface.addEventListener('pointerup', onUp);
  surface.addEventListener('pointercancel', onUp);
  layer.addEventListener('wheel', swallow, { passive: false });
  layer.addEventListener('pointerdown', stop);
  layer.addEventListener('contextmenu', swallow);
  bar.addEventListener('click', onBarClick);
  doc.addEventListener('keydown', onKey, true);
  win?.addEventListener('resize', onResize);
  vp.setAttribute('data-pkc-canvas-drawing', '');

  function close(): void {
    if (closed) return;
    closed = true;
    current = null;
    surface.removeEventListener('pointerdown', onDown);
    surface.removeEventListener('pointermove', onMove);
    surface.removeEventListener('pointerup', onUp);
    surface.removeEventListener('pointercancel', onUp);
    layer.removeEventListener('wheel', swallow);
    layer.removeEventListener('pointerdown', stop);
    layer.removeEventListener('contextmenu', swallow);
    bar.removeEventListener('click', onBarClick);
    doc.removeEventListener('keydown', onKey, true);
    win?.removeEventListener('resize', onResize);
    vp.removeAttribute('data-pkc-canvas-drawing');
    // 🔴 画素を手放してから外す(定常コスト 0)
    surface.width = 0;
    surface.height = 0;
    layer.remove();
    strokes.length = 0;
    opts.onClose();
  }

  syncButtons();
  paint();
  return {
    strokes,
    close,
    place: doPlace,
  };
}
