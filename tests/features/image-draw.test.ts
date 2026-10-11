/**
 * 画像への描き込み(#683 段③)── 線の形・取り消し・保存する大きさ・名前。
 *
 * 守るのは「user が描いた形がそのまま画像に焼かれる」こと:
 * 四角はどちらへドラッグしても同じ・矢印の矢じりは先端にある・取り消しは最後の 1 本だけ・
 * 大きな画像は縦横比を保って縮む・保存名は元の名前 + (描き込み) + .png。
 */
import { describe, expect, it } from 'vitest';
import {
  DRAW_COLORS,
  DRAW_MAX_SIDE,
  arrowGeometry,
  canDrawOnImage,
  drawSize,
  drawnImageName,
  isDrawable,
  normalizeRect,
  paintPenSegment,
  paintStroke,
  pushStroke,
  strokeWidthFor,
  undoStroke,
  type CanvasPen,
  type Stroke,
} from '../../src/features/asset/image-draw';

/** 呼ばれた順を記録する偽の canvas(描く手順を直接見る)。 */
function recorder(): { ctx: CanvasPen; log: string[] } {
  const log: string[] = [];
  const ctx: CanvasPen = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    beginPath: () => void log.push('begin'),
    closePath: () => void log.push('close'),
    moveTo: (x, y) => void log.push(`M${x},${y}`),
    lineTo: (x, y) => void log.push(`L${x},${y}`),
    arc: (x, y, r) => void log.push(`arc${x},${y},${r}`),
    stroke: () => void log.push(`stroke:${String(ctx.strokeStyle)}:${ctx.lineWidth}`),
    fill: () => void log.push(`fill:${String(ctx.fillStyle)}`),
    strokeRect: (x, y, w, h) => void log.push(`rect${x},${y},${w},${h}:${String(ctx.strokeStyle)}`),
  };
  return { ctx, log };
}

