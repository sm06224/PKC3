/**
 * 同梱した mermaid の版(#1003)。
 *
 * 🔴 **焼いた図のキャッシュの鍵に入れるための値**である。⚠ mermaid は版が変わると
 * **同じ原文でも配置と寸法が変わる**(11 → 12 で既定の配置が `dagre` → `elk` になり、
 * 図の大きさが全種類で変わった)。鍵に版が無いと、上げた日から**古い図は 11 の配置のまま・
 * 新しく焼く図だけ 12** になり、同じ文書の中で混ざる。
 *
 * ⚠ **手書きしない** ── `vite.config.ts` の `define` が、入れた `node_modules/mermaid` の
 * `package.json` から読んで字ごと置き換える(版を上げた人が、ここを直し忘れる余地を無くす)。
 * 🔑 だから `globalThis['…']` では受けられない(`define` が書き換えるのは**裸の識別子**だけ。
 * `release-meta.ts` の `BUILT_AT` と同じ作り)。焼いていない環境では宣言が無いので
 * `typeof` で確かめてから触る。
 */
declare const __PKC_MERMAID_VERSION__: string | undefined;

/** 焼いていない環境(`define` が無い)では `'unknown'` ── 空にしない(鍵が区切りだけになる)。 */
export const MERMAID_VERSION: string =
  typeof __PKC_MERMAID_VERSION__ === 'string' && __PKC_MERMAID_VERSION__ !== ''
    ? __PKC_MERMAID_VERSION__
    : 'unknown';
