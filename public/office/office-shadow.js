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

  /**
   * Ctrl / Meta + S を押したとき、静止の起点を**後ろへ送る間**(ms)。
   * 🔴 保存の確認(「Keep format」)が開いている間は、同じ文書が**保存の途中**にある ── そこへ `storeToURL` を
   * 打たない。保存が通れば `isModified` が偽になるので、その後は書かない(待つだけで足りる)。
   */
  var SAVE_DEFER_MS = 10000;

  /**
   * 変換中(`compositionstart` 〜 `compositionend`)が**終わらないまま**でも、書くのを止め続けない上限(ms)。
   * ⚠ `compositionend` が来ない窓(取りこぼし)で影が**永久に**書かれなくなるのを避ける。
   */
  var COMPOSING_MAX_MS = 60000;

  /**
   * 書けなかったときの再試行の間(ms)。失敗が続くたびに 1 つずつ進み、最後の値で止まる。
   * 先頭の 0 = 次の見張り(1 秒後)で 1 度やり直す。⚠ 同じ理由で書けない窓が、書き出しで main thread を
   * 200〜700ms 塞ぐのを毎秒繰り返さないために、2 回目からは間をあける。
   */
  var RETRY_BACKOFF_MS = [0, 30000, 60000, 120000];

  /**
   * 「保存していない変更が在るか」を窓の中から聞く間隔(ms)(#1228 段 2)。
   * 🔴 打鍵の契機(`QUIET_MS`)は**打たない編集**(表の挿入・図の移動 = マウスだけ)を拾えない。`isModified` は
   * 1 回 0.5〜1.6 ms(段 1 の実測)なので、2〜3 秒ごとに聞けば足りる。⚠ 書くのは**これまでと同じ 1 本の口**
   * (`take` → `write`)── 聞いて「変わった」と分かったら静止の印を立てるだけで、別の書き口を作らない。
   */
  var MODIFIED_POLL_MS = 2500;

  /** 棚の中の影の名前(13 桁の時刻 + 拡張子)。⚠ `meta.json` などを影と取り違えない。 */
  var SHADOW_NAME_RE = /^[0-9]{13}\.[A-Za-z0-9]+$/;

  /** 棚へ添える元の文書の記録の名前(⚠ 影ではない)。 */
  var META_NAME = 'meta.json';

  /** 合言葉の前置き(`src/features/office/office-launch.ts` の `LOCAL_PREFIX` と同じ。test が突き合わせる)。 */
  var LOCAL_TOKEN_PREFIX = 'local:';

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
    // 変換中(IME)。⚠ 変換中の字は確定していない ── 書くと**変換途中**が影になる
    var composing = false;
    var composeAt = 0;
    // 窓に聞いた「保存していない変更が在るか」の最後の答え(`observeModified` が据える)。⚠ 聞く前は false
    var knownModified = false;
    return {
      /** 打った印。⚠ 起点を**後ろへ送ってあるとき(Ctrl+S の直後)は縮めない**。 */
      typed: function (at) { dirty = true; if (at > last) last = at; },
      take: function (at) {
        if (!dirty) return false;
        // 変換中は書かない(終わらない変換の取りこぼしだけ、上限で諦める)
        if (composing) {
          if (at - composeAt < COMPOSING_MAX_MS) return false;
          composing = false;
        }
        if (at - last < quietMs) return false;
        dirty = false;
        return true;
      },
      isDirty: function () { return dirty; },
      /**
       * 🔴 **マウスだけの編集を拾う**(#1228 段 2)。窓に聞いた答え(`isModified`)を渡す。
       *   - 「変更なし」→「変更あり」へ**変わった**とき → 打った印を立てる(表の挿入・図の移動の最初の 1 手)
       *   - 変更ありのまま(2 手目以降)→ 何もしない(毎回書かない)。2 手目以降は `pointed` が拾う
       *   - 聞けなかった(`null`)→ 前の答えのまま
       */
      observeModified: function (mod, at) {
        // ⚠ すでに打った印が立っているときは**起点を動かさない**(打ち続けた分の静止を、聞いた時刻で延ばさない)
        if (mod === true) { if (!knownModified) { knownModified = true; if (!dirty) { dirty = true; if (at > last) last = at; } } }
        else if (mod === false) { knownModified = false; }
      },
      /**
       * マウスを離した。⚠ **変更ありと分かっている間だけ**打った印にする(変更なしの文書でクリックしても書かない)。
       * 🔑 マウスだけの 2 手目以降(変更ありのまま図を動かす)を拾う唯一の信号 ── 動かしていない単なるクリックでも
       * 立つので、書くのは「止まって 3 秒」の 1 回だけ(打鍵と同じ間隔で、毎クリックには書かない)。
       */
      pointed: function (at) { if (knownModified) { dirty = true; if (at > last) last = at; } },
      isKnownModified: function () { return knownModified; },
      compositionStart: function (at) { composing = true; composeAt = at; if (dirty && at > last) last = at; },
      compositionEnd: function (at) { composing = false; dirty = true; if (at > last) last = at; },
      isComposing: function () { return composing; },
      /**
       * 静止の起点を `ms` だけ**後ろへ送る**(Ctrl+S の直後など)。⚠ 印は立てない ── 打っていないなら書かない。
       * 立っている印があるときだけ、`at + ms` から `quietMs` 経ってから書く。
       */
      defer: function (at, ms) { if (at + ms > last) last = at + ms; },
      /**
       * 書けなかったので**印を戻す**。`delayMs` 後(`take` が通る時刻)にもう一度書く。
       * ⚠ その間に打たれていれば、打った時刻のほうが後なのでそちらを採る。
       */
      retry: function (at, delayMs) {
        dirty = true;
        var due = at + delayMs - quietMs;
        if (due > last) last = due;
      },
    };
  }

  /**
   * 窓の入力 1 件を、静止の判定へ渡す(`host.html` の listener が呼ぶ。判断はここ ── host.html は unit が届かない)。
   *   - 修飾キーだけの押下 → 何もしない(Ctrl を押しただけで「打った」にしない)
   *   - pointerup / mouseup → 変更ありと分かっているときだけ打った印(#1228 段 2。マウスだけの編集)
   *   - Ctrl / Meta + S の keydown → 打った印は立てず、静止の起点を `SAVE_DEFER_MS` 後ろへ送る
   *   - compositionstart / compositionend → 変換中の出入り(終わるまで書かない)
   *   - それ以外 → 打った印
   * @param type イベントの種類 / @param e イベント(`key` / `ctrlKey` / `metaKey` を読む)/ @param at 時刻(ms)
   */
  var MODIFIER_KEYS = { Shift: 1, Control: 1, Alt: 1, Meta: 1, CapsLock: 1 };
  function feedInput(quiet, type, e, at) {
    if (!quiet) return;
    if (type === 'compositionstart') { quiet.compositionStart(at); return; }
    if (type === 'compositionend') { quiet.compositionEnd(at); return; }
    // マウスを離した ── 変更ありと分かっているときだけ印(`createQuiet().pointed`)
    if (type === 'pointerup' || type === 'mouseup') { quiet.pointed(at); return; }
    if (type === 'keydown' && e) {
      if (MODIFIER_KEYS[e.key] === 1) return;
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') { quiet.defer(at, SAVE_DEFER_MS); return; }
    }
    quiet.typed(at);
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
   * - 選ぶ: 保存していない変更が在る文書のうち、**書ける形式(`.odt` / `.docx`)を先に**、同じ書ける形式の中では
   *   窓が開いた文書(`opts.docPath`。MEMFS の path)と同じ場所の物を優先。同順位なら最初の 1 件。
   *   ⚠ 書けない形式(`.xlsx` など / 場所の無い新規文書)が先に来ても、後ろの書ける文書の影を**取りこぼさない**
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
    var chosenRank = -1;
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
            // 書ける形式(2)> 同じ場所(1)。⚠ 書けない文書しか無ければ最初の 1 件(`skipped: 'format'` を返す)
            var rank = (filterFor(extOfName(loc)) !== null ? 2 : 0) + (matches ? 1 : 0);
            if (chosen === null || rank > chosenRank) {
              del(chosen);
              chosen = el; chosenLoc = loc; chosenRank = rank;
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
      if (!(size > 0)) throw new Error('shadow: 空の下書きが書かれた');
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

  /**
   * 棚の中の名前にできる形へ。⚠ 空なら呼び側が代わりの id(窓ごとの `winKey`)を渡す。
   * 🔴 **`local:` で始まる合言葉は使わない**(手元の file。`local-office-files.ts` の連番はページを読み込むたびに
   * 1 から数え直す)── `local:1` が**別の file・別の窓・別のタブで同じ棚**になり、`shelve` が古い名前を消して
   * **別の file の唯一の影を消す**。窓ごとの名前を使い、元の file 名は `meta.json` に書き添える。
   */
  function safeId(token, fallback) {
    var raw = String(token || '');
    if (raw.indexOf(LOCAL_TOKEN_PREFIX) === 0) raw = '';
    var t = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
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

  /** 棚の記録(`meta.json`)を書く。⚠ 書けなくても投げない(影は既に置けている)。 */
  async function writeMeta(dir, d, at) {
    var o = d.origin || {};
    var text = JSON.stringify({
      v: 1,
      name: typeof o.name === 'string' ? o.name : '',
      size: typeof o.size === 'number' && o.size >= 0 ? o.size : null,
      at: at,
      ext: d.ext,
      // どのノートの添付か(#1228 段 2。本体が「この添付の影」を引く)。⚠ 手元の file(`local:`)・窓の中で作った文書は空
      lid: typeof o.lid === 'string' && o.lid.indexOf(LOCAL_TOKEN_PREFIX) !== 0 ? o.lid : '',
    });
    var w = null;
    try {
      var fh = await dir.getFileHandle(META_NAME, { create: true });
      w = await fh.createWritable();
      await w.write(new TextEncoder().encode(text));
      await w.close();
      return true;
    } catch (e) {
      if (w) { try { await w.abort(); } catch (e2) { /* 既に閉じている */ } }
      return false;
    }
  }

  /**
   * 影を OPFS の棚 `<SHELF_DIR>/<id>/<時刻>.<拡張子>` へ**刻んで**置く(丸ごと複製しない)。
   * 置けたら、**同じ棚の古い影を消す**(最新 1 つだけ残す)。⚠ 自分より新しい名前は消さない(別の窓の分)。
   * ⚠ 書きかけは残さない(`createWritable` は close で確定する。失敗したら `abort`)。
   * 棚には**元の文書の記録**(`meta.json`)も 1 つ置く(段 2 が「どの file の影か」を探せるように)。
   * 中身は `{ v, name, size, at, ext, lid }` だけ ── ⚠ **本文は入れない**。書けなくても影は成功とする(影が本体)。
   * @param d `storage`(`navigator.storage`)/ `id` / `ext` / `size` / `read(into, wanted, position)` / `now` /
   *   `origin`(任意。`{ name, size, lid }` ── 元の文書の名前と大きさ・どのノートの添付か)
   * @returns `{ at, name, meta }`(`meta` は記録を書けたか)
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
    // ⚠ 影の名前だけを数える(`meta.json` など別の物は消さない)
    for await (var k of dir.keys()) { if (SHADOW_NAME_RE.test(k) && k < name) olds.push(k); }
    for (var i = 0; i < olds.length; i += 1) {
      try { await dir.removeEntry(olds[i]); } catch (e) { /* 消せなくても次回消える */ }
    }
    var metaOk = await writeMeta(dir, d, at);
    return { at: at, name: name, meta: metaOk };
  }

  /**
   * 棚(`<SHELF_DIR>/<id>`)を**丸ごと消す**(#1228 段 2)。保存が通った窓が、その文書の影を片付けるのに使う。
   * ⚠ **冪等** ── 棚が無くても投げない(`false` を返す)。⚠ 他の `id` の棚は触らない。
   * @returns 消したか
   */
  async function unshelve(d) {
    var s = d.storage;
    if (!s || typeof s.getDirectory !== 'function') return false;
    try {
      var rootDir = await s.getDirectory();
      var top = await rootDir.getDirectoryHandle(SHELF_DIR, { create: false });
      await top.removeEntry(d.id, { recursive: true });
      return true;
    } catch (e) {
      return false;
    }
  }

  // ───────────────────────── 画面に出す理由(内部の語を出さない) ─────────────────────────

  /** 失敗の理由を、user が読める短い字へ。⚠ `fd_sync` / `storeToURL` / OPFS などの内部語を出さない。 */
  function reasonOf(e) {
    var code = e && e.shadowReason;
    if (code === 'no-opfs') return 'この端末の保存領域を使えません';
    if (code === 'no-gate') return 'このバージョンの Office では書けません';
    if (code === 'no-uno') return '編集の状態を Office に聞けませんでした';
    if (e && e.name === 'QuotaExceededError') return '保存領域の空きが足りません';
    return '書き出せませんでした';
  }

  // ───────────────────────── 書く流れ(静止 → 確かめる → 書く → 棚へ) ─────────────────────────

  /**
   * 1 回の `tick` が、静止していれば影を 1 つ書く。
   * @param d `now()` / `quiet`(`createQuiet`)/ `isDead()` / `isModified()`(Promise。`true` / `false` / `null` = 聞けなかった)/
   *   `write()`(同期。`storeShadowSync`)/ `shelve(info)`(Promise)/ `discard()` / `onWritten(at)` / `onFailed(reason)` /
   *   `log(e)`(任意)/ `pollMs`(任意。`MODIFIED_POLL_MS` ── 聞く間隔。省けば聞かない = 打鍵の契機だけ)/
   *   `unshelve()`(任意。Promise ── `afterSaved` が棚を消す)
   * @returns `'dead' | 'busy' | 'wait' | 'clean' | 'skipped' | 'written' | 'failed'`(test の観測点)
   */
  function createWriter(d) {
    var busy = false;
    var lastReason = null;
    var failures = 0;
    var lastPoll = null;
    // 書いている最中に保存が通った。⚠ その場で棚を消すと書きかけの `createWritable` が転ぶ ── 終わってから消す
    var clearPending = false;
    async function clearShelf() {
      // 🔴 **消してよいのは「保存した後に変更が無い」と窓が答えたときだけ**。⚠ 聞けなかった(`null`)/ 変更あり
      //    は消さない ── 保存の後に打った分は、これから書く影が持つ(消すと、その分を守れない)
      var mod = await d.isModified();
      if (mod !== false) return false;
      if (typeof d.unshelve !== 'function') return false;
      try { return !!(await d.unshelve()); } catch (e) { return false; }
    }
    /** 書けなかった。印を戻して間をあけて再試行する(続くほど間を伸ばす)。 */
    function again() {
      var q = d.quiet;
      var wait = RETRY_BACKOFF_MS[Math.min(failures, RETRY_BACKOFF_MS.length - 1)];
      failures += 1;
      if (q && typeof q.retry === 'function') q.retry(d.now(), wait);
    }
    function fail(reason) {
      // 同じ理由が続くとき 1 度だけ言う(打つたびに同じ 1 行を出さない)。成功したら言い直せる
      if (reason !== lastReason) { lastReason = reason; d.onFailed(reason); }
    }
    return {
      tick: async function () {
        if (d.isDead()) return 'dead';
        if (busy) return 'busy';
        // 🔴 マウスだけの編集(#1228 段 2): 一定の間隔で窓に聞き、変わったら静止の印を立てる(書くのは下の同じ 1 本)
        if (typeof d.pollMs === 'number' && typeof d.quiet.observeModified === 'function') {
          var t = d.now();
          if (lastPoll === null || t - lastPoll >= d.pollMs) {
            lastPoll = t;
            busy = true;
            try { d.quiet.observeModified(await d.isModified(), d.now()); }
            catch (e) { /* 聞けなかった ── 次の回に聞く */ }
            finally {
              busy = false;
              if (clearPending) { clearPending = false; void clearShelf(); }
            }
          }
        }
        if (!d.quiet.take(d.now())) return 'wait';
        busy = true;
        try {
          var mod = await d.isModified();
          if (mod === null) { fail(reasonOf({ shadowReason: 'no-uno' })); again(); return 'failed'; }
          // 保存済み(変更なし)は書かない
          if (mod !== true) { failures = 0; return 'clean'; }
          var info = d.write();
          if (info && info.skipped) { failures = 0; return 'skipped'; }
          await d.shelve(info);
          lastReason = null;
          failures = 0;
          d.onWritten(d.now());
          return 'written';
        } catch (e) {
          // 画面には字を出し、原因は console へ(内部の語はここだけ)
          if (typeof d.log === 'function') { try { d.log(e); } catch (e2) { /* 記録に失敗しても続ける */ } }
          fail(reasonOf(e));
          again();
          return 'failed';
        } finally {
          busy = false;
          try { d.discard(); } catch (e) { /* 片付けに失敗しても次の回がある */ }
          if (clearPending) { clearPending = false; void clearShelf(); }
        }
      },
      /**
       * 🔴 **保存が通った**(#1228 段 2)。保存した後に変更が無ければ、この文書の影を消す
       * (影が残ると、次に「Office で開く」を押したとき保存済みの版と取り違えて訊いてしまう)。
       * ⚠ 影を書いている最中なら、終わってから消す。
       * @returns 消したなら true(書いている最中で後回しにしたときは false)
       */
      afterSaved: async function () {
        if (d.isDead()) return false;
        if (busy) { clearPending = true; return false; }
        return clearShelf();
      },
      isBusy: function () { return busy; },
    };
  }

  root.PKC3OfficeShadow = {
    QUIET_MS: QUIET_MS,
    SAVE_DEFER_MS: SAVE_DEFER_MS,
    COMPOSING_MAX_MS: COMPOSING_MAX_MS,
    RETRY_BACKOFF_MS: RETRY_BACKOFF_MS,
    MODIFIED_POLL_MS: MODIFIED_POLL_MS,
    META_NAME: META_NAME,
    LOCAL_TOKEN_PREFIX: LOCAL_TOKEN_PREFIX,
    feedInput: feedInput,
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
    unshelve: unshelve,
    reasonOf: reasonOf,
    createWriter: createWriter,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