describe('四角', () => {
  it('どちらの角からドラッグしても同じ四角になる', () => {
    const a = normalizeRect({ x: 10, y: 20 }, { x: 40, y: 80 });
    const b = normalizeRect({ x: 40, y: 80 }, { x: 10, y: 20 });
    const c = normalizeRect({ x: 40, y: 20 }, { x: 10, y: 80 });
    expect(a).toEqual({ x: 10, y: 20, w: 30, h: 60 });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('描くときも正規化した四角で strokeRect を呼ぶ(逆向きでも負の幅を渡さない)', () => {
    const { ctx, log } = recorder();
    paintStroke(ctx, { tool: 'rect', color: 'red', width: 5, from: { x: 40, y: 80 }, to: { x: 10, y: 20 } });
    expect(log).toEqual([`rect10,20,30,60:${DRAW_COLORS.red}`]);
  });

  it('面積 0 に近い四角は捨てる(クリックしただけで線が残らない)', () => {
    const s = (to: { x: number; y: number }): Stroke => ({ tool: 'rect', color: 'red', width: 4, from: { x: 5, y: 5 }, to });
    expect(isDrawable(s({ x: 5, y: 5 }))).toBe(false);
    expect(isDrawable(s({ x: 5, y: 200 }))).toBe(false); // 幅 0 の線
    expect(isDrawable(s({ x: 50, y: 50 }))).toBe(true);
  });
});

describe('矢印', () => {
  it('矢じりの先端は終点で、軸は矢じりの根元で止まる', () => {
    const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 4)!;
    expect(g.head[0]).toEqual({ x: 100, y: 0 });
    // 太さ 4 → 矢じりの長さ 20。根元は終点の 20 手前
    expect(g.shaftEnd.x).toBeCloseTo(80);
    expect(g.shaftEnd.y).toBeCloseTo(0);
    // 左右の翼は軸の両側に対称に開く
    expect(g.head[1].x).toBeCloseTo(80);
    expect(g.head[2].x).toBeCloseTo(80);
    expect(g.head[1].y).toBeCloseTo(-g.head[2].y);
    expect(Math.abs(g.head[1].y)).toBeGreaterThan(5);
  });

  it('斜めでも、翼は軸に直交する向きに開く', () => {
    const g = arrowGeometry({ x: 0, y: 0 }, { x: 30, y: 40 }, 2)!; // 長さ 50、向き (0.6, 0.8)
    const w1 = { x: g.head[1].x - g.shaftEnd.x, y: g.head[1].y - g.shaftEnd.y };
    expect(w1.x * 0.6 + w1.y * 0.8).toBeCloseTo(0); // 軸との内積 0
  });

  it('短い矢印では矢じりを全長の半分までに収める', () => {
    const g = arrowGeometry({ x: 0, y: 0 }, { x: 10, y: 0 }, 10)!; // 5 倍 = 50 > 全長
    expect(g.shaftEnd.x).toBeCloseTo(5);
  });

  it('長さがほぼ 0 の矢印は描かない', () => {
    expect(arrowGeometry({ x: 3, y: 3 }, { x: 3.5, y: 3 }, 4)).toBeNull();
    expect(isDrawable({ tool: 'arrow', color: 'black', width: 4, from: { x: 3, y: 3 }, to: { x: 3, y: 3 } })).toBe(false);
  });

  it('描く手順:軸を線で引き、矢じりは塗りつぶす', () => {
    const { ctx, log } = recorder();
    paintStroke(ctx, { tool: 'arrow', color: 'black', width: 4, from: { x: 0, y: 0 }, to: { x: 100, y: 0 } });
    expect(log[0]).toBe('begin');
    expect(log).toContain('M0,0');
    expect(log).toContain('L80,0');
    expect(log).toContain(`stroke:${DRAW_COLORS.black}:4`);
    expect(log).toContain('close');
    expect(log[log.length - 1]).toBe(`fill:${DRAW_COLORS.black}`);
  });
});

describe('ペン', () => {
  it('1 点だけ(タップ)でも点として残り、描かれる', () => {
    const s: Stroke = { tool: 'pen', color: 'red', width: 6, points: [{ x: 7, y: 9 }] };
    expect(isDrawable(s)).toBe(true);
    const { ctx, log } = recorder();
    paintStroke(ctx, s);
    expect(log).toEqual(['begin', 'arc7,9,3', `fill:${DRAW_COLORS.red}`]);
  });

  it('区間ごとに足し描きできる(全部を描き直す手順と同じ結果)', () => {
    const s: Stroke = { tool: 'pen', color: 'black', width: 3, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 2 }] };
    const all = recorder();
    paintStroke(all.ctx, s);
    const step = recorder();
    for (let i = 0; i < 3; i++) paintPenSegment(step.ctx, s, i);
    expect(step.log).toEqual(all.log);
    expect(all.log).toContain('M0,0');
    expect(all.log).toContain('L5,5');
    expect(all.log).toContain('M5,5');
    expect(all.log).toContain('L9,2');
  });

  it('色は赤と黒の 2 色だけで、描く色がそのまま使われる', () => {
    expect(Object.keys(DRAW_COLORS).sort()).toEqual(['black', 'red']);
    const { ctx, log } = recorder();
    paintStroke(ctx, { tool: 'pen', color: 'red', width: 3, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    expect(log.some((l) => l.includes(DRAW_COLORS.red))).toBe(true);
    expect(log.some((l) => l.includes(DRAW_COLORS.black))).toBe(false);
  });
});

describe('元に戻す', () => {
  const pen = (n: number): Stroke => ({ tool: 'pen', color: 'red', width: 2, points: [{ x: n, y: n }] });

  it('最後の 1 本だけが消え、元の配列は変わらない', () => {
    const l1 = pushStroke([], pen(1));
    const l2 = pushStroke(l1, pen(2));
    const l3 = pushStroke(l2, pen(3));
    const undone = undoStroke(l3);
    expect(undone).toHaveLength(2);
    expect(undone[1]).toBe(l2[1]);
    expect(l3).toHaveLength(3); // 触っていない
    expect(l1).toHaveLength(1);
  });

  it('何も無いときに戻しても壊れない / 全部戻すと空になる', () => {
    expect(undoStroke([])).toEqual([]);
    expect(undoStroke(undoStroke(pushStroke([], pen(1))))).toEqual([]);
  });
});

describe('保存する大きさ', () => {
  it('上限以内ならそのまま(縮めない)', () => {
    expect(drawSize(800, 600)).toEqual({ width: 800, height: 600, scale: 1 });
    expect(drawSize(DRAW_MAX_SIDE, 100).scale).toBe(1);
  });

  it('上限を超えたら、長いほうを上限に合わせて縦横比を保つ', () => {
    const s = drawSize(8192, 4096);
    expect(s).toEqual({ width: 4096, height: 2048, scale: 0.5 });
    const t = drawSize(3000, 12000);
    expect(t.height).toBe(4096);
    expect(t.width).toBe(1024);
  });

  it('極端に細長くても 1px を下回らない', () => {
    expect(drawSize(100000, 1).height).toBe(1);
  });

  it('線の太さは画像の大きさに比例し、小さい画像でも 2px を下回らない', () => {
    expect(strokeWidthFor(100, 80)).toBe(2);
    expect(strokeWidthFor(2000, 1000)).toBe(10);
    expect(strokeWidthFor(1000, 4000)).toBe(20);
  });
});

describe('名前と対象', () => {
  it('拡張子の前に (描き込み) を入れ、保存は PNG なので拡張子も .png にする', () => {
    expect(drawnImageName('写真.jpg')).toBe('写真 (描き込み).png');
    expect(drawnImageName('a.b.webp')).toBe('a.b (描き込み).png');
    expect(drawnImageName('拡張子なし')).toBe('拡張子なし (描き込み).png');
    expect(drawnImageName('.hidden')).toBe('.hidden (描き込み).png');
  });

  it('描き込んだ画像にもう一度描くと、括弧が並ぶ(元をたどれる)', () => {
    expect(drawnImageName('写真 (描き込み).png')).toBe('写真 (描き込み) (描き込み).png');
  });

  it('描ける種類は PNG / JPEG / WebP / BMP だけ(SVG と GIF は出さない)', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'IMAGE/PNG', 'image/png; x=1']) {
      expect(canDrawOnImage(m), m).toBe(true);
    }
    for (const m of ['image/svg+xml', 'image/gif', 'application/pdf', 'text/plain', '', null, undefined]) {
      expect(canDrawOnImage(m), String(m)).toBe(false);
    }
  });
});
