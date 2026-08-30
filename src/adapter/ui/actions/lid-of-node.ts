/**
 * 🔴 **押した所から「どのノートの行か」を引く**(#281 検算 2026-08-30)。
 *
 * ⚠ これは #277 段②-b で 1 度直した罠の**再発**である。あのときは
 * 「カンバンの札は別のノートの行なので、押すと**開いているノートの同じ行番号**を
 * 書き換える(いちばん静かなデータ破壊)」を `data-pkc-entry` で塞いだ。
 * 🔴 ところが **#505 の「横に留めた枠」は `data-pkc-split-lid` を焼く** ──
 * `data-pkc-entry` は持たないので、`closest` が `null` を返して
 * **主の枠のノートへ落ちる**。実害は 2 つ:
 *
 * | 主の枠 | 起きること |
 * |---|---|
 * | 板ではない | 黙って何も起きない(dead click) |
 * | 板である | 🔴 **別のノートの同じ行を書き換えうる** |
 *
 * 🔑 だから**引き方を 1 か所に寄せる** ── 「ノートを表す印」は 2 つあり、
 * どちらが内側かは場面で違うので、`closest` に**両方を渡して内側を採る**。
 * ⚠ 片方ずつ 2 回 `closest` すると、外側の印が内側に勝つ場面を作ってしまう。
 *
 * ⚠ **内側を保証しているのは選択子が 1 本であること**で、下の `??` の並び順ではない
 * (変異試験で順を入れ替えても SURVIVED ── 1 つの要素が両方の印を持つ場面が無い)。
 * 🔑 「これが無いと壊れる」と書く前に外して壊れるのを見る、の実行結果である。
 */

/** ノートを表す印。⚠ 増えたらここに足す(呼び側に散らさない)。 */
const OWNER = '[data-pkc-entry],[data-pkc-split-lid]';

/**
 * 押した節点が属するノートの lid。
 *
 * @param node   押した要素(`Event.target`)
 * @param fallback どの印も見つからないときの落とし先。⚠ 本文の面は
 *   `data-pkc-entry` を持たない(器はノートを表す要素ではない)ので、
 *   そこだけがここへ落ちる ── 呼び側は `openBody?.lid ?? selectedLid` を渡す。
 */
export function lidOfNode(node: Element | null, fallback: string | null): string | null {
  const owner = node?.closest<HTMLElement>(OWNER) ?? null;
  if (owner === null) return fallback;
  return (
    owner.getAttribute('data-pkc-entry') ?? owner.getAttribute('data-pkc-split-lid') ?? fallback
  );
}
