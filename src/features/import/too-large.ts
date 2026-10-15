/**
 * 🔴 **大きすぎて読み込めなかったときの断り**(#1087)。
 * 🔑 葉の module(他を import しない)── 取り込みの口とバックアップの読み手の両方が、循環せずに呼べる。
 *
 * - ⚠ 大きさの上限は**決めない**(PKC2 の書き出しやバックアップは、大きくてもよい)。読んでみて、ブラウザが
 *   文字列を作れなかったとき(`RangeError: Invalid string length`)だけ、この字にする。
 * - 「Invalid string length」という英語の例外の字は、user には何が起きたか分からない。
 */
export const TOO_LARGE_TO_READ_REFUSAL = 'ファイルが大きすぎて読み込めませんでした';

/** ブラウザが「文字列・配列を作れない」と言った例外か(⚠ 他の `RangeError`〔再帰の深さ など〕は含めない)。 */
export function isTooLargeToRead(e: unknown): boolean {
  return (
    e instanceof RangeError &&
    /invalid (string|array|typed array) length|array buffer allocation failed|allocation failed/i.test(e.message)
  );
}
