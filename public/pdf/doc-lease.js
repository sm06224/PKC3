/**
 * 開いた PDF(= pdf.js の解析 worker)の**貸し出し**(#275 段①の残り)。
 *
 * 🔴 不可侵指示(2026-08-03):重い処理はワーカーへ・**ワーカーはしばらく使われないなら kill と解放し、
 * ジョブはバッファして再起動後にディスパッチする**。`src/adapter/platform/worker-lease.ts` と同じ 3 つの規律を、
 * pdf.js の窓(素の JS・bundle を通らない)向けに写した物である:
 *
 *   1. **遅延起動** ── 要るまで開かない(`use` が呼ばれて初めて `open`)
 *   2. **ジョブのバッファ** ── 開いている最中に来た依頼は**同じ 1 回の起動を待つ**(落とさない・二重に開かない)
 *   3. **アイドルで kill と解放** ── 飛んでいる依頼が 0 のまま `idleMs` 経ったら `close`(= `pdf.destroy()` =
 *      解析 worker の terminate)。次の依頼が来たら黙って開き直す
 *
 * 🔴 **飛んでいる依頼がある間は kill しない**(アイドル = 「依頼が 0 件」であって「最後の投函から N ms」ではない ──
 *   後者だけだと、N ms より長い 1 件を殺す)。
 * 🔴 **畳むときに待っている依頼を必ず reject する**(`dispose`)── 捨てるだけだと `await` が永久に返らない。
 * ⚠ なぜ `WorkerLease` を使わないか: あちらは「こちらが組んだ封筒を `postMessage` で投げる」形のワーカー用で、
 *   pdf.js は**自分で worker を持ち自分の口で話す**(`getDocument` / `destroy`)ので封筒の層が噛み合わない。
 *   方針だけ写し、実体は分ける(`duckdb-lease.ts` と同じ判断)。
 * 🔑 描いた頁の絵(PNG)・文字の層・検索用の本文は**窓の側が持つ**ので、kill しても残る
 *   (開き直しが要るのは、まだ描いていない頁を描くときだけ)。
 *
 * ⚠ 素の JS(classic script)── `public/` の窓は bundle を通らない。
 *   `tests/adapter/pdf-doc-lease.test.ts` が**この file の原文を読んで**走らせる。
 */
(function (root) {
  'use strict';

  /**
   * 何もしていない状態がこれだけ続いたら畳む(ms)。
   *
   * 🔑 他の計算 worker の idle(15〜30 秒)より**長い 60 秒**にしてある ── あちらは「1 件投げて返事を待つ」
   * 短い仕事の worker で、ここは **1 頁を読んでいる間**(頁をめくる間隔)を跨がせたくないため。
   * 短すぎると、頁をめくるたびに開き直して**かえって重くなる**(`WorkerLease.idleMs` の注記と同じ)。
   */
  var IDLE_MS = 60000;

  /**
   * @param {object} opts
   * @param {() => Promise<any>} opts.open  文書を開く(**呼ばれるまで開かない**)
   * @param {(doc: any) => (void | Promise<void>)} opts.close  畳む(`destroy`。例外を投げても「畳んだ」ものとして進む)
   * @param {number} [opts.idleMs]
   * @param {(fn: () => void, ms: number) => any} [opts.setTimer]  test が差し替える(実時間を待たない)
   * @param {(h: any) => void} [opts.clearTimer]
   */
  function DocLease(opts) {
    this.openDoc = opts.open;
    this.closeDoc = opts.close;
    this.idleMs = opts.idleMs === undefined ? IDLE_MS : opts.idleMs;
    this.setTimer =
      opts.setTimer ||
      function (fn, ms) {
        return setTimeout(fn, ms);
      };
    this.clearTimer =
      opts.clearTimer ||
      function (h) {
        clearTimeout(h);
      };
    this.doc = null;
    /** 開いている最中の 1 回(⚠ 起動待ちに来た依頼は全部これを待つ = バッファ)。 */
    this.opening = null;
    /** 飛んでいる依頼の数(0 = アイドル)。 */
    this.busy = 0;
    this.timer = null;
    this.disposed = false;
    /** 開いた回数(test と計測の観測点)。 */
    this.opened = 0;
  }

  /** いま解析 worker が生きているか(= 文書を握っているか)。 */
  Object.defineProperty(DocLease.prototype, 'alive', {
    get: function () {
      return this.doc !== null;
    },
  });

  DocLease.prototype.cancelIdle = function () {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  };

  DocLease.prototype.armIdle = function () {
    if (this.disposed || this.doc === null || this.busy > 0) return;
    this.cancelIdle();
    var self = this;
    this.timer = this.setTimer(function () {
      self.timer = null;
      self.onIdle();
    }, this.idleMs);
  };

  DocLease.prototype.onIdle = function () {
    // 🔴 飛んでいる依頼がある間は畳まない(予約の後に投函されたものを殺さない)
    if (this.busy > 0 || this.opening !== null || this.doc === null) return;
    var doc = this.doc;
    this.doc = null;
    this.release(doc);
  };

  DocLease.prototype.release = function (doc) {
    try {
      var r = this.closeDoc(doc);
      if (r && typeof r.catch === 'function') r.catch(function () {});
    } catch (e) {
      // 畳む途中の例外は握りつぶす(畳んだものとして進む)
    }
  };

  DocLease.prototype.ensure = function () {
    if (this.disposed) return Promise.reject(new Error('doc-lease: disposed'));
    if (this.doc !== null) return Promise.resolve(this.doc);
    if (this.opening === null) {
      var self = this;
      var started;
      try {
        // 🔑 同期に始める(「呼ばれるまで開かない」が、呼ばれた瞬間に開き始める)
        started = Promise.resolve(self.openDoc());
      } catch (e) {
        started = Promise.reject(e);
      }
      this.opening = started.then(
          function (doc) {
            self.opening = null;
            // 開いている間に畳まれた ── 受け取った文書をそのまま手放す
            if (self.disposed) {
              self.release(doc);
              throw new Error('doc-lease: disposed');
            }
            self.doc = doc;
            self.opened += 1;
            return doc;
          },
          function (e) {
            self.opening = null;
            throw e;
          },
        );
    }
    return this.opening;
  };

  /**
   * 1 件流す。⚠ 文書が無ければ**ここで開く**(遅延起動)。`fn` の間は「飛んでいる」とみなし、畳まない。
   * @template T
   * @param {(doc: any) => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  DocLease.prototype.use = function (fn) {
    var self = this;
    this.busy += 1;
    // アイドル kill の予約は**投函した時点で**畳む
    this.cancelIdle();
    var done = function () {
      self.busy -= 1;
      if (self.busy === 0) self.armIdle();
    };
    return this.ensure().then(
      function (doc) {
        return Promise.resolve()
          .then(function () {
            return fn(doc);
          })
          .then(
            function (v) {
              done();
              return v;
            },
            function (e) {
              done();
              throw e;
            },
          );
      },
      function (e) {
        done();
        throw e;
      },
    );
  };

  /** 明示的に畳む(窓を閉じる / 内蔵の表示へ退避する)。⚠ 以後の依頼は reject する。 */
  DocLease.prototype.dispose = function () {
    this.disposed = true;
    this.cancelIdle();
    if (this.doc !== null) {
      var doc = this.doc;
      this.doc = null;
      this.release(doc);
    }
  };

  root.PkcPdfDocLease = { DocLease: DocLease, IDLE_MS: IDLE_MS };
})(typeof self !== 'undefined' ? self : this);
