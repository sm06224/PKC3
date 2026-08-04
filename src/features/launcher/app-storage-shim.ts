/**
 * 隔離したままアプリに**保存領域を貸す**(P8 段⑭)。
 *
 * > user 回答 2026-08-03(原文)
 * > 「**アプリが状態を保存できない」1 点です / 毎回聞かれずに使い続けたいです**」
 *
 * 設計は `docs/development/launcher-app-storage-design-2026-08.md` §2-2 の決定表。
 * ここはその **prelude(アプリの文書の先頭で走る script)を組む pure module**。
 *
 * 🔴 直す前に測ったもの ── opaque origin(`allow-same-origin` 無し)では
 * `window.localStorage` の**プロパティ読みそのもの**が同期に投げる:
 *
 * ```
 * SecurityError: Failed to read the 'sessionStorage' property from 'Window':
 *   The document is sandboxed and lacks the 'allow-same-origin' flag.
 * ```
 *
 * `try/catch` を書いていないアプリは **1 行目で止まる**。user から見えるのは
 * 「白紙 / 読み込み中のまま」だけで、console を開かない限り理由が分からない。
 *
 * 🔑 差し替えられる根拠: `localStorage` は window の **own accessor** で
 * `{enumerable: true, configurable: true}` ── `Object.defineProperty` が通る。
 * 裸の `localStorage` も `globalThis.localStorage` も差し替え先を指す。
 *
 * ⚠ **素のオブジェクトでは駄目**(実測 15 項目中 15 不一致)。`ls.a` のドット読み・
 * `ls.foo = 1`・`Object.keys`・`JSON.stringify`・`'a' in ls`・`delete ls.a` が全滅する。
 * **Proxy(`ownKeys` と `getOwnPropertyDescriptor` の両方)が要る**。
 *
 * ⚠ **`[object Storage]` と `instanceof Storage`** は `Storage.prototype` を
 * 継がせて直す。ただし prototype の native メソッドを素通しさせると
 * `TypeError: Illegal invocation` になるので、get trap で**全部覆う**。
 */

/** 1 アプリあたりの上限(2MB)。⚠ ノート本体と同じ財布を食うので上限は要る。 */
export const APP_STORAGE_LIMIT = 2 * 1024 * 1024;

/**
 * 保存先の名前空間。⚠ `<appId>` は entry の lid ── データは「このアプリ」に付く。
 *
 * 🔴 **lid を符号化する**(P8 段⑯。レビュー)。区切りは `.` なので、lid に `.` が
 * 入ると分離が壊れる ── `lid = "a"` の鍵 `b.c` と `lid = "a.b"` の鍵 `c` が
 * どちらも `pkc3.app.a.b.c` になり、**別のアプリのデータを読み書きできる**。
 * PKC2 取込は lid をそのまま持ち込むので、これは実在しうる形である。
 * ⚠ 符号化はここ 1 か所に閉じる ── `readAppStorage` / `clearAppStorage` /
 * 外殻の走査は必ずここを通す(規則が 2 か所に生えると片方だけ直る)。
 */
export function appStoragePrefix(appId: string): string {
  return `pkc3.app.${encodeURIComponent(appId).replace(/\./g, '%2E')}.`;
}

/**
 * 差分の合図。⚠ **全量スナップショットは送らない** ── 実測で O(N²)
 * (80 回の setItem・計 5MB で clone 累計 212MB)、かつ 2 タブで
 * 「片方の作業が丸ごと消える」が起きた。
 */
export const APP_STORAGE_MESSAGE = 'pkc3.app.storage';

/**
 * インライン script に文字列を埋めるための escape。
 *
 * 🔴 **`JSON.stringify` だけでは足りない**(実測で踏んだ)── `JSON.stringify` は
 * `<` を escape しないので、値の中の `</script>` が**その場で script を閉じる**。
 * 外殻に埋めたアプリ HTML の `</script>` が外殻自身の script を切り、
 * 「外殻が初期化されない」で全部 timeout した。
 */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * prelude の本体。**アプリの文書の中**で走る(= opaque origin)。
 *
 * ⚠ ここは文字列として srcdoc に焼かれるので、外側のテンプレートリテラルと
 * 衝突する記法(バッククォート・`${`)を使わない。
 */
