import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import {
  DUCKDB_ENGINE,
  DUCKDB_EXTENSIONS,
  duckDbExtensionPath,
} from '../src/features/query/duckdb-pack.ts';

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

/**
 * 🔴 **拡張は `node_modules` に 1 件も無い**(#682 段④b。実測 2026-09-16)。
 *
 * 出どころは `extensions.duckdb.org` だけで、npm にも package が無い(3 つ試して 404)。
 * ⚠ そして**開発の箱からは出られない**(403)── だから **repo に置いてある**。
 * 由来と sha256 は `vendor/duckdb-extensions/README.md`。
 */
const VENDOR_DIR = 'vendor/duckdb-extensions';

/**
 * 🔴 **版が器と食い違ったら、ここで落とす**(#682 段④b)。
 *
 * ⚠ 拡張は **engine の版と完全一致**でなければ読み込めないが、こちらが上げるのは
 *   **npm の `@duckdb/duckdb-wasm`** である ── 2 つは別々に動くので、
 *   🔴 **npm を上げた日に `vendor/` が黙って古くなる**のがいちばん危ない。
 *   その壊れ方は「user が parquet を開こうとした日に、初めて分かる」形で出る。
 *
 * 🔑 検算できる観測点が 1 つある:**engine は拡張の URL を自分で組む**ので、
 *   版と台の名前は**配る wasm の中に字として実在する**(実測 2026-09-16:
 *   `v1.5.4` が 1 件 / `wasm_eh` が 1 件)。だから**それを突き合わせる**。
 *
 * ⚠ 「在るか」だけでなく**空振りしていないこと**も見る ── でたらめな版が
 *   当たらないことまで見ないと、`includes` が常に真になる作りに気づけない。
 */
function assertEngineMatches(wasm: Buffer): void {
  const text = wasm.toString('latin1');
  for (const want of [DUCKDB_ENGINE.version, DUCKDB_ENGINE.platform]) {
    if (!text.includes(want)) {
      throw new Error(
        `duckdb: 配る duckdb-eh.wasm の中に「${want}」が無い ── `
          + 'engine の版が上がったのに vendor/duckdb-extensions がそのままになっている。'
          + ' 拡張を取り直して DUCKDB_ENGINE を直すこと(vendor/duckdb-extensions/README.md)',
      );
    }
  }
  // ⚠ **空振り防止** ── 在りえない字が「在る」と出るなら、この突合は何も見ていない
  if (text.includes('v0.0.0-pkc-never')) {
    throw new Error('duckdb: 版の突合が空振りしている(在りえない字が見つかった)');
  }
}

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

      const emit = (packPath: string, source: Buffer): { path: string; bytes: number } => {
        /**
         * ⚠ **空振り防止** ── 上流が名前を変えた日に、ここが黙って 0 バイトを
         * 配ると「取ってきたのに動かない」という、いちばん遠い所で出る壊れ方になる。
         */
        if (source.byteLength === 0) throw new Error(`duckdb: ${packPath} が 0 バイト`);
        this.emitFile({ type: 'asset', fileName: `${DUCKDB_DIR}${packPath}`, source });
        return { path: packPath, bytes: source.byteLength };
      };

      const files = SHIPPED.map((name) => {
        const source = readFileSync(join(distDir, name));
        // 🔴 版の突合は**配る wasm そのもの**で行う(`node_modules` の別の file ではなく)
        if (name.endsWith('.wasm')) assertEngineMatches(source);
        return emit(name, source);
      });

      /**
       * 🔴 **拡張を同じ配り先へ足す**(#682 段④b)。
       * ⚠ `ext/` の下へ置く ── 起動に要る 2 つと混ぜない(読み手が数え分けられる)。
       */
      for (const name of DUCKDB_EXTENSIONS) {
        const packPath = duckDbExtensionPath(name);
        const from = join(
          VENDOR_DIR,
          DUCKDB_ENGINE.version,
          DUCKDB_ENGINE.platform,
          `${name}.duckdb_extension.wasm`,
        );
        let source: Buffer;
        try {
          source = readFileSync(from);
        } catch {
          /**
           * ⚠ **黙って配らない** ── ここを飲むと、拡張の無い一式が配られ、
           *   症状は「parquet を開いた人だけ落ちる」という遠い所で出る。
           */
          throw new Error(
            `duckdb: 拡張が見つからない(${from})── vendor/duckdb-extensions/README.md の`
              + '「取り直し方」を見ること',
          );
        }
        files.push(emit(packPath, source));
      }

      this.emitFile({
        type: 'asset',
        fileName: DUCKDB_PACK,
        source: `${JSON.stringify({ version, files }, null, 2)}\n`,
      });
    },
  };
}
