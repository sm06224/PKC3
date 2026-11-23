/**
 * 🔴 **浮き札(トースト)を、追記欄の真上へ上げる量を測って CSS 変数に書く**(2026-11-23 レビュー)。
 *
 * 浮き札は中央の本文のマスの**右下**に重ねる(一覧・左の縦のバー・ペインの操作を覆わない)。⚠ 追記欄(打つ欄)は本文のマスの下端にあるので、
 * その丈ぶん上へ上げないと覆ってしまう。丈は追記欄の大きさ・掴む帯・畳み(1 行の帯)で変わるので、CSS の固定値にせず**測る**。
 * `--pkc-toast-lift` = 本文のマスの下端 − 追記欄(と掴む帯)の上端。追記欄が無い / 畳まれて場所を取らないときは 0。
 */
export function installToastLift(root: HTMLElement): () => void {
  const shell = root.querySelector<HTMLElement>('[data-pkc-region="shell"]');
  const center = root.querySelector<HTMLElement>('[data-pkc-region="center"]');
  const append = root.querySelector<HTMLElement>('[data-pkc-region="append"]');
  if (shell === null || center === null || append === null) return () => undefined;
  let last = -1;
  const measure = (): void => {
    const c = center.getBoundingClientRect();
    let top = c.bottom;
    for (const el of [append, ...Array.from(center.querySelectorAll<HTMLElement>('[data-pkc-axis="y"]'))]) {
      if (el.hidden || el.closest('[hidden]') !== null) continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.top < top) top = r.top;
    }
    const lift = Math.max(0, Math.round(c.bottom - top));
    if (lift === last) return;
    last = lift;
    shell.style.setProperty('--pkc-toast-lift', `${String(lift)}px`);
  };
  measure();
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  const ro = new ResizeObserver(measure);
  ro.observe(center);
  ro.observe(append);
  const mo = new MutationObserver(measure);
  mo.observe(center, { attributes: true, attributeFilter: ['hidden', 'data-pkc-append-hidden'], subtree: true });
  return () => {
    ro.disconnect();
    mo.disconnect();
  };
}