const SHIM_SOURCE = `
(function (seed, limit, tag) {
  'use strict';
  // ⚠ 本物の保管庫が生きている環境では何もしない(差し替えるのは投げるときだけ)
  try { if (window.localStorage) return; } catch (e) { /* ここへ来るのが正常 */ }

  // 🔴 **for...in を使わない**(実測で踏んだ)── target は Storage.prototype を
  //    継いでいるので、for...in が prototype の列挙可能メンバまで舐め、
  //    target.length の getter が**実 Storage でない this** で呼ばれて
  //    TypeError: Illegal invocation になる(SPA が 1 行目で死ぬ ── 直す前と同じ症状)。
  //    own の文字列キーだけが要るので Object.keys で足りる。
  function bytesOf(map) {
    var keys = Object.keys(map);
    var n = 0;
    for (var i = 0; i < keys.length; i++) n += keys[i].length + map[keys[i]].length;
    return n;
  }

  function quotaError() {
    try {
      return new DOMException('保存領域の上限を超えました', 'QuotaExceededError');
    } catch (e) {
      var err = new Error('保存領域の上限を超えました');
      err.name = 'QuotaExceededError';
      return err;
    }
  }

  function build(initial, notify, exposeTarget) {
    // Storage.prototype を継ぐ ── [object Storage] と instanceof が本物と揃う
    var target = Object.create(typeof Storage === 'function' ? Storage.prototype : Object.prototype);
    if (exposeTarget) localTarget = target;
    var seedKeys = Object.keys(initial);
    for (var i = 0; i < seedKeys.length; i++) target[seedKeys[i]] = String(initial[seedKeys[i]]);

    var api = {
      getItem: function (key) {
        key = String(key);
        return Object.prototype.hasOwnProperty.call(target, key) ? target[key] : null;
      },
      setItem: function (key, value) {
        key = String(key);
        value = String(value);
        // ⚠ 直前の書込が外殻に**入らなかった**なら、ここで知らせる
        //    (同期に投げる ── 本物の意味論に寄せる)
        if (rejected !== null) {
          rejected = null;
          throw quotaError();
        }
        var had = Object.prototype.hasOwnProperty.call(target, key);
        var next = bytesOf(target) - (had ? key.length + target[key].length : 0) + key.length + value.length;
        // ⚠ **同期に投げる**(本物の意味論)── 投げないと「上限で古いものを捨てる」
        //    型のアプリが永久に捨てず、静かに食い続ける
        if (next > limit) throw quotaError();
        var prevVal = had ? target[key] : null;
        target[key] = value;
        notify({ op: 'set', key: key, value: value, __prev: prevVal });
      },
      removeItem: function (key) {
        key = String(key);
        delete target[key];
        notify({ op: 'remove', key: key });
      },
      clear: function () {
        var ks = Object.keys(target); // ⚠ ここも for...in にしない(上と同じ罠)
        for (var i = 0; i < ks.length; i++) delete target[ks[i]];
        notify({ op: 'clear' });
      },
      key: function (i) {
        var keys = Object.keys(target);
        i = Number(i) || 0;
        return i >= 0 && i < keys.length ? keys[i] : null;
      },
    };

    return new Proxy(target, {
      get: function (t, prop) {
        if (prop === 'length') return Object.keys(t).length;
        if (Object.prototype.hasOwnProperty.call(api, prop)) return api[prop];
        var v = t[prop];
        // ⚠ prototype の native メソッドを素通しさせない(Illegal invocation になる)
        return typeof v === 'function' ? undefined : v;
      },
      set: function (t, prop, value) {
        if (typeof prop === 'symbol') { t[prop] = value; return true; }
        api.setItem(prop, value);
        return true;
      },
      has: function (t, prop) {
        return Object.prototype.hasOwnProperty.call(t, prop);
      },
      deleteProperty: function (t, prop) {
        if (Object.prototype.hasOwnProperty.call(t, prop)) api.removeItem(prop);
        return true;
      },
      ownKeys: function (t) {
        return Object.keys(t);
      },
      getOwnPropertyDescriptor: function (t, prop) {
        if (!Object.prototype.hasOwnProperty.call(t, prop)) return undefined;
        return { value: t[prop], writable: true, enumerable: true, configurable: true };
      },
    });
  }

  // 🔴 **外殻の返事を受ける**(P8 段⑯。レビュー H-3)。かつては投げっぱなしで、
  //    外殻側で書けなかった場合に**アプリの保存が無言で消えて**いた
  //    (実測: 例外 none・読み戻しも成功なのに、次回起動で 1 件も残っていない)。
  //    ⚠ 同期の意味論は 1 手遅れる(次の setItem で投げる)が、黙って消えるより
  //    はるかによい ── 「壊れを検出する材料を捨てない」と同じ向きの判断
  var seq = 0;
  var inflight = {};
  var rejected = null;
  /** local 側の実体(巻き戻しに要る)。⚠ session は往復しないので持たない。 */
  var localTarget = null;

  function send(payload) {
    try {
      payload.tag = tag;
      if (payload.op === 'set') {
        seq += 1;
        payload.seq = seq;
        // 🔴 **前の値は代入の前に捕まえたものを使う**(実測で外した)。
        //    ここで target を読むと、既に新しい値が入っているので巻き戻しが no-op になる
        inflight[seq] = { key: payload.key, prev: payload.__prev };
        delete payload.__prev; // ⚠ 外殻へは送らない(payload を倍にしない)
      }
      parent.postMessage(payload, '*');
    } catch (e) {
      // 届かなくてもアプリは動き続ける(保存されないだけ)
    }
  }


  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.tag !== tag || d.op !== 'ack') return;
    var rec = inflight[d.seq];
    delete inflight[d.seq];
    if (!rec || d.ok) return;
    // ⚠ **像を巻き戻す** ── 外殻に入っていないものを「在る」と見せ続けない
    if (localTarget) {
      if (rec.prev === null) delete localTarget[rec.key];
      else localTarget[rec.key] = rec.prev;
    }
    rejected = rec.key;
  });

  var local = build(seed, send, true);
  // ⚠ sessionStorage は**タブ単位**なので往復させない(メモリだけ)
  var session = build({}, function () {});

  function install(name, value) {
    try {
      Object.defineProperty(window, name, {
        value: value,
        writable: false,
        enumerable: true,
        configurable: true,
      });
    } catch (e) {
      /* 差し替えられない環境でも、アプリを止めない */
    }
  }
  install('localStorage', local);
  install('sessionStorage', session);
})`;

