/**
 * `pos` を含む行の頭(`\n` の次の位置。先頭の行なら 0)。
 *
 * 🔴 **`text.lastIndexOf('\n', pos - 1) + 1` と素直に書くと、`pos === 0` で行頭を取り違える**
 * (#1213 で見つけ、字下げ #1166 の `indentLines` も同じ形だった):`lastIndexOf` は
 * **負の `fromIndex` を 0 に丸めて 0 番目を見る**ので、本文が `\n` で始まる(先頭が空行の)
 * とき `pos = 0` が **1** を返す ── 先頭の空行が欄の外へ落ち、選択の頭が 1 つ(字下げのときは
 * 字下げの幅の分)ずれる。⚠ 字は 1 つも壊れないので、見た目では気づけない。
 * 🔑 だから 0 は自前で返す。**判定は 1 か所**(`line-swap.ts` / `indent-assist.ts` が呼ぶ)。
 */
export function lineStart(text: string, pos: number): number {
  return pos <= 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;
}
