/**
 * 🔴 **アプリとして入れて開いているか(PWA)を、文書の印にする**(A1。user 裁定 2026-11-22)。
 *
 * ブラウザのタブで開いている間は、ブラウザ自身の戻る・進むが在るので、左上のアプリの中の `‹ ›` は出さない(パソコンの幅)。
 * アプリとして入れて開いたときはブラウザの戻るが無いので、`‹ ›` を標準のボタンの大きさで出す(見え方は `app.css` の `[data-pkc-standalone]`)。
 * 🔴 「アプリとして開いているか」の判定は `installed-app.ts` の `isInstalledApp` の 1 本(着地前レビュー ⚠6 ── 2 か所に規則を持たない)。
 * ⚠ 印は `<html>` に付ける(どの面からも読める)。表示の形が変わったら付け直す(各 `display-mode` の `change`)。
 */
import { INSTALLED_MODES, isInstalledApp } from '@adapter/platform/installed-app';

export const STANDALONE_ATTR = 'data-pkc-standalone';

/** @returns 外す関数 */
export function installStandalone(
  doc: Document = document,
  win: Pick<Window, 'matchMedia'> = window,
  installed: () => boolean = isInstalledApp,
): () => void {
  const apply = (): void => {
    doc.documentElement.toggleAttribute(STANDALONE_ATTR, installed());
  };
  apply();
  if (typeof win.matchMedia !== 'function') return () => undefined;
  const mqs = INSTALLED_MODES.map((m) => win.matchMedia(`(display-mode: ${m})`));
  for (const mq of mqs) mq.addEventListener?.('change', apply);
  return () => {
    for (const mq of mqs) mq.removeEventListener?.('change', apply);
  };
}
