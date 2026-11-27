/**
 * 🔴 **スナップ補助線**(v4.0 仕上げ Polish PR-C)── 付箋を動かしているとき、ほかの付箋の端・中央に揃う所で吸い付かせる。数だけを扱う。
 *
 * - X 軸(左端 / 中央 / 右端)と Y 軸(上端 / 中央 / 下端)を**別々に**見る。動かしている四角の 3 本の線と、
 *   ほかの付箋の 3 本の線の組のうち、いちばん近い組が閾値以内なら、その差だけ吸い付かせる。
 * - 吸い付いた後に揃っている線を、補助線として返す(同じ位置の線は 1 本にまとめ、両方の付箋にまたがる長さにする)。
 *
 * ⚠ ここは DOM もブラウザの API も持たない(`features` 層)。座標はワールド座標(付箋の `x=` / `y=` と同じ px。負もある)。
 * 🔑 結果は決定的 ── 同じ入力からは同じ吸い付き・同じ補助線(並びも同じ)を返す。
 */
import type { CanvasRect } from './viewport';

/** 吸い付く距離(**画面の px**)。ワールドでの閾値は倍率で割る(`snapThresholdFor`)。 */
export const SNAP_THRESHOLD_PX = 6;

/**
 * 補助線 1 本。
 * - `axis: 'x'` は **x = pos の縦の線**(`from`〜`to` は y の範囲)。
 * - `axis: 'y'` は **y = pos の横の線**(`from`〜`to` は x の範囲)。
 */
export interface SnapGuide {
  readonly axis: 'x' | 'y';
  readonly pos: number;
  readonly from: number;
  readonly to: number;
}

export interface SnapResult {
  /** 吸い付かせる差(ワールド px)。吸い付かなければ 0。 */
  readonly snapDx: number;
  readonly snapDy: number;
  readonly guides: readonly SnapGuide[];
}

/** 倍率に合わせたワールドの閾値(画面で常に 6px 相当)。⚠ 倍率が 0 以下・数でないときは 1 倍として扱う。 */
export function snapThresholdFor(zoom: number): number {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return SNAP_THRESHOLD_PX / z;
}

/** 揃いを見る 3 本(始端 / 中央 / 終端)。 */
function linesOf(start: number, size: number): [number, number, number] {
  return [start, start + size / 2, start + size];
}

/** 浮動小数の揺れを吸う(補助線の「揃っている」判定)。 */
const EPS = 1e-6;

interface AxisPick {
  readonly delta: number;
}

/**
 * 1 つの軸で、いちばん近い組の差を選ぶ。
 * ⚠ 同じ距離が複数あれば、動かす側の線(始端 → 中央 → 終端)、ほかの付箋の並び、その付箋の線の順で先の物を採る(決定的)。
 */
function pickAxis(moving: readonly number[], others: ReadonlyArray<readonly number[]>, threshold: number): AxisPick | null {
  let best: AxisPick | null = null;
  let bestAbs = Number.POSITIVE_INFINITY;
  for (const m of moving) {
    for (const o of others) {
      for (const v of o) {
        const d = v - m;
        const a = Math.abs(d);
        if (a <= threshold + EPS && a < bestAbs - EPS) {
          best = { delta: d };
          bestAbs = a;
        }
      }
    }
  }
  return best;
}

/** 揃った線を補助線にする(同じ位置は 1 本へまとめる)。 */
function guidesOf(
  axis: 'x' | 'y',
  moving: CanvasRect,
  others: readonly CanvasRect[],
): SnapGuide[] {
  const mLines = axis === 'x' ? linesOf(moving.x, moving.w) : linesOf(moving.y, moving.h);
  const mFrom = axis === 'x' ? moving.y : moving.x;
  const mTo = axis === 'x' ? moving.y + moving.h : moving.x + moving.w;
  const byPos = new Map<number, { from: number; to: number }>();
  for (const o of others) {
    const oLines = axis === 'x' ? linesOf(o.x, o.w) : linesOf(o.y, o.h);
    const oFrom = axis === 'x' ? o.y : o.x;
    const oTo = axis === 'x' ? o.y + o.h : o.x + o.w;
    for (const m of mLines) {
      for (const v of oLines) {
        if (Math.abs(v - m) > EPS) continue;
        const pos = Math.round(v * 1000) / 1000;
        const cur = byPos.get(pos);
        const from = Math.min(mFrom, oFrom, cur?.from ?? Number.POSITIVE_INFINITY);
        const to = Math.max(mTo, oTo, cur?.to ?? Number.NEGATIVE_INFINITY);
        byPos.set(pos, { from, to });
      }
    }
  }
  return [...byPos.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pos, r]) => ({ axis, pos, from: r.from, to: r.to }));
}

/**
 * 🔴 **吸い付きと補助線を出す**。
 * @param moving 動かしている四角(複数選択・グループのときは全員の外接四角)
 * @param others 動かしていない付箋の四角
 * @param threshold 吸い付く距離(ワールド px。既定は `SNAP_THRESHOLD_PX` ── 倍率があるときは `snapThresholdFor(zoom)`)
 */
export function computeSnapGuides(
  moving: CanvasRect,
  others: readonly CanvasRect[],
  threshold: number = SNAP_THRESHOLD_PX,
): SnapResult {
  if (others.length === 0 || !(threshold >= 0)) return { snapDx: 0, snapDy: 0, guides: [] };
  const px = pickAxis(
    linesOf(moving.x, moving.w),
    others.map((o) => linesOf(o.x, o.w)),
    threshold,
  );
  const py = pickAxis(
    linesOf(moving.y, moving.h),
    others.map((o) => linesOf(o.y, o.h)),
    threshold,
  );
  const snapDx = px === null ? 0 : px.delta;
  const snapDy = py === null ? 0 : py.delta;
  const snapped: CanvasRect = { x: moving.x + snapDx, y: moving.y + snapDy, w: moving.w, h: moving.h };
  const guides = [
    ...(px === null ? [] : guidesOf('x', snapped, others)),
    ...(py === null ? [] : guidesOf('y', snapped, others)),
  ];
  // ⚠ -0 を返さない(比べる側が `Object.is` で迷わない)
  return { snapDx: snapDx === 0 ? 0 : snapDx, snapDy: snapDy === 0 ? 0 : snapDy, guides };
}

/** 四角の外接四角(空なら `null`)。動かす仲間が複数のとき、まとめて 1 つの四角として揃える。 */
export function boundsOf(rects: readonly CanvasRect[]): CanvasRect | null {
  if (rects.length === 0) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
