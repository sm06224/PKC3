import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';
import type { Plugin } from 'vite';

/**
 * 🔴 **React(JSX)の囲みを描く sandbox の箱へ入れるランタイムを、1 本の字として焼く**(#528 ②)。
 *
 * 箱は CSP で外へ出られず(外部 CDN は使えない)、`allow-same-origin` も無いので、React・ReactDOM・JSX の変換器
 * (sucrase)・Tailwind を**箱の中へ inline で入れる**しかない。React 19 は UMD を配らない(ESM / CJS だけ)ので、
 * ここで `react` / `react-dom/client` / `sucrase` を **IIFE の 1 本**に畳み、字として adapter へ渡す。
 *
 * - 仮想 module `virtual:pkc3-react-runtime` の default export = ランタイム(JS の字)
 * - 仮想 module `virtual:pkc3-tailwind` の default export = Tailwind の browser build(JS の字)
 *   (`@tailwindcss/browser` が配る IIFE をそのまま読む。箱の中で class を見て CSS を作る)
 * - どちらも**要る瞬間まで読まれない**(adapter が dynamic import する ── 初期ロードに載せない)
 *
 * ⚠ 配る量ではなく**定常**:箱は見えたときに作り、使い終われば(本文を離れれば)箱ごと捨てる。
 */

const ENTRY = fileURLToPath(new URL('./react-runtime/entry.mjs', import.meta.url));
const RUNTIME_ID = 'virtual:pkc3-react-runtime';
const TAILWIND_ID = 'virtual:pkc3-tailwind';

let cache: string | null = null;

async function bundleRuntime(): Promise<string> {
  if (cache !== null) return cache;
  const out = await build({
    input: ENTRY,
    write: false,
    // 余計な警告を出さない(ライブラリ内部の eval 等)
    logLevel: 'silent',
    platform: 'browser',
    output: { format: 'iife', minify: true, codeSplitting: false },
    transform: { define: { 'process.env.NODE_ENV': '"production"' } },
  });
  const chunk = out.output.find((o) => o.type === 'chunk');
  if (chunk === undefined || chunk.type !== 'chunk') throw new Error('react runtime: bundle failed');
  cache = chunk.code;
  return cache;
}

export function reactRuntimePlugin(): Plugin {
  return {
    name: 'pkc3-react-runtime',
    resolveId(id) {
      if (id === RUNTIME_ID || id === TAILWIND_ID) return `\0${id}`;
      return null;
    },
    async load(id) {
      if (id === `\0${RUNTIME_ID}`) return `export default ${JSON.stringify(await bundleRuntime())};`;
      if (id === `\0${TAILWIND_ID}`) {
        const url = import.meta.resolve('@tailwindcss/browser');
        return `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};`;
      }
      return null;
    },
  };
}
