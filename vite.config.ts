/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { swPlugin } from './build/sw-plugin.ts';
import { bodyCssPlugin } from './build/body-css-plugin.ts';
import { COI_HEADERS as SHARED_COI_HEADERS } from './src/adapter/platform/sw/coi-headers.ts';

/**
 * cache 名に入れる build id。
 *
 * 🔴 **中身から作る**(review M-1)。`GITHUB_SHA` を使うと、product のバイト列が
 * 1 バイトも変わっていなくても main への push のたびに `sw.js` だけが変わり、
 * **全 user が 1.6MB を再ダウンロードして再 precache する**(北極星「速く、安く」に
 * 直接反する)。precache 一覧は hash 付きファイル名を含むので、**一覧が同じ =
 * 配る物が同じ** ── それを id にすれば「変わったときだけ更新」が自然に成り立つ。
 */
export const buildIdFor = (precache: readonly string[]): string =>
  createHash('sha256').update(JSON.stringify([...precache].sort())).digest('hex').slice(0, 12);

/**
 * cross-origin isolation のヘッダ。dev / preview の両方に同じものを配る。
 *
 * 🔴 **本番(GitHub Pages)はヘッダを返せないので、service worker が被せる**
 * (`src/adapter/platform/sw/sw-source.ts`)。ここは 2026-08-11 まで
 * 「返せないホストでは SW で被せる必要がある」と**書いてあるだけ**で、
 * その分が無かった ── 手元(preview)だけ分離が成立し、**本番だけが
 * 構造的に動かない**状態を smoke ごと素通りさせた(#111)。
 *
 * ⚠ したがって綴りは**共有の定数から取る**。ここに直書きすると、dev と本番で
 * 静かにずれる ── この repo は同じ形(一覧が 2 か所)で 1 度壊している。
 */
const COI_HEADERS: Record<string, string> = { ...SHARED_COI_HEADERS };

// base './' — Pages の / と /dev/ の両方で同一ビルドが動く相対パス配信
export default defineConfig({
  base: './',
  // ⚠ bodyCssPlugin は `apply` を付けない ── dev / build / **vitest** の 3 つで
  //    同じものを配る必要がある(test だけ virtual module が解決できないと、
  //    書き出し HTML の検査が丸ごと動かない)
  plugins: [swPlugin(buildIdFor), bodyCssPlugin()],
  // 🔴 **crossOriginIsolated を成立させる**(#88 O2 の前提)。
  //
  // Office(LibreOffice wasm)は `-pthread` = SharedArrayBuffer を要求し、
  // それには COOP/COEP が要る。⚠ **なぜ `credentialless` なのか**(外部画像との
  // 両立を実測して選んだ表)は `src/adapter/platform/sw/coi-headers.ts` に在る
  // ── ここには写さない。
  //
  // ⚠ **dev / preview の両方に要る**。preview は smoke(`tests/smoke`)が使うので、
  //   片方だけだと「手元で通って CI で落ちる」型の食い違いを自分で作ることになる。
  // ⚠ そして **preview で通ることは本番の保証にならない**(#111 で踏んだ)──
  //   本番は SW が被せるので、その経路は `tests/smoke/coi.smoke.spec.ts` が
  //   **ヘッダを返さない server** を別に立てて見ている。
  server: { headers: COI_HEADERS },
  preview: { headers: COI_HEADERS },
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
