/**
 * 🔴 **2 列の書き方で、右の表示を左のスクロールの割合に合わせて送る**(#1163 依頼 249、案 A)。
 *
 * 🔑 「おおよそ同じ割合の位置」── 原文と表示は行の高さが違う(図・表・見出しの大きさ)ので、行を突き合わせる
 *   写像は持たない。左が全体の何割まで進んだかを、右の送れる幅に掛ける。
 * ⚠ 向きは**左 → 右だけ**。右を自分で送ったときに左を動かすと、打っている欄が勝手に動く(両向きにすると往復で揺れる)。
 */
export interface ScrollBox {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** 送れる幅のうち、いま何割まで進んでいるか(0〜1)。送れる幅が無ければ 0。 */
export function scrollRatio(box: ScrollBox): number {
  const room = box.scrollHeight - box.clientHeight;
  if (room <= 0) return 0;
  return Math.min(1, Math.max(0, box.scrollTop / room));
}

/** `from` と同じ割合になる `to` の scrollTop。 */
export function followScrollTop(from: ScrollBox, to: ScrollBox): number {
  const room = to.scrollHeight - to.clientHeight;
  if (room <= 0) return 0;
  return Math.round(scrollRatio(from) * room);
}

/**
 * 左の欄の送りに右を付いて行かせる。⚠ 1 描画に 1 回だけ動かす(`requestAnimationFrame` で畳む)── scroll は 1 描画に
 *   何度も来るので、来るたびに右を書くと版面の計算が重なる。
 * @returns 外す手(編集を抜けたとき)
 */
export function followScroll(from: HTMLElement, to: HTMLElement): () => void {
  let queued = false;
  const raf =
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0);
  const onScroll = (): void => {
    if (queued) return;
    queued = true;
    raf(() => {
      queued = false;
      if (!from.isConnected || !to.isConnected) return;
      to.scrollTop = followScrollTop(from, to);
    });
  };
  from.addEventListener('scroll', onScroll, { passive: true });
  return () => from.removeEventListener('scroll', onScroll);
}
