/**
 * 無限キャンバスの共通の計算(v4.0 Phase 2 / PR-09、`src/features/canvas/viewport.ts`)。
 *
 * 1. 画面 ⇔ ワールドの往復が一致する(倍率・位置を変えても)
 * 2. `zoomAtPoint` はポインタの下の点を動かさない(不動点)。倍率は 0.1〜4.0 に収まる
 * 3. `fitCameraToBounds` は全部を枠の真ん中に収め、拡大しすぎない(上限 1.0)
 * 4. `isRectInViewport` は余白込みで判定する(境界の内と外を両側から)
 * 5. ミニマップの写像は付箋と映っている所の両方を収め、逆変換で元へ戻る
 */
import { describe, expect, it } from 'vitest';
import {
  boundsOfRects,
  CANVAS_FIT_ZOOM_MAX,
  CANVAS_ZOOM_DEFAULT,
  CANVAS_ZOOM_MAX,
  CANVAS_ZOOM_MIN,
  centerCameraOn,
  clampZoom,
  fitCameraToBounds,
  isRectInViewport,
  minimapGeometry,
  minimapPointToWorld,
  panCamera,
  screenToWorld,
  stageTransform,
  worldRectToMinimap,
  worldToScreen,
  zoomAtPoint,
  zoomLabel,
  type CanvasCamera,
} from '../../../src/features/canvas/viewport';

const close = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe('座標の変換', () => {
  const cams: CanvasCamera[] = [
    { x: 0, y: 0, zoom: 1 },
    { x: -500, y: 320, zoom: 0.5 },
    { x: 1234.5, y: -987.25, zoom: 2 },
    { x: 10, y: 10, zoom: 0.1 },
    { x: -3, y: 7, zoom: 4 },
  ];
  it('🔴 screenToWorld と worldToScreen は往復で一致する', () => {
    for (const cam of cams) {
      for (const [sx, sy] of [[0, 0], [100, 50], [-30, 777.5]] as const) {
        const w = screenToWorld(cam, sx, sy);
        const s = worldToScreen(cam, w.x, w.y);
        close(s.x, sx);
        close(s.y, sy);
      }
    }
  });
  it('画面の左上はカメラの位置、倍率 2 では画面 200px がワールド 100px', () => {
    const cam = { x: -120, y: 40, zoom: 2 };
    expect(screenToWorld(cam, 0, 0)).toEqual({ x: -120, y: 40 });
    expect(screenToWorld(cam, 200, 0)).toEqual({ x: -20, y: 40 });
  });
  it('stageTransform は translate(−x·zoom, −y·zoom) scale(zoom) と同じ写像', () => {
    expect(stageTransform({ x: -100, y: 50, zoom: 2 })).toBe('translate3d(200px, -100px, 0) scale(2)');
    expect(stageTransform({ x: 0, y: 0, zoom: 1 })).toBe('translate3d(0px, 0px, 0) scale(1)');
  });
});

describe('ズーム', () => {
  it('🔴 zoomAtPoint はポインタの下のワールドの点を動かさない(不動点)', () => {
    const cams: CanvasCamera[] = [
      { x: 0, y: 0, zoom: 1 },
      { x: -400, y: 260, zoom: 0.7 },
      { x: 50, y: -50, zoom: 3 },
    ];
    for (const cam of cams) {
      for (const next of [0.1, 0.5, 1, 1.25, 2.5, 4]) {
        for (const [sx, sy] of [[0, 0], [320, 240], [17.5, 903]] as const) {
          const before = screenToWorld(cam, sx, sy);
          const z = zoomAtPoint(cam, next, sx, sy);
          const after = screenToWorld(z, sx, sy);
          close(after.x, before.x);
          close(after.y, before.y);
          expect(z.zoom).toBe(next);
        }
      }
    }
  });
  it('🔴 倍率は 0.1〜4.0 に収まり、範囲の外へ寄せても不動点は保つ', () => {
    const cam = { x: 0, y: 0, zoom: 1 };
    expect(zoomAtPoint(cam, 99, 10, 10).zoom).toBe(CANVAS_ZOOM_MAX);
    expect(zoomAtPoint(cam, 0.001, 10, 10).zoom).toBe(CANVAS_ZOOM_MIN);
    const z = zoomAtPoint(cam, 99, 100, 60);
    close(screenToWorld(z, 100, 60).x, 100);
    expect(clampZoom(Number.NaN)).toBe(CANVAS_ZOOM_DEFAULT);
    expect(clampZoom(Infinity)).toBe(CANVAS_ZOOM_DEFAULT);
    expect([CANVAS_ZOOM_MIN, CANVAS_ZOOM_DEFAULT, CANVAS_ZOOM_MAX]).toEqual([0.1, 1, 4]);
  });
  it('panCamera: 手で右へ 100px 引くと中身も右へ 100px(倍率 2 ではワールド 50px)', () => {
    const cam = { x: 0, y: 0, zoom: 2 };
    const p = panCamera(cam, 100, -40);
    expect(p).toEqual({ x: -50, y: 20, zoom: 2 });
    expect(worldToScreen(p, 0, 0)).toEqual({ x: 100, y: -40 });
  });
  it('zoomLabel は百分率', () => {
    expect(zoomLabel(1)).toBe('100%');
    expect(zoomLabel(0.5)).toBe('50%');
    expect(zoomLabel(1.5625)).toBe('156%');
  });
});

