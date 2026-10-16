/**
 * 外から来た字を **1 行に畳む**口(#1087)。
 *
 * 改行の類(`\r \n` / NEL / 行区切り / 段落区切り / `\v \f`)を空白 1 つにする。
 * 🔑 取り込みで題名や 1 行の項目へ入れる字は、**記法へ入れる前にここを通す** ── 通さないと、外の file の改行で
 *   新しい行(`:::format{…}` など)を差し込める・題名が 2 行になる。
 * ⚠ 本文(メモの文章)には使わない ── 本文の改行は字そのものである。
 */
export function foldBreaks(s: string): string {
  return s.replace(/[\r\n\u0085\u{2028}\u{2029}\v\f]+/gu, ' ');
}

/** 取り込む題名の上限。1 行に 100 万字の「題名」を作らせない(本文は原文のまま残る)。 */
export const IMPORT_TITLE_MAX = 200;

/** 題名にする字を **1 行に畳み、上限で切る**(md の前書きの題名と vCard の名前が同じ口を通る)。 */
export function importTitleOf(raw: string): string {
  const t = foldBreaks(raw).trim();
  // ⚠ 字数は code point で数えて切る(`slice` は UTF-16 単位で、絵文字などの対を半分で切って壊れた字を残す)
  if (t.length <= IMPORT_TITLE_MAX) return t;
  const cps = Array.from(t);
  return cps.length > IMPORT_TITLE_MAX ? `${cps.slice(0, IMPORT_TITLE_MAX - 1).join('')}…` : t;
}
