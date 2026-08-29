/**
 * 🔴 **行 → 文字位置**(#596 C)。
 *
 * ## なぜ要るか
 *
 * 「**ここから編集する**」は押した見出しの行を持って編集へ入るが、
 * **2 ペイン編集**の原文は素の `<textarea>` なので、行を渡す口が無い ──
 * 直す前は `editOpenAt` を読むのが 1 列編集の描画だけで、2 ペインの側は
 * **1 度も読んでいなかった**(300 行のノートの真ん中を押しても**先頭が開く**)。
 * ⚠ **画面に出ている字は契約である** ──「ここから」と書いてある以上、
 * 守られていないと嘘になる。
 *
 * ⚠ **pure module**。browser API を持たない(`textarea` を触るのは adapter 側)。
 */

/**
 * `line` 行目の先頭の文字位置(0 始まり)。
 *
 * ⚠ **行を数えるのは `\n` だけ**(`\r\n` はここへ来る前に正規化されている)。
 * ⚠ **範囲外は端へ丸める** ── 呼び側が `setSelectionRange` へ渡すので、
 *   ここで投げると「開けなかった」ではなく**編集に入れない**になる。
 *   🔑 丸めるのは安全側:0 行目(先頭)= 直す前と同じ振る舞いに落ちる。
 */
export function lineStartOffset(text: string, line: number): number {
  if (!Number.isFinite(line) || line <= 0) return 0;
  let at = 0;
  for (let i = 0; i < line; i += 1) {
    const nl = text.indexOf('\n', at);
    // ⚠ 行が足りない ── **最後の行の先頭**を返す(末尾ではない)。
    //    末尾へ飛ばすと、行が 1 本足りないだけで「文書の終わり」へ落ちる
    if (nl < 0) return at;
    at = nl + 1;
  }
  return at;
}

/**
 * その行が画面に入るための `scrollTop`(px)。
 *
 * ⚠ **折り返しは数えない** ── `textarea` は長い行を折り返すので、
 *   実際の行はこの見積もりより下に在ることがある(下にずれる = **行き過ぎない**)。
 *   🔑 だから **1/3 上に置く**:多少ずれても画面の中に残る。
 * ⚠ `lineHeight` が `normal` だと数にならないので、呼び側が既定を渡す。
 */
export function scrollTopForLine(line: number, lineHeight: number, viewport: number): number {
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return 0;
  const top = Math.max(0, line) * lineHeight;
  return Math.max(0, top - Math.max(0, viewport) / 3);
}
