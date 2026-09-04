/**
 * 🔴 **可搬単一 HTML の実験用ビルド**(#400、まず成立するかを測る)。
 *
 * ⚠ **本番の `dist` は 1 バイトも変えない** ── 単一化は worker の作り方・
 *   asset の埋め込み方を変えるので、通常の配信に混ぜると全 user に効く。
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { bodyCssPlugin } from './body-css-plugin.ts';
import { manualPagePlugin } from './manual-page-plugin.ts';

export default defineConfig({
  base: './',
  // 🔴 `manual.html` もここで焼く(#648 段③)── `fold.mjs` が 1 枚の中へ焼き込む。
  //    ⚠ 外すと fold が「畳む前にマニュアルの page が焼かれていない」で止まる(黙って落ちない)
  plugins: [manualPagePlugin(), bodyCssPlugin()],
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('../src/core', import.meta.url)),
      '@features': fileURLToPath(new URL('../src/features', import.meta.url)),
      '@adapter': fileURLToPath(new URL('../src/adapter', import.meta.url)),
      '@runtime': fileURLToPath(new URL('../src/runtime', import.meta.url)),
    },
  },
  worker: { format: 'iife' },
  build: {
    target: 'es2022',
    sourcemap: false,
    outDir: 'dist-portable',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
