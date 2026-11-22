/**
 * 🔴 **アプリとして入れて開いているか(PWA)を、文書の印にする**(A1。user 裁定 2026-11-22)。
 *
 * ブラウザのタブで開いている間は、ブラウザ自身の戻る・進むが在るので、左上のアプリの中の `‹ ›` は出さない。
 * アプリとして入れて開いたとき(`display-mode: standalone` / `window-controls-overlay`)はブラウザの戻るが無いので、
 * `‹ ›` を標準のボタンの大きさで出す(見え方は `app.css` が `[data-pkc-standalone]` で決める)。
 * ⚠ 印は `<html>` に付ける(どの面からも読める)。表示の形が変わったら付け直す(`change`)。
 */

export const STANDALONE_ATTR = 'data-pkc-standalone';
export const STANDALONE_QUERY = '(display-mode: standalone), (display-mode: window-controls-overlay)';

/** @returns 外す関数 */
export function installStandalone(doc: Document = document, win: Pick<Window, 'matchMedia'> = window): () => void {
  if (typeof win.matchMedia !== 'function') return () => undefined;
  const mq = win.matchMedia(STANDALONE_QUERY);
  const apply = (): void => {
    doc.documentElement.toggleAttribute(STANDALONE_ATTR, mq.matches);
  };
  apply();
  mq.addEventListener?.('change', apply);
  return () => mq.removeEventListener?.('change', apply);
}
