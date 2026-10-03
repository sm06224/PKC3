import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { Plugin } from 'vite';
import { COI_HEADERS } from '../src/adapter/platform/sw/coi-headers.ts';

/**
 * 🔴 **PDF を PKC の画面で読む窓の部品(pdf.js)を、precache に載せずに配る**(#275 段①)。
 *
 * ## なぜこの形か(DuckDB の `duckdb-assets-plugin.ts` と同じ向き)
 *
 * 裁定(Gemini、#275):設定で**選んだ人だけ**が PKC の画面で PDF を読む。既定はブラウザ内蔵の表示。
 * だから pdf.js 本体と日本語の cmap(合わせて数 MB)は**選んだ人が押したときだけ取りに行く**物で、
 * 全員が install で落とす precache に載せない(`shouldPrecache` が `pdf/lib/` を外す)。
 * 🔑 窓の小さな HTML / JS(`public/pdf/` 直下の 6 file)は**precache に載る** ── 載せないと、オフラインで窓を開いたとき
 *   service worker が `index.html` へ退避して**PKC をもう 1 枚開く**(マニュアルの窓と同じ穴)。載せておけば
 *   窓は開き、本体(`lib/`)が取れなくても**内蔵の表示へ自動で退避**する。
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
 * ## dev server でも配る
 *
 * `vite dev` は bundle を作らないので `generateBundle` が走らない。`configureServer` が**同じ一覧**
 * (`pdfLibFiles`)から `node_modules` の実 file をそのまま返す(写しを作らない)。
 *
 * ## ⚠ この plugin が置く物を消したら鳴る所
 *
 * - `shouldPrecache`(`src/adapter/platform/sw/sw-source.ts`)が `pdf/lib/` を**外す**
 * - `scripts/dist-inspect.mjs` が **別立ての予算と、在るべき file の集合**で見る
 *   (外したぶんの門を置き直す ── 外した瞬間、この中身は 0 バイトでも 100 MB でも通る)
 */

/**
 * 配る先の接頭辞(= pdf.js の実体を置く所)。⚠ 綴りの正本はここ(`PDF_PRECACHE_SKIP` /
 * `dist-inspect.mjs` の `PDF_DIR` と突合)。⚠ `public/pdf/reader.js` が `./lib/` で読む。
 */
export const PDF_DIR = 'pdf/lib/';

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

/** pdf.js の実体の置き場(`node_modules/pdfjs-dist/`)。⚠ `package.json` の `exports` を通らず、実在する file から割り出す。 */
function pdfjsRoot(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('pdfjs-dist/build/pdf.min.mjs')).replace(/[\\/]build$/, '');
}

/**
 * 配る file の一覧(`pdf/lib/` からの相対 → `node_modules` の実 path)。
 *
 * 🔑 **build(`generateBundle`)と dev(下の `pdfLibMiddleware`)が同じ 1 本から引く** ── 配る物の規則を 2 か所に
 *   持たない。dev のために写しを作る(重複コピー)のではなく、**同じ実 path をそのまま返す**。
 * ⚠ 上流の構成が変わって 0 件になったら、黙って空を配らず落とす。
 */
export function pdfLibFiles(): Map<string, string> {
  const root = pdfjsRoot();
  const out = new Map<string, string>();
  for (const [from, to] of SINGLE) out.set(to, join(root, from));
  for (const { dir, keep } of TREES) {
    const names = readdirSync(join(root, dir)).filter(keep);
    if (names.length === 0) throw new Error(`pdf: ${dir}/ に配る物が 1 つも無い`);
    for (const name of names) out.set(`${dir}/${name}`, join(root, dir, name));
  }
  return out;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

/**
 * 🔴 **`vite dev` でも `pdf/lib/` を配る**(#275 段①の残り)。
 *
 * ⚠ build は `generateBundle` で `dist/pdf/lib/` へ写すが、**dev server は bundle を作らない**ので、
 *   窓(`public/pdf/host.html`)が `./lib/pdf.min.mjs` を取りに行くと 404(SPA の退避で HTML が返る形もある)になり、
 *   窓が毎回「読めなかった」扱いで内蔵の表示へ退避する ── `npm run dev` で PDF の窓を触れない。
 * 🔑 dev は**写さず、`node_modules` の実 file をそのまま返す**(`public/` へ置かない理由と同じ ── 数 MB を追跡しない)。
 * ⚠ 返す物は `pdfLibFiles` が言う file だけ(任意の path を `node_modules` から返さない)。
 * ⚠ 分離のヘッダ(COOP/COEP)を**自分の応答にも付ける** ── 窓の解析 worker は COEP の下では
 *   worker の応答自身にも COEP が要る(`server.headers` は別の経路の応答にしか付かない)。
 */
export function pdfLibMiddleware(): (
  req: { url?: string },
  res: { setHeader(k: string, v: string): void; statusCode: number; end(b?: Buffer): void },
  next: () => void,
) => void {
  let files: Map<string, string> | null = null;
  return (req, res, next) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    // ⚠ 安い門を先に ── `/pdf/lib/` 以外は一覧を読まずに通す
    if (!path.startsWith(`/${PDF_DIR}`)) {
      next();
      return;
    }
    files ??= pdfLibFiles();
    let rel: string;
    try {
      rel = decodeURIComponent(path.slice(PDF_DIR.length + 1));
    } catch {
      next();
      return;
    }
    const real = files.get(rel);
    if (real === undefined) {
      next();
      return;
    }
    for (const [k, v] of Object.entries(COI_HEADERS)) res.setHeader(k, v);
    res.setHeader('Content-Type', CONTENT_TYPES[extname(rel)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.statusCode = 200;
    res.end(readFileSync(real));
  };
}

export function pdfAssetsPlugin(): Plugin {
  return {
    name: 'pkc-pdf-assets',
    configureServer(server) {
      server.middlewares.use(pdfLibMiddleware());
    },
    generateBundle() {
      for (const [rel, real] of pdfLibFiles()) {
        const source = readFileSync(real);
        /**
         * ⚠ **空振り防止** ── 上流が名前を変えた日に、ここが黙って 0 バイトを配ると
         *   「窓は開くのに何も読めない」という、いちばん遠い所で出る壊れ方になる。
         */
        if (source.byteLength === 0) throw new Error(`pdf: ${rel} が 0 バイト`);
        this.emitFile({ type: 'asset', fileName: `${PDF_DIR}${rel}`, source });
      }
    },
  };
}
