/**
 * 同梱した mermaid の版を、`define` で焼く値として返す(#1003)。
 *
 * 🔴 **vite.config.ts と build/portable.config.ts の両方が使う** ── 片方にだけ書くと、
 * 可搬版では版が `'unknown'` のまま焼かれ、焼いた図のキャッシュの鍵が版で変わらない
 * (`src/runtime/mermaid-version.ts`)。⚠ 手書きしない:入れた `node_modules/mermaid` から読む。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function mermaidVersion(): string {
  const path = fileURLToPath(new URL('../node_modules/mermaid/package.json', import.meta.url));
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
}

/** 入れた依存の版(`node_modules/<name>/package.json`)。⚠ 手書きしない。 */
function installedVersion(name: string): string {
  const path = fileURLToPath(new URL(`../node_modules/${name}/package.json`, import.meta.url));
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
}

/**
 * 焼いた絵のキャッシュの鍵に入れる**産出器の版**(mermaid #1003 / plotly・pdf.js #528 #529)。
 * ⚠ 名前はそのまま(両方の config が使う)。plotly と pdf.js の版も同じ `define` で焼く ── 版が上がっても
 *   鍵が変わらないと、上げた日から古い PNG が返り続ける。
 */
export const mermaidVersionDefine = (): Record<string, string> => ({
  __PKC_MERMAID_VERSION__: JSON.stringify(mermaidVersion()),
  __PKC_PLOTLY_VERSION__: JSON.stringify(installedVersion('plotly.js-dist-min')),
  __PKC_PDFJS_VERSION__: JSON.stringify(installedVersion('pdfjs-dist')),
});
