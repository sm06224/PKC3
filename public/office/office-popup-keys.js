/**
 * 🔴 **メニューが開いている間、打った字をメニューへ届ける**(#1360)。
 *
 * ## 直している実害(cowork の実機報告 2026-10-06、Mac / Chrome)
 *
 * 1. 右クリックのメニューで `Y`(日本語の「コピー(Y)」)を押しても何も起きない。矢印 + Enter なら動く。
 * 2. 日本語入力がオンだと、同じ `Y` が **選んだ範囲を「ｙ」に置き換え**、本文 4 ページが消えた。
 *
 * ## 原因(Qt の wasm plugin を読んで確定。手元の headless でも `Shift+F10` で再現)
 *
 * Qt は IME 用に隠し `<input>` を 1 つ持ち、文書に焦点があるあいだそこへ DOM の焦点を置く。
 * `QWasmWindow::handleKeyForInputContextEvent`(`qwasmwindow.cpp`)は、その `<input>` が受けた
 * **修飾キーなしの 1 文字キー**を `inputMethodAccepted()` のとき「input イベントで処理する」として
 * **キーイベントにせずに返す**。字は `insertText` / 変換中の字として **文書へ入る**。
 *
 * ところが LO のメニューは VCL が自前で描き、**キーイベントで**鍵(mnemonic)を探す。メニューが開いても
 * Qt の `<input>` の焦点はそのままなので(マウスで開いたときは版面を押して焦点が外れる環境もあるが、
 * キーボード / Mac では残る)、`Y` は **キーイベントにならず文書へ入る**。
 * 日本語入力オンでは `Y` が変換中の「ｙ」になり、**選択範囲を置き換える**。
 *
 * ## 直し(この file)
 *
 * メニュー(= 枠のない Qt の窓が足された状態)が開いているあいだ、`<input>` が受けた字のキーを
 *  - **そのまま握り潰し**(文書へ入れない)、
 *  - **同じキーを、開いているメニューの canvas へ合成のキーイベントとして渡す**(Qt の canvas の keydown が受け、
 *    VCL のメニューが鍵として拾う)。日本語入力の「処理済みキー」(keyCode 229 / key が `Process`)は
 *    `code`(`KeyY`)から字を決める。
 *  - 握り潰したキーから**変換が始まっても Qt へ流さず**、その変換を捨てる(`blur` → `focus`)。
 *
 * ⚠ **ここは「判断」と、DOM への薄い配線**。判断(`decide`)は DOM を触らず、unit が届く
 *   (`host.html` は bundle されないので、ここへ出さないと test が 1 件も届かない。`office-title-watch.js` と同じ理由)。
 * ⚠ 枠のあるダイアログ(`has-title`)は「メニュー」に数えない ── ダイアログの入力欄には日本語を打てなければならない。
 *   ツールチップも枠なしの窓だが、字を打つ手を止めずにキーイベント経由でも同じ字が文書へ届く(VCL が受ける)。
 * ⚠ Mac 実機(IME)は未測。手元の headless では `Input.imeSetComposition` で再現し、直りを確かめる
 *   (`build/office-wasm/ime-compose-probe.mjs` の `ctx-kbd` / `ctx-kbd-ime` 腕)。
 */
