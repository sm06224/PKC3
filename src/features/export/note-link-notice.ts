/**
 * Markdown で書き出した先で、ノートへのリンク(`entry:…`)は開けない ── それを**数えて言う**(#1087)。
 *
 * 🔑 閲覧用 HTML は同じ状況で「このファイルに入っていないノートへのリンク N 件は …」と言う
 *   (`pkc3-html.ts`)。Markdown 側は何も言わなかったので、書き出した人は
 *   「リンクが外でも効く」と思ったまま渡してしまう。
 * ⚠ **言うだけ**。リンクを書き換えるかは見え方の判断なので、本文は 1 バイトも変えない。
 * 🔑 3 つの出口(zip / PC のフォルダ / ノート 1 件の `.md`)が**同じ数え方・同じ文面**を使うよう、
 *   数える規則と文面はここの 1 か所に置く(§7)。
 */
import { scanLinks, type LinkSite } from '@features/markdown/link-scan';

/** `entry:…` を指す宛先(画像の形の埋め込み `![](entry:…)` も、外では開けないので数える)。 */
const NOTE_DEST = /^entry:/i;

/** 走査済みの宛先から、ノートを指す物の数。 */
export function countNoteLinkSites(sites: readonly LinkSite[]): number {
  let n = 0;
  for (const s of sites) if (NOTE_DEST.test(s.dest)) n++;
  return n;
}

/** 本文の中の、ノートへのリンクの数(fence・行内コードの中は数えない ── `scanLinks` の規則)。 */
export function countNoteLinks(text: string): number {
  return countNoteLinkSites(scanLinks(text).sites);
}

/** 書き出した人に見せる注意(0 件なら `null`)。 */
export function noteLinkNotice(n: number): string | null {
  if (n <= 0) return null;
  return `ノートへのリンク ${n} 件は、書き出した先では開けません(リンクの字のまま残ります)`;
}
