import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * 🔴 **PDF を PKC の画面で読む窓の部品(pdf.js)を、precache に載せずに配る**(#275 段①)。
 *
 * ## なぜこの形か(DuckDB の `duckdb-assets-plugin.ts` と同じ向き)
 *
 * 裁定(Gemini、#275):設定で**選んだ人だけ**が PKC の画面で PDF を読む。既定はブラウザ内蔵の表示。
 * だから pdf.js 本体と日本語の cmap(合わせて数 MB)は**選んだ人が押したときだけ取りに行く**物で、
 * 全員が install で落とす precache に載せない(`shouldPrecache` が `pdf/` を外す)。
 * ⚠ 「配る量は気にしない」(不可侵指示 2026-08-03)は**全員が使う物**の話で、
 *   選んだ人だけが使う物を全員へ配ってよい理由にはならない。
 *
 * ## なぜ `public/` に置かないか
 *
 * `public/` は git に入る ── 数 MB の minified JS と cmap を追跡することになる。
 * 🔑 だから **build のたびに `node_modules/pdfjs-dist` から写す**(窓の HTML / 小さな JS だけが
 * `public/pdf/` に在る)。
 *
 * ## 何を配るか
 *
 * | 配る | 理由 |
 * |---|---|
 * | `legacy/build/pdf.min.mjs` + `legacy/build/pdf.worker.min.mjs` | 本体と解析 worker(窓の中で動く。⚠ `legacy` の版 ── 下の `SINGLE` の注記) |
 * | `cmaps/*.bcmap` | 日本語など非 Latin の文字の対応表(無いと日本語の PDF が読めない) |
 * | `standard_fonts/*` | 埋め込みの無い標準書体の代替 |
 * | `wasm/{jbig2,openjpeg,qcms_bg}.wasm` | 画像の復号(スキャンの PDF) |
 *
 * ⚠ 配らない物: `*.map`(2〜5 MB。調査手段は dev の同じ版で足りる)/ `iccs/` /
 *   `web/`(viewer の UI。窓は自前で描く)/ `legacy/` の**他の部品**(image_decoders / web)/ スクリプト実行の QuickJS(PDF の中の
 *   JavaScript は**動かさない**)/ wasm が使えない環境向けの `*_nowasm_fallback.js`。
 *
 * ## ⚠ この plugin が置く物を消したら鳴る所
 *
 * - `shouldPrecache`(`src/adapter/platform/sw/sw-source.ts`)が `pdf/` を**外す**
 * - `scripts/dist-inspect.mjs` が **別立ての予算と、在るべき file の集合**で見る
 *   (外したぶんの門を置き直す ── 外した瞬間、この中身は 0 バイトでも 100 MB でも通る)
 */

/** 配る先の接頭辞。⚠ 綴りの正本はここ(`PDF_PRECACHE_SKIP` / `dist-inspect.mjs` の `PDF_DIR` と突合)。 */
export const PDF_DIR = 'pdf/';
/** pdf.js の実体を置く下位の所。⚠ `public/pdf/reader.js` が `./lib/` で読む。 */
export const PDF_LIB = `${PDF_DIR}lib/`;

/** 単体で写す file(`node_modules/pdfjs-dist/` からの相対 → `pdf/lib/` からの相対)。 */
const SINGLE: ReadonlyArray<readonly [string, string]> = [
  // 🔴 **`legacy/` の版を配る**(実測 2026-10-02)── 素の版(`build/`)は `Map.prototype.getOrInsertComputed`
  //    (ES の新しい機能)を**そのまま呼ぶ**ので、持たないブラウザでは**頁が 1 枚も描けない**
  //    (手元の Chromium 141 で `getOrInsertComputed is not a function`)。`legacy/` の版は
  //    その手当てを抱えており、**増えるのは +110 KB だけ**(本体 +60 KB / worker +52 KB)。
  //    ⚠ 解析の worker も同じ事情なので、**本体と worker は必ず同じ側から**写す(混ぜると版が食い違う)。
  ['legacy/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['LICENSE', 'LICENSE'],
];

/** 下の階層ごと写す物。 */
const TREES: ReadonlyArray<{ readonly dir: string; readonly keep: (name: string) => boolean }> = [
  { dir: 'cmaps', keep: (n) => n.endsWith('.bcmap') || n === 'LICENSE' },
  { dir: 'standard_fonts', keep: () => true },
  {
    dir: 'wasm',
    keep: (n) => n === 'jbig2.wasm' || n === 'openjpeg.wasm' || n === 'qcms_bg.wasm' || n.startsWith('LICENSE'),
  },
];

export function pdfAssetsPlugin(): Plugin {
  return {
    name: 'pkc-pdf-assets',
    apply: 'build',
    generateBundle() {
      const require = createRequire(import.meta.url);
      // ⚠ `package.json` の `exports` を通らず、実在する file から場所を割り出す
      const root = dirname(require.resolve('pdfjs-dist/build/pdf.min.mjs')).replace(/[\\/]build$/, '');
      const emit = (rel: string, source: Buffer): void => {
        /**
         * ⚠ **空振り防止** ── 上流が名前を変えた日に、ここが黙って 0 バイトを配ると
         *   「窓は開くのに何も読めない」という、いちばん遠い所で出る壊れ方になる。
         */
        if (source.byteLength === 0) throw new Error(`pdf: ${rel} が 0 バイト`);
        this.emitFile({ type: 'asset', fileName: `${PDF_LIB}${rel}`, source });
      };
      for (const [from, to] of SINGLE) emit(to, readFileSync(join(root, from)));
      for (const { dir, keep } of TREES) {
        const names = readdirSync(join(root, dir)).filter(keep);
        // ⚠ 0 件なら上流の構成が変わっている ── 黙って空の階層を配らない
        if (names.length === 0) throw new Error(`pdf: ${dir}/ に配る物が 1 つも無い`);
        for (const name of names) emit(`${dir}/${name}`, readFileSync(join(root, dir, name)));
      }
    },
  };
}
