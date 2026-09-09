/**
 * 🔴 **溜めてから貼る**(#679)── 純粋な層。まだ画面には繋がない。
 *
 * > user の言葉 2026-09-03:「**ペースト時の一括ペーストや並び替えしてからのペースト
 * > (スクラップのような)**」
 *
 * ## 🔑 置き場は増やさない
 *
 * 集める先は **#678 のコピー履歴そのもの**(`CopiedItem[]`)である。
 * ⚠ 「スクラップ」という**2 つ目の置き場**を作ると、
 * 「どっちに入れたか」を user が覚える羽目になる(issue 本文の「2 つ作らない」)。
 * 🔑 ここが持つのは **印(どれを選んだか)と、その並び**だけ ── 中身は履歴が持つ。
 *
 * ## ⚠ 並びは `at` ではない
 *
 * 履歴の並びは**コピーした順**だが、貼るときの並びは **user が決める**。
 * だから印は「集合」ではなく**列**(`readonly string[]`)で持つ ──
 * 集合で持つと並べ替えが表現できない。
 */
import type { CopiedItem } from './history';

/**
 * 印を付ける / 外す(`text` で名指す。⚠ 履歴の同一性も `text` である)。
 *
 * 🔑 **付けた順に後ろへ積む** ── user が選んだ順が既定の並びになる。
 * ⚠ 外して付け直すと**末尾へ回る**(「選び直した」= いちばん新しい意思)。
 */
export function toggleMark(marks: readonly string[], text: string): string[] {
  return marks.includes(text) ? marks.filter((m) => m !== text) : [...marks, text];
}

/**
 * 印を 1 つ動かす(掴んで並べ替える)。
 *
 * ⚠ 範囲の外は**動かさない**(黙って端へ丸めない)── 丸めると、掴んで
 *   画面の外へ出したときに「勝手に先頭へ飛んだ」と見える。
 */
export function moveMark(marks: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= marks.length || to < 0 || to >= marks.length || from === to) {
    return [...marks];
  }
  const out = [...marks];
  const [moved] = out.splice(from, 1);
  if (moved === undefined) return [...marks];
  out.splice(to, 0, moved);
  return out;
}

/**
 * 印の付いた物を、**印の並びで**取り出す。
 *
 * 🔴 **履歴から消えた物は落とす** ── 別のタブが「消す」を押した後でも、
 *   印だけが残って**貼るときに空行が増える**、という形にしない。
 * ⚠ 落ちたことは**呼び側が数えられる**ように、入力の印の数と返りの数で分かる形にする。
 */
export function pickMarked(
  list: readonly CopiedItem[],
  marks: readonly string[],
): CopiedItem[] {
  const byText = new Map(list.map((c) => [c.text, c]));
  const out: CopiedItem[] = [];
  for (const m of marks) {
    const hit = byText.get(m);
    if (hit !== undefined) out.push(hit);
  }
  return out;
}

/**
 * 印を、いまの履歴に在る物だけへ揃える(消えた物の印を落とす)。
 * 🔑 画面を描く前に通す ── 通さないと「押せない印」が並ぶ。
 */
export function pruneMarks(
  list: readonly CopiedItem[],
  marks: readonly string[],
): string[] {
  const alive = new Set(list.map((c) => c.text));
  return marks.filter((m) => alive.has(m));
}

/**
 * 🔴 **まとめて貼る 1 本の字**(#679 の裁定 2026-09-09)。
 *
 * ⚠ 繋ぎは**空行 1 つ**である。PKC の本文は改行をそのまま `<br>` にする
 *   (`breaks: true`)ので、`\n` 1 つで繋ぐと**溜めた物が全部 1 つの段落へ潰れる**。
 *   user の言葉は「**並び替えしてからのペースト**」= 塊を並べる話なので、
 *   塊のまま入るほうが意図に合う。
 * 🔑 これが分かったら覆る: user が「1 行ずつ詰めて貼りたい」と言ったとき。
 *
 * ⚠ **端の空白は落とす**が、**中の形は 1 バイトも変えない**
 *   (表・コード塊をコピーした物が壊れる)。
 * ⚠ 中身が空になった物は**落とす** ── 落とさないと空行だけが増える。
 */
export function joinCopied(items: readonly CopiedItem[]): string {
  return items
    .map((c) => c.text.replace(/^\s+|\s+$/g, ''))
    .filter((t) => t !== '')
    .join('\n\n');
}
