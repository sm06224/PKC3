/**
 * 🔴 **LO の保存を見つける判断**(#205 段 A / 方式監査 #209)。
 *
 * ⚠ **ここは「判断」だけ。** FS も DOM も BroadcastChannel も触らない ──
 * `host.html` が hook を掛け、ここへ生の出来事を流し、ここが「保存された file」を返す。
 * 🔑 そうしないと **unit が 1 件も届かない**(`host.html` は bundle されない生 HTML で、
 * 読む test が 0 件である)。⚠ この file は素の JS(ES5 相当)で書く ── `host.html` が
 * `<script src>` で読むので、bundler を通らない。
 *
 * ## なぜ FS を包むのか(UNO ではなく)
 *
 * 🔴 **UNO の文書イベントは、この一式では使えない**(2026-08-16 の probe、#209)。
 * `XDocumentEventListener` を**登録した瞬間**に、保存のたびに窓が死ぬ
 * (`Aborted(Assertion failed: invalid handle: …)` / 178 秒 復帰なし)。
 * ⚠ 装着自体は全段でき、自作の broadcast は届く ── **壊すのは「登録」**である。
 * 🔑 `invalid handle` の abort はこれで **3 件目**(① LO 側から `QInputMethod::show()`
 * ② Qt の `update()` から `updateInputElement()` ③ UNO listener の登録)。
 * **この一式では「LO のスレッド文脈から JS/embind のオブジェクトへ触る」経路が全部死ぬ。**
 *
 * 🚫 **polling も採らない**: 既存 path を持つ文書は**元の場所**へ書かれるので監視範囲を
 * 狭めれば漏れ、全走査は `/` で 20〜27ms(1,937 files)。しかも `PROXY_TO_PTHREAD = 0`
 * なので **soffice の main は窓の main thread** ── 毎秒の走査が LO の描画と直接競合する。
 *
 * ## 🔴 `rename` と `close` の**両方**が要る(実測で形が違う)
 *
 * | 操作 | LO が実際にやること |
 * |---|---|
 * | 既存 path の上書き | temp へ write → **`rename`** で置換 |
 * | 新規保存 | **最終 path へ直接 `write` + `close`**(rename ではない) |
 *
 * → `rename` だけ見ると**新規を落とし**、`close` だけ見ると**temp を拾う**。
 *
 * ⚠ 同じ path に `close` が **3〜4 回**来る(自動回復用の複製)ので、**静穏化して畳む**。
 */
(function (root) {
  'use strict';

  /** 見る場所。⚠ **直下だけ**(`/` を舐めない ── 20〜27ms でメインが止まる)。 */
  var WATCH_DIRS = ['/work', '/home/web_user'];

  /**
   * 静穏の窓(ms)。最後の出来事からこれだけ動かなければ「落ち着いた」とみなす。
   * ⚠ 実測の落ち着き幅は **367ms / 599ms**(既存 path のほうが長い ── temp → rename の
   * 往復があるため)。⚠ **保存中はメインが 0.35 秒級で塞がる**ので、tick 数ではなく
   * **壁時計**で数える(tick は飛ぶ)。
   */
  var QUIET_MS = 700;

  /**
   * 🔴 **拾わない名前**。⚠ ここを緩めると temp を「保存」として親へ流す。
   * - `lu42v7msuf.tmp` … LO の一時 file(実測。`lu` + 英数 + `.tmp`)
   * - `.~lock.<名前>#` … LO のロック file
   * - dot 始まり全般
   */
  function isIgnoredName(name) {
    if (!name || name.charAt(0) === '.') return true;
    return /\.tmp$/i.test(name);
  }

  /** その path が監視対象の**直下**か。⚠ 入れ子は見ない(`/tmp/luXXXX.tmp/` は LO の持ち物)。 */
  function watchedDirOf(path) {
    if (typeof path !== 'string') return null;
    for (var i = 0; i < WATCH_DIRS.length; i += 1) {
      var d = WATCH_DIRS[i];
      if (path.indexOf(d + '/') !== 0) continue;
      // 直下だけ ── 残りに `/` があれば入れ子である
      if (path.slice(d.length + 1).indexOf('/') >= 0) return null;
      return d;
    }
    return null;
  }

  /** path の末尾(= 添付の名前になる)。⚠ 日本語と空白を含む(`無題 1.odt`)。 */
  function baseName(path) {
    var i = path.lastIndexOf('/');
    return i < 0 ? path : path.slice(i + 1);
  }

  /**
   * 🔴 **保存の候補を貯めて、落ち着いたものだけ返す。**
   *
   * @param opts.now  いまの時刻(ms)を返す。⚠ test が差せる(既定 `Date.now`)
   * @param opts.baseline `path -> {size, mtimeMs}`。**起動時に開いた文書**を入れておく
   *   ── ⚠ 無いと「開いただけ」で保存扱いになる(実測: boot 中に `/work/x.odt` の
   *   `close` が 3 回来る。size は変わらない)
   */
  function createSaveWatch(opts) {
    var o = opts || {};
    var now = o.now || function () { return Date.now(); };
    var baseline = {};
    var pending = {}; // path -> lastEventAt

    return {
      /** 起動時の姿を覚える(これと同じなら保存ではない)。 */
      setBaseline: function (path, size, mtimeMs) {
        baseline[path] = { size: size, mtimeMs: mtimeMs };
      },

      /**
       * hook からの生の出来事。`kind` は `'close'` か `'rename'`。
       * @returns 受け付けたら true(⚠ test が「拾ったか」を見る観測点)
       */
      note: function (kind, path, at) {
        if (kind !== 'close' && kind !== 'rename') return false;
        if (watchedDirOf(path) === null) return false;
        if (isIgnoredName(baseName(path))) return false;
        pending[path] = typeof at === 'number' ? at : now();
        return true;
      },

      /**
       * 静穏を過ぎたものを確定して返す。⚠ **`stat` は呼び側が渡す**
       * (ここは FS を触らない)── `stat(path)` は `{size, mtimeMs}` か `null`。
       * @returns `[{path, name, size, mtimeMs}]`(⚠ bytes はここでは読まない)
       */
      due: function (stat, at) {
        var t = typeof at === 'number' ? at : now();
        var out = [];
        for (var path in pending) {
          if (!Object.prototype.hasOwnProperty.call(pending, path)) continue;
          if (t - pending[path] < QUIET_MS) continue;
          delete pending[path];
          var st = null;
          try { st = stat(path); } catch (e) { st = null; }
          // 消えた(temp だった / LO が片付けた)── 黙って落とす
          if (!st || !(st.size > 0)) continue;
          var b = baseline[path];
          // 🔑 起動時と同じなら「開いただけ」── 保存ではない
          if (b && b.size === st.size && b.mtimeMs === st.mtimeMs) continue;
          baseline[path] = { size: st.size, mtimeMs: st.mtimeMs };
          out.push({ path: path, name: baseName(path), size: st.size, mtimeMs: st.mtimeMs });
        }
        return out;
      },

      /** 待っている件数(⚠ 静穏化が効いていることの観測点)。 */
      pendingCount: function () {
        var n = 0;
        for (var k in pending) if (Object.prototype.hasOwnProperty.call(pending, k)) n += 1;
        return n;
      },
    };
  }

  root.PKC3OfficeSaveWatch = {
    WATCH_DIRS: WATCH_DIRS,
    QUIET_MS: QUIET_MS,
    isIgnoredName: isIgnoredName,
    watchedDirOf: watchedDirOf,
    baseName: baseName,
    createSaveWatch: createSaveWatch,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
