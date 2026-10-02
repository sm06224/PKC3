/**
 * 🔴 **`src/features/asr/asr-parts.ts`(正本)を、この directory の script から読む**(#772 段 1)。
 *
 * ⚠ 目録の規則(`readAsrPack`)・2 択の定義(`ASR_PARTS`)・実行の部品の名前(`ASR_RUNTIME_FILES`)は
 *   `src/` に **1 か所だけ**在る。make-pack / check-pack がそれを**書き写さない**ために、Vite 自身に
 *   読ませる(`build/manual-page-plugin.ts` と同じ手 ── 拡張子無しの import を Node 単体は解決できない)。
 * ⚠ 使い捨ての server は `configFile: false`(この repo の `vite.config.ts` を読まない)・依存の事前 bundle を切る
 *   (SSR には要らず、root 直下の `*.html` を crawl して落ちるため ── manual-page-plugin.ts の実測)。
 * 🔑 vite は **PKC3 の root の `node_modules`** から解決される(`build/asr-pack/package.json` には入れない)。
 *   配る側の Actions は PKC3 を checkout して `npm ci` する前提。
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

/** 出力先の既定。⚠ 生成物なので追わない(`.gitignore`)。 */
export const DEFAULT_OUT = join(REPO_ROOT, 'dist-asr-pack');

/** @returns {Promise<{ mod: Record<string, any>, close: () => Promise<void> }>} */
export async function loadAsrParts() {
  let createServer;
  try {
    ({ createServer } = await import('vite'));
  } catch (e) {
    throw new Error(`vite が読めません(PKC3 の root で npm ci が要る): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  const server = await createServer({
    root: REPO_ROOT,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const mod = await server.ssrLoadModule('/src/features/asr/asr-parts.ts');
    return { mod, close: () => server.close() };
  } catch (e) {
    await server.close();
    throw e;
  }
}
