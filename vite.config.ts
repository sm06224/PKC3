/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { swPlugin } from './build/sw-plugin.ts';
import { bodyCssPlugin } from './build/body-css-plugin.ts';

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
 * ⚠ 本番(静的ホスティング)は**サーバ側で同じ 2 つを返す**か、
 *   返せないホスト(GitHub Pages 等)では service worker で被せる必要がある。
 */
const COI_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
} as const;

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
  // それには COOP/COEP が要る。⚠ **`crossOriginIsolated` は最上位文書の性質**なので、
  // 「iframe だけ分離する」ことはできない ── 本体に付けるしかない。
  //
  // 🔑 **`credentialless` を選ぶ**(2026-08-10 実測):
  //
  //   | COEP            | isolated | SharedArrayBuffer | 外部画像(CORP 無し) |
  //   |-----------------|----------|-------------------|----------------------|
  //   | (なし)          | false    | ✕                 | OK                   |
  //   | require-corp    | true     | ✓                 | **BLOCKED**          |
  //   | credentialless  | **true** | **✓**             | **OK**               |
  //
  // ⚠ `require-corp` にすると **CORP を返さない外部画像が全部消える** ──
  // 「外部画像の同意」機能がそのまま死ぬ。`credentialless` は資格情報を落として
  // no-cors 取得を許すので、両立する。
  // ⚠ ただし `credentialless` に対応しないブラウザでは分離が成立しない
  //   ── その環境は **Office 以外は全部動く**(README の対応表)。
  //
  // ⚠ **dev / preview の両方に要る**。preview は smoke(`tests/smoke`)が使うので、
  //   片方だけだと「手元で通って CI で落ちる」型の食い違いを自分で作ることになる。
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
