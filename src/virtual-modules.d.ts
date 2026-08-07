/**
 * build 時に作られる仮想モジュールの型。
 *
 * ⚠ ここが無いと `tsc --noEmit` が「モジュールが見つからない」で落ちる ──
 * 実体は `build/body-css-plugin.ts` が `load` で返す文字列である。
 */

declare module 'virtual:pkc-body-css' {
  /**
   * `src/styles/app.css` から抜いた**本文の規則**と、それが要求するトークン
   * (light / dark)。書き出す HTML の `<style>` に焼く。
   */
  const css: string;
  export default css;
}
