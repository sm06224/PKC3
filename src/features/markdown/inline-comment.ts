/**
 * 🔴 **行の中の隠しメモ `%%…%%` の読み方(1 か所)**(台帳 #1852 束 R1、依頼 256)。
 *
 * `%%` を 2 回書くと、その間の字は画面に出ないメモになる。`100%% done and 50%% more` のように
 * 字のまま `%%` を書きたいときは、`\%%` と書く(ほかの記号と同じく `\` で逃がす)。
 * 今までのメモは 1 つも変わらない ── 字のまま書く方法が増えるだけである。
 *
 * ⚠ `\\`(逃がした `\` 自身)は、その直後の `%%` をメモの始まりとして読む。
 *   つまり `\\%%x%%` は「`\` + メモ」である(`\%%` の `\` が逃がす側のときだけ字になる)。
 * 🔑 描画 / 書き出し(方言を落とす)/ 日付の読み取り / 参照元の数え方が同じ読み方をするよう、
 *   正規表現はここ 1 本から引く(判定を 2 か所に生やさない)。
 *
 * 🔑 pure module。DOM も窓も知らない。
 */

/** 新しい正規表現(`g` を持つので、使い回して `lastIndex` を持ち越さない)。当たりが `\…` なら字のまま(メモではない)。 */
export function inlineCommentRe(): RegExp {
  return /\\\\|\\%%|%%[^\n]*?%%/g;
}

/** 当たりがメモ(= 画面に出ない物)か。`\\` と `\%%` は字のまま残す側。 */
export function isInlineComment(match: string): boolean {
  return match.startsWith('%%');
}

/** 行の中のメモを `fn` の戻りに置き換える。`\\` と `\%%` は触らない。 */
export function replaceInlineComments(line: string, fn: (comment: string) => string): string {
  if (!line.includes('%%')) return line;
  return line.replace(inlineCommentRe(), (m) => (isInlineComment(m) ? fn(m) : m));
}

/** 行の中のメモの範囲(`[始まり, 終わり)`、UTF-16 の添字)。 */
export function inlineCommentRanges(line: string): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  if (!line.includes('%%')) return out;
  for (const m of line.matchAll(inlineCommentRe())) {
    if (isInlineComment(m[0])) out.push([m.index!, m.index! + m[0].length] as const);
  }
  return out;
}
