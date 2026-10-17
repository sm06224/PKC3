/**
 * 🔴 **選んでいる間のバーを貼り付けてよいか**(台帳 #1852 束 C2 の副作用。依頼 82-1)。
 *
 * 貼り付くバー(`filer-move`)は、一覧の見えている高さが低い(取り込み直後など約 250px)と、
 * バーが 150px 超になる場面で**下の行を覆って押せなくなる**。見えている高さがバーの 2 倍に
 * 満たないときは貼り付けず、従来どおり行の下に流す(行は覆われない)。
 * ⚠ 貼り付けないときの見え方は束 C1 と同じ。貼り付くのは十分な高さがあるときだけ。
 */
export const BAR_STICK_RATIO = 2;

export function barFitsSticky(viewHeight: number, barHeight: number): boolean {
  if (!(viewHeight > 0)) return false; // 隠れている面(高さ 0)では貼り付けない
  return viewHeight >= barHeight * BAR_STICK_RATIO;
}

/** バーと一覧の高さが変わるたびに `data-pkc-bulk-stick` を付け外しする。返り値で観測をやめる。 */
export function watchBarStick(bar: HTMLElement, scroller: HTMLElement): () => void {
  const sync = (): void => {
    const on = bar.hasAttribute('data-pkc-bulk') && barFitsSticky(scroller.clientHeight, bar.offsetHeight);
    bar.toggleAttribute('data-pkc-bulk-stick', on);
  };
  sync();
  if (typeof ResizeObserver === 'undefined') return () => {};
  const ro = new ResizeObserver(sync);
  ro.observe(scroller);
  ro.observe(bar);
  return () => ro.disconnect();
}
