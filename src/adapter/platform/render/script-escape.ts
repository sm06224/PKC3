/**
 * 字を `<script>` の中へ**そのまま**置くときの逃がし(plotly / React の枠が、同梱のライブラリを inline で入れる)。
 *
 * 🔴 HTML の「script data」は次の 2 つで崩れる:
 * - `</script` ── そこで script が終わる
 * - `<!--` の後に `<script` が来ると「二重に逃がされた状態」に入り、**次の `</script>` で終わらなくなる**
 *   (ライブラリの本体は `<!--` も `<script` も字の中に持ちうる)
 * 🔑 どちらも JavaScript の字の中(文字列・正規表現・コメント)にしか現れないので、`\` を 1 つ挟んでも意味は変わらない
 *   (`<\/script` = `</script`、`<\x21--` = `<!--`)。⚠ `\!` ではなく `\x21`:正規表現の `u` フラグでは `\!` は構文エラーになる。
 * ⚠ 生の字では書かない(`</script` をこの file の字面に置くと、ビルドの HTML 化で壊れる)。
 */
export function escapeScript(src: string): string {
  return src.split('</script').join('<\\/script').split('<!--').join('<\\x21--');
}
