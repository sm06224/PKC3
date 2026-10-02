/**
 * 🔴 **Office の窓の中に「保存していない変更」が在るか**(#1228 穴②)。
 *
 * 別の文書を開く放送(`reload-request`)で窓は `location.replace` するので、LO の中で
 * 打った分は保存していなければ**確認なしで消える**(段 0 の実測)。消す前に聞く。
 *
 * ## 信号は LO に聞く(推測しない)
 *
 * 一式は emscripten の **UNO 橋**(`Module.uno` / `getUnoComponentContext`)を輸出している。
 * 🔴 ここで使うのは **JS → LO の同期呼び出し**(`XModifiable.isModified()`)だけ。
 * ⚠ `invalid handle` で窓が死ぬのは **LO 側から JS の物を触る**経路(UNO の listener 登録など、
 * `office-save-watch.js` の注記)で、こちらの向きは実ブラウザで 30 回続けて通した(1 回 0.5〜4 ms)。
 * 🔑 **Desktop の全文書を数える**(`getCurrentModelFromViewSh` は「いま前面の 1 件」しか見ない)。
 * Start Center だけのときも 1 件返る(`isModified` を持たない)── それは「無い」と読む。
 *
 * ## ⚠ ここは「判断」だけ
 *
 * `lo`(`window.__lo`)を**引数で受ける**。`host.html` は bundle されず unit が 1 件も届かない
 * (CLAUDE.md「どの test からも実行されない file に、判断を書かない」)── 取り出せば node で当てられる。
 * ⚠ 素の JS(ES5 相当 + async)で書く ── `host.html` が `<script src>` で読む。
 *
 * ⚠ **wrapper は全部 `delete()` する**(embind の手動解放。落とすと呼ぶたびに積む)。
 */
(function (root) {
  'use strict';

  function del(o) {
    try { if (o && typeof o.delete === 'function') o.delete(); } catch (e) { /* 解放に失敗しても判定は返す */ }
  }

  /**
   * 開いている文書のどれかに保存していない変更が在るか。
   * @returns `true`(在る)/ `false`(無い)/ `null`(**聞けなかった**: 橋が無い・LO がまだ起動中・例外)
   * ⚠ `null` は「無い」と同じに扱ってよい(呼び側は今まで通り開く)── ただし区別して返す
   *   (test が「聞けなかった」を「無かった」と取り違えないため)。
   */
  async function anyModified(lo) {
    if (!lo || !lo.uno || typeof lo.getUnoComponentContext !== 'function') return null;
    var modified = false;
    try {
      // 橋の初期化待ち(起動中ならここで解決する)。⚠ 解決しない相手を待ち続けない
      if (lo.uno_init && typeof lo.uno_init.then === 'function') {
        var timer = null;
        try {
          await Promise.race([
            lo.uno_init,
            new Promise(function (_, rej) { timer = setTimeout(function () { rej(new Error('uno_init')); }, 3000); }),
          ]);
        } finally {
          if (timer !== null) clearTimeout(timer);
        }
      }
      var S = lo.uno.com.sun.star;
      var ctx = lo.getUnoComponentContext();
      var any = ctx.getValueByName('/singletons/com.sun.star.frame.theDesktop');
      var ifc = any.get();
      del(any); del(ctx);
      var desktop = S.frame.XDesktop.query(ifc);
      del(ifc);
      var comps = desktop.getComponents();
      del(desktop);
      var en = comps.createEnumeration();
      del(comps);
      while (en.hasMoreElements()) {
        var a = en.nextElement();
        var el = a.get();
        del(a);
        try {
          var mod = S.util.XModifiable.query(el);
          // ⚠ 戻りは 0 / 1(boolean ではない)。Start Center は query が null
          if (mod && mod.isModified()) modified = true;
          del(mod);
        } catch (e) { /* この 1 件は聞けなかった ── 他の文書は見る */ }
        del(el);
      }
      del(en);
      return modified;
    } catch (e) {
      // ⚠ 数え途中で例外でも、**在ると分かった分は捨てない**(消す側へ倒さない)
      return modified ? true : null;
    }
  }

  /**
   * 🔴 **別の文書へ替える前の門**(`host.html` の `reload-request` が通る 1 本)。
   *
   * 判断は 4 つだけ:
   *   - 窓が停止している / LO がまだ無い → **そのまま替える**(停止の帯の動線を塞がない)
   *   - 聞けなかった(`null`)/ 保存していない変更が**無い**(`false`)→ **そのまま替える**
   *     (対照群 ── ここで確認を出すと、普通の「別の文書を開く」に手数が 1 つ増える)
   *   - **在る**(`true`)→ 確認を出す。「開く」で替え、「やめる」で替えない(本体へ返す)
   *
   * 確認が出ている間 / 確かめている間に来た依頼は、**行き先だけ更新**する(箱は 1 つ。
   * 「開く」を押したとき**最後に頼まれた文書**へ替わる)。
   *
   * @param h `getLo()` `isDead()` `replace(url)` `show()` `hide()` `declined()`
   *   (DOM と `location` は呼び側 ── ここは触らない)
   */
  function createGate(h) {
    var open = false;
    var checking = false;
    var latest = null;
    return {
      isOpen: function () { return open; },
      request: function (url) {
        latest = url;
        if (open || checking) return Promise.resolve();
        var lo = h.getLo();
        if (h.isDead() || !lo) { h.replace(url); return Promise.resolve(); }
        checking = true;
        return anyModified(lo).then(function (r) { return r; }, function () { return null; }).then(function (r) {
          checking = false;
          // 確かめている間に停止した窓は聞いても答えられない ── 替える側へ
          if (r === true && !h.isDead()) { open = true; h.show(); } else { h.replace(latest); }
        });
      },
      /** 「開く」。 */
      accept: function () {
        if (!open) return;
        open = false;
        h.hide();
        h.replace(latest);
      },
      /** 「やめる」。⚠ 本体へ返す(`declined`)── 返さないと本体は渡すつもりの文書を握り続ける。 */
      cancel: function () {
        if (!open) return;
        open = false;
        h.hide();
        h.declined();
      },
      /** 停止した(`died()`)。箱を畳むだけで、答えは返さない(停止の帯が出口)。 */
      abort: function () {
        if (!open) return;
        open = false;
        h.hide();
      },
    };
  }

  root.PKC3OfficeUnsaved = {
    anyModified: anyModified,
    createGate: createGate,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
