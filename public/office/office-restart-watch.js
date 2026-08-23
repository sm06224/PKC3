/**
 * 🔴 **「窓を開き直せば反映される」を、こちらから言えるようにする判断**(#160)。
 *
 * ## 直している実害
 *
 * UI 言語を変えると LO は「LibreOfficeDev の再起動」ダイアログを出すが、
 * **`すぐに再起動(R)` を押しても何も起きない**(実機レポート #8、1/1)。
 * wasm では LO の自己再起動が実装されていないためで、⚠ **user から見ると
 * 「押したのに効かないボタン」**である ── しかも言語を変えた直後なので、
 * 「このアプリは壊れている」と読まれる。
 *
 * 🚫 死んでいるのは **LO 自身の canvas の中のボタン**なので、こちらからは
 * 書き換えられない。だから直せるのは「**こちら側に効く道を用意する**」ほうである。
 *
 * ## 観測点 ── ダイアログの字ではなく、**設定の値**を見る
 *
 * ⚠ ダイアログの題名で見つけるのは**その時の UI 言語に依存する**(日本語で
 * 起動していれば日本語、英語なら英語)。しかも本件は**言語を変えた直後**に出るので、
 * いちばん当てにならない場面で字に頼ることになる。
 *
 * 🔑 代わりに **LO が書いた設定 file(`registrymodifications.xcu`)を見る**。
 * user が UI 言語を変えたとき LO が書く値は、上流を読んで**名前まで確かめた**:
 *
 *     cui/source/options/optgdlg.cxx:885-886
 *       sUserLocalePath = "org.openoffice.Office.Linguistic/General"
 *       sUserLocaleKey  = "UILocale"
 *     同 :1149-1159
 *       xProp->setPropertyValue(sUserLocaleKey, ...) → commitChanges()
 *       → svtools::executeRestartDialog(..., RESTART_REASON_LANGUAGE_CHANGE)
 *
 * つまり **この値を書く処理の次の行が、当の「再起動して」ダイアログ**である ──
 * 症状との結び付きがこれ以上ないほど固い。
 *
 * ⚠ **`ooLocale` ではない。** `/org.openoffice.Setup/L10N` の `ooLocale` は
 * もっともらしいが、Options の言語ページが書くのは上の `UILocale` のほうだった
 * (推測で書いていたら、帯は**永久に出ないのに test は緑**になっていた)。
 * ⚠ `ooSetupSystemLocale`(ロケール設定)は**再起動を要求しない**ので見ない ──
 * 見ると偽の帯が出る。
 *
 * ## ⚠ ここは「判断」だけ
 *
 * FS も DOM も timer も触らない ── `host.html` が file を読んでここへ流し、
 * ここが「再起動が要る」を返す。🔑 そうしないと **unit が 1 件も届かない**
 * (`host.html` は bundle されない生 HTML である ── `office-save-watch.js` が
 * 分かれているのと同じ理由)。
 * ⚠ 素の JS(ES5 相当)で書く ── `host.html` が `<script src>` で読むので
 * bundler を通らない。
 */
(function (root) {
  'use strict';

  /** 🔴 上流で確かめた在り処(上の docstring 参照)。⚠ 推測で書き換えない。 */
  var UI_LOCALE_PATH = '/org.openoffice.Office.Linguistic/General';
  var UI_LOCALE_KEY = 'UILocale';

  /**
   * `registrymodifications.xcu` の本文から **UI 言語の設定値**を取り出す。
   *
   * 返り値は 3 通り。⚠ **`null` と `''` を混ぜない**:
   *   `null` … 読めなかった(XML が壊れている / DOMParser が無い)= **比べてはいけない**
   *   `''`   … 設定が書かれていない(= 既定のまま)
   *   その他 … 書かれている値(`'en-US'` など)
   *
   * ⚠ 文字列検索で拾わない ── `UILocale` という語は他の item のコメントや
   * 別の path の下にも現れうる(CLAUDE.md §1「範囲が広すぎて無関係な散文に満たされる」)。
   * **path と name の両方が一致した prop の `<value>` だけ**を採る。
   */
  function readUiLocale(text) {
    if (typeof text !== 'string' || text === '') return null;
    var P = root.DOMParser;
    if (typeof P !== 'function') return null;
    try {
      var doc = new P().parseFromString(text, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length > 0) return null;
      var items = doc.getElementsByTagName('item');
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].getAttribute('oor:path') !== UI_LOCALE_PATH) continue;
        var props = items[i].getElementsByTagName('prop');
        for (var j = 0; j < props.length; j += 1) {
          if (props[j].getAttribute('oor:name') !== UI_LOCALE_KEY) continue;
          var v = props[j].getElementsByTagName('value')[0];
          // ⚠ `<value/>`(空)は「既定へ戻した」であって「読めなかった」ではない
          return v ? String(v.textContent || '') : '';
        }
      }
      return '';
    } catch (e) {
      return null;
    }
  }

  /**
   * 見張りを 1 つ作る。
   *
   * `note(text)` は「**いま初めて『再起動が要る』と分かった**」ときだけ `true` を返す。
   *
   * ⚠ **掛け金を掛ける**(一度 `true` を返したら以後は `false`)── 帯は 1 枚でよく、
   * 3 秒ごとに出し直すと user の操作を邪魔する。
   * ⚠ **最初の 1 回は基準を採るだけ**(必ず `false`)── 起動時点の値と比べるので、
   * 基準が無い状態で比べてはいけない。
   * ⚠ 読めなかった回(`null`)は**何もしない** ── 基準にも据えないし、変化とも数えない
   * (壊れた 1 回で基準が消えると、その後の本物の変更を見落とす)。
   */
  function createRestartWatch() {
    var baseline = null;
    var latched = false;
    return {
      note: function (text) {
        var loc = readUiLocale(text);
        if (loc === null) return false;
        if (baseline === null) { baseline = loc; return false; }
        if (latched || loc === baseline) return false;
        latched = true;
        return true;
      },
      /** 採った基準(まだ無ければ `null`)── 検査と診断のために見せる。 */
      baseline: function () { return baseline; },
      /** 既に帯を出したか。 */
      latched: function () { return latched; },
    };
  }

  root.PKC3OfficeRestartWatch = {
    UI_LOCALE_PATH: UI_LOCALE_PATH,
    UI_LOCALE_KEY: UI_LOCALE_KEY,
    readUiLocale: readUiLocale,
    createRestartWatch: createRestartWatch,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
