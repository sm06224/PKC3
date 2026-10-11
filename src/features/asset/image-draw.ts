/**
 * 画像への描き込み(#683 段③)── 線の形と、書き出す大きさを決める純粋な部分。
 *
 * 裁定(#1163 のコメント。Gemini への委任):描いたものは**1 枚の新しい画像に焼いて**
 * 新しい添付として保存する。元の画像は触らない。やり直しの履歴(redo)は持たない。
 * 段階 1 は「ペン / 矢印 / 四角」と「赤 / 黒」だけ。
 *
 * ⚠ **browser API を使わない**(canvas を受け取る形は `CanvasPen` という最小の型で受ける。
 *   実体の `CanvasRenderingContext2D` は構造が合うのでそのまま渡せる)。
 *   描く手順をここに置くのは、**線の形が画面と書き出しで割れない**ため ── 窓は
 *   `paintStroke` を呼ぶだけで、矢じりの幾何を自分で持たない。
 */

export type DrawTool = 'pen' | 'arrow' | 'rect';
export type DrawColor = 'red' | 'black';

export interface Pt {
  readonly x: number;
  readonly y: number;
}

export type Stroke =
  | { readonly tool: 'pen'; readonly color: DrawColor; readonly width: number; readonly points: readonly Pt[] }
  | { readonly tool: 'arrow'; readonly color: DrawColor; readonly width: number; readonly from: Pt; readonly to: Pt }
  | { readonly tool: 'rect'; readonly color: DrawColor; readonly width: number; readonly from: Pt; readonly to: Pt };

/** 色は 2 色だけ(段階 1)。⚠ 地が白でも黒でも見えるよう、赤はやや濃い赤にする。 */
export const DRAW_COLORS: Readonly<Record<DrawColor, string>> = {
  red: '#e02020',
  black: '#000000',
};

/** 描き込める画像の種類。⚠ SVG(大きさが不定)と GIF(動きが消える)は含めない。 */
const DRAWABLE_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'];

export function canDrawOnImage(mime: string | null | undefined): boolean {
  const m = (mime ?? '').split(';')[0]!.trim().toLowerCase();
  return DRAWABLE_MIMES.includes(m);
}

/** 描き込みで持つ画像の一辺の上限(px)。ここを超える画像は縮めて保存する。 */
export const DRAW_MAX_SIDE = 4096;

export interface DrawSize {
  readonly width: number;
  readonly height: number;
  /** 1 = 原寸。1 未満なら縮めている(保存する画像が元より小さくなる)。 */
  readonly scale: number;
}

/**
 * 描く台(canvas)の大きさ。長いほうの辺が上限を超えるときだけ、縦横比を保って縮める。
 * ⚠ 0 以下・非有限の寸法は呼び側が先に断る(ここは 1 以上に丸めるだけ)。
 */
export function drawSize(naturalWidth: number, naturalHeight: number, maxSide: number = DRAW_MAX_SIDE): DrawSize {
  const longest = Math.max(naturalWidth, naturalHeight);
  const scale = longest > maxSide ? maxSide / longest : 1;
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
    scale,
  };
}

/** 線の太さ(px)。画像の長いほうの辺に比例させ、小さな画像でも見える下限を持つ。 */
export function strokeWidthFor(width: number, height: number): number {
  return Math.max(2, Math.round(Math.max(width, height) / 200));
}

/** 対角の 2 点から、左上と幅・高さを出す(どちらへドラッグしても同じ四角になる)。 */
export function normalizeRect(a: Pt, b: Pt): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

const ARROW_HALF_ANGLE = (28 * Math.PI) / 180;

/**
 * 矢印の形。軸は矢じりの根元までで止める(軸の先端の丸みが矢じりの外へ出ないように)。
 * 長さがほぼ 0 の矢印は `null`(描かない)。
 */
