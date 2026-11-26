/**
 * 🔴 **無限キャンバスの複数選択と整列**(v4.0 Phase 2 / PR-10、ビジョン 2-B)── 数だけを扱う。
 *
 * - 範囲選択(ラバーバンド): 引いた四角と**少しでも重なる**付箋を選ぶ(`selectRectsInBox`)。
 * - 整列: 選んだ付箋の移動後の左上を出す(`alignCanvasRects`)。書くのは呼び側(`MOVE_PLACES` 1 回)。
 *
 * ⚠ ここは DOM もブラウザの API も持たない(`features` 層)。付箋をどう引くか(要素・行番号)は
 *   `key` という字で受け、返すのも `key` だけ ── どの画面の要素かを知らない。
 * 🔑 座標はワールド座標(付箋の `x=` / `y=` と同じ px。負もある)。整列の結果は**整数**に丸め、
 *   `±PLACE_RECT_MAX` の中へ収める(本文に書けない値を出さない)。
 */
import { PLACE_RECT_MAX } from '@features/markdown/place-rect';
import type { CanvasRect } from './viewport';

/** 付箋 1 枚の四角(ワールド座標)と、それを引く字。 */
export interface IndexedRect extends CanvasRect {
  readonly key: string;
}

export type AlignKind =
  | 'left'
  | 'center-x'
  | 'right'
  | 'top'
  | 'center-y'
  | 'bottom'
  | 'distribute-x'
  | 'distribute-y';

/** 整列の種類(画面のメニューの並び順)。 */
export const ALIGN_KINDS: readonly AlignKind[] = [
  'left',
  'center-x',
  'right',
  'top',
  'center-y',
  'bottom',
  'distribute-x',
  'distribute-y',
];

/** メニューに出す名前(標準の日本語 IT 用語)。 */
export const ALIGN_LABELS: Readonly<Record<AlignKind, string>> = {
  left: '左揃え',
  'center-x': '左右中央揃え',
  right: '右揃え',
  top: '上揃え',
  'center-y': '上下中央揃え',
  bottom: '下揃え',
  'distribute-x': '左右に等間隔',
  'distribute-y': '上下に等間隔',
};

/** その整列に要る最少の枚数(揃えは 2 枚、等間隔は 3 枚)。 */
export function alignMinCount(kind: AlignKind): number {
  return kind === 'distribute-x' || kind === 'distribute-y' ? 3 : 2;
}

/** 字が整列の種類か(画面から来た字を素通しにしない)。 */
export function isAlignKind(v: unknown): v is AlignKind {
  return typeof v === 'string' && (ALIGN_KINDS as readonly string[]).includes(v);
}

/** 引いた四角を正規化する(左上へ引いても、幅・高さを正にする)。 */
export function normalizeBox(box: CanvasRect): CanvasRect {
  const x = box.w < 0 ? box.x + box.w : box.x;
  const y = box.h < 0 ? box.y + box.h : box.y;
  return { x, y, w: Math.abs(box.w), h: Math.abs(box.h) };
}

/**
 * 🔴 **引いた四角と重なる付箋**(範囲選択)。⚠ 辺がちょうど接するだけ(幅 0 の重なり)は選ばない。
 * 引いた四角の幅・高さが負でもよい(左上へ引いた)。並びは渡した順のまま。
 */
export function selectRectsInBox(rects: readonly IndexedRect[], box: CanvasRect): string[] {
  const b = normalizeBox(box);
  const out: string[] = [];
  for (const r of rects) {
    if (r.x < b.x + b.w && r.x + r.w > b.x && r.y < b.y + b.h && r.y + r.h > b.y) out.push(r.key);
  }
  return out;
}

function clampPos(n: number): number {
  const v = Math.round(n);
  // ⚠ `-0` を本文へ書かない
  return Math.min(PLACE_RECT_MAX, Math.max(-PLACE_RECT_MAX, v)) || 0;
}

/**
 * 🔴 **整列した後の左上**。キーは付箋の `key`、値は移動後の `{ x, y }`(整数・`±PLACE_RECT_MAX` の中)。
 *
 * - 揃え(6 種)は 2 枚以上、等間隔(2 種)は 3 枚以上。足りなければ空の Map(何も動かさない)。
 * - 揃えは**選んだ付箋の外接四角**の辺・中央に合わせる(左揃え = いちばん左の付箋の左端)。
 * - 等間隔は両端の付箋を動かさず、間の付箋の**隙間**を等しくする(大きさが違っても隙間で揃える)。
 *   隙間の合計が負(重なっている)でも、同じ式で中心寄りに並べる。
 * ⚠ 動かない付箋も結果に入れる(呼び側は「元と同じなら書かない」を自分で見る)。
 */
export function alignCanvasRects(
  rects: readonly IndexedRect[],
  kind: AlignKind,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (rects.length < alignMinCount(kind)) return out;
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
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  if (kind === 'distribute-x' || kind === 'distribute-y') {
    const horiz = kind === 'distribute-x';
    // 🔑 並べる順は位置(同じなら渡した順)── 並びを入れ替えない
    const sorted = rects
      .map((r, i) => ({ r, i }))
      .sort((a, b) => (horiz ? a.r.x - b.r.x : a.r.y - b.r.y) || a.i - b.i)
      .map((v) => v.r);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const start = horiz ? first.x : first.y;
    const end = horiz ? last.x + last.w : last.y + last.h;
    const sizes = sorted.reduce((s, r) => s + (horiz ? r.w : r.h), 0);
    const gap = (end - start - sizes) / (sorted.length - 1);
    let at = start;
    sorted.forEach((r, i) => {
      // 両端は動かさない(丸めで 1px もずらさない)
      const pos = i === 0 ? (horiz ? r.x : r.y) : i === sorted.length - 1 ? (horiz ? r.x : r.y) : at;
      out.set(r.key, horiz ? { x: clampPos(pos), y: clampPos(r.y) } : { x: clampPos(r.x), y: clampPos(pos) });
      at += (horiz ? r.w : r.h) + gap;
    });
    return out;
  }
  for (const r of rects) {
    let x = r.x;
    let y = r.y;
    switch (kind) {
      case 'left':
        x = minX;
        break;
      case 'center-x':
        x = cx - r.w / 2;
        break;
      case 'right':
        x = maxX - r.w;
        break;
      case 'top':
        y = minY;
        break;
      case 'center-y':
        y = cy - r.h / 2;
        break;
      case 'bottom':
        y = maxY - r.h;
        break;
    }
    out.set(r.key, { x: clampPos(x), y: clampPos(y) });
  }
  return out;
}
