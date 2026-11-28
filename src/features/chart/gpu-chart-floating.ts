/**
 * 🔴 **上端に固定したグラフの「実描画」と「見た目」を分ける**(v4.2 Phase 0 / PR-1)。
 *
 * 上端に固定(`sticky`)した連動グラフは、本文を読む邪魔にならないよう**縮小した絵**で見せ、
 * 押すと**実描画の大きさ**まで広げる(もう一度で縮小に戻す ── 片道にしない)。
 *
 * 🔑 **実描画は縮めない** ── 描く論理解像度は常に本来の `(renderW, renderH)` のまま。見た目だけを
 *   `transform: scale(<scale>)` で縦横比を保って縮める(字や線の比率が崩れない)。
 *   ⚠ かつては描画面の縦だけを `max-height: 32vh` で押し潰していた(縦横比が崩れ、それでも上部を大きく占めた)。
 *
 * ここは DOM を持たない純関数(adapter の `gpu-chart-bound.ts` が使う)。
 */

/** 縮小したときの見た目の高さ(既定・下限・上限。CSS px)。 */
export const COMPACT_HEIGHT_DEFAULT = 140;
export const COMPACT_HEIGHT_MIN = 80;
export const COMPACT_HEIGHT_MAX = 280;
/** 倍率で直に指定するとき(`"compactScale"`)の下限・上限。 */
export const COMPACT_SCALE_MIN = 0.25;
export const COMPACT_SCALE_MAX = 0.85;

export interface CompactOptions {
  /** 縮小時の見た目の高さ(`"bind": { "compactHeight": 140 }`)。 */
  readonly compactHeight?: number;
  /** 縮小時の倍率(`"bind": { "compactScale": 0.45 }`)。⚠ 在れば `compactHeight` より優先。 */
  readonly compactScale?: number;
}

export interface CompactLayout {
  /** 見た目の倍率(0 < scale ≤ 1)。 */
  readonly scale: number;
  /** 縮小した見た目の幅・高さ(CSS px)。 */
  readonly visualW: number;
  readonly visualH: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** `"compactHeight"` を検める。読めなければ `undefined`(既定を使う)。 */
export function parseCompactHeight(v: unknown): number | undefined {
  return finite(v) && v > 0 ? Math.round(clamp(v, COMPACT_HEIGHT_MIN, COMPACT_HEIGHT_MAX)) : undefined;
}

/** `"compactScale"` を検める。読めなければ `undefined`。 */
export function parseCompactScale(v: unknown): number | undefined {
  return finite(v) && v > 0 ? clamp(v, COMPACT_SCALE_MIN, COMPACT_SCALE_MAX) : undefined;
}

/**
 * 実描画の大きさと指定から、縮小の倍率と見た目の大きさを出す。
 * - 倍率の指定があればそれ(`0.25〜0.85`)
 * - 無ければ「見た目の高さ ÷ 実描画の高さ」(見た目の高さは既定 140px、`80〜280px`)
 * - 🔑 実描画が既に見た目の高さより低いなら拡大はしない(倍率は 1 まで)
 */
export function compactLayoutOf(renderW: number, renderH: number, opts: CompactOptions = {}): CompactLayout {
  const w = finite(renderW) && renderW > 0 ? renderW : 1;
  const h = finite(renderH) && renderH > 0 ? renderH : 1;
  const byScale = parseCompactScale(opts.compactScale);
  const target = parseCompactHeight(opts.compactHeight) ?? COMPACT_HEIGHT_DEFAULT;
  const scale = byScale ?? Math.min(1, clamp(target / h, COMPACT_SCALE_MIN, 1));
  const s = Math.round(scale * 1000) / 1000;
  return { scale: s, visualW: Math.round(w * s), visualH: Math.round(h * s) };
}
