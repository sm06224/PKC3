/**
 * 🔴 **使っている OSS の表記を、`package.json` の `dependencies` から自動で焼く**
 * (#948)。
 *
 * ## なぜ手書きの一覧を作らないか
 *
 * 依存を 1 つ足した人が、表記の一覧に書き足すのを忘れても、**気づく計器が無い**。
 * だから `package.json` の `dependencies`(⚠ 件数は書かない ── 増減で古びる)を
 * **全数**読み、各 package の実物(`node_modules/<pkg>/`)から SPDX の種別と、
 * 在れば全文を集める(`collectOssNotices` が下限も含めて全部止める ── 0 件 /
 * 解決できない依存 / `license` が無い依存、どれでも `this.error` で build を止める)。
 * 🔴 **例外が 1 つだけある**(#1054 段①、下の `VENDORED_FONT_SOURCES`)── 実行時
 * import は無いが glyph データが配布物に入る devDependency は、名指しで加える。
 *
 * ## 🔴 全文が同梱されていない依存が 2 つある(実測 2026-09-15)
 *
 * `@duckdb/duckdb-wasm` と `@sqlite.org/sqlite-wasm` は、配られる npm package の
 * **直下に `LICENSE` 系 file を 1 つも持たない**(`package.json` の `license` field は
 * 在る:`MIT` / `Apache-2.0`)。⚠ **標準のひな型を当てはめて全文を捏造しない** ──
 * `text: null` のまま返し、読む側(`help.ts`)が「全文は同梱されていません」と
 * 事実だけを言う。
 *
 * ## ⚠ ここで数えない物(docstring に明記)
 *
 * LibreOffice wasm 一式(別 repo で焼く)と、DuckDB / LibreOffice が**内部で**
 * 束ねている C++ 側の依存の全数調査は、この回ではやらない。ここが数えるのは
 * `package.json` の `dependencies`(npm package)だけである ──
 * `@duckdb/duckdb-wasm` 自身は npm package なので一覧には載る。
 *
 * ## 配る形は `body-css-plugin.ts` と同じ virtual module
 *
 * `duckdb-assets-plugin.ts` のように asset として emit **しない** ── ここは
 * `help.ts` が**実行時に描画で読むデータ**なので、import で受け取れる形にする。
 *
 * 🔴 **`help.ts` がこの module を import するので、`help.ts` を `ssrLoadModule` する
 * 経路(`manual-page-plugin.ts` の `bakeWithServer`)にも、この plugin を渡す。**
 * 渡し忘れると `npm run build` が
 * `Failed to resolve import "virtual:pkc-oss-notices"` で止まる
 * (`bodyCssPlugin` が同じ理由でそこに居るのと同じ形)。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import type { OssNotice } from '../src/features/oss-notices/oss-notices.ts';

/** import 側が書く名前。 */
export const OSS_NOTICES_ID = 'virtual:pkc-oss-notices';
/** 解決後の id。⚠ 先頭の NUL は「他の plugin が触るな」の Rollup 規約。 */
const RESOLVED = '\u0000pkc-oss-notices';

/** `name` 直下に見える、ライセンスと分かる file 名かどうか。 */
const LICENSE_FILE_NAME = /^licen[cs]e(\.|$)/iu;

interface PkgJson {
  readonly name?: unknown;
  readonly license?: unknown;
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
}

/**
 * 🔴 **devDependency だが、書体の bytes が配布物に入る**もの(#1054 段①)。
 *
 * `@phosphor-icons/web` は `scripts/build-icon-font.mjs` が焼くときにしか
 * 読まれない(実行時 import は無い)ので、`dependencies` の自動収集には
 * 出てこない。⚠ それでも `src/styles/fonts/pkc-symbols.woff2` には**その
 * glyph データの部分集合**が同梱されているので、MIT の表記義務は生きている。
 *
 * 🔑 **自動収集の対象を `devDependencies` 全体へは広げない** ── eslint / vite /
 * vitest のような「build/test にしか要らない、出力に 1 bytes も残らない」道具まで
 * ライセンス一覧に混ざるのを防ぐため、ここへ**名指しで**足す形にする。
 * ⚠ `package.json` の `devDependencies` に無ければ**静かに数えない**(この
 * 一覧の各名は `tests/build/oss-notices-plugin.test.ts` の合成 root には
 * 存在しないので、この carve-out がそちらの既存 test を壊さない ── 実在するのは
 * このリポジトリ自身の package.json だけである)。
 */
export const VENDORED_FONT_SOURCES = ['@phosphor-icons/web'] as const;

function readPkgJson(path: string): PkgJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PkgJson;
}

