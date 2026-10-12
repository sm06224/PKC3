/**
 * 🔴 **付箋の回転**(#530 段⑤d。Gemini 裁定 2026-10-11 依頼 19 Q2「推薦どおり」、設計 `board-next-stage-design-2026-10.md` §2・§4.2・§5)。
 *
 * 書き方は開き行の `rotate=15`(**度**、右回り、**0〜359 の整数**)。
 * ⚠ 札が無い = 回していない(古いノートは 1 バイトも変わらない)。`rotate=0` と書いても読める(= 札が無いのと同じ)が、
 *   画面から「回転を解く」を選んだときは**札を消す**(`size=standard` / `arrow=none` と同じ作法)。
 * ⚠ 負・小数・単位つき(`-15` / `7.5` / `15deg`)・360 以上は**読めない = 無視**(本文は消さない)。書くときは 0〜359 へ畳む。
 * 🔑 向きは CSS の `rotate(θ)` と PowerPoint の `rot`(60000 分の 1 度)と同じ(どちらも時計回り)。
 *
 * ## 🔑 回る軸は付箋の中心 ── `x=` `y=` `w=` `h=` は回す前の四角のまま
 *
 * 画面は `transform: rotate(θ)`(`transform-origin` は中心)で回すので、`left` / `top` / `width` / `height` は変わらない。
 * だから「回した付箋の座標」は**回す前の四角を中心の周りに回した四角**であり、その計算はここ 1 か所に置く(§7)。
 * 線の端(`place-line.ts` の `anchorPoint`)・辺の判定(`place-handles.ts`)・離した先の当たり・角の伸縮・板の高さの見積もりが、
 * 全部この関数を引く。
 */

/** 右クリックの 1 回で回る角度(度)。 */
export const PLACE_ROTATE_STEP = 15;

/** `rotate=` の値を読む。⚠ 読めない字 / 値なし / 空は `null`(札が無いのと同じ扱い)。0〜359 の整数だけ。 */
export function parsePlaceRotate(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!/^\d{1,3}$/.test(v)) return null;
  const n = Number(v);
  return n >= 0 && n <= 359 ? n : null;
}

/** 画面・書き出しが使う読み方 ── 読めない / 無いは `0`(回していない)。⚠ 規則は `parsePlaceRotate` の 1 本。 */
export function placeRotateOf(raw: unknown): number {
  return parsePlaceRotate(raw) ?? 0;
}

/**
 * 右(`+1`)/ 左(`-1`)へ 1 段回した後の角度(0〜359)。
 * ⚠ 15 の倍数でない角度(手で `rotate=20` と書いた)からも**15° 動かす**(丸めて飛ばさない)。
 */
export function stepPlaceRotate(current: number, dir: 1 | -1): number {
  const n = (Math.round(current) + dir * PLACE_ROTATE_STEP) % 360;
  return n < 0 ? n + 360 : n;
}

/** 回す前の四角(器の左上が原点、px)。⚠ `place-line.ts` の `PlaceRect` と同じ形(循環を避けて写している)。 */
interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 度 → (sin, cos)。⚠ 90 度の倍数は**正確な 0 / ±1** を返す(`Math.cos(π/2)` の 6e-17 を座標に混ぜない)。 */
function sinCos(deg: number): { sin: number; cos: number } {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return { sin: 0, cos: 1 };
  if (d === 90) return { sin: 1, cos: 0 };
  if (d === 180) return { sin: 0, cos: -1 };
  if (d === 270) return { sin: -1, cos: 0 };
  const r = (d * Math.PI) / 180;
  return { sin: Math.sin(r), cos: Math.cos(r) };
}

