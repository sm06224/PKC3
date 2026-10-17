/**
 * ページの一覧(窓の左に縦に並ぶ小さな絵)の、**どの頁を描くか / どの頁を光らせるか**の判断(#275 段②-1a)。
 *
 * 絵を描くのは `reader.js`(pdf.js の worker を借りる)。ここは**判断だけ**で、DOM にも pdf.js にも触らない
 * (取り出して test できる形にしてある)。
 *
 * 🔴 不可侵指示(重い処理は窓の外へ / 描いたら焼いて即返す)に沿って、**一覧の中で見えている頁の前後だけ**を描く。
 * 100 頁の文書でも、一度に持つ絵は `limit` 枚まで。
 *
 * ⚠ 素の JS(classic script)で書く ── `public/` の窓は bundle を通らない。
 *   `tests/adapter/pdf-page-list.test.ts` が**この file の原文を読んで**走らせる。
 */
(function (root) {
  'use strict';

  /**
   * 描く頁。一覧で見えている頁(`visible`)の前後 `radius` 頁を、`center` に近い順に `limit` 枚まで。
   * @param {Iterable<number>} visible  一覧の枠の中に見えている頁番号
   * @returns {Set<number>}  何も見えていなければ空(一覧を隠している間は何も持たない)
   */
  function thumbWanted(visible, total, radius, limit, center) {
    var lo = Infinity;
    var hi = -Infinity;
    visible.forEach(function (p) {
      if (p >= 1 && p <= total) {
        if (p < lo) lo = p;
        if (p > hi) hi = p;
      }
    });
    var out = new Set();
    if (lo === Infinity) return out;
    var from = Math.max(1, lo - radius);
    var to = Math.min(total, hi + radius);
    var all = [];
    for (var i = from; i <= to; i += 1) all.push(i);
    all.sort(function (a, b) {
      return Math.abs(a - center) - Math.abs(b - center) || a - b;
    });
    all.slice(0, limit).forEach(function (p) {
      out.add(p);
    });
    return out;
  }

  /**
   * 次に描く頁。まだ持っていない・描いている最中でもない頁のうち、`center` にいちばん近いもの。
   * @param {Set<number>} wanted
   * @param {(p: number) => boolean} skip  持っている / 描いている最中なら true
   * @returns {number | null}
   */
  function pickNext(wanted, skip, center) {
    var best = null;
    wanted.forEach(function (p) {
      if (skip(p)) return;
      if (
        best === null ||
        Math.abs(p - center) < Math.abs(best - center) ||
        (Math.abs(p - center) === Math.abs(best - center) && p < best)
      ) {
        best = p;
      }
    });
    return best;
  }

  /**
   * いまの頁の光らせ方。`prev` から `next` へ変わるとき、消す頁と点ける頁を返す。
   * 変わらない / 範囲の外なら `null`(何もしない)。
   * @returns {{ off: number | null, on: number } | null}
   */
  function currentChange(prev, next, total) {
    if (!(next >= 1 && next <= total)) return null;
    if (prev === next) return null;
    return { off: prev >= 1 && prev <= total ? prev : null, on: next };
  }

  /**
   * 読んでいる位置を「そのページの何割まで読み進んだか」で控える(#1663)。拡大縮小や窓の大きさ・一覧の出し入れで
   * ページの大きさが変わっても、同じ所を出し直すため。`viewTop` = 読む面の上端 / `boxTop`・`boxH` = ページの上端と高さ(同じ座標)。
   * ページの上より前(隙間)は 0、下より後は 1。高さが 0 以下(測れない)なら `null`。
   */
  function readFraction(viewTop, boxTop, boxH) {
    if (!(boxH > 0)) return null;
    return Math.max(0, Math.min(1, (viewTop - boxTop) / boxH));
  }

  /** 控えた割合 `frac` の所を読む面の上端に出すために、読む面を動かす量(px。`scrollTop` に足す)。 */
  function scrollDelta(viewTop, boxTop, boxH, frac) {
    return boxTop - viewTop + frac * boxH;
  }

  root.PkcPdfPageList = { readFraction: readFraction, scrollDelta: scrollDelta, thumbWanted: thumbWanted, pickNext: pickNext, currentChange: currentChange };
})(typeof self !== 'undefined' ? self : this);
