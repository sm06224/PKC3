/**
 * 🔴 **CSS を「構文で」読む道具**(test 用)。
 *
 * happy-dom は描画しないので、CSS の主張は原文を読んで確かめるしかない。
 * ⚠ そこが罠の巣で、CLAUDE.md §1 に **5 回踏んだ**と記録がある:
 *
 * | 踏んだ形 | どうなったか |
 * |---|---|
 * | `indexOf(選択子 + ' {')` | 版面の `grid-area` の規則に当たって落ちた |
 * | `` `${sel} {` `` で探す | **選択子リスト**(`A,\nB {`)の規則を 1 つも拾えなかった |
 * | 注釈を剥がずに探す | 直前のコメントが選択子の一部として拾われた |
 * | 最初の `@media` で切る | `@media` 群の**後ろ**に在る素の規則が見えなくなった |
 * | `@media` の中まで拾う | 印刷や狭い版面だけの規則で「画面の規則を消しても緑」 |
 *
 * 🔑 だから **1 か所に置く**(#303 の着地前レビュー B-4)── 2 つの test file に
 *   丸ごとコピーされていたので、**次に直したとき片方だけ直る**(CLAUDE.md §7)。
 */

/** 注釈を剥ぐ ── 剥がないと直前の注釈が選択子の一部として拾われる。 */
export const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * `選択子 { 宣言 }` を全部読み、選択子リストに `sel` を**丸ごと**含むブロックの
 * 宣言を返す。⚠ 部分一致にしない ── `A B` を探して `A B C` に当たる。
 */
export function blocksFor(css: string, sel: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1]!.split(',').map((x) => x.trim().replace(/\s+/g, ' '));
    if (sels.includes(sel)) out.push(m[2]!);
  }
  return out;
}

/**
 * `@media` ブロックを**構文で**取り除く(入れ子の brace を数えて対応する閉じまで)。
 * ⚠ 「最初の `@media` で切る」では足りない ── `@media` 群の**後にも**素の規則が続く。
 */
export function withoutMedia(css: string): string {
  let out = css;
  for (let at = out.indexOf('@media'); at !== -1; at = out.indexOf('@media')) {
    const open = out.indexOf('{', at);
    if (open < 0) throw new Error('@media に { が無い(構文が壊れている)');
    let depth = 1;
    let i = open + 1;
    for (; i < out.length && depth > 0; i++) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}') depth--;
    }
    if (depth !== 0) throw new Error('@media の閉じ } が無い(構文が壊れている)');
    out = out.slice(0, at) + out.slice(i);
  }
  return out;
}

/**
 * `@media <query> { … }` の**中だけ**と、その開始位置を返す。
 *
 * ⚠ **コメントを剥いでから渡すこと** ── `app.css` の print 節の直上には
 *   「`@media print` は 0 件だった」という**散文**が在り、素の `indexOf` は
 *   そちらに当たる(#303 の変異ハーネスで実際に踏み、build を落とした)。
 */
export function mediaBlock(css: string, query: string): { body: string; at: number } {
  const at = css.indexOf(`@media ${query}`);
  if (at < 0) throw new Error(`@media ${query} が無い`);
  const open = css.indexOf('{', at);
  let depth = 1;
  let i = open + 1;
  for (; i < css.length && depth > 0; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
  }
  if (depth !== 0) throw new Error(`@media ${query} の閉じ } が無い`);
  return { body: css.slice(open + 1, i - 1), at };
}

/**
 * 🔴 **宣言 1 本を、プロパティ名の先頭に固定して探す正規表現**を作る。
 *
 * ⚠ 素の `/height:\s*5em/` は **`max-height` / `min-height` / `line-height`**
 *   にも当たる(#303 の着地前レビュー A-1 / A-2 ── `height: var(--day-band)` を
 *   消す変異が、隣の `line-height: var(--day-band)` に満たされて**生き延びた**)。
 * 🔑 プロパティは **宣言ブロックの先頭か `;` の直後**にしか来ないので、そこへ固定する。
 * ⚠ 固定を `[;{]` で書くと**必ず落ちる** ── `blocksFor` が返すのは `{ }` の**中身**
 *   なので、先頭の宣言の前に `{` は無い(1 稿目で 4 件落ちた)。
 */
export function decl(prop: string, valuePattern: string): RegExp {
  return new RegExp(`(?:^|;)\\s*${prop}:\\s*${valuePattern}`);
}
