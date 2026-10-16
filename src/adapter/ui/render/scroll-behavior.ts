/**
 * スクロールの動かし方(滑らか / 即時)を 1 か所で決める。
 *
 * 🔑 OS の「視差効果を減らす」(`prefers-reduced-motion: reduce`)を出している人には、
 *   滑らかなスクロールを使わず即時に動かす。`matchMedia` が無い環境(古い環境 / 一部の test)は滑らかのまま。
 */
export function preferredScrollBehavior(): ScrollBehavior {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'smooth';
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
