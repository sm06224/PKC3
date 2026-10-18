/**
 * 🔴 **本文の `:::toc` の行を、右のペインの目次と同じ飛び方にする**(台帳 #1852 束 R1、依頼 86-2 B)。
 *
 * 直す前は普通のリンク(`href="#見出し"`)で、押すとアドレスが `#見出し` に替わり、ノートのアドレスが消えた
 * (ブックマークすると、そのノートに戻れなくなるおそれ)。右のペインの目次・クイック目次と同じ `toc-jump`
 * (描き直しを待つ / 畳んだ章は開く / アドレスは変えない)に揃える。
 *
 * 🔑 描いた後の DOM へ当てる(`applyMissingLinks` と同じ事情)。**中央の読む面だけ** ── 書き出した HTML・
 *    章の別ウィンドウ・印刷は、今までどおり素のページ内リンクのまま(そちらは `toc-jump` を受ける本体が居ない)。
 * ⚠ 冪等。`href` は残す(押せる印・ブラウザの「リンクのコピー」のため。押したときは `preventDefault` 済み)。
 */
const SELECTOR = '.pkc-toc-formal a.pkc-toc-link[href^="#"]';

export function applyBodyTocLinks(host: ParentNode): void {
  for (const a of host.querySelectorAll<HTMLAnchorElement>(SELECTOR)) {
    const raw = (a.getAttribute('href') ?? '').slice(1);
    let slug = raw;
    try {
      slug = decodeURIComponent(raw);
    } catch {
      // 読めない % の並びは、そのまま(手で書いた id)
    }
    if (slug === '') continue;
    if (a.getAttribute('data-pkc-action') !== 'toc-jump') a.setAttribute('data-pkc-action', 'toc-jump');
    if (a.getAttribute('data-pkc-toc-slug') !== slug) a.setAttribute('data-pkc-toc-slug', slug);
  }
}