describe('外接四角と全体を表示', () => {
  it('boundsOfRects: 負の座標も含めた外接四角 / 空なら null', () => {
    expect(boundsOfRects([])).toBeNull();
    expect(boundsOfRects([{ x: -100, y: 20, w: 50, h: 10 }, { x: 200, y: -30, w: 40, h: 40 }])).toEqual({
      x: -100,
      y: -30,
      w: 340,
      h: 60,
    });
  });
  it('🔴 fitCameraToBounds: 全部が余白の内側に入り、真ん中に来る', () => {
    const b = { x: -500, y: -200, w: 2000, h: 1000 };
    const cam = fitCameraToBounds(b, 1000, 600, 48);
    const tl = worldToScreen(cam, b.x, b.y);
    const br = worldToScreen(cam, b.x + b.w, b.y + b.h);
    expect(tl.x).toBeGreaterThanOrEqual(48 - 1e-9);
    expect(tl.y).toBeGreaterThanOrEqual(48 - 1e-9);
    expect(br.x).toBeLessThanOrEqual(1000 - 48 + 1e-9);
    expect(br.y).toBeLessThanOrEqual(600 - 48 + 1e-9);
    close((tl.x + br.x) / 2, 500);
    close((tl.y + br.y) / 2, 300);
  });
  it('🔴 小さな中身は拡大しすぎない(上限 1.0)', () => {
    const cam = fitCameraToBounds({ x: 10, y: 10, w: 100, h: 50 }, 1000, 600);
    expect(cam.zoom).toBe(CANVAS_FIT_ZOOM_MAX);
    const c = worldToScreen(cam, 60, 35);
    close(c.x, 500);
    close(c.y, 300);
  });
  it('大きすぎる中身は下限 0.1 で止める / 枠が測れない(0)ときは倍率 1 で左上を余白ぶん内側へ', () => {
    expect(fitCameraToBounds({ x: 0, y: 0, w: 1e7, h: 10 }, 1000, 600).zoom).toBe(CANVAS_ZOOM_MIN);
    expect(fitCameraToBounds({ x: -80, y: 30, w: 10, h: 10 }, 0, 0, 48)).toEqual({ x: -128, y: -18, zoom: 1 });
  });
  it('centerCameraOn: その点が枠の真ん中に映る', () => {
    const cam = centerCameraOn({ x: 0, y: 0, zoom: 0.5 }, -300, 400, 800, 600);
    expect(worldToScreen(cam, -300, 400)).toEqual({ x: 400, y: 300 });
  });
});