/**
 * `name` の実体が在るディレクトリを探す。
 *
 * ⚠ **`require.resolve(name + '/package.json')` には頼らない** ──
 * `exports` map が部分木を塞いでいる package がある(実測:
 * `@duckdb/duckdb-wasm` / `chart.js` は `Package subpath './package.json' is
 * not defined by "exports"` で落ちる。`@sqlite.org/sqlite-wasm` / `katex` /
 * `markdown-it` / `markdown-it-footnote` / `mermaid` は通る ── **package ごとに
 * 割れる**ので、通る前提を書かない)。
 * 🔑 **既定の入口を解決してから、`package.json` の `name` が一致するまで上へ辿る**
 * (scoped 名にも、サブパスの奥へ潜る package にも効く)。
 *
 * 🔴 **`req.resolve(name)`(既定の入口)自体が落ちる package もある**
 * (実測:`@phosphor-icons/web` の `exports` は `"./duotone"` 等のサブパスしか
 * 定義せず、`"."` 自体が無い ── `req.resolve(name)` が
 * `No "exports" main defined` で落ちる。これは「入口は解決できるが `./package.json`
 * だけ塞がれている」上の 2 例とは**別の壊れ方**である)。⚠ その場合は
 * `require.resolve.paths(name)`(`exports` を経由しない、node_modules の
 * 探索候補そのもの)から `<候補>/<name>/package.json` を直接あたる。
 */
function findPackageRoot(req: ReturnType<typeof createRequire>, name: string): string {
  let dir: string;
  try {
    dir = dirname(req.resolve(name));
  } catch {
    const candidates = req.resolve.paths(name) ?? [];
    const found = candidates.find((c) => existsSync(join(c, name, 'package.json')));
    if (found === undefined)
      throw new Error(`oss-notices: ${name} の実体が node_modules に見つかりません`);
    return join(found, name);
  }
  // ⚠ node_modules の入れ子は深くても数段 ── 無限に上らないよう上限を置く
  for (let i = 0; i < 16; i += 1) {
    const path = join(dir, 'package.json');
    try {
      if (readPkgJson(path).name === name) return dir;
    } catch {
      // まだ package.json が無い深さ、または壊れた JSON ── 上へ続ける
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`oss-notices: ${name} の package.json(name 一致)が見つかりません`);
}

/** そのディレクトリ**直下**に在る、ライセンスの file 名(無ければ `null`)。 */
function findLicenseFile(dir: string): string | null {
  return readdirSync(dir).find((f) => LICENSE_FILE_NAME.test(f)) ?? null;
}

/** SPDX の種別を読む。⚠ 古い形式(`{ type: 'MIT', ... }`)も受ける。 */
function licenseIdOf(pkg: PkgJson, name: string): string {
  const raw = pkg.license;
  if (typeof raw === 'string' && raw.trim() !== '') return raw;
  if (raw !== null && typeof raw === 'object' && 'type' in raw) {
    const t = (raw as { type?: unknown }).type;
    if (typeof t === 'string' && t.trim() !== '') return t;
  }
  throw new Error(`oss-notices: ${name} の package.json に license がありません`);
}

/**
 * `root/package.json` の `dependencies` を**全数**集める。
 * ⚠ **並びは名前順で固定** ── package.json の書かれた順に依らず、同じ入力から
 *   同じ並びが出るようにする。
 * 🔴 **空振り防止(下限)**:0 件は「手違い」として止める。1 件でも
 *   `require.resolve` / `license` が読めなければ、その package 名を添えて止める
 *   (黙って一覧から落とさない ── §「全部が載っている」を build 側でも守る)。
 */
export function collectOssNotices(root: string): readonly OssNotice[] {
  const req = createRequire(join(root, 'package.json'));
  const rootPkg = readPkgJson(join(root, 'package.json'));
  const runtimeNames = Object.keys(rootPkg.dependencies ?? {});
  if (runtimeNames.length === 0) {
    throw new Error(
      'oss-notices: package.json の dependencies が 0 件です(手違いの疑いがあります)',
    );
  }
  // 🔴 上の `VENDORED_FONT_SOURCES` を足す ── ⚠ **devDependencies に実在するときだけ**
  //   (合成 root のような、名指しの相手が居ない root では何も足さない)。
  const devDeps = rootPkg.devDependencies ?? {};
  const vendoredNames = VENDORED_FONT_SOURCES.filter((n) =>
    Object.prototype.hasOwnProperty.call(devDeps, n),
  );
  const names = [...runtimeNames, ...vendoredNames].sort((a, b) => (a < b ? -1 : 1));
  return names.map((name) => {
    const dir = findPackageRoot(req, name);
    const pkg = readPkgJson(join(dir, 'package.json'));
    const license = licenseIdOf(pkg, name);
    const file = findLicenseFile(dir);
    const text = file === null ? null : readFileSync(join(dir, file), 'utf8');
    return { name, license, text };
  });
}

export function ossNoticesPlugin(): Plugin {
  /**
   * ⚠ **`import.meta.url` から引かない**(`bodyCssPlugin` と同じ理由)。
   * vitest はこの file を dev server 経由で読むので `import.meta.url` が `http:`
   * になり、`fileURLToPath` が落ちる。解決済み config から取り、
   * 来ない経路(test から直接叩く)では cwd に倒す。
   */
  let root = process.cwd();
  return {
    name: 'pkc3-oss-notices',
    configResolved(config: ResolvedConfig) {
      root = config.root;
    },
    resolveId(id) {
      return id === OSS_NOTICES_ID ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      // ⚠ package.json を直したら焼き直す(dev で古い一覧のまま、を作らない)
      this.addWatchFile(join(root, 'package.json'));
      const notices = collectOssNotices(root);
      return `export default ${JSON.stringify(notices)};`;
    },
  };
}
