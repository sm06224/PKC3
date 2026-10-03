/**
 * 文書内検索の一致を、pdf.js の文字の層の **span ごとの範囲**へ割り付ける(#275 段①の残り)。
 *
 * ⚠ 一致は 1 つの span に収まるとは限らない ── pdf.js は**書体が変わる / 間が空く**ところで文字を別の
 * 塊(= 別の span)に分けるので、「あい」が span「あ」+「い」にまたがることがある。
 * 🔑 だから **全 span の字を連結した 1 本の文字列**で一致を取り(`search` が頁ごとに数える本文と同じ作り)、
 * 一致の範囲が重なる**全部の span**へ、その span の中の部分範囲として割り付ける。
 * (先頭の span だけへ割り付けると、またがる一致は強調が欠ける ── 一致の数は数えているのに画面に出ない)
 *
 * ⚠ 素の JS(classic script)── `public/` の窓は bundle を通らない。純粋関数だけ
 *   (DOM は触らない)なので、`tests/adapter/pdf-text-hits.test.ts` が**この file の原文を読んで**走らせる。
 */
(function (root) {
  'use strict';

  /**
   * 検索語(小文字化済み)の一致を、span ごとの範囲にする。
   *
   * @param {string[]} strs  span ごとの字(`TextLayer.textContentItemsStr`。連結 = 検索が数える本文)
   * @param {string} query  小文字化済み・空でない検索語
   * @returns {Map<number, Array<[number, number]>>}  span の番号 → その span の字の中の `[開始, 終了)`(昇順・重ならない)
   */
  function rangesBySpan(strs, query) {
    var out = new Map();
    if (query === '') return out;
    // 🔑 大文字小文字は span ごとに小文字化して連結する(連結してから小文字化すると、span の境目が
    //    小文字化で伸び縮みしたとき、どの span の字か分からなくなる)
    var lowered = [];
    var starts = [];
    var off = 0;
    for (var i = 0; i < strs.length; i += 1) {
      var s = String(strs[i]).toLowerCase();
      lowered.push(s);
      starts.push(off);
      off += s.length;
    }
    var text = lowered.join('');
    var k = 0;
    var at = text.indexOf(query);
    while (at !== -1) {
      var end = at + query.length;
      // 一致は昇順に来るので、span の番号は前から進める
      while (k < strs.length && starts[k] + lowered[k].length <= at) k += 1;
      for (var j = k; j < strs.length && starts[j] < end; j += 1) {
        var len = lowered[j].length;
        if (len === 0) continue;
        var from = Math.max(at, starts[j]) - starts[j];
        var to = Math.min(end, starts[j] + len) - starts[j];
        // 小文字化で長さが変わった span は、字の位置を原文へ写せない ── span 全体を強調する(欠けるより広いほうがよい)
        if (len !== String(strs[j]).length) {
          from = 0;
          to = String(strs[j]).length;
        }
        var list = out.get(j);
        if (list === undefined) {
          list = [];
          out.set(j, list);
        }
        var last = list[list.length - 1];
        if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
        else list.push([from, to]);
      }
      at = text.indexOf(query, end);
    }
    return out;
  }

  root.PkcPdfTextHits = { rangesBySpan: rangesBySpan };
})(typeof self !== 'undefined' ? self : this);
