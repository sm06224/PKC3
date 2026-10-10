/**
 * 🔴 **Office の上のバーの文書名を、閉じた文書のまま残さない判断**(#1363 の 3)。
 *
 * ## 直している実害
 *
 * バーの文書名(`#name`)は**開いたときに 1 度だけ**書いていた。文書を閉じて
 * スタートセンターへ戻っても、Impress を新しく作っても、バーは「New Text.docx」のまま残る
 * (cowork の実機報告 2026-10-06)── user は「まだその文書を開いている」と読む。
 *
 * ## 観測点 ── LO の窓の題名
 *
 * 開いたかどうかは既に **Qt が DOM へ出す窓の題名**で見ている(`host.html` の `docOpened`)。
 * 🔑 同じ観測点を**開いた後も**ときどき見て、文書の名前が題名から消えたら名前を外す
 * (LO から「閉じた」の知らせは来ないので、こちらから見る)。
 * ⚠ 別の名前を出すことはしない ── LO が付けた題名(「無題 1」など)は UI 言語で変わるので、
 *   拾って写すと字が揺れる。分かっていることだけ書く:**開いた文書がまだ在るか**。
 *
 * ## ⚠ ここは「判断」だけ
 *
 * DOM も timer も触らない ── `host.html` が題名を見てここへ流し、ここが「バーをどうするか」を返す。
 * `host.html` は bundle されないので、ここへ出さないと unit が 1 件も届かない
 * (`office-restart-watch.js` と同じ理由)。素の JS(ES5 相当)で書く。
 */
(function (root) {
  'use strict';

  /** 題名を見る間隔。⚠ 見るたびに Qt の DOM を歩くので、打鍵ごとには見ない。 */
  var TITLE_POLL_MS = 2000;
  /**
   * 何回続けて見えなかったら外すか。
   * ⚠ 1 回で外さない ── 窓を作り直している途中など、題名が一瞬だけ取れない回がありうる
   *   (外して戻すと、バーの字がちらつく)。
   */
  var MISSES_TO_CLEAR = 2;

  /**
   * 見張りを 1 つ作る。`name` は開いた文書の名前(バーに出している字)。
   *
   * `observe(present)` は**バーを書き換えるときだけ**新しい字を返す。書き換えないときは `null`。
   *   - 見えなくなって `MISSES_TO_CLEAR` 回続いた → `''`(名前を外す。バーは「Office」だけになる)
   *   - 外した後にまた見えた(同じ文書を開き直した)→ `name`(戻す)
   * ⚠ 同じ字を何度も返さない(書き込みは変わるときだけ)。
   */
  function createTitleWatch(name) {
    var misses = 0;
    var shown = true;
    return {
      observe: function (present) {
        if (present) {
          misses = 0;
          if (shown) return null;
          shown = true;
          return name;
        }
        misses += 1;
        if (!shown || misses < MISSES_TO_CLEAR) return null;
        shown = false;
        return '';
      },
      /** いまバーに名前を出しているか ── 検査と診断のために見せる。 */
      shown: function () { return shown; },
    };
  }

  root.PKC3OfficeTitleWatch = {
    TITLE_POLL_MS: TITLE_POLL_MS,
    MISSES_TO_CLEAR: MISSES_TO_CLEAR,
    createTitleWatch: createTitleWatch,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
