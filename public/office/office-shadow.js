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

  // ───────────────────────── 契機: 打ってから 3 秒止まった ─────────────────────────

  /**
   * 「打ち続けている間は書かない / 止まると 1 回」の判定(時刻だけで決まる。DOM も timer も持たない)。
   * `typed(at)` で印を立て、`take(at)` は**静止が `quietMs` 続いた最初の 1 回だけ** true を返して印を下ろす。
   * ⚠ 下ろした後は、次の `typed` が来るまで true を返さない(打っていないのに 3 秒ごとに書かない)。
   */
  function createQuiet(opts) {
    var quietMs = (opts && opts.quietMs) || QUIET_MS;
    var dirty = false;
    var last = 0;
    return {
      typed: function (at) { dirty = true; last = at; },
      take: function (at) {
        if (!dirty) return false;
        if (at - last < quietMs) return false;
        dirty = false;
        return true;
      },
      isDirty: function () { return dirty; },
    };
  }

  // ───────────────────────── LO に影を書かせる(JS → LO の同期呼び) ─────────────────────────

  function del(o) {
    try { if (o && typeof o.delete === 'function') o.delete(); } catch (e) { /* 解放に失敗しても続ける */ }
  }

  /** `storeToURL` へ渡す PropertyValue の列。⚠ 作った wrapper は呼び側が全部 `delete()` する(embind)。 */
  function makeProps(lo, props) {
    var PS = lo['uno_Type_com$sun$star$beans$PropertyState'];
    var Seq = lo['uno_Sequence_com$sun$star$beans$PropertyValue'];
    var seq = new Seq(props.length, lo.uno_Sequence.FromSize);
    var anys = [];
    for (var i = 0; i < props.length; i += 1) {
      var v = props[i][1];
      var a = new lo.uno_Any(typeof v === 'boolean' ? lo.uno_Type.Boolean() : lo.uno_Type.String(), v);
      anys.push(a);
      seq.set(i, { Name: props[i][0], Handle: 0, Value: a, State: PS.DIRECT_VALUE });
    }
    return { seq: seq, anys: anys };
  }

  function decoded(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  /** MEMFS の影の置き場の中身を全部消す(影の本体と、LO が横に残す `lu*.tmp`)。⚠ 消せなくても続ける。 */
  function discardLocal(FS) {
    var n = 0;
    try {
      var names = FS.readdir(SHADOW_DIR);
      for (var i = 0; i < names.length; i += 1) {
        if (names[i] === '.' || names[i] === '..') continue;
        try { FS.unlink(SHADOW_DIR + '/' + names[i]); n += 1; } catch (e) { /* 消せない */ }
      }
    } catch (e) { /* 置き場がまだ無い */ }
    return n;
  }

  /**
   * 保存していない文書を 1 つ選び、`storeToURL` で MEMFS の影の置き場へ書く。**同期**(塞ぐ ── 書き出しの間)。
   *
   * - 選ぶ: 保存していない変更が在る文書のうち、窓が開いた文書(`opts.docPath`。MEMFS の path)と同じ場所の物を優先。
   *   無ければ最初の 1 件(窓の中で別の文書へ替えた場合)
   * - 書く: `fd_sync` の差し替え(`gate.begin()`)の**間だけ**。⚠ `end()` は必ず `finally` で呼ぶ
   * - 書けない形式(`.xlsx` など測っていない物)は書かずに `{ skipped: 'format' }`
   * @returns `{ skipped: 'unmodified' | 'format', ext? }` か `{ ext, path, size }`。書けなければ**投げる**
   */
  function storeShadowSync(lo, gate, opts) {
    var S = lo.uno.com.sun.star;
    var FS = lo.FS;
    var hint = opts && opts.docPath ? 'file://' + opts.docPath : '';
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
    var chosen = null;
    var chosenLoc = '';
    var chosenMatches = false;
    try {
      while (en.hasMoreElements()) {
        var a = en.nextElement();
        var el = a.get();
        del(a);
        var keep = false;
        var mod = null;
        var st = null;
        try {
          mod = S.util.XModifiable.query(el);
          var isMod = !!(mod && mod.isModified());
          if (isMod) {
            st = S.frame.XStorable.query(el);
            var loc = st ? decoded(String(st.getLocation())) : '';
            var matches = hint !== '' && loc === hint;
            if (chosen === null || (matches && !chosenMatches)) {
              del(chosen);
              chosen = el; chosenLoc = loc; chosenMatches = matches;
              keep = true;
            }
          }
        } catch (e) {
          /* この 1 件は見られなかった ── 他の文書は見る */
        } finally {
          // ⚠ 投げた経路でも解放する(`isModified()` が投げると、query で作った wrapper が残る)
          del(mod); del(st);
        }
        if (!keep) del(el);
      }
    } finally {
      del(en);
    }
    if (chosen === null) return { skipped: 'unmodified' };
    var made = null;
    var store = null;
    try {
      var ext = extOfName(chosenLoc);
      var filter = filterFor(ext);
      if (filter === null) return { skipped: 'format', ext: ext };
      try { FS.mkdirTree(SHADOW_DIR); } catch (e) { /* 既に在る */ }
      discardLocal(FS);
      var path = SHADOW_DIR + '/shadow.' + ext;
      made = makeProps(lo, [['FilterName', filter]]);
      store = S.frame.XStorable.query(chosen);
      gate.begin();
      try { store.storeToURL('file://' + path, made.seq); } finally { gate.end(); }
      var size = FS.stat(path).size;
      if (!(size > 0)) throw new Error('shadow: 空の影が書かれた');
      return { ext: ext, path: path, size: size };
    } finally {
      del(store);
      if (made) { del(made.seq); for (var i = 0; i < made.anys.length; i += 1) del(made.anys[i]); }
      del(chosen);
    }
  }

  // ───────────────────────── OPFS の棚(窓ごとに asset 単位で最新 1 つだけ) ─────────────────────────

  /** 1 回に運ぶ量。⚠ 山の高さそのもの(`office-save-stage.js` と同じ 1MiB)。 */
  var CHUNK = 1024 * 1024;

  /** 棚の中の名前にできる形へ。⚠ 空なら呼び側が代わりの id を渡す。 */
  function safeId(token, fallback) {
    var t = String(token || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
    if (t === '') t = String(fallback || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
    return t === '' ? 'unnamed' : t;
  }

  function pad13(n) {
    var s = String(Math.max(0, Math.floor(n)));
    while (s.length < 13) s = '0' + s;
    return s;
  }

  function coded(code, msg) {
    var e = new Error(msg);
    e.shadowReason = code;
    return e;
  }

  /**
   * 影を OPFS の棚 `<SHELF_DIR>/<id>/<時刻>.<拡張子>` へ**刻んで**置く(丸ごと複製しない)。
   * 置けたら、**同じ棚の古い影を消す**(最新 1 つだけ残す)。⚠ 自分より新しい名前は消さない(別の窓の分)。
   * ⚠ 書きかけは残さない(`createWritable` は close で確定する。失敗したら `abort`)。
   * @param d `storage`(`navigator.storage`)/ `id` / `ext` / `size` / `read(into, wanted, position)` / `now`
   * @returns `{ at, name }`
   */
  async function shelve(d) {
    var s = d.storage;
    if (!s || typeof s.getDirectory !== 'function') throw coded('no-opfs', 'shadow: OPFS が無い');
    if (!(d.size > 0)) throw new Error('shadow: 空は置かない');
    var rootDir = await s.getDirectory();
    var top = await rootDir.getDirectoryHandle(SHELF_DIR, { create: true });
    var dir = await top.getDirectoryHandle(d.id, { create: true });
    var at = d.now();
    var name = pad13(at) + '.' + d.ext;
    var fh = await dir.getFileHandle(name, { create: true });
    var w = await fh.createWritable();
    var buf = new Uint8Array(Math.min(CHUNK, d.size));
    var pos = 0;
    try {
      while (pos < d.size) {
        var wanted = Math.min(buf.length, d.size - pos);
        var got = d.read(buf, wanted, pos);
        if (!(got > 0)) throw new Error('shadow: 読めなくなった @' + pos);
        await w.write(buf.subarray(0, got));
        pos += got;
      }
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch (e2) { /* 既に閉じている */ }
      // 書きかけの名前を残さない
      try { await dir.removeEntry(name); } catch (e3) { /* 無い */ }
      throw e;
    }
    // 古い影を消す(名前は時刻の固定長なので、文字列比較が時刻順になる)
    var olds = [];
    for await (var k of dir.keys()) { if (k < name) olds.push(k); }
    for (var i = 0; i < olds.length; i += 1) {
      try { await dir.removeEntry(olds[i]); } catch (e) { /* 消せなくても次回消える */ }
    }
    return { at: at, name: name };
  }

  // ───────────────────────── 画面に出す理由(内部の語を出さない) ─────────────────────────

  /** 失敗の理由を、user が読める短い字へ。⚠ `fd_sync` / `storeToURL` / OPFS などの内部語を出さない。 */
  function reasonOf(e) {
    var code = e && e.shadowReason;
    if (code === 'no-opfs') return 'この端末の保存領域を使えません';
    if (code === 'no-gate') return 'この版の Office では書けません';
    if (code === 'no-uno') return '編集の状態を Office に聞けませんでした';
    if (e && e.name === 'QuotaExceededError') return '保存領域の空きが足りません';
    return '書き出せませんでした';
  }

  // ───────────────────────── 書く流れ(静止 → 確かめる → 書く → 棚へ) ─────────────────────────

  /**
   * 1 回の `tick` が、静止していれば影を 1 つ書く。
   * @param d `now()` / `quiet`(`createQuiet`)/ `isDead()` / `isModified()`(Promise。`true` / `false` / `null` = 聞けなかった)/
   *   `write()`(同期。`storeShadowSync`)/ `shelve(info)`(Promise)/ `discard()` / `onWritten(at)` / `onFailed(reason)` /
   *   `log(e)`(任意。原因を console へ)
   * @returns `'dead' | 'busy' | 'wait' | 'clean' | 'skipped' | 'written' | 'failed'`(test の観測点)
   */
  function createWriter(d) {
    var busy = false;
    var lastReason = null;
    function fail(reason) {
      // 同じ理由が続くとき 1 度だけ言う(打つたびに同じ 1 行を出さない)。成功したら言い直せる
      if (reason !== lastReason) { lastReason = reason; d.onFailed(reason); }
    }
    return {
      tick: async function () {
        if (d.isDead()) return 'dead';
        if (busy) return 'busy';
        if (!d.quiet.take(d.now())) return 'wait';
        busy = true;
        try {
          var mod = await d.isModified();
          if (mod === null) { fail(reasonOf({ shadowReason: 'no-uno' })); return 'failed'; }
          // 保存済み(変更なし)は書かない
          if (mod !== true) return 'clean';
          var info = d.write();
          if (info && info.skipped) return 'skipped';
          await d.shelve(info);
          lastReason = null;
          d.onWritten(d.now());
          return 'written';
        } catch (e) {
          // 画面には字を出し、原因は console へ(内部の語はここだけ)
          if (typeof d.log === 'function') { try { d.log(e); } catch (e2) { /* 記録に失敗しても続ける */ } }
          fail(reasonOf(e));
          return 'failed';
        } finally {
          busy = false;
          try { d.discard(); } catch (e) { /* 片付けに失敗しても次の回がある */ }
        }
      },
      isBusy: function () { return busy; },
    };
  }

  root.PKC3OfficeShadow = {
    QUIET_MS: QUIET_MS,
    CHUNK: CHUNK,
    SHADOW_FILTERS: SHADOW_FILTERS,
    SHADOW_DIR: SHADOW_DIR,
    SHELF_DIR: SHELF_DIR,
    extOfName: extOfName,
    filterFor: filterFor,
    createSyncGate: createSyncGate,
    createQuiet: createQuiet,
    storeShadowSync: storeShadowSync,
    discardLocal: discardLocal,
    safeId: safeId,
    shelve: shelve,
    reasonOf: reasonOf,
    createWriter: createWriter,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
