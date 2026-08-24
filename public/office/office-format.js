/**
 * 🔴 **この形式は、この Office で保存できるか**(#225)。
 *
 * ## 測って分かったこと(2026-08-23、**古い一式**での観測)
 *
 * 同じ腕・同じ打鍵で **9 形式**を回した実測 ── **ODF 4/4 が通り、非 ODF 5/5 が落ちる**
 * (Writer / Calc / Impress のどれでも同じ):
 *
 * | 形式 | Ctrl+S の後 | |
 * |---|---|---|
 * | `.odt` 8,289 → **9,192** / `.ods` 8,991 → **9,676** | 増える | ✅ |
 * | `.odp` 841 → **11,452** / `.odg` 12,401 → **13,447** | 増える | ✅ |
 * | `.rtf` / `.doc` / `.docx` / `.xlsx` | 変わらず | 🔴 「一般的な I/O エラー」 |
 * | `.pptx` | 変わらず | 🔴 ⚠ **小窓すら出ない**(黙って保存されない) |
 *
 * ## 🔴 原因の説明は**間違っていた**(2026-08-24 に訂正)
 *
 * ⚠ ここには当初「分かれ目は ODF かどうかで、上流の `IsPackageStorageFormat_Impl` /
 * `FileFormatVersion = 0` のせい」と書いていた。**推測であり、誤りだった。**
 *
 * 真因は **`cui/ui/querydialog.ui` が一式に入っていなかったこと**である(#225)。
 * LO は非 ODF で保存するとき必ず「標準のファイル形式ではありません」と**訊く**が、
 * その `.ui` が無いので例外が飛び、`sfx2/source/doc/objserv.cxx` の
 * `catch(Exception&)` が `ERRCODE_IO_GENERAL` = 「一般的な I/O エラー」に化けていた。
 * 計装が例外の message でこれを確定させ、`.ui` を補って焼いたら
 * **`.docx` は 1,269 → 5,987 B で保存できた**(小窓が出て、答えると書ける)。
 *
 * 🔑 **上の表は「観測」なので残す。消えたのは「説明」だけである。**
 * ⚠ ただし表は**その一式の性質**であって、形式そのものの性質ではない ──
 * 直した一式では変わる。
 *
 * ## ⚠ だから、ここはまだ ODF だけを真にしている
 *
 * 🔴 **単純に非 ODF を足してはいけない。** 直した一式を配っても、
 * **古い一式を入れたままの user には上の表がそのまま正しい** ── そこで
 * 「保存できます」と言うと、その人は**編集を失う**。
 * 🔑 直し方は「入っている一式が保存できるかどうか」で出し分けること(#225 の続き)。
 * ⚠ `.pptx` は古い一式で**小窓すら出なかった**ので、別の理由が重なっている可能性がある ──
 * 足すなら**形式ごとに測ってから**にする。
 *
 * ## ⚠ ここは「入口を出すか」の判定と**別物**である
 *
 * `src/features/office/office-entry.ts` の `isOfficeAttachment` は
 * 「Office で開くボタンを出すか」を決めるもので、**取りこぼしのほうが痛い**ので
 * 広く拾う(false-keep)。こちらは「**保存できると言ってよいか**」なので、
 * **狭く当てる**(ODF だけを真にする)── 誤差の向きが逆である。
 * ⚠ CLAUDE.md「判定を増やさない。誤差の向きを決めて、両側に使い回さない」。
 *
 * ⚠ **ここは「判断」だけ。** DOM も FS も触らない ── `host.html` は bundle されない
 * 生 HTML で、中に書いた判断は**どの test からも実行されない**
 * (`office-save-watch.js` / `office-restart-watch.js` が分かれているのと同じ理由)。
 * ⚠ 素の JS(ES5 相当)で書く ── `<script src>` で読むので bundler を通らない。
 */
(function (root) {
  'use strict';

  /**
   * 保存できる形式(= ODF)。
   *
   * ⚠ **4 つとも実測してある**(上の表)── 推測で入れた物は 1 つも無い。
   * 🔑 flat ODF(`.fodt` など)は**別扱いで、ここに入れない** ── あちらは 1 枚の
   * XML でパッケージ格納形式ではなく、**測っていない**。
   * ⚠ 「できる」と言って失うほうが、「できない」と言って驚かせるより痛い ──
   * 迷ったら**保存できない側**へ倒す。⚠ ここへ足すなら、まず測ること。
   */
  var SAVABLE_EXTS = ['.odt', '.ods', '.odp', '.odg'];

  /** 拡張子(小文字・ドット付き)。無ければ空文字。 */
  function extOf(name) {
    var s = String(name == null ? '' : name).trim().toLowerCase();
    var i = s.lastIndexOf('.');
    return i < 0 ? '' : s.slice(i);
  }

  /**
   * この名前の文書は、この Office で保存できるか。
   *
   * ⚠ **名前が空 / 拡張子が無いときは `true`** を返す ── 窓の中で新規に作った文書は
   * 既定で ODF になるので、そこへ「保存できません」と出すのは**嘘**である。
   * 🔑 断りを出すのは「**保存できないと分かっている形式**」だけにする。
   */
  function isSavable(name) {
    var ext = extOf(name);
    if (ext === '') return true;
    for (var i = 0; i < SAVABLE_EXTS.length; i += 1) {
      if (SAVABLE_EXTS[i] === ext) return true;
    }
    return false;
  }

  root.PKC3OfficeFormat = {
    SAVABLE_EXTS: SAVABLE_EXTS,
    extOf: extOf,
    isSavable: isSavable,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
