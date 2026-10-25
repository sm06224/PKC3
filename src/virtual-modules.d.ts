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

declare module 'virtual:pkc-oss-notices' {
  /**
   * 実体は `build/oss-notices-plugin.ts` が `package.json` の `dependencies`
   * から焼く(#948)。`help.ts` が「使っているオープンソース」の一覧を描くのに読む。
   */
  import type { OssNotice } from './features/oss-notices/oss-notices';
  const notices: readonly OssNotice[];
  export default notices;
}

declare module 'virtual:pkc3-react-runtime' {
  /** React・ReactDOM・JSX の変換器(sucrase)を畳んだ IIFE の字(`build/react-runtime-plugin.ts`。#528 ②)。 */
  const code: string;
  export default code;
}

declare module 'virtual:pkc3-tailwind' {
  /** Tailwind の browser build の字(`@tailwindcss/browser` が配る IIFE。#528 ②)。 */
  const code: string;
  export default code;
}
