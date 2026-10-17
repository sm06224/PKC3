/**
 * 🔴 **ID が重なって、別のノートとして足したときの注意**(依頼 38-5 の裁定 B。#1643)。
 *
 * 直す前は「N 件のノートは ID が重なっていたので付け直しました」と件数だけで、**どのノートか**が
 * 分からなかった(別の端末で直したノートを取り込むと、同じ題名のノートが 2 つ目として足される)。
 * 題名で言い、**いまのノートは変わっていない**ことまで添える。
 *
 * - 多いときは先頭 3 件の題名だけ出して「ほか N 件」にまとめる(注意が件数ぶん並ばない ── `warn-cap` と同じ向き)
 * - ⚠ 内部の ID は出さない(user には直しようが無い ── #1087)
 * - ⚠ 対象は**いまのノートと重なった分だけ**。ファイルの中で ID が重なっていた分は「いまのノート」と
 *   言えないので、呼び側が従来の件数の 1 行で言う(`relabeledInFileWarning`)
 */

/** 先頭に出す題名の数。これを超えた分は「ほか N 件」。 */
export const RELABEL_TITLES_SHOWN = 3;

/** @returns 重なったノートが 0 件なら `null` */
export function relabeledWarning(titles: readonly string[]): string | null {
  if (titles.length === 0) return null;
  const shown = titles
    .slice(0, RELABEL_TITLES_SHOWN)
    .map((t) => `「${t === '' ? '(無題)' : t}」`)
    .join('');
  const rest = titles.length - RELABEL_TITLES_SHOWN;
  const who = rest > 0 ? `${shown}ほか ${String(rest)} 件` : shown;
  return `${who}は、いまのノートと同じ ID でした。別のノートとして追加しました(いまのノートは変わっていません)`;
}

/** ファイルの中で ID が重なっていた分(= いまのノートとは重なっていない)。 */
export function relabeledInFileWarning(count: number): string | null {
  return count > 0 ? `${String(count)} 件のノートは ID が重なっていたので付け直しました` : null;
}
