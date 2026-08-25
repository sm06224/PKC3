/**
 * 🔴 **雛形(スニペット)フレーバー**(#196 / B-2。user go 2026-08-25)。
 *
 * 本文はいつもどおり **PKC-Markdown** で、雛形であることは archetype が持つ ──
 * 短縮語は frontmatter の `abbr:`(規約は `features/snippet/snippet-table.ts`)。
 *
 * ⚠ **抽出列は 1 つも書かない。** 雛形は予定ではないので `date` / `status` を
 *   写すと、書いた覚えのない予定が予定の面に並ぶ。
 * ⚠ `archived` も写さない ── 片付ける操作は普通のノートと同じ経路が持つ。
 *
 * 🔑 **seed は「規約が見える最小形」に留める**(`FlavorSpec.seed` の規約)。
 *   雛形の中身まで用意すると、それは「雛形の雛形」であって盛り込みすぎである。
 */
import { NO_EXTRACT, type FlavorSpec } from './flavor-spec';
import { SNIPPET_ABBR_KEY, SNIPPET_ARCHETYPE } from '@features/snippet/snippet-table';

export const snippetFlavor: FlavorSpec = {
  archetype: SNIPPET_ARCHETYPE,
  extract: () => NO_EXTRACT,
  /** PKC2 に対応する archetype は無い ── 恒等で通す(取り込みで落とさない)。 */
  fromPkc2: (body) => body,
  /**
   * ⚠ 短縮語は**空で置く** ── 埋めておくと、作った端から別の雛形と衝突する。
   * 🔑 `${…}` の例を 1 つ置く ── 記法の説明をマニュアルまで探しに行かせない。
   */
  seed: () =>
    `---\n${SNIPPET_ABBR_KEY}: \n---\n\nここに雛形の本文を書きます。\n\n` +
    `\${宛名} と書いた所は、挿したあと打ち替えられます(次の場所へは Tab)。\n` +
    `\${date} は挿した日、\${cursor} は挿したあとカーソルが来る場所です。\n`,
};
