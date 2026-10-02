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

export const mermaidVersionDefine = (): Record<string, string> => ({
  __PKC_MERMAID_VERSION__: JSON.stringify(mermaidVersion()),
});
