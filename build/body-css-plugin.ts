/**
 * 本文の CSS を **build 時に 1 度抜いて** `virtual:pkc-body-css` として配る Vite plugin。
 *
 * 🔑 **`?raw` で app.css 全文を import しない** ── 全文は 80KB、抜いた分は約 12KB。
 * 配る量そのものは問題にしない方針だが(CLAUDE.md「配る量は気にしない」)、
 * **本文と無関係な器の規則を書き出し HTML に載せるのは害**である ── 閲覧側の
 * `body{display:grid}` などを器の規則が上書きして、見た目を壊す。
 *
 * 🔴 **抜けたら build を止める**(CLAUDE.md「tripwire は上限だけでなく下限も置く」)。
 * この plugin の失敗は**静かに起きる** ── 規則が 0 本でも CSS としては妥当なので、
 * 書き出し HTML は「本文が素のまま」になるだけで、test は緑のまま通りうる。
 *
 * ⚠ **判定は `build/body-css.ts` の `auditBodyCss` に置く**(この file には置かない)。
 *   plugin の hook は Vite を起こさないと走らないので、ここに書いた検査は
 *   **test から触れない** ── 実際、初版は 3 つの検査を丸ごと削除しても全 test 緑だった
 *   (CLAUDE.md「検品する側・test する側も変異試験の対象にする」)。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { auditBodyCss, extractBodyCss } from './body-css.ts';

/** import 側が書く名前。 */
export const BODY_CSS_ID = 'virtual:pkc-body-css';
/**
 * 解決後の id。⚠ 先頭の NUL は「他の plugin が触るな」の Rollup 規約。
 * ⚠ **生バイトで書かない**(CLAUDE.md の規律。`tests/repo-hygiene.test.ts` が止める)。
 */
const RESOLVED = '\u0000pkc-body-css';

export function bodyCssPlugin(): Plugin {
  /**
   * ⚠ **`import.meta.url` から引かない**(2026-08-07)。vitest はこの file を
   * dev server 経由で読むので `import.meta.url` が `http:` になり、
   * `fileURLToPath` が「The URL must be of scheme file」で落ちる ──
   * **plugin を test から触れなくなる**。`swPlugin` と同じく解決済み config から取る。
   * ⚠ `configResolved` が来ない経路(test から直接叩く)では cwd に落ちる。
   *   file が無ければ `readFileSync` が**パス付きで**落ちるので、黙って通ることはない。
   */
  let root = process.cwd();
  return {
    name: 'pkc3-body-css',
    configResolved(config: ResolvedConfig) {
      root = config.root;
    },
    resolveId(id) {
      return id === BODY_CSS_ID ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      const appCssPath = join(root, 'src/styles/app.css');
      const tokensPath = join(root, 'src/styles/tokens.css');
      // ⚠ dev では CSS を直したら焼き直す ── 監視に載せないと、書き出し HTML だけが
      //   古い見た目のまま残り、しかも「直したのに変わらない」としか見えない
      this.addWatchFile(appCssPath);
      this.addWatchFile(tokensPath);
      const out = extractBodyCss(readFileSync(appCssPath, 'utf8'), readFileSync(tokensPath, 'utf8'));
      const bad = auditBodyCss(out);
      if (bad.length > 0) {
        this.error(`本文の CSS の焼き込みが壊れています:\n- ${bad.join('\n- ')}`);
      }
      return `export default ${JSON.stringify(out.css)};`;
    },
  };
}
