/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// base './' — Pages の / と /dev/ の両方で同一ビルドが動く相対パス配信
export default defineConfig({
  base: './',
  // @sqlite.org/sqlite-wasm は pre-bundle すると worker/wasm 解決が壊れる(公式指示)
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@features': fileURLToPath(new URL('./src/features', import.meta.url)),
      '@adapter': fileURLToPath(new URL('./src/adapter', import.meta.url)),
      '@runtime': fileURLToPath(new URL('./src/runtime', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    // 🔴 **product では map を出さない**(P7 §5-2、user 委任 2026-08-02)。
    // 生成物の 2/3(3.2MB)が map で、Pages の配信量・SW の precache 量に
    // そのまま乗る ── 「速く、安く」に真っ向から反する。
    // ⚠ 調査手段は失わない: `/dev/` は**同じ commit**を map つきで焼いたもの。
    // 本番のスタックトレースは dev 版 URL で再現してもらう。
    // ⚠ 「同じコード」ではない ── `BUILD_KIND`(`import.meta.env.VITE_PKC_KIND`)が
    // bundle に焼き込まれるので entry chunk の中身も content hash も kind ごとに違う。
    // **product の map を dev の map で読み替えることはできない**(縮小コードは
    // 実質 1 行で、刻印のぶんカラムが十数ずれる ── レビュー M-1 で実測)
    sourcemap: process.env.VITE_PKC_KIND !== 'product',
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
  },
});
