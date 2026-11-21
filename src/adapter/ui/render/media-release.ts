/**
 * 🔴 **音・動画の器から URL を外してから返す**(founding §2-4「ゼロコピー・寿命の終端で即破棄」)。
 *
 * ⚠ `<audio>` / `<video>` は**読み込みの途中で URL が死ぬと、数百ミリ秒おきに読み直す**
 *   (Chromium の実測: `Failed to load resource: net::ERR_FILE_NOT_FOUND @ blob:…` が約 400ms おき)。
 *   読み込み中の器は画面から外れても**ブラウザが生かしておく**ので、外したあとも読み直しは止まらない。
 * 🔑 だから **revoke の前に `src` を外して `load()` する** ── `src` を外すだけでは読み込みは止まらない
 *   (HTML の仕様: 読み込みを捨てるのは `load()` の「器を空にする」段)。`src` も `<source>` も無い器の
 *   `load()` は `error` を出さずに `NETWORK_EMPTY` で終わるので、`replaceOnMediaError` の 1 行にも化けない。
 *
 * @param root この要素自身と、その中の音・動画の器を見る
 * @param url  この URL を差している器だけ外す。`null` なら中の器を全部外す(器ごと捨てる貸出)
 */
export function unloadMedia(root: Element, url: string | null): void {
  const els: HTMLMediaElement[] = [];
  if (root instanceof HTMLMediaElement) els.push(root);
  els.push(...root.querySelectorAll<HTMLMediaElement>('audio, video'));
  for (const el of els) {
    if (url !== null && el.getAttribute('src') !== url) continue;
    try {
      el.pause();
      el.removeAttribute('src');
      el.load();
    } catch {
      // 外せなくても、返す側(revoke)は止めない
    }
  }
}
