/**
 * 🔴 **Office の窓の「影」(編集中の文書の写し)を、自前で書く**(#1228 段 1)。
 *
 * LO が固まる / 窓が落ちても、**打った分を失わない**ための控え。保存(Ctrl+S)とは別の物で、
 * 書く先も別(窓の MEMFS → OPFS の棚)。LO の自動回復は書き込みが 0 だった(段 0 の実測)ので、
 * こちらから `XStorable.storeToURL` を打って作る。
 *
 * ## ⚠ ここは「判断」だけ
 *
 * `host.html` は bundle されず unit が 1 件も届かない(CLAUDE.md「どの test からも実行されない file に、
 * 判断を書かない」)。だから**取り出せる物は全部ここに在る**。素の JS(ES5 相当 + async)で書く。
 * DOM / `location` / `BroadcastChannel` は触らない ── `host.html` が配線する。
 *
 * ## 🔴 `fd_sync` を、影を書く間だけ**同期の no-op**にする(測って分かったこと)
 *
 * 製品の窓のまま JS から `storeToURL` を呼ぶと必ず `SuspendError: trying to suspend without
 * WebAssembly.promising` になる(`docs/development/office-shadow-measure-2026-10.md` A)。出どころは
 * wasm の import `fd_sync`(JSPI の suspend 側)── LO の main ループの外から呼ぶ同期呼びでは suspend できない。
 * 差し替えると `.odt` / `.docx` とも元の形式の完結した影が書け、副作用は無かった(同 B・C)。
 *
 * 🔴 **import は instantiate の時に決まる。** emscripten は `fd_sync` を `WebAssembly.Suspending` の
 * **object**(呼べない)で渡してくるので、起動の後から入れ替えられない ── **起動の `instantiateWasm` で
 * 1 度だけ包む**(`wrapImports`)。包んだ関数は
 *   - 影を書く間(`begin()` 〜 `end()`)→ **0 を返すだけ**(同期)
 *   - それ以外 → **元の `fd_sync` が MEMFS に対してやっていたことと同じ**(下の `fdSync`)
 * ⚠ **元の `fd_sync` そのものではない。** 元の実体は `Suspending` の中に閉じていて取り出せず、
 * しかも**同じ import で「suspend する / しない」は切り替えられない**(suspend 側は常に suspend する)。
 * 元の挙動は `stream.node.mount.type.syncfs` が在るときだけ非同期の仕事をする ── この窓の MEMFS には
 * `syncfs` が無い(実測)ので、**素で返すのは 0(開いていない fd のときだけ EBADF)**で、同じになる。
 * ⚠ もし `syncfs` を持つ mount が来たら `unsyncedMount` に数える(黙って 0 を返さない)。
 *
 * ## 影を書く契機
 *
 * 「打ってから 3 秒止まった」(裁定 A)。打ち続けている間は書かない ── 書き出しは main thread を
 * 200〜700ms 塞ぐ(`.odt`)ので、打鍵の最中に当てない。`isModified` が 0(保存済み)なら書かない。
 */
(function (root) {
  'use strict';

  /** 「静止」と見なす間(ms)。裁定 A「打ってから 3 秒止まった」。 */
  var QUIET_MS = 3000;

  /** EBADF(開いていない fd)。元の `fd_sync` が `ErrnoError(8)` から返していた値。 */
  var EBADF = 8;

  /**
   * 影を書ける形式 → `FilterName`。
   * 🔴 `.docx` は **`FilterName` を渡さないと ODF で書かれる**(測った: `.docx` に渡さないと
   * `mimetype` = `application/vnd.oasis.opendocument.text`)。`.odt` は渡さなくても ODF だが明示する。
   * ⚠ ここに無い形式(`.xlsx` / `.pptx` / `.ods` …)は**測っていない**ので書かない(`filterFor` が null)。
   */
  var SHADOW_FILTERS = { odt: 'writer8', docx: 'MS Word 2007 XML' };

  /** 影の宛先(MEMFS)。⚠ `/work` の**入れ子**にしない ── 保存の見張りは `/work` 直下しか見ない。 */
  var SHADOW_DIR = '/tmp/pkc3-shadow';

  /** 影の宛先の棚(OPFS のルート直下)。⚠ 取り込みの棚(`pkc3-office-stage`)とは別。 */
  var SHELF_DIR = 'pkc3-office-shadow';

  function extOfName(name) {
    var s = String(name || '');
    var i = s.lastIndexOf('.');
    return i < 0 ? '' : s.slice(i + 1).toLowerCase();
  }

  /** その拡張子の影を書けるか。書けるなら `FilterName`、書けないなら `null`。 */
  function filterFor(ext) {
    var k = String(ext || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(SHADOW_FILTERS, k) ? SHADOW_FILTERS[k] : null;
  }

  // ───────────────────────── fd_sync の差し替えの口 ─────────────────────────

  /**
   * `fd_sync` の差し替えの口。
   * @param getFS 窓の `FS`(`window.__lo.FS`)を返す。⚠ 起動前は無い ── 無ければ「素の側」は 0 を返す
   */
  function createSyncGate(getFS) {
    var active = false;
    var n = { gated: 0, passed: 0, ebadf: 0, unsyncedMount: 0 };

    /** wasm が呼ぶ関数。⚠ 同期でなければならない(`Suspending` ではない普通の関数)。 */
    function fdSync(fd) {
      if (active) { n.gated += 1; return 0; }
      n.passed += 1;
      var FS = null;
      try { FS = typeof getFS === 'function' ? getFS() : null; } catch (e) { FS = null; }
      if (!FS || typeof FS.getStream !== 'function') return 0;
      var stream = null;
      try { stream = FS.getStream(fd); } catch (e) { stream = null; }
      if (!stream) { n.ebadf += 1; return EBADF; }
      try {
        var mount = stream.node && stream.node.mount;
        if (mount && mount.type && typeof mount.type.syncfs === 'function') n.unsyncedMount += 1;
      } catch (e) { /* 読めなくても 0 */ }
      return 0;
    }

    return {
      fdSync: fdSync,
      /**
       * 起動の import object の `fd_sync` を包む(`env` / `wasi_snapshot_preview1` のどちらにあっても)。
       * @returns 差し替えた名前の配列(**空なら当たっていない** ── 呼び側が見る)
       */
      wrapImports: function (imports) {
        var hit = [];
        var names = ['env', 'wasi_snapshot_preview1'];
        for (var i = 0; i < names.length; i += 1) {
          var o = imports && imports[names[i]];
          if (o && o.fd_sync !== undefined) { o.fd_sync = fdSync; hit.push(names[i]); }
        }
        return hit;
      },
      /** 影を書く間の始まり。⚠ **重ねて呼べない**(重なると、先の `end()` で後の書き出しが `SuspendError` になる)。 */
      begin: function () {
        if (active) throw new Error('shadow: begin が重なった');
        active = true;
      },
      /** 終わり。⚠ 何度呼んでも安全(戻し忘れを finally で必ず呼べるように)。 */
      end: function () { active = false; },
      isActive: function () { return active; },
      counts: function () { return { gated: n.gated, passed: n.passed, ebadf: n.ebadf, unsyncedMount: n.unsyncedMount }; },
    };
  }

  root.PKC3OfficeShadow = {
    QUIET_MS: QUIET_MS,
    SHADOW_FILTERS: SHADOW_FILTERS,
    SHADOW_DIR: SHADOW_DIR,
    SHELF_DIR: SHELF_DIR,
    extOfName: extOfName,
    filterFor: filterFor,
    createSyncGate: createSyncGate,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
