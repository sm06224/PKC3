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
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { extractBodyCss } from './body-css.ts';

/** import 側が書く名前。 */
export const BODY_CSS_ID = 'virtual:pkc-body-css';
/**
 * 解決後の id。⚠ 先頭の NUL は「他の plugin が触るな」の Rollup 規約。
 * ⚠ **生バイトで書かない**(CLAUDE.md の規律。`tests/repo-hygiene.test.ts` が止める)。
 */
const RESOLVED = '\u0000pkc-body-css';

/**
 * 下限。2026-08-07 時点で 116 本 / 19 個。
 * ⚠ **実測値ぴったりにしない** ── 規則を 1 本消すだけで build が落ちると、
 *   まともな整理ができない。事故の桁(半分に減る / 空になる)を止める値にする。
 */
const MIN_RULES = 80;
const MIN_VARS = 12;

export function bodyCssPlugin(): Plugin {
  const appCssPath = fileURLToPath(new URL('../src/styles/app.css', import.meta.url));
  const tokensPath = fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url));
  return {
    name: 'pkc3-body-css',
    resolveId(id) {
      return id === BODY_CSS_ID ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      // ⚠ dev では CSS を直したら焼き直す ── 監視に載せないと、書き出し HTML だけが
      //   古い見た目のまま残り、しかも「直したのに変わらない」としか見えない
      this.addWatchFile(appCssPath);
      this.addWatchFile(tokensPath);
      const out = extractBodyCss(
        readFileSync(appCssPath, 'utf8'),
        readFileSync(tokensPath, 'utf8'),
      );
      if (out.missing.length > 0) {
        // 🔴 未定義の `var()` は宣言ごと無効になり、**先行する規則へ fall back しない**
        //    ── 焼いたせいで、いま効いているものまで消える(何もしないより悪い)
        this.error(
          `本文の CSS が参照するトークンの定義が見つかりません: ${out.missing.join(', ')}\n` +
            `src/styles/tokens.css の :root(幾何)/ [data-pkc-theme='light'](配色)を確かめてください。`,
        );
      }
      if (out.ruleCount < MIN_RULES) {
        this.error(
          `本文の規則が ${out.ruleCount} 本しか抜けていません(下限 ${MIN_RULES})。` +
            `app.css の本文の規則が .pkc-md-rendered 前置きでなくなった可能性があります。`,
        );
      }
      if (out.vars.length < MIN_VARS) {
        this.error(
          `トークンが ${out.vars.length} 個しか抜けていません(下限 ${MIN_VARS})。`,
        );
      }
      return `export default ${JSON.stringify(out.css)};`;
    },
  };
}