/** 点 `(px, py)` を `(cx, cy)` の周りに `deg` 度(右回り)回した点。 */
export function rotatePointAround(
  px: number,
  py: number,
  cx: number,
  cy: number,
  deg: number,
): { x: number; y: number } {
  if (deg === 0) return { x: px, y: py };
  const { sin, cos } = sinCos(deg);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/** 回した四角の 4 つの角(左上・右上・右下・左下を回した点。この順)。 */
export function rotatedCorners(r: Box, deg: number): Array<{ x: number; y: number }> {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return [
    rotatePointAround(r.x, r.y, cx, cy, deg),
    rotatePointAround(r.x + r.w, r.y, cx, cy, deg),
    rotatePointAround(r.x + r.w, r.y + r.h, cx, cy, deg),
    rotatePointAround(r.x, r.y + r.h, cx, cy, deg),
  ];
}

/** 回した四角を囲む、回さない四角(板の高さの見積もりに使う)。 */
export function rotatedBounds(r: Box, deg: number): Box {
  if (deg === 0) return r;
  const cs = rotatedCorners(r, deg);
  const xs = cs.map((c) => c.x);
  const ys = cs.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * 画面の点を、**付箋の中の座標**(回す前の四角で見た点)へ戻す ── 中心の周りに逆に回す。
 * 🔑 辺の判定(`nearestEdge`)と離した先の当たり(`topPlaceAt`)は、これを通してから回さない四角と比べる。
 */
export function unrotatePoint(r: Box, deg: number, px: number, py: number): { x: number; y: number } {
  return rotatePointAround(px, py, r.x + r.w / 2, r.y + r.h / 2, -deg);
}

/**
 * 🔴 **回した付箋の角の伸縮**(設計 §4.2 #5)── 掴んだのは付箋の右下の角。
 *
 * 手の動き `(dx, dy)` を**付箋の向きへ逆に回して**から `w` `h` に足す(90° 回した付箋で右へ引くと、付箋の向きでの幅が伸びる)。
 * ⚠ 中心の周りで回っているので `w` `h` だけ変えると**反対側の角が動く** ── PowerPoint と同じに、
 *   付箋の左上の角(掴んだ角の反対側)が**画面で動かない**ように `x` `y` も返す。
 * ⚠ 下限(`minW` `minH`)で止まったときも、実際に伸びた分で左上を固定する(下限を越えて引いても角が飛ばない)。
 * ⚠ `x` `y` は 0 を下回れない(記法の下限)。下回るときは**丸めず、伸び縮みの量(dw dh)を同じ比で手前まで減らす** ──
 *   丸めると左上の角が画面で飛ぶ(90° で x=30 から +100 引くと 70px)。減らした分、付箋は引いた量より少なく伸びる。
 */
export function resizeRotated(
  start: Box,
  deg: number,
  dx: number,
  dy: number,
  min: { readonly w: number; readonly h: number },
): Box {
  const { sin, cos } = sinCos(deg);
  // 画面の動きを付箋の向きへ(逆回し)
  const ldx = dx * cos + dy * sin;
  const ldy = -dx * sin + dy * cos;
  const w = Math.max(min.w, start.w + ldx);
  const h = Math.max(min.h, start.h + ldy);
  let dw = w - start.w;
  let dh = h - start.h;
  // 中心の移動 = 付箋の向きでの (dw/2, dh/2) を回した物。左上の角 = 中心 − (w/2, h/2) を回した物が不動になる
  // x' = x + dw·(cos−1)/2 − dh·sin/2 / y' = y + dw·sin/2 + dh·(cos−1)/2(dw dh について線形)
  const ax = (dw * (cos - 1)) / 2 - (dh * sin) / 2;
  const ay = (dw * sin) / 2 + (dh * (cos - 1)) / 2;
  let t = 1;
  if (ax < 0 && start.x + ax < 0) t = Math.min(t, start.x / -ax);
  if (ay < 0 && start.y + ay < 0) t = Math.min(t, start.y / -ay);
  if (t < 1) {
    dw *= t;
    dh *= t;
  }
  const cxMove = (dw / 2) * cos - (dh / 2) * sin;
  const cyMove = (dw / 2) * sin + (dh / 2) * cos;
  return {
    // ⚠ 丸めの誤差(−1e-13)だけを 0 へ寄せる ── 上で手前に止めてあるので、ここで角は飛ばない
    x: Math.max(0, start.x - dw / 2 + cxMove),
    y: Math.max(0, start.y - dh / 2 + cyMove),
    w: start.w + dw,
    h: start.h + dh,
  };
}
