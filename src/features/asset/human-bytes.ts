/**
 * 🔴 **人が読む「大きさ」は 1 か所で作る**(#454)。
 *
 * ⚠ 直す前は**同じ実装が 2 本**在った ── `features/markdown/fence-asset.ts` の
 *   `formatBytes` と `features/asset/image-shrink.ts` の `humanBytes` が
 *   **1 バイトも違わない**同じ関数で、しかも後者の docstring には
 *   「**画面と test で書き直さないよう 1 か所に置く**」と書いてあった
 *   (書いてあるのに 2 本ある、が実態だった ── CLAUDE.md §7)。
 *
 * ⚠ **もう 1 本ある**(`features/storage/storage-profile.ts` の `formatBytes`)。
 *   あちらは **`512 B` / `2.0 KB`** と**形が違う**ので、寄せると user に見える
 *   変化になる ── **どちらへ寄せるかは #454 で user に出してある**。
 *   ここでは**同じ形の 2 本だけ**を 1 本にした(見た目は 1 ピクセルも変わらない)。
 *
 * ⚠ **pure module**。⚠ 桁を揃えるより**読めること**を優先する。
 */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
