/**
 * 🔴 **キャンバスに直接手書きする ── 数の部分**(v4.0 Phase 2 / PR-10、ビジョン 2-B)。
 *
 * 描いた線(ストローク)はワールド座標(付箋の `x=` / `y=` と同じ px)で持つ。「ボードに置く」とき、
 * ストロークの外接四角だけを透過 PNG に焼き(「図は描いたら焼く」)、その四角の位置・大きさで
 * 付箋(`.pkc-place`)を 1 枚置く。ここはその四角と、四角の中の座標への写しを出すだけ。
 *
 * ⚠ pure module(DOM もブラウザの API も持たない)。焼くのは `adapter/ui/render/canvas-draw.ts`。
 * 🔑 色と太さは決まった表から選ぶ(本文には色を書かない ── 焼いた PNG に入るだけ)。
 */
import { PLACE_RECT_MAX } from '@features/markdown/place-rect';
import type { CanvasPoint, CanvasRect } from './viewport';

/** ペンの色(4 色)。⚠ 地の色に関係なく読める濃さ ── 焼いた PNG はテーマで変わらない。 */
export const FREEHAND_COLORS = [
  { id: 'black', label: '黒', value: '#1f2937' },
  { id: 'red', label: '赤', value: '#dc2626' },
  { id: 'blue', label: '青', value: '#2563eb' },
  { id: 'green', label: '緑', value: '#15803d' },
] as const;

/** ペンの太さ(3 段階、ワールド px)。 */
export const FREEHAND_WIDTHS = [
  { id: 'thin', label: '細', value: 2 },
  { id: 'medium', label: '中', value: 4 },
  { id: 'thick', label: '太', value: 8 },
] as const;

export const FREEHAND_DEFAULT_COLOR = FREEHAND_COLORS[0].value;
export const FREEHAND_DEFAULT_WIDTH = FREEHAND_WIDTHS[1].value;

/** 外接四角の周りの余白(px)── 線の太さで端が欠けない。 */
export const FREEHAND_PADDING = 12;
/** 置く付箋の大きさの下限と上限(px)。 */
export const FREEHAND_MIN_SIZE = 48;
export const FREEHAND_MAX_SIZE = 2048;

export interface FreehandStroke {
  readonly points: readonly CanvasPoint[];
  readonly color: string;
  readonly width: number;
}

/** 表の色か(手で渡された字を素通しにしない)。 */
export function isFreehandColor(v: unknown): v is string {
  return typeof v === 'string' && FREEHAND_COLORS.some((c) => c.value === v);
}

/** 表の太さか。 */
export function isFreehandWidth(v: unknown): v is number {
  return typeof v === 'number' && FREEHAND_WIDTHS.some((w) => w.value === v);
}

function finitePoint(p: CanvasPoint): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** 点を 1 つも持たないストローク・数でない点を捨てる。 */
export function usableStrokes(strokes: readonly FreehandStroke[]): FreehandStroke[] {
  const out: FreehandStroke[] = [];
  for (const s of strokes) {
    const pts = s.points.filter(finitePoint);
    if (pts.length === 0) continue;
    out.push({ points: pts, color: s.color, width: Number.isFinite(s.width) && s.width > 0 ? s.width : FREEHAND_DEFAULT_WIDTH });
  }
  return out;
}

/**
 * 🔴 **置く付箋の四角**(ワールド座標・整数)。ストロークの外接四角に、余白(`FREEHAND_PADDING`)と
 * 線の太さの半分を足す。大きさは `FREEHAND_MIN_SIZE`〜`FREEHAND_MAX_SIZE` に収め、
 * 位置は `±PLACE_RECT_MAX` の中へ収める。
 * - 小さすぎる(点を 1 つ打っただけ)ときは、描いた所を真ん中にして下限まで広げる。
 * - 大きすぎるときは、左上を描き始めの外接四角の左上にして上限で切る(はみ出した線は焼かない)。
 * @returns 使えるストロークが無ければ `null`(置かない)
 */
export function freehandBounds(strokes: readonly FreehandStroke[], padding = FREEHAND_PADDING): CanvasRect | null {
  const usable = usableStrokes(strokes);
  if (usable.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of usable) {
    const half = s.width / 2;
    for (const p of s.points) {
      minX = Math.min(minX, p.x - half);
      minY = Math.min(minY, p.y - half);
      maxX = Math.max(maxX, p.x + half);
      maxY = Math.max(maxY, p.y + half);
    }
  }
  minX -= padding;
  minY -= padding;
  maxX += padding;
  maxY += padding;
  const fit = (lo: number, hi: number): [number, number] => {
    let a = Math.floor(lo);
    let size = Math.ceil(hi) - a;
    if (size < FREEHAND_MIN_SIZE) {
      a = Math.floor((lo + hi) / 2 - FREEHAND_MIN_SIZE / 2);
      size = FREEHAND_MIN_SIZE;
    }
    if (size > FREEHAND_MAX_SIZE) size = FREEHAND_MAX_SIZE;
    a = Math.min(PLACE_RECT_MAX, Math.max(-PLACE_RECT_MAX, a)) || 0;
    return [a, size];
  };
  const [x, w] = fit(minX, maxX);
  const [y, h] = fit(minY, maxY);
  return { x, y, w, h };
}

/** ストロークを四角の中の座標(四角の左上が 0)へ写す。焼くときに使う。 */
export function toLocalStrokes(strokes: readonly FreehandStroke[], origin: CanvasPoint): FreehandStroke[] {
  return usableStrokes(strokes).map((s) => ({
    color: s.color,
    width: s.width,
    points: s.points.map((p) => ({ x: p.x - origin.x, y: p.y - origin.y })),
  }));
}

/**
 * 🔴 **置く付箋の本文**(1 枚)── 透過の地・枠なしの付箋に、焼いた PNG を 1 枚入れる。
 * ⚠ 添付の key は開き行の外(本文の字)に入るが、`asset:` の綴りを壊さない字(英数・`_`・`-`)に限る。
 * @returns 書けない値なら `null`
 */
export function freehandPlaceBlock(rect: CanvasRect, assetKey: string, alt = '手書き'): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(assetKey)) return null;
  for (const v of [rect.x, rect.y]) if (!Number.isInteger(v) || Math.abs(v) > PLACE_RECT_MAX) return null;
  for (const v of [rect.w, rect.h]) if (!Number.isInteger(v) || v < 1 || v > PLACE_RECT_MAX) return null;
  const safeAlt = alt.replace(/[[\]\n\r\\]/g, '').trim() || '手書き';
  return `:::format{.pkc-place x=${rect.x} y=${rect.y} w=${rect.w} h=${rect.h} fill=transparent stroke=none}\n![${safeAlt}](asset:${assetKey})\n:::\n`;
}
