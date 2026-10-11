/**
 * ページの編集(並べ替え・回す・外す)の**計画**(#275 段②-1b)── 画面の操作を「作り方」に直す純粋な判断。
 *
 * 画面(`reader.js`)は 1 ページごとに `{ page, rot }` を持つ並びを握る。`page` は**元の PDF の何ページ目か**、
 * `rot` は**そのページを右へ何度回したか**(0 / 90 / 180 / 270)。ここは並びを作り替える関数と、
 * worker へ渡す依頼(`{ order, rotate }`)への変換だけで、DOM にも pdf-lib にも触らない
 * (取り出して test できる形にしてある)。
 *
 * 🔑 worker へ渡すのは**ページ番号の並びと回す角度だけ**(設計 doc §3.1)。bytes は別に transfer する。
 * ⚠ 並びは**書き換えない**(毎回新しい配列を返す)── 画面は返った並びを丸ごと取り替える。
 * ⚠ 素の JS(classic script)で書く ── `public/` の窓は bundle を通らない。
 *   `tests/adapter/pdf-page-edit.test.ts` が**この file の原文を読んで**走らせる。
 */
(function (root) {
  'use strict';

  /** 元のとおりの並び(1 ページ目から `total` ページ目まで、回していない)。 */
  function fresh(total) {
    var out = [];
    for (var i = 1; i <= total; i += 1) out.push({ page: i, rot: 0 });
    return out;
  }

  /** `at` 番目(0 始まり)を右へ 90° 回す。範囲の外なら同じ並びを返す。回すたびに足し、360° で 0 に戻る。 */
  function rotateAt(items, at) {
    if (!(at >= 0 && at < items.length)) return items.slice();
    return items.map(function (it, i) {
      return i === at ? { page: it.page, rot: (it.rot + 90) % 360 } : it;
    });
  }

  /** `at` 番目を外す。範囲の外なら同じ並びを返す。 */
  function removeAt(items, at) {
    if (!(at >= 0 && at < items.length)) return items.slice();
    return items.filter(function (_, i) {
      return i !== at;
    });
  }

  /**
   * `from` 番目を取り出して、**取り出した後の並びの** `to` 番目へ入れる(ドラッグでもキーでも、これ 1 本)。
   * 範囲の外は端に丸める。動かないなら同じ並びを返す。
   */
  function moveTo(items, from, to) {
    if (!(from >= 0 && from < items.length)) return items.slice();
    var dest = Math.max(0, Math.min(items.length - 1, to));
    if (dest === from) return items.slice();
    var out = items.slice();
    var one = out.splice(from, 1)[0];
    out.splice(dest, 0, one);
    return out;
  }

  /** 元のままか(同じページが同じ順で、回していない)。 */
  function isChanged(items, total) {
    if (items.length !== total) return true;
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].page !== i + 1 || items[i].rot !== 0) return true;
    }
    return false;
  }

  /**
   * worker へ渡す依頼。`order` = 残すページ(元の番号)を出力の順に / `rotate` = 回すページ(元の番号)→ 右へ回す角度。
   * 回していないページは `rotate` に載せない。
   */
  function toJob(items) {
    var order = [];
    var rotate = {};
    items.forEach(function (it) {
      order.push(it.page);
      if (it.rot !== 0) rotate[it.page] = it.rot;
    });
    return { order: order, rotate: rotate };
  }

  /** 保存できるか(0 ページの PDF は作らない)。 */
  function canSave(items) {
    return items.length >= 1;
  }

  /**
   * 保存した PDF の名前。`元の名前.pdf` → `元の名前 (編集).pdf`(拡張子は大文字小文字を問わず取り、
   * 無ければ付け足す)。既に ` (編集)` で終わっていれば重ねない。
   */
  function outputName(name) {
    var base = String(name || '').replace(/\.pdf$/i, '');
    if (base === '') base = 'document';
    if (!/ \(編集\)$/.test(base)) base += ' (編集)';
    return base + '.pdf';
  }

  /** 2 つの並びが同じか(同じページが同じ順で、同じ向き)。保存した並びを基準にして「まだ保存していない変更」を見る。 */
  function sameArrangement(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i += 1) {
      if (a[i].page !== b[i].page || a[i].rot !== b[i].rot) return false;
    }
    return true;
  }

  /**
   * 編集中の案内の 1 行(ページ数と、保存するとどうなるか)。引き継がれない物は別の行(`warnLine`)。
   * @returns {string}
   */
  function noteLine(kept, total) {
    var line = '編集中(' + String(kept) + ' / ' + String(total) + ' ページ)。';
    if (kept < 1) return line + 'すべてのページを外したので、保存できません。';
    return line + '保存すると新しい PDF として添付に加わります(元の PDF は変わりません)。';
  }

  /**
   * 引き継がれない物の 1 行。**元にあるものだけ**言う。1 つも無ければ空(行ごと出さない)。
   * @param {{ outlines: boolean, form: boolean, signature: boolean }} info  元の PDF にあるもの
   * @returns {string}
   */
  function warnLine(info) {
    var line = '';
    if (info.outlines) line += 'しおりは引き継がれません。';
    if (info.form) line += '入力欄は引き継がれません。';
    if (info.signature) line += '電子署名は無効になります。';
    return line;
  }

  root.PkcPdfPageEdit = {
    fresh: fresh,
    rotateAt: rotateAt,
    removeAt: removeAt,
    moveTo: moveTo,
    isChanged: isChanged,
    toJob: toJob,
    canSave: canSave,
    outputName: outputName,
    sameArrangement: sameArrangement,
    noteLine: noteLine,
    warnLine: warnLine,
  };
})(typeof self !== 'undefined' ? self : this);
