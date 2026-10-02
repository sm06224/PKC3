/**
 * 描いた頁の絵(ObjectURL)の置き場 ── **描いたら焼き、外れたら即 revoke する**(#275 段①)。
 *
 * 🔴 不可侵指示(2026-07-27 / 2026-08-03):生成物は**寿命の終端で破棄**する。ここでの終端は
 * 「可視頁の ±N から外れた」か「置き場から押し出された」か「窓が閉じた」── どれでも
 * `revoke` を**必ず 1 度**呼ぶ(呼ばれない経路が在ると、閉じるまで blob が積もる)。
 *
 * ⚠ 素の JS(classic script)で書く ── `public/` の窓は bundle を通らない。
 *   `tests/adapter/pdf-page-cache.test.ts` が**この file の原文を読んで**走らせる。
 */
(function (root) {
  'use strict';

  /**
   * @param {number} limit  同時に持てる頁の数(これを超えたら**使われていない順**に revoke)
   * @param {(url: string) => void} revoke  URL を返す口
   */
  function PageCache(limit, revoke) {
    this.limit = limit;
    this.revoke = revoke;
    /** 頁番号 → URL。⚠ Map の挿入順 = 使った順(古いものが先頭)。 */
    this.map = new Map();
  }

  /** 置く。同じ頁が既に在れば、古い URL を**先に返してから**差し替える。 @returns 押し出された頁番号 */
  PageCache.prototype.put = function (page, url) {
    var evicted = [];
    if (this.map.has(page)) {
      this.revoke(this.map.get(page));
      this.map.delete(page);
    }
    this.map.set(page, url);
    while (this.map.size > this.limit) {
      var oldest = this.map.keys().next().value;
      this.revoke(this.map.get(oldest));
      this.map.delete(oldest);
      evicted.push(oldest);
    }
    return evicted;
  };

  /** 見る(使った扱いにして末尾へ回す)。 */
  PageCache.prototype.get = function (page) {
    if (!this.map.has(page)) return null;
    var url = this.map.get(page);
    this.map.delete(page);
    this.map.set(page, url);
    return url;
  };

  PageCache.prototype.has = function (page) {
    return this.map.has(page);
  };

  /** 残す頁(`Set<number>`)以外を全部返す。@returns 外した頁番号 */
  PageCache.prototype.retain = function (keep) {
    var dropped = [];
    var self = this;
    this.map.forEach(function (url, page) {
      if (!keep.has(page)) dropped.push(page);
    });
    dropped.forEach(function (page) {
      self.revoke(self.map.get(page));
      self.map.delete(page);
    });
    return dropped;
  };

  /** 全部返す(拡大したとき / 窓を閉じるとき)。 */
  PageCache.prototype.clear = function () {
    var self = this;
    this.map.forEach(function (url) {
      self.revoke(url);
    });
    this.map.clear();
  };

  /**
   * 描く範囲。見えている頁の前後 `radius` 頁(1〜total に収める)。
   * @returns {Set<number>}
   */
  function windowOf(first, last, total, radius) {
    var out = new Set();
    var lo = Math.max(1, first - radius);
    var hi = Math.min(total, last + radius);
    for (var i = lo; i <= hi; i += 1) out.add(i);
    return out;
  }

  root.PkcPdfPageCache = { PageCache: PageCache, windowOf: windowOf };
})(typeof self !== 'undefined' ? self : this);
