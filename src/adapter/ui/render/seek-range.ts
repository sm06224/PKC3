/**
 * 🔴 **録音の長さを超える時刻は、再生の字にしない**(#1163 依頼 373、推薦 C。user 裁定 2026-11-15)。
 *
 * > 録音の文字起こしの行頭の時刻は押すとそこから再生する(#1232)。ただし行頭に書いた時計の時刻(`14:00 会議`)も
 * > 押せる字になっていた ── 10 分の録音で `14:00` を押しても、そこには何も無い。
 *
 * 🔑 長さは**再生機が読み込んだとき**(`loadedmetadata`)にしか分からない ── 描くときではなく、分かった時点で
 *   長さを超える時刻の印を外して、ふつうの字に戻す(見た目の下線も、押しても動かない字も残さない)。
 * ⚠ 長さが分からない(`Infinity` / `NaN`。配信型の webm など)ときは何もしない ── 確かでない長さで字を外さない。
 */
const LINK = '.pkc-seek-link[data-pkc-seek-ms]';

/** `durationMs` を超える時刻の再生の字を、ふつうの字に戻す。@returns 戻した数 */
export function limitSeekLinks(root: ParentNode, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  let n = 0;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(LINK))) {
    const at = Number(el.getAttribute('data-pkc-seek-ms'));
    if (!Number.isFinite(at) || at <= durationMs) continue;
    el.replaceWith(el.ownerDocument.createTextNode(el.textContent ?? ''));
    n += 1;
  }
  return n;
}

/**
 * 再生機(`<audio>` / `<video>`)が長さを読んだら、`desc` の中の時刻を絞る。
 * ⚠ `loadedmetadata` は泡立たない ── 再生機を包む器(`host`)で**捕まえる側**(capture)に付ける。
 * @returns 外す手
 */
export function watchSeekRange(host: HTMLElement, desc: ParentNode): () => void {
  const on = (e: Event): void => {
    const media = e.target;
    if (!(media instanceof HTMLMediaElement)) return;
    limitSeekLinks(desc, media.duration * 1000);
  };
  host.addEventListener('loadedmetadata', on, true);
  return () => host.removeEventListener('loadedmetadata', on, true);
}
