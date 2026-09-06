import type { Plugin } from 'vite';

/**
 * 🔴 **KaTeX の書体は woff2 だけ配る**(#707)。
 *
 * ## なぜ要るか(実測 2026-09-06)
 *
 * `katex/dist/katex.min.css` の `@font-face` は 1 書体につき **woff2 / woff / ttf の
 * 3 形式**を並べる。素のまま取り込むと Vite が **59 file** を生成物へ出す:
 *
 * | 形式 | 本数 | 大きさ |
 * |---|---|---|
 * | **woff2** | 19 | **250.2 KB** ← 実際に使われるのはこれだけ |
 * | woff | 20 | 296.0 KB |
 * | ttf | 20 | 501.6 KB |
 *
 * ⚠ **woff と ttf は 1 バイトも読まれない**(woff2 を読めないブラウザは
 * PKC3 の対象に居ない)。それでも **SW の precache に載る**ので、
 * 初回起動で **797.6 KB を余分に取りに行く**。
 *
 * 🔑 「配る量は気にしない。効くのは定常」(user 指示 2026-08-03)は
 * **重いから入れない、を禁じる**指示であって、**読まれない物を配る**理由にはならない。
 * ⚠ そして cap(`scripts/check-dist.mjs`)は「重い dep の**誤取込**」を止める
 * tripwire である ── 3 形式の取り込みはまさにその形なので、
 * **cap を上げて通す**のではなく**取り込みを直す**のが正しい向きである。
 *
 * ## どうやるか
 *
 * ⚠ Vite の CSS 段が `url(...)` を解決する**前**に文字列を書き換える
 * (`enforce: 'pre'`)── 解決の後だと、既に生成物が emit されている。
 */
export function katexWoff2Plugin(): Plugin {
  return {
    name: 'pkc-katex-woff2',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('katex') || !id.endsWith('.css')) return null;
      // ⚠ 空振り防止:元の CSS に 3 形式が在ることを確かめてから削る
      //    (上流が woff2 だけになった日に、この段は黙って no-op になる)
      const before = (code.match(/url\([^)]*\.(?:woff|ttf)\)/g) ?? []).length;
      if (before === 0) return null;
      const out = code
        // `src: url(a.woff2) format("woff2"),url(b.woff) format("woff"),url(c.ttf) format("truetype")`
        .replace(/,\s*url\([^)]*\.woff\)\s*format\("woff"\)/g, '')
        .replace(/,\s*url\([^)]*\.ttf\)\s*format\("truetype"\)/g, '');
      return { code: out, map: null };
    },
  };
}
