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
 * ## 🔴 だから判定は「入っている一式」に依存する
 *
 * ⚠ **単純に非 ODF を足してはいけない。** 直した一式を配っても、
 * **入れ替えていない人の手元では今も落ちる** ── そこで「保存できます」と言うと、
 * その人は**編集を失う**。
 * 🔑 だから `isSavable(name, alienOk)` は第 2 引数を取る ── `alienOk` は
 * **その一式が確認ダイアログ(`cui/ui/querydialog.ui`)を持っているか**である。
 * ⚠ **渡されなければ `false` 扱い**(= 断る側へ倒す)。逆にしてはいけない。
 *
 * ⚠ 判定の材料は `host.html` が**一式そのもの**から採る(`soffice.data.js.metadata`
 * に `/soffice.cfg/cui/ui/querydialog.ui` が在るか)。pack.json に新しい欄を足さないので、
 * **既に入れてある一式にも遡って効く**。
 * 🔴 **突き合わせは完全一致で行う** ── 部分一致(`querydialog.ui` を含むか)にすると、
 * 古い一式にも在る `vcl/ui/querydialog.ui` / `recalcquerydialog.ui` /
 * `safemodequerydialog.ui` に**満たされて常に真**になる(2026-08-24 に踏みかけた)。
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
   * **どの一式でも保存できる形式**(= ODF)。
   *
   * ⚠ **4 つとも実測してある** ── 推測で入れた物は 1 つも無い。
   * 🔑 flat ODF(`.fodt` など)は**別扱いで、ここに入れない** ── あちらは 1 枚の
   * XML でパッケージ格納形式ではなく、**測っていない**。
   */
  var SAVABLE_EXTS = ['.odt', '.ods', '.odp', '.odg'];

  /**
   * 🔴 **確認ダイアログを持つ一式でだけ保存できる形式**(#225)。
   *
   * LO は非 ODF で保存するとき必ず「標準のファイル形式ではありません」と訊く。
   * その `cui/ui/querydialog.ui` が入っていない一式では例外になり、
   * 画面には「一般的な I/O エラー」しか出ない ── **押すまで分からない**。
   *
   * ⚠ **7 つとも 1 件ずつ実測してある**(2026-08-24、直した一式 `lo-06c7bd033c1d`。
   * 自作の文書を開き、1 手加えて Ctrl+S → 小窓の「この形式のままにする」を押した後):
   *
   * | 形式 | 前 → 後 | mtime | 取り込み |
   * |---|---|---|---|
   * | `.rtf` | 1,434 → **3,211** | 動 | ✅ |
   * | `.doc` | 8,704 → **9,216** | 動 | ✅ |
   * | `.docx` | 1,269 → **5,987** | 動 | ✅ |
   * | `.xls` | 5,632 → 5,632 | **動** | ✅ |
   * | `.xlsx` | 5,439 → **7,196** | 動 | ✅ |
   * | `.ppt` | 459,264 → **460,288** | 動 | ✅ |
   * | `.pptx` | 7,947 → **11,418** | 動 | ✅ |
   *
   * 🔴 **`.xls` は大きさが 1 バイトも動かない。** BIFF は区画の大きさが決まって
   * いるので、1 文字ぶんの変更では総量が変わらない ── ⚠ **大きさだけを見ていたら
   * 「保存できない」と読み違えていた**。判定は **mtime が動いたこと** +
   * `medium:commit` が出たこと + PKC 側が保存を拾ったこと の 3 点で採っている。
   *
   * ⚠ **測っていない形式をここへ足さない。**
   */
  var ALIEN_SAVABLE_EXTS = ['.rtf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];

  /** 拡張子(小文字・ドット付き)。無ければ空文字。 */
  function extOf(name) {
    var s = String(name == null ? '' : name).trim().toLowerCase();
    var i = s.lastIndexOf('.');
    return i < 0 ? '' : s.slice(i);
  }

  function has(list, ext) {
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] === ext) return true;
    }
    return false;
  }

  /**
   * この名前の文書は、**いま入っている一式で**保存できるか。
   *
   * @param name       文書の名前(拡張子で判る)
   * @param alienOk    その一式が非 ODF の確認ダイアログを持っているか。
   *                   ⚠ **渡されなければ `false` 扱い**(= 断る側へ倒す)。
   *
   * ⚠ **名前が空 / 拡張子が無いときは `true`** を返す ── 窓の中で新規に作った文書は
   * 既定で ODF になるので、そこへ「保存できません」と出すのは**嘘**である。
   * 🔑 断りを出すのは「**保存できないと分かっている形式**」だけにする。
   *
   * 🔴 **既定を `false` にしてあるのは、古い一式を守るためである。**
   * 直した一式を配っても、**入れ替えていない人の手元では今も落ちる** ──
   * そこで「保存できます」と言うと、その人は**編集を失う**。
   * ⚠ 呼び側が引数を落としたら**断りが出る**(= 安全側)。逆にしてはいけない。
   */
  function isSavable(name, alienOk) {
    var ext = extOf(name);
    if (ext === '') return true;
    if (has(SAVABLE_EXTS, ext)) return true;
    return alienOk === true && has(ALIEN_SAVABLE_EXTS, ext);
  }

  /**
   * 🔴 **その一式は非 ODF を保存できるか**を、**一式の目録から**決める(#225)。
   *
   * @param metaText `soffice.data.js.metadata` の中身(JSON の原文)。
   *
   * 判定は「確認ダイアログ `cui/ui/querydialog.ui` が詰め込まれているか」の 1 点。
   * これが無い一式では、非 ODF の保存が例外になり「一般的な I/O エラー」に化ける。
   *
   * 🔴 **完全一致で見る。** 部分一致(`querydialog.ui` を含むか)にすると、
   * **古い一式にも在る別物**に満たされて**常に真**になる ──
   * `vcl/ui/querydialog.ui` / `modules/scalc/ui/recalcquerydialog.ui` /
   * `sfx/ui/safemodequerydialog.ui` の 3 つ(2026-08-24 に実際に踏みかけた)。
   * 🔑 目録は `"filename":"…/soffice.cfg/cui/ui/querydialog.ui"` の形なので、
   * **閉じ引用符まで**含めて探せば、前にも後ろにも延びない。
   *
   * ⚠ 読めない / 渡されないときは **false**(= 断りを出す側へ倒す)。
   */
  var ALIEN_DIALOG_MARK = '/soffice.cfg/cui/ui/querydialog.ui"';

  function packSavesAlien(metaText) {
    if (typeof metaText !== 'string' || metaText === '') return false;
    return metaText.indexOf(ALIEN_DIALOG_MARK) >= 0;
  }

  root.PKC3OfficeFormat = {
    SAVABLE_EXTS: SAVABLE_EXTS,
    ALIEN_SAVABLE_EXTS: ALIEN_SAVABLE_EXTS,
    ALIEN_DIALOG_MARK: ALIEN_DIALOG_MARK,
    extOf: extOf,
    isSavable: isSavable,
    packSavesAlien: packSavesAlien,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