(function (root) {
  'use strict';

  /** 変換で処理されたキーの印(keyCode 229 / key = Process or Unidentified)。 */
  function isImeProcessed(ev) {
    return ev.keyCode === 229 || ev.key === 'Process' || ev.key === 'Unidentified' || ev.isComposing === true;
  }

  /**
   * `code`(物理キー)から、メニューの鍵に使う字を決める。英字 / 数字だけ(それ以外は null)。
   * ⚠ Shift つきの数字(記号になる)は決められないので null。
   */
  function keyFromCode(code, shiftKey) {
    var m = /^Key([A-Z])$/.exec(code || '');
    if (m) return shiftKey ? m[1] : m[1].toLowerCase();
    var d = /^Digit([0-9])$/.exec(code || '');
    if (d && !shiftKey) return d[1];
    return null;
  }

  /** この窓の枠(`.qt-decorated-window` の class)は、メニュー(枠なし)か。 */
  function isFramelessWindowClass(cls) {
    var c = ' ' + String(cls || '').replace(/\s+/g, ' ') + ' ';
    return c.indexOf(' qt-decorated-window ') >= 0 && c.indexOf(' has-title ') < 0;
  }

  /**
   * キー 1 つをどうするか。
   *
   * `ev`: { key, code, keyCode, isComposing, shiftKey, ctrlKey, altKey, metaKey, repeat }
   * `ctx`: { popupOpen: メニューが開いているか, onImeInput: keydown の宛先が Qt の IME 用 <input> か }
   *
   * 返り値: `{ kind: 'pass' }`(何もしない)/ `{ kind: 'route', key, ime }`(握り潰して、メニューへ key を渡す)。
   */
  function decide(ev, ctx) {
    if (!ctx.popupOpen || !ctx.onImeInput) return { kind: 'pass' };
    // 修飾キーつきは Qt が元から key イベントにする(Ctrl+C など)。Alt は AltGr(ctrl+alt)の字も含むので触らない
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return { kind: 'pass' };
    if (ev.isComposing === true) return { kind: 'pass' }; // 変換の途中のキーは変換へ(メニューより前に始まっている)
    var ime = isImeProcessed(ev);
    var key = null;
    if (!ime && typeof ev.key === 'string' && ev.key.length === 1) key = ev.key;
    else if (ime) key = keyFromCode(ev.code, ev.shiftKey);
    if (key === null) return { kind: 'pass' };
    return { kind: 'route', key: key, ime: ime };
  }

  /** 合成するキーイベントの初期値(Qt が読む `key` `code` `repeat` と修飾キー)。 */
  function syntheticInit(ev, key) {
    return {
      key: key,
      code: ev.code || '',
      shiftKey: !!ev.shiftKey,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: !!ev.repeat,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
  }

  // ── DOM への配線 ────────────────────────────────────────────────

  /**
   * shadow root を越えて、Qt の窓の canvas を集める(後ろほど手前)。`onlyFrameless` なら枠のない窓(= メニュー)だけ。
   * ⚠ 見るのは `#screen` の中だけ(ページ全体を歩かない。打鍵のたびに呼ぶ)。
   */
  function findCanvases(doc, onlyFrameless) {
    var screen = doc.getElementById('screen');
    var out = [];
    if (!screen) return out;
    (function walk(node) {
      var els = node.querySelectorAll('*');
      for (var i = 0; i < els.length; i += 1) {
        var el = els[i];
        if (el.classList && el.classList.contains('qt-decorated-window')
            && (!onlyFrameless || isFramelessWindowClass(el.className))) {
          var vis = !el.style || el.style.display !== 'none';
          var canvas = el.querySelector('canvas');
          if (vis && canvas) out.push(canvas);
        }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    })(screen);
    return out;
  }

  function findPopupCanvases(doc) {
    return findCanvases(doc, true);
  }

  function isImeInput(el) {
    // Qt が `m_inputElement.set("data-qinputcontext", ptr)` で付ける property(attribute ではない)
    return !!el && el.tagName === 'INPUT' && el['data-qinputcontext'] !== undefined;
  }

  /**
   * `win`(window)へ配線する。`env.doc` 省略時は `win.document`。返り値の `uninstall()` で外す。
   * ⚠ capture で受ける(Qt の `<input>` の listener より前に走らせる)。
   */
  function install(win, env) {
    var doc = (env && env.doc) || win.document;
    var routed = {}; // code -> 合成した key(keyup も同じ形で渡すため)
    var swallowing = false;
    var swallowTimer = null;
    var lastInput = null;

    function target(e) {
      var p = e.composedPath ? e.composedPath() : null;
      return p && p.length ? p[0] : e.target;
    }

    function stopSwallowing() {
      swallowing = false;
      if (swallowTimer) { win.clearTimeout(swallowTimer); swallowTimer = null; }
    }

    function dispatchOn(canvas, type, ev, key) {
      var KE = win.KeyboardEvent;
      canvas.dispatchEvent(new KE(type, syntheticInit(ev, key)));
    }

    function onKeyDown(e) {
      var t = target(e);
      var popups = findPopupCanvases(doc);
      var d = decide(e, { popupOpen: popups.length > 0, onImeInput: isImeInput(t) });
      if (d.kind !== 'route') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      routed[e.code] = d.key;
      lastInput = t;
      dispatchOn(popups[popups.length - 1], 'keydown', e, d.key);
      if (d.ime) {
        // 処理済みキーは、このあと変換が始まりうる。始まった変換は Qt へ流さず捨てる(文書を置き換えさせない)
        swallowing = true;
        if (swallowTimer) win.clearTimeout(swallowTimer);
        swallowTimer = win.setTimeout(stopSwallowing, 1500);
      }
    }

    function onKeyUp(e) {
      var key = routed[e.code];
      if (key === undefined) return;
      delete routed[e.code];
      e.preventDefault();
      e.stopImmediatePropagation();
      // 合成の keydown でメニューが閉じることがある。keyup は残っている窓のどれかへ渡す(Qt は窓を問わず受ける)
      var all = findCanvases(doc, false);
      if (all.length) dispatchOn(all[all.length - 1], 'keyup', e, key);
    }

    function onComposition(e) {
      if (!swallowing || !isImeInput(target(e))) return;
      e.stopImmediatePropagation();
      if (e.type === 'beforeinput' && e.cancelable) e.preventDefault();
      if (e.type === 'compositionstart') {
        // 捨てる: 焦点を外すと変換は確定して終わる(確定の event もここで握り潰される)→ すぐ焦点を戻す
        var el = target(e);
        win.setTimeout(function () {
          try { el.blur(); el.focus(); } catch (err) { /* 窓が閉じている */ }
        }, 0);
      }
      if (e.type === 'compositionend') stopSwallowing();
    }

    var names = ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input'];
    win.addEventListener('keydown', onKeyDown, true);
    win.addEventListener('keyup', onKeyUp, true);
    for (var i = 0; i < names.length; i += 1) win.addEventListener(names[i], onComposition, true);

    return {
      uninstall: function () {
        win.removeEventListener('keydown', onKeyDown, true);
        win.removeEventListener('keyup', onKeyUp, true);
        for (var j = 0; j < names.length; j += 1) win.removeEventListener(names[j], onComposition, true);
        stopSwallowing();
      },
      /** 検査のために内側の状態を見せる */
      state: function () { return { swallowing: swallowing, routed: Object.keys(routed), lastInput: lastInput }; },
    };
  }

  var api = {
    isImeProcessed: isImeProcessed,
    keyFromCode: keyFromCode,
    isFramelessWindowClass: isFramelessWindowClass,
    decide: decide,
    syntheticInit: syntheticInit,
    findPopupCanvases: findPopupCanvases,
    findCanvases: findCanvases,
    isImeInput: isImeInput,
    install: install,
  };
  root.PkcOfficePopupKeys = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
