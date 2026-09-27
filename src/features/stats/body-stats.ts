/**
 * 🔴 ノートの文字数と読了目安時間の計算・整形 (#1112)。
 *
 * ## user がやりたいこと
 *
 * 情報ペイン（インスペクター）で、いま開いているノートの規模感
 * （文字数と読むのにかかる時間の目安）を一目で把握したい。
 *
 * ## 規律
 *
 * 1. 🔑 **pure module**: DOM やエディタを知らない。
 * 2. 🔑 **読書速度の基準**: 日本語の一般的な読書速度（400〜600字/分、標準 500字/分）。
 * 3. 🔑 **1文字以上のときは最低 1 分**: わずかでも本文があれば「約 1 分」と表示する。
 */

/** 日本語の一般的な読書速度（文字/分）。 */
export const READING_SPEED_CPM = 500;

/**
 * 本文文字数から読了目安時間（分）を計算する。
 * 0 文字以下のときは 0 分、1 文字以上のときは最低 1 分（切り上げ）。
 */
export function estimateReadingMinutes(chars: number, cpm: number = READING_SPEED_CPM): number {
  if (chars <= 0) return 0;
  return Math.max(1, Math.ceil(chars / cpm));
}

/**
 * 情報ペイン等に表示する文字数と読了目安の文字列を組み立てる。
 *
 * 例:
 * - `chars === null` → `'—'`
 * - `chars === 0` → `'0 文字'`
 * - `chars === 450` → `'450 文字 (読了 約 1 分)'`
 * - `chars === 2500` → `'2,500 文字 (読了 約 5 分)'`
 */
export function formatBodyStats(chars: number | null): string {
  if (chars === null) return '—';
  if (chars <= 0) return '0 文字';
  const formattedChars = chars.toLocaleString('ja-JP');
  const minutes = estimateReadingMinutes(chars);
  return `${formattedChars} 文字 (読了 約 ${minutes} 分)`;
}
