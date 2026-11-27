/**
 * 🔴 **ドラッグ端のオートパン**(v4.0 仕上げ Polish PR-C)── 付箋や範囲選択を引いたまま画面の端へ近づくと、
 * そちらへ画面を送る速さを出す。数だけを扱う。
 *
 * - 枠の内側 `marginPx` の帯に入ると、端に近いほど速く(2 乗で滑らかに)送る。帯の外(真ん中)は 0。
 * - 端を越えて枠の外へ出たときは最高速のまま(手を離すまで送り続ける)。
 * - 向き: 右端・下端は正、左端・上端は負(呼び側は `panCanvasBy(host, -vx, -vy)` で中身を逆へ動かす)。
 *
 * ⚠ ここは DOM もブラウザの API も持たない(`features` 層)。枠は `{ left, top, width, height }` の数で受ける。
 */

export interface EdgePanRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface EdgePanVelocity {
  /** 1 コマに送る量(画面 px)。 */
  readonly vx: number;
  readonly vy: number;
}

/** 端から反応する帯の幅(画面 px)。 */
export const EDGE_PAN_MARGIN_PX = 40;
/** 1 コマの最高速(画面 px)。 */
export const EDGE_PAN_MAX_SPEED = 14;

/** 1 つの軸の速さ。`pos` は枠の左(上)からの距離。 */
function axisSpeed(pos: number, size: number, margin: number, max: number): number {
  if (!(size > 0) || !(margin > 0) || !(max > 0) || !Number.isFinite(pos)) return 0;
  // ⚠ 枠が帯 2 本より狭いときは帯を半分に縮める(両端の帯が重なって左右へ同時に送らない)
  const m = Math.min(margin, size / 2);
  let depth = 0;
  let sign = 0;
  if (pos < m) {
    depth = (m - pos) / m;
    sign = -1;
  } else if (pos > size - m) {
    depth = (pos - (size - m)) / m;
    sign = 1;
  }
  if (sign === 0) return 0;
  const d = Math.min(1, Math.max(0, depth));
  const v = sign * max * d * d;
  // ⚠ -0 と、目に見えない端数の送りを出さない(動かない 1 コマで rAF を回し続けない)
  return Math.abs(v) < 0.01 ? 0 : Math.round(v * 100) / 100;
}

/**
 * 🔴 **端に近いほど速いパンの速さ**。帯の外は `{ vx: 0, vy: 0 }`。
 * @param pointerX ポインタの画面の x(`clientX`)
 * @param pointerY ポインタの画面の y(`clientY`)
 * @param viewportRect 枠の外形(`getBoundingClientRect` と同じ数)
 */
export function computeEdgePanVelocity(
  pointerX: number,
  pointerY: number,
  viewportRect: EdgePanRect,
  marginPx: number = EDGE_PAN_MARGIN_PX,
  maxSpeedPxPerFrame: number = EDGE_PAN_MAX_SPEED,
): EdgePanVelocity {
  return {
    vx: axisSpeed(pointerX - viewportRect.left, viewportRect.width, marginPx, maxSpeedPxPerFrame),
    vy: axisSpeed(pointerY - viewportRect.top, viewportRect.height, marginPx, maxSpeedPxPerFrame),
  };
}
