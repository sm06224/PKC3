/**
 * 🔴 **アプリの画面では、文書ルート(html)を 0 の位置から動かさない**(画面全体が下へスクロールする不具合)。
 *
 * PKC の画面は shell が画面ちょうどの高さを取り、スクロールはペインの中だけで起きる。
 * それでも何かの要素が少しでも下へはみ出すと、`scrollIntoView`・フォーカス・ページ内検索がルートを持ち上げ、
 * 追記欄の下に空白が出たまま戻らない(CSS の `overflow: hidden` はホイールしか止めない ── 呼び出しによる
 * スクロールは通る)。ルートが動いたら、その場で 0 へ戻す。
 *
 * - 定常のコスト: `scroll` はルートが動いたときだけ来る(ペインの中のスクロールはルートの `scroll` を起こさない)。
 * - 紙(印刷)では戻さない ── `matchMedia('print')` の間は何もしない。
 * - shell が無い文書(別の文書・テスト)では何もしない。
 */
export function installRootScrollGuard(win: Window): () => void {
  const doc = win.document;
  const printing = (): boolean => {
    try {
      return win.matchMedia?.('print').matches === true;
    } catch {
      return false;
    }
  };
  const onScroll = (): void => {
    const root = doc.scrollingElement;
    if (root === null) return;
    if (root.scrollTop === 0 && root.scrollLeft === 0) return;
    if (printing()) return;
    if (doc.querySelector('[data-pkc-region="shell"]') === null) return;
    root.scrollTop = 0;
    root.scrollLeft = 0;
  };
  win.addEventListener('scroll', onScroll, { passive: true });
  return () => win.removeEventListener('scroll', onScroll);
}
