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
 * - shell が無い文書(別の文書・テスト)では何もしない(印 `data-pkc-shell` を html で見る)。
 * - スマホ・タブレットの版面では何もしない(ソフトキーボードがルートを動かすことがある)。
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
    // shell が入った印(`buildShell` が html に立てる)。無ければ別の文書 ── 触らない
    if (!doc.documentElement.hasAttribute('data-pkc-shell')) return;
    // ⚠ スマホ・タブレットの版面では戻さない ── 指の端末はソフトキーボードを出すとき、入力欄を見せるために
    //   ルートを動かすことがある(戻すと追記欄がキーボードの裏に隠れる)
    const layout = doc.querySelector('[data-pkc-region="shell"]')?.getAttribute('data-pkc-layout');
    if (layout === 'phone' || layout === 'tablet') return;
    root.scrollTop = 0;
    root.scrollLeft = 0;
  };
  win.addEventListener('scroll', onScroll, { passive: true });
  return () => win.removeEventListener('scroll', onScroll);
}
