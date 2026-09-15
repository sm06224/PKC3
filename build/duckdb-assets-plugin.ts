import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * 🔴 **DuckDB の実体を、precache に載せずに配る**(#682 段①。裁定 2026-09-15 = 案 A)。
 *
 * ## なぜこの形か
 *
 * user 裁定(解釈):DuckDB も sqlite や Office と同じように**オフラインで使える**こと。
 * そのうえで PKC3 の柱(**勝手に外へ出ない**)を崩さないこと。
 *
 * ⚠ duckdb-wasm の素の姿は**実行時に外の CDN へ取りに行く**ので、そのままでは
 * **オフラインで死ぬ**と**外へ出る**の両方に当たる。だから **PKC3 自身が配る** ──
 * ⚠ ただし **Office とは配信経路を分ける**(相乗りすると、片方が落ちたとき道連れになる)。
 *
 * ## なぜ precache に載せないか(実測 2026-09-15)
 *
 * | | 値 |
 * |---|---|
 * | いま precache に載っている量 | **137 file / 8.2 MiB** |
 * | ここで足す量 | **約 35 MiB** |
 *
 * 🔑 載せると **8.2 → 43 MiB** になり、**DuckDB を選ばない user が 5.2 倍を払う**。
 * ⚠ 「配る量は気にしない」(不可侵指示 2026-08-03)は**全 user が使う物**の話であって、
 * **選んだ人だけが使う物**を全員へ配ってよい理由にはならない。
 *
 * ## なぜ `public/` に置かないか
 *
 * `public/` は git に入る ── **34.3 MiB の wasm を追跡することになる**。
 * 🔑 だから **build のたびに node_modules から写す**(`katex-woff2-plugin.ts` と同じ向き:
 * 上流の実体を、配る形へこちらで整える)。
 *
 * ## ⚠ この plugin が置く物を消したら鳴る所
 *
 * - `shouldPrecache`(`src/adapter/platform/sw/sw-source.ts`)が `duckdb/` を**外す**
 * - `scripts/dist-inspect.mjs` が **別立ての予算**で見る(外したぶんの門を置き直す ──
 *   外した瞬間、この file は **0 バイトでも 100 MB でも通る**ようになる)
 */

/** 配る先の接頭辞。⚠ 綴りの正本はここ ── 読み手は `DUCKDB_DIR` を import する。 */
export const DUCKDB_DIR = 'duckdb/';

/** 目録の file 名(Office の `pack.json` と同じ役目)。 */
export const DUCKDB_PACK = `${DUCKDB_DIR}pack.json`;

/**
 * 配る実体。⚠ **素の版(`eh`)だけ**を配る ── スレッド版(`coi`)は実測で
 * 遅く・重く・壊れやすかった(設計 doc §5)。`mvp` は `eh` が使えない
 * 古いブラウザ向けで、PKC3 の対象には居ない。
 */
const SHIPPED = ['duckdb-eh.wasm', 'duckdb-browser-eh.worker.js'] as const;

export function duckdbAssetsPlugin(): Plugin {
  return {
    name: 'pkc-duckdb-assets',
    apply: 'build',
    generateBundle() {
      const require = createRequire(import.meta.url);
      /**
       * ⚠ **`package.json` は引けない** ── 上流の `exports` が公開していない
       *   （`Package subpath './package.json' is not defined by "exports"`）。
       * 🔑 公開されている `dist/…` から場所を割り出し、版は
       *   **素の fs で読む**（`exports` は import の道だけを塞ぐ）。
       */
      const distDir = dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'));
      const version = (
        JSON.parse(readFileSync(join(distDir, '..', 'package.json'), 'utf-8')) as {
          version: string;
        }
      ).version;

      const files = SHIPPED.map((name) => {
        const source = readFileSync(join(distDir, name));
        /**
         * ⚠ **空振り防止** ── 上流が名前を変えた日に、ここが黙って 0 バイトを
         * 配ると「取ってきたのに動かない」という、いちばん遠い所で出る壊れ方になる。
         */
        if (source.byteLength === 0) throw new Error(`duckdb: ${name} が 0 バイト`);
        this.emitFile({ type: 'asset', fileName: `${DUCKDB_DIR}${name}`, source });
        return { path: name, bytes: source.byteLength };
      });

      this.emitFile({
        type: 'asset',
        fileName: DUCKDB_PACK,
        source: `${JSON.stringify({ version, files }, null, 2)}\n`,
      });
    },
  };
}
