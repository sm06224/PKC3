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
  applyMosaic,
  arrowGeometry,
  canDrawOnImage,
  clampPt,
  drawSize,
  drawnImageName,
  isDrawable,
  mosaicCellFor,
  normalizeRect,
  paintPenSegment,
  paintStroke,
  pushStroke,
  shouldCommitText,
  strokeWidthFor,
  textFont,
  textSizeFor,
  undoStroke,
  type CanvasPen,
  type PixelBuffer,
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
    font: '',
    textBaseline: 'alphabetic',
    fillText: (t, x, y) => void log.push(`text:${t}@${x},${y}:${String(ctx.fillStyle)}:${ctx.font}:${ctx.textBaseline}`),
    getImageData: (x, y, w, h) => {
      log.push(`get${x},${y},${w},${h}`);
      return pixels(w, h, (i) => (i % 2 === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    },
    putImageData: (_d, x, y) => void log.push(`put${x},${y}`),
  };
  return { ctx, log };
}

/** w×h の画素の入れ物。`f` が i 番目の画素の RGBA を返す。 */
function pixels(w: number, h: number, f: (i: number) => [number, number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(f(i), i * 4);
  return { width: w, height: h, data };
}
const px = (b: PixelBuffer, x: number, y: number): number[] => {
  const i = (y * b.width + x) * 4;
  return [b.data[i]!, b.data[i + 1]!, b.data[i + 2]!, b.data[i + 3]!];
};

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

  it('色は赤・黒・青・黄の 4 色だけで、描く色がそのまま使われる', () => {
    expect(Object.keys(DRAW_COLORS).sort()).toEqual(['black', 'blue', 'red', 'yellow']);
    expect(new Set(Object.values(DRAW_COLORS)).size).toBe(4);
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

describe('太さ 2 段', () => {
  it('「太い」は「細い」より太く、どちらも画像の大きさに比例する', () => {
    expect(strokeWidthFor(2000, 1000, 'thin')).toBe(10);
    expect(strokeWidthFor(2000, 1000, 'thick')).toBe(25);
    expect(strokeWidthFor(2000, 1000)).toBe(strokeWidthFor(2000, 1000, 'thin'));
    expect(strokeWidthFor(100, 80, 'thick')).toBeGreaterThan(strokeWidthFor(100, 80, 'thin'));
  });
  it('文字の大きさも「太い」のほうが大きく、小さな画像でも読める下限がある', () => {
    expect(textSizeFor(100, 80)).toBe(16);
    expect(textSizeFor(4000, 3000)).toBe(100);
    expect(textSizeFor(4000, 3000, 'thick')).toBeGreaterThan(textSizeFor(4000, 3000, 'thin'));
  });
});

describe('文字', () => {
  it('空・空白だけの文字は置かない / 打った文字は置く', () => {
    const t = (text: string): Stroke => ({ tool: 'text', color: 'red', size: 20, at: { x: 1, y: 2 }, text });
    expect(isDrawable(t(''))).toBe(false);
    expect(isDrawable(t('  \u3000 '))).toBe(false);
    expect(isDrawable(t('確認済み'))).toBe(true);
  });

  it('描く手順:色・書体・左上を基準に、押した位置へ書く', () => {
    const { ctx, log } = recorder();
    paintStroke(ctx, { tool: 'text', color: 'blue', size: 24, at: { x: 30, y: 40 }, text: '日本語' });
    expect(log).toEqual([`text:日本語@30,40:${DRAW_COLORS.blue}:${textFont(24)}:top`]);
    expect(textFont(24)).toContain('24px');
  });

  it('日本語入力の変換中の Enter は確定しない / 変換が済んだ Enter は確定する', () => {
    expect(shouldCommitText({ key: 'Enter', isComposing: true })).toBe(false);
    expect(shouldCommitText({ key: 'Enter', keyCode: 229 })).toBe(false);
    expect(shouldCommitText({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(true);
    expect(shouldCommitText({ key: 'Enter' })).toBe(true);
    expect(shouldCommitText({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(shouldCommitText({ key: 'a' })).toBe(false);
  });
});

describe('モザイク', () => {
  it('升目の中は全部 1 色(升目の平均)になり、元の画素は読み戻せない', () => {
    // 4×4 を 2 画素の升目に。左上の升目は赤 / 青を交互に敷いてあるので平均は紫っぽい 1 色
    const b = pixels(4, 4, (i) => (i % 2 === 0 ? [200, 0, 0, 255] : [0, 0, 100, 255]));
    applyMosaic(b, { x: 0, y: 0, w: 4, h: 4 }, 2);
    for (const [cx, cy] of [[0, 0], [2, 0], [0, 2], [2, 2]] as const) {
      const first = px(b, cx, cy);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) expect(px(b, cx + dx, cy + dy)).toEqual(first);
    }
    expect(px(b, 0, 0)).toEqual([100, 0, 50, 255]);
  });

  it('平均が同じなら、元の画素が違っても結果は同じ(元の並びは残らない)', () => {
    const a = pixels(2, 2, (i) => [[255, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255], [255, 0, 0, 255]][i] as [number, number, number, number]);
    const c = pixels(2, 2, (i) => [[0, 0, 0, 255], [255, 0, 0, 255], [255, 0, 0, 255], [0, 0, 0, 255]][i] as [number, number, number, number]);
    applyMosaic(a, { x: 0, y: 0, w: 2, h: 2 }, 2);
    applyMosaic(c, { x: 0, y: 0, w: 2, h: 2 }, 2);
    expect(Array.from(a.data)).toEqual(Array.from(c.data));
    expect(px(a, 0, 0)).toEqual([128, 0, 0, 255]);
  });

  it('範囲の外は 1 画素も変えない / 画像からはみ出す分は切る', () => {
    const b = pixels(6, 6, (i) => [i, 10, 20, 255]);
    const before = Array.from(b.data);
    const done = applyMosaic(b, { x: 2, y: 2, w: 100, h: 2 }, 3);
    expect(done).toEqual({ x0: 2, y0: 2, x1: 6, y1: 4 });
    const after = Array.from(b.data);
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) {
        const inside = x >= 2 && y >= 2 && y < 4;
        const i = (y * 6 + x) * 4;
        if (!inside) expect(after.slice(i, i + 4), `${x},${y}`).toEqual(before.slice(i, i + 4));
      }
    }
    expect(applyMosaic(b, { x: 50, y: 50, w: 5, h: 5 }, 3)).toBeNull();
  });

  it('端の余りの升目は小さな升目として平均する', () => {
    const b = pixels(5, 1, (i) => [i * 40, 0, 0, 255]); // 0 40 80 120 160
    applyMosaic(b, { x: 0, y: 0, w: 5, h: 1 }, 3);
    expect(px(b, 0, 0)[0]).toBe(40); // (0+40+80)/3
    expect(px(b, 3, 0)[0]).toBe(140); // (120+160)/2
    expect(px(b, 4, 0)[0]).toBe(140);
  });

  it('透明な画素の色は平均に混ざらない', () => {
    const b = pixels(2, 1, (i) => (i === 0 ? [255, 0, 0, 255] : [0, 255, 0, 0]));
    applyMosaic(b, { x: 0, y: 0, w: 2, h: 1 }, 2);
    expect(px(b, 0, 0)).toEqual([255, 0, 0, 128]);
    expect(px(b, 1, 0)).toEqual([255, 0, 0, 128]);
  });

  it('描く手順:下の画素を読んで、同じ場所へ平均で書き戻す(半透明の板を重ねない)', () => {
    const { ctx, log } = recorder();
    paintStroke(ctx, { tool: 'mosaic', cell: 4, from: { x: 30.6, y: 9 }, to: { x: 10.2, y: 20 } });
    expect(log).toEqual(['get10,9,21,11', 'put10,9']);
    const fills = recorder();
    paintStroke(fills.ctx, { tool: 'mosaic', cell: 4, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } });
    expect(fills.log.some((l) => l.startsWith('fill') || l.startsWith('stroke'))).toBe(false);
  });

  it('小さい範囲は捨てる / 升目は画像の大きさに比例し下限がある', () => {
    const m = (to: { x: number; y: number }): Stroke => ({ tool: 'mosaic', cell: 8, from: { x: 5, y: 5 }, to });
    expect(isDrawable(m({ x: 5, y: 50 }))).toBe(false);
    expect(isDrawable(m({ x: 40, y: 50 }))).toBe(true);
    expect(mosaicCellFor(100, 100)).toBe(8);
    expect(mosaicCellFor(3000, 2000)).toBe(50);
  });

  it('点を画像の中へ収める', () => {
    expect(clampPt({ x: -5, y: 900 }, 100, 80)).toEqual({ x: 0, y: 80 });
    expect(clampPt({ x: 50, y: 20 }, 100, 80)).toEqual({ x: 50, y: 20 });
  });
});
