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

  var CJK = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
  var SPACE = /\s/;

  /**
   * span の列を、検索で突き合わせる 1 本の文字列にする(改行・連続する空白は空白 1 つに畳む)。
   * 🔑 pdf.js は行末の span に `hasEOL` を付ける。行末は**欧文では空白 1 つ**(「the」+改行+「lazy」= 「the lazy」)、
   * **日本語どうしの間では何も無し**(「文」+改行+「章」= 「文章」)として扱う。
   * 戻り値の `own[n]` / `at[n]` は、`text[n]` が**どの span の何字目(小文字化後)か**(行末が作った空白は -1)。
   *
   * @param {string[]} strs
   * @param {boolean[]|undefined} eols  span ごとの `hasEOL`(無ければ行末の情報なし = 連結のまま)
   */
  function build(strs, eols) {
    var text = '';
    var own = [];
    var at = [];
    var pending = false;
    for (var i = 0; i < strs.length; i += 1) {
      var s = String(strs[i]).toLowerCase();
      for (var j = 0; j < s.length; j += 1) {
        var ch = s.charAt(j);
        if (SPACE.test(ch)) {
          pending = false;
          if (text === '' || text.charAt(text.length - 1) === ' ') continue;
          text += ' ';
        } else {
          if (pending) {
            pending = false;
            var prev = text.charAt(text.length - 1);
            if (text !== '' && prev !== ' ' && !(CJK.test(prev) && CJK.test(ch))) {
              text += ' ';
              own.push(-1);
              at.push(0);
            }
          }
          text += ch;
        }
        own.push(i);
        at.push(j);
      }
      if (eols !== undefined && eols[i] === true && text !== '') pending = true;
    }
    return { text: text, own: own, at: at };
  }

  /** 検索語の空白も同じ作りに畳む(前後の空白は落とす)。 */
  function normQuery(query) {
    return String(query).replace(/\s+/g, ' ').replace(/^ | $/g, '');
  }

  /**
   * 検索語(小文字化済み)の一致を、span ごとの範囲にする。
   *
   * @param {string[]} strs  span ごとの字(`TextLayer.textContentItemsStr`。連結 = 検索が数える本文)
   * @param {string} query  小文字化済み・空でない検索語
   * @param {boolean[]} [eols]  span ごとの `hasEOL`(行末)。無ければ行末は無いものとして連結する
   * @returns {Map<number, Array<[number, number]>>}  span の番号 → その span の字の中の `[開始, 終了)`(昇順・重ならない)
   */
  function rangesBySpan(strs, query, eols) {
    var out = new Map();
    var q = normQuery(query);
    if (q === '') return out;
    // 🔑 大文字小文字は span ごとに小文字化して連結する(連結してから小文字化すると、span の境目が
    //    小文字化で伸び縮みしたとき、どの span の字か分からなくなる)
    var b = build(strs, eols);
    var pos = b.text.indexOf(q);
    while (pos !== -1) {
      var end = pos + q.length;
      var lo = new Map();
      var hi = new Map();
      for (var n = pos; n < end; n += 1) {
        var j = b.own[n];
        if (j < 0) continue;
        if (!lo.has(j) || b.at[n] < lo.get(j)) lo.set(j, b.at[n]);
        if (!hi.has(j) || b.at[n] + 1 > hi.get(j)) hi.set(j, b.at[n] + 1);
      }
      lo.forEach(function (from, j) {
        var to = hi.get(j);
        // 小文字化で長さが変わった span は、字の位置を原文へ写せない ── span 全体を強調する(欠けるより広いほうがよい)
        if (String(strs[j]).toLowerCase().length !== String(strs[j]).length) {
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
      });
      pos = b.text.indexOf(q, end);
    }
    return out;
  }

  /**
   * 一致の数(重ならない数え方)。`limit` に達したら数えるのをやめる。
   * 🔑 頁ごとの検索の数え(`reader.js`)と強調(`rangesBySpan`)が**同じ作りの本文**で突き合わせるための口。
   */
  function countHits(strs, query, eols, limit) {
    var q = normQuery(query);
    if (q === '') return 0;
    var text = build(strs, eols).text;
    var n = 0;
    var pos = text.indexOf(q);
    while (pos !== -1 && n < limit) {
      n += 1;
      pos = text.indexOf(q, pos + q.length);
    }
    return n;
  }

  /**
   * 一致ごとに「画面の `mark.hit` の何番目から始まるか」を返す(「3 / 7 件」の数字と光っている印を揃える口)。
   * 🔴 一致の数と印の数は一致しない ── 一致が span をまたげば印は複数になり、隣り合う一致は 1 つの印につながる。
   *   一致の番号をそのまま印の番号に使うと、数字と光っている所がずれる。
   * 印の並びは `rangesBySpan` の結果(span の昇順 → span の中の昇順)= 画面の `querySelectorAll('mark.hit')` の順。
   *
   * @returns {number[]}  一致の順 → その一致の先頭の字を含む印の番号
   */
  function markIndexOfHits(strs, query, eols) {
    var q = normQuery(query);
    var out = [];
    if (q === '') return out;
    var ranges = rangesBySpan(strs, query, eols);
    var spans = Array.from(ranges.keys()).sort(function (a, b) {
      return a - b;
    });
    var base = new Map();
    var acc = 0;
    spans.forEach(function (j) {
      base.set(j, acc);
      acc += ranges.get(j).length;
    });
    var b = build(strs, eols);
    var pos = b.text.indexOf(q);
    while (pos !== -1) {
      var n = pos;
      while (n < pos + q.length && b.own[n] < 0) n += 1;
      var j = b.own[n];
      var list = ranges.get(j);
      var k = 0;
      if (list !== undefined) {
        var at = b.at[n];
        for (var r = 0; r < list.length; r += 1) {
          if (list[r][0] <= at && at < list[r][1]) {
            k = r;
            break;
          }
        }
        out.push(base.get(j) + k);
      }
      pos = b.text.indexOf(q, pos + q.length);
    }
    return out;
  }

  root.PkcPdfTextHits = { rangesBySpan: rangesBySpan, countHits: countHits, markIndexOfHits: markIndexOfHits };
})(typeof self !== 'undefined' ? self : this);
