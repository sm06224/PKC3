/**
 * 🔴 **輪郭の近接発光(ネオン)の「どのカードが近いか」**(B2)── pure(DOM も browser API も触らない)。
 *
 * ポインタ(`x`, `y`)から**半径 `radius` 以内**にあるカードだけを返し、各カードの**局所座標**(カードの左上を原点とした px)を添える。
 * 局所座標は CSS の `radial-gradient(circle … at var(--gx) var(--gy))` の中心になる。
 *
 * - 距離は**矩形までの最短距離**(ポインタが矩形の中なら 0)。**ちょうど半径**は近い側に入る(境界は含む)。
 * - 矩形の測り直しは重い(レイアウトを強いる)ので、`createRectCache` が**汚れの印**で持つ ── 印が立つまで測り直さない。
 *   測り直しは「次のポインタのコマ」だけ(変更のたびに同期で測らない)。
 */

/** カードの矩形(viewport 座標。`DOMRect` の部分集合)。 */
export interface CardRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface NearCard {
  /** 渡した矩形の並びでの位置。 */
  readonly index: number;
  /** カードの左上を原点にしたポインタの座標(px。整数に丸める)。 */
  readonly gx: number;
  readonly gy: number;
}

/** ゾーンごとの光の半径(px)。⚠ `app.css` の `--neon-r`(`circle` の半径)と揃える ── `tests/adapter/neon-glow.test.ts` が突き合わせる。 */
export const NEON_RADIUS = { log: 160, inspector: 160, rail: 56 } as const;

/** ポインタから矩形までの最短距離の 2 乗。 */
export function distanceSqToRect(r: CardRect, x: number, y: number): number {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return dx * dx + dy * dy;
}

/** 半径内のカードと局所座標。 */
export function nearCards(rects: readonly CardRect[], x: number, y: number, radius: number): NearCard[] {
  const out: NearCard[] = [];
  const rr = radius * radius;
  for (let index = 0; index < rects.length; index += 1) {
    const r = rects[index]!;
    if (distanceSqToRect(r, x, y) > rr) continue;
    out.push({ index, gx: Math.round(x - r.left), gy: Math.round(y - r.top) });
  }
  return out;
}

/** 光らせてよいか ── 環境の問い(`GLOW_QUERY`)が真で、スマホ用画面でないこと。⚠ 判定はここ 1 か所(全ゾーン共通)。 */
export function mayGlow(queryMatches: boolean, phone: boolean): boolean {
  return queryMatches && !phone;
}

export interface RectCache<T> {
  /** 汚す(次の `get` で測り直す)。同期で測らない。 */
  markDirty(): void;
  /** 汚れていれば測り直して返す。汚れていなければ前回の値(測らない)。 */
  get(): readonly T[];
  /** 捨てる(次の `get` は測り直す)。 */
  reset(): void;
}

/** 矩形の入れ物。`measure` は汚れているときだけ呼ばれる。 */
export function createRectCache<T>(measure: () => T[]): RectCache<T> {
  let value: T[] = [];
  let dirty = true;
  return {
    markDirty: () => {
      dirty = true;
    },
    get: () => {
      if (dirty) {
        value = measure();
        dirty = false;
      }
      return value;
    },
    reset: () => {
      value = [];
      dirty = true;
    },
  };
}
