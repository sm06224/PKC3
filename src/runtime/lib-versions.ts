/**
 * 同梱した plotly.js / pdf.js の版(#528 / #529)。焼いた絵のキャッシュの鍵(`engine`)に入れる。
 *
 * 🔴 手書きしない ── `build/mermaid-version.ts` の `define` が `node_modules` の `package.json` から焼く
 * (`mermaid-version.ts` と同じ作り。`define` は裸の識別子だけを置き換えるので `typeof` で受ける)。
 * 焼いていない環境(test)では `'unknown'`。
 */
declare const __PKC_PLOTLY_VERSION__: string | undefined;
declare const __PKC_PDFJS_VERSION__: string | undefined;

export const PLOTLY_VERSION: string =
  typeof __PKC_PLOTLY_VERSION__ === 'string' && __PKC_PLOTLY_VERSION__ !== '' ? __PKC_PLOTLY_VERSION__ : 'unknown';
export const PDFJS_VERSION: string =
  typeof __PKC_PDFJS_VERSION__ === 'string' && __PKC_PDFJS_VERSION__ !== '' ? __PKC_PDFJS_VERSION__ : 'unknown';