export function arrowGeometry(
  from: Pt,
  to: Pt,
  width: number,
): { shaftEnd: Pt; head: readonly [Pt, Pt, Pt] } | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!(len >= 2)) return null;
  const ux = dx / len;
  const uy = dy / len;
  // 矢じりは太さの 5 倍。ただし短い矢印では全長の半分までに収める
  const headLen = Math.min(width * 5, len * 0.5);
  const baseX = to.x - ux * headLen;
  const baseY = to.y - uy * headLen;
  const side = Math.tan(ARROW_HALF_ANGLE) * headLen;
  // 軸方向に直交する向きへ振る
  const nx = -uy;
  const ny = ux;
  return {
    shaftEnd: { x: baseX, y: baseY },
    head: [to, { x: baseX + nx * side, y: baseY + ny * side }, { x: baseX - nx * side, y: baseY - ny * side }],
  };
}

/** 描く価値のある線か。長さ 0 の矢印・面積 0 の四角は捨てる(ペンは 1 点でも点として残す)。 */
export function isDrawable(s: Stroke): boolean {
  switch (s.tool) {
    case 'pen':
      return s.points.length >= 1;
    case 'arrow':
      return arrowGeometry(s.from, s.to, s.width) !== null;
    case 'rect': {
      const r = normalizeRect(s.from, s.to);
      return r.w >= 2 && r.h >= 2;
    }
  }
}

/** 線を 1 本足す(元の配列は変えない)。 */
export function pushStroke(list: readonly Stroke[], s: Stroke): readonly Stroke[] {
  return [...list, s];
}

/** 最後の 1 本を取り消す(元の配列は変えない)。空のときはそのまま返す。 */
export function undoStroke(list: readonly Stroke[]): readonly Stroke[] {
  return list.length === 0 ? list : list.slice(0, -1);
}

/**
 * 保存する添付の名前。`写真.jpg` → `写真 (描き込み).png`(保存は常に PNG なので拡張子も揃える)。
 * ⚠ 拡張子の前に入れる(後ろだと書き出したとき OS が種類を見失う)。
 * 描き込んだ画像にもう一度描くと括弧が 2 つ並ぶ ── 元がどれかを残すためわざとそうする。
 */
export function drawnImageName(name: string): string {
  const tag = ' (描き込み)';
  const dot = name.lastIndexOf('.');
  // 先頭の「.」は拡張子ではない
  const stem = dot <= 0 ? name : name.slice(0, dot);
  return `${stem}${tag}.png`;
}

/** 描くのに要る canvas の最小の形。`CanvasRenderingContext2D` がそのまま満たす。 */
export interface CanvasPen {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  stroke(): void;
  fill(): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
}

function setup(ctx: CanvasPen, s: Stroke): void {
  const css = DRAW_COLORS[s.color];
  ctx.strokeStyle = css;
  ctx.fillStyle = css;
  ctx.lineWidth = s.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

/** ペンの最後の 1 区間だけを足し描きする(動かしている間に全部を描き直さないため)。 */
export function paintPenSegment(ctx: CanvasPen, s: Extract<Stroke, { tool: 'pen' }>, index: number): void {
  const b = s.points[index];
  if (b === undefined) return;
  setup(ctx, s);
  const a = s.points[index - 1];
  if (a === undefined) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, s.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

/** 1 本を最初から最後まで描く。 */
export function paintStroke(ctx: CanvasPen, s: Stroke): void {
  switch (s.tool) {
    case 'pen': {
      for (let i = 0; i < s.points.length; i++) paintPenSegment(ctx, s, i);
      return;
    }
    case 'rect': {
      setup(ctx, s);
      const r = normalizeRect(s.from, s.to);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      return;
    }
    case 'arrow': {
      const g = arrowGeometry(s.from, s.to, s.width);
      if (g === null) return;
      setup(ctx, s);
      ctx.beginPath();
      ctx.moveTo(s.from.x, s.from.y);
      ctx.lineTo(g.shaftEnd.x, g.shaftEnd.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(g.head[0].x, g.head[0].y);
      ctx.lineTo(g.head[1].x, g.head[1].y);
      ctx.lineTo(g.head[2].x, g.head[2].y);
      ctx.closePath();
      ctx.fill();
      return;
    }
  }
}
