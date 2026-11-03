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

/**
 * 🔴 **貼り付けると、印の付いた行を覆うか**(全量・並列の smoke で「フォルダを開き直してもノートが見えない」と落ちて見つけた)。
 *
 * ⚠ 帯は**印が付いた瞬間に**現れる ── 画面の下のほうの行をダブルクリックすると、1 回目で選んだ瞬間に貼り付いた帯が
 *   その行を覆い、**2 回目のクリックが帯に落ちて**フォルダへ入れない(ノートなら別のウィンドウが開かない)。
 *   user が普通の速さで押しても起きる(2 回の間に描画が入るので)── 無反応の 2 回押しである。
 * 🔑 だから印の付いた行(いま見えている物)が、貼り付いた帯の来る帯域(一覧の見えている下端から帯の高さぶん)に掛かる間は
 *   貼り付けない(従来どおり行の下に流す)。送って行が帯域の上へ出れば、そのとき貼り付く(依頼 82-1 の「選んだら帯が見える」)。
 *
 * @param rows 印の付いた行の上端・下端(画面の座標)
 * @param viewBottom 一覧の見えている下端(画面の座標)
 */
export function barCoversMarked(
  rows: readonly { readonly top: number; readonly bottom: number }[],
  viewBottom: number,
  barHeight: number,
): boolean {
  const bandTop = viewBottom - barHeight;
  return rows.some((r) => r.bottom > bandTop && r.top < viewBottom);
}

/** 一覧の中の、印の付いた行(組まれている物)。 */
const MARKED_ROWS = '[data-pkc-region="filer-table"] [data-pkc-entry][data-pkc-marked]';

/** バーと一覧の高さが変わるたび・一覧を送るたびに `data-pkc-bulk-stick` を付け外しする。返り値で観測をやめる。 */
export function watchBarStick(bar: HTMLElement, scroller: HTMLElement): () => void {
  const covers = (): boolean => {
    const rows = [...scroller.querySelectorAll<HTMLElement>(MARKED_ROWS)].map((r) => r.getBoundingClientRect());
    if (rows.length === 0) return false;
    const view = scroller.getBoundingClientRect();
    return barCoversMarked(rows, view.top + scroller.clientHeight, bar.offsetHeight);
  };
  const sync = (): void => {
    const on =
      bar.hasAttribute('data-pkc-bulk') && barFitsSticky(scroller.clientHeight, bar.offsetHeight) && !covers();
    bar.toggleAttribute('data-pkc-bulk-stick', on);
    // 🔴 貼り付いている間は、帯の高さぶん「スクロールで見せる範囲」を狭める ── 帯の真下に隠れた行を
    //   `scrollIntoView` が「見えている」と読んで動かず、押せなかった(pdf-reader.smoke の FL_OUT)。
    if (on) scroller.style.scrollPaddingBottom = `${bar.offsetHeight}px`;
    else scroller.style.removeProperty('scroll-padding-bottom');
  };
  sync();
  /**
   * 🔑 送ったら次の描画で決め直す(印の行が帯域から出入りする)── 1 回の描画に 1 度だけ(送りの度には読まない)。
   * ⚠ 印が無い間は何も読まない(`data-pkc-bulk` が無ければ貼り付かないので、行の位置は要らない)。
   */
  const win = scroller.ownerDocument.defaultView;
  let queued = false;
  const onScroll = (): void => {
    if (queued || !bar.hasAttribute('data-pkc-bulk') || win === null) return;
    queued = true;
    win.requestAnimationFrame(() => {
      queued = false;
      sync();
    });
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  const stopScroll = (): void => scroller.removeEventListener('scroll', onScroll);
  if (typeof ResizeObserver === 'undefined')
    return () => {
      stopScroll();
      scroller.style.removeProperty('scroll-padding-bottom');
    };
  const ro = new ResizeObserver(sync);
  ro.observe(scroller);
  ro.observe(bar);
  return () => {
    ro.disconnect();
    stopScroll();
    scroller.style.removeProperty('scroll-padding-bottom');
  };
}