describe('ビューポートカリング(isRectInViewport)', () => {
  const cam = { x: 0, y: 0, zoom: 1 };
  it('🔴 枠の中・余白の中は映る、余白の外は映らない(境界を両側から)', () => {
    expect(isRectInViewport({ x: 10, y: 10, w: 10, h: 10 }, cam, 800, 600, 240)).toBe(true);
    // 右へ: 枠の幅 800 + 余白 240 = 1040 より手前で始まれば映る
    expect(isRectInViewport({ x: 1039, y: 10, w: 10, h: 10 }, cam, 800, 600, 240)).toBe(true);
    expect(isRectInViewport({ x: 1040, y: 10, w: 10, h: 10 }, cam, 800, 600, 240)).toBe(false);
    // 左へ: 右端が −240 を越えていれば映る
    expect(isRectInViewport({ x: -250, y: 10, w: 11, h: 10 }, cam, 800, 600, 240)).toBe(true);
    expect(isRectInViewport({ x: -250, y: 10, w: 10, h: 10 }, cam, 800, 600, 240)).toBe(false);
    // 下・上も同じ
    expect(isRectInViewport({ x: 0, y: 839, w: 10, h: 10 }, cam, 800, 600, 240)).toBe(true);
    expect(isRectInViewport({ x: 0, y: 840, w: 10, h: 10 }, cam, 800, 600, 240)).toBe(false);
    expect(isRectInViewport({ x: 0, y: -260, w: 10, h: 10 }, cam, 800, 600, 240)).toBe(false);
  });
  it('余白 0 では枠だけで判定し、倍率で余白のワールドの幅が変わる', () => {
    expect(isRectInViewport({ x: 800, y: 0, w: 10, h: 10 }, cam, 800, 600, 0)).toBe(false);
    expect(isRectInViewport({ x: 799, y: 0, w: 10, h: 10 }, cam, 800, 600, 0)).toBe(true);
    // 倍率 0.5 では枠がワールド 1600px を映す(余白 240px = ワールド 480px)
    const half = { x: 0, y: 0, zoom: 0.5 };
    expect(isRectInViewport({ x: 2079, y: 0, w: 1, h: 1 }, half, 800, 600, 240)).toBe(true);
    expect(isRectInViewport({ x: 2080, y: 0, w: 1, h: 1 }, half, 800, 600, 240)).toBe(false);
  });
  it('負の座標のカメラでも同じ(無限平面)', () => {
    const far = { x: -5000, y: -5000, zoom: 1 };
    expect(isRectInViewport({ x: -4900, y: -4900, w: 50, h: 50 }, far, 800, 600)).toBe(true);
    expect(isRectInViewport({ x: 0, y: 0, w: 50, h: 50 }, far, 800, 600)).toBe(false);
  });
});

describe('ミニマップの写像', () => {
  it('🔴 付箋の外接四角と映っている所の両方がミニマップに収まる', () => {
    const content = { x: -1000, y: -500, w: 3000, h: 1500 };
    const cam = { x: 5000, y: 5000, zoom: 1 }; // 付箋から遠く離れた所を見ている
    const g = minimapGeometry(content, cam, 800, 600, 200, 140);
    const c = worldRectToMinimap(g, content);
    for (const r of [c, g.view]) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(200 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(140 + 1e-9);
    }
  });
  it('🔴 逆変換(minimapPointToWorld)で元のワールド座標へ戻る', () => {
    const g = minimapGeometry({ x: -300, y: 100, w: 1200, h: 400 }, { x: 0, y: 0, zoom: 0.8 }, 900, 500, 200, 140);
    for (const [wx, wy] of [[-300, 100], [0, 0], [450.5, 333]] as const) {
      const m = worldRectToMinimap(g, { x: wx, y: wy, w: 0, h: 0 });
      const back = minimapPointToWorld(g, m.x, m.y);
      close(back.x, wx);
      close(back.y, wy);
    }
  });
  it('映っている所の四角は、枠の大きさ ÷ 倍率 × 縮尺', () => {
    const g = minimapGeometry({ x: 0, y: 0, w: 1000, h: 1000 }, { x: 0, y: 0, zoom: 2 }, 400, 200, 200, 200);
    // 映っているのはワールド 200 × 100。全体は 1000 × 1000 → 縮尺 0.2
    close(g.scale, 0.2);
    close(g.view.w, 40);
    close(g.view.h, 20);
  });
  it('付箋が無くても(null)映っている所だけで写像できる', () => {
    const g = minimapGeometry(null, { x: -50, y: -50, zoom: 1 }, 400, 280, 200, 140);
    close(g.view.w, 200);
    close(g.view.h, 140);
  });
});