export interface ShimOptions {
  /** 起動前に外殻が読んだ保存内容。 */
  seed: Readonly<Record<string, string>>;
  /** 1 アプリの上限(既定 2MB)。 */
  limit?: number;
}

/**
 * prelude の `<script>` を組む。
 *
 * 🔴 **`<!doctype …>` の直後に挿す**(実測で踏んだ)── 素朴に文書の先頭へ
 * 前置すると doctype より前に内容が来るので **quirks mode に落ちる**
 * (`preludeBeforeDoctype` → `BackCompat` / `preludeAfterDoctype` → `CSS1Compat`)。
 * 挿す場所は `insertPrelude()` が決める。
 */
export function buildStorageShim(opts: ShimOptions): string {
  const limit = opts.limit ?? APP_STORAGE_LIMIT;
  return (
    '<script>' +
    SHIM_SOURCE +
    `(${inlineJson(opts.seed)},${String(limit)},${inlineJson(APP_STORAGE_MESSAGE)});` +
    '</script>'
  );
}

/** 先頭の doctype(前に BOM / 空白 / コメントがあってもよい)。 */
const DOCTYPE = /^(\ufeff?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>)/i;

/**
 * アプリの HTML に prelude を挿す。
 *
 * ⚠ **doctype が無ければ先頭に挿す**。無い HTML はもともと quirks mode なので、
 * こちらが `<!doctype html>` を足すと**アプリの箱の計算が変わる**(見た目が壊れる)。
 * 「直接開いたときと同じ」を守る方が大事。
 */
export function insertPrelude(html: string, prelude: string): string {
  const m = DOCTYPE.exec(html);
  if (!m) return prelude + html;
  return m[1] + prelude + html.slice(m[1]!.length);
}
