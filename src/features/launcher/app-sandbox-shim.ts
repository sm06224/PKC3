/**
 * 🔴 **囲いの中で「無い能力」を、投げずに・黙らずに見せる**(2026-08-06。user 報告 2-15)。
 *
 * `localStorage` は既に差し替えてある(`app-storage-shim.ts` が**本当に貸している**)。
 * 例外が出たあとの 1 行も既にある(`app-anchor-shim.ts` の `say()`)。
 * 残っていたのは**その手前** ── 投げること自体を止める手当てである。
 *
 * ## 🔴 実測(2026-08-06。フル Chromium / 親は `http://localhost` = secure context)
 *
 * 調査 doc は「5 つとも**プロパティ読みで**投げる」と書いていたが、**測ったら違った**
 * ── 読みで投げるものと、**読めるのに使えない**ものが混在している:
 *
 * | | 読む | 使う |
 * |---|---|---|
 * | `indexedDB` | ok | `.open()` / `.deleteDatabase()` が **SecurityError** |
 * | `caches` | **SecurityError** | ─ |
 * | `navigator.serviceWorker` | **SecurityError** | ─ |
 * | `document.cookie` | **SecurityError**(読み・書き両方) | ─ |
 * | `navigator.storage` | ok | `getDirectory()` は ok(**promise が reject**) |
 * | `localStorage` | **SecurityError** | ─(別 module が貸している) |
 *
 * ⚠ 対照群(同一オリジンの親そのもの)は **12 項目すべて ok** ── 上の throw は
 *   隔離に由来する。⚠ 最初の計測は親を `about:blank` にしてしまい、
 *   `caches` が「非セキュアコンテキストなので単に無い」に化けて**読みが ok に
 *   見えた** ── 環境の性質を実装の挙動と読み違えないこと。
 *
 * この表から手当ての形が決まる:
 * - **読みで投げるもの**(`caches` / `serviceWorker` / `cookie`)→ getter を差し替える
 * - **読めるのに使えないもの**(`indexedDB`)→ **使ってみて**判定する。
 *   ⚠ 能力を見るアプリ(`if (window.indexedDB)`)は**真と読んでしまう**ので、
 *   読みだけ守っても `.open()` で 1 行目から死ぬ。probe は `deleteDatabase` に
 *   する ── 存在しない名前への削除は同一オリジンでは**副作用の無い成功**で、
 *   囲いの中では投げる(= 判別できる。上の実測がそれを示している)
 * - **reject で返るもの**(`navigator.storage`)→ 触らない。promise は catch できる
 *   ので「1 行目で死ぬ」形ではない(表に残すのは、将来 throw に変わったら
 *   同じ道で拾えるようにするため)
 *
 * ## 方針
 * 1. **実装はしない**(IndexedDB を真似ない ── 新機能を盛り込みすぎない)。
 *    「**無い**」として見せる ── `if (window.indexedDB)` の形で能力を見るアプリは
 *    そのまま代替(= 貸している localStorage)へ落ちる。
 * 2. **触られたら 1 行出す** ── 黙って無いことにすると「保存したのに残らない」の
 *    理由が user に届かない。⚠ 出す先は**アプリの文書の中**(外殻へ postMessage
 *    しない)── `app-anchor-shim.ts` が「受け口を増やさずに済む形を選ぶ」と決めた
 *    のと同じ判断。規則を 2 本にしない。
 * 3. ⚠ 例外の行は**下**、こちらは**上**に出す ── どちらも `position: fixed` なので
 *    同じ端に置くと重なって片方が読めない(能力の話と落ちた話は同時に起きる)。
 *
 * ⚠ **pure module**(browser API を使わない ── 文字列を組むだけ)。
 * ⚠ 外側のテンプレートリテラルへ焼くので、**バッククォートと `${`** を
 *   shim 本体に書かない(app-storage-shim.ts と同じ制約 ── 3 度ビルドを壊した)。
 */

/** 「使えないものに触った」1 行の器(test / smoke がここで観測する)。 */
export const APP_CAPABILITY_FIELD = 'app-capability';

/**
 * 囲いの中では使えないもの。⚠ **`localStorage` / `sessionStorage` は入れない**
 * ── あちらは本当に貸しているので、無いことにしてはいけない。
 */
export const SANDBOX_ABSENT = ['indexedDB', 'caches', 'storage', 'serviceWorker', 'cookie'];

/** 画面に出す呼び名(内部名 → user に見える語)。 */
const LABELS: Readonly<Record<string, string>> = {
  indexedDB: 'IndexedDB',
  caches: 'Cache API',
  storage: '保存容量の問い合わせ',
  serviceWorker: 'Service Worker',
  cookie: 'cookie',
};

const SOURCE = `
(function (labels) {
  'use strict';
  var touched = [];
  var line = null;
  function tell(name) {
    if (touched.indexOf(name) >= 0) return;
    touched.push(name);
    var host = document.body || document.documentElement;
    if (!host) return;
    if (!line) {
      line = document.createElement('p');
      line.setAttribute('data-pkc-field', 'app-capability');
      // ⚠ 例外の行は下端なので、こちらは**上端**(重ねない)
      line.style.cssText = 'position:fixed;left:0;right:0;top:0;margin:0;padding:6px 10px;' +
        'font:12px/1.5 system-ui,sans-serif;background:#3a3320;color:#f0e6c8;z-index:2147483646;' +
        'cursor:pointer';
      // 🔑 **閉じられるようにする**。これは「落ちた」ではなく**お知らせ**である ──
      //    能力を見て代替へ落ちるアプリ(よくある形)は正常に動いているのに、
      //    帯がその画面を覆い続ける。⚠ 押す先はアプリの UI ではなくこの帯だけ
      line.title = '押すと閉じます';
      line.addEventListener('click', function () {
        if (line && line.parentNode) line.parentNode.removeChild(line);
      });
      host.appendChild(line);
    }
    var names = [];
    for (var i = 0; i < touched.length; i++) names.push(labels[touched[i]] || touched[i]);
    // ⚠ **1 枚を書き換える**(足すたびに行を増やさない ── 画面が埋まる)
    line.textContent =
      'このアプリは ' + names.join(' / ') + ' を使おうとしましたが、囲いの中では使えません' +
      '(押すと閉じます)';
  }
  function hide(host, name) {
    try {
      Object.defineProperty(host, name, {
        configurable: true,
        enumerable: true,
        get: function () {
          tell(name);
          return undefined;
        },
      });
    } catch (e) { /* 差し替えられなくても、アプリは壊さない */ }
  }
  // ⚠ **使えるものは触らない**(素のまま = 同一オリジンで開いた場合)。
  //    ⚠ 判定は 2 段 ── 読めない / 読めるが使えない。実測の表(上の TSDoc)より、
  //    IndexedDB は**読めるのに使えない**ので、読みだけ見ると素通りする。
  function absent(host, name, use) {
    var value;
    try {
      value = host[name];
    } catch (e) {
      hide(host, name); // 読みで投げる(caches / serviceWorker)
      return;
    }
    if (!use || value === undefined || value === null) return;
    try {
      use(value);
    } catch (e2) {
      hide(host, name); // 読めるが使えない(indexedDB)
    }
  }
  absent(window, 'indexedDB', function (idb) {
    // ⚠ **副作用の無い probe を選ぶ** ── 存在しない名前への削除は同一オリジンでは
    //    ただ成功する(DB を作らない)。open は作ってしまうので使わない
    idb.deleteDatabase('pkc3-capability-probe');
  });
  absent(window, 'caches');
  absent(navigator, 'storage');
  absent(navigator, 'serviceWorker');
  // 🔑 cookie は **undefined ではなく空文字** ── 素の環境で cookie が無いときと
  //    同じ姿にしないと、document.cookie.split(…) 型の書き方が TypeError で
  //    落ちる(無いことより悪くなる)。⚠ 書き込みも受けて捨てる(投げない)
  try {
    void document.cookie;
  } catch (e2) {
    try {
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        enumerable: true,
        get: function () {
          tell('cookie');
          return '';
        },
        set: function () {
          tell('cookie');
        },
      });
    } catch (e3) { /* 同上 */ }
  }
})`;

/**
 * 能力の shim(囲いの中だけで効く ── 読める環境では何もしない)。
 *
 * ⚠ 1 行の文に「保存は localStorage に貸しています」と続けたくなるが**書かない**:
 *   ① 貸すかどうかは**呼び側の条件**(`appId` の有無)なので、ここで言うと嘘になりうる
 *   ② `shim` 本体は文字列として srcdoc に焼かれるので、**コメントに書いた語も
 *      生成物に混ざる** ── 「貸さないときは外殻に `localStorage` の語が 1 つも
 *      出ない」を pin している test が、説明文だけで落ちる(実際に落とした)。
 *      CLAUDE.md「コメントを剥いでから走査する」の裏返しの罠である。
 */
export function buildCapabilityShim(): string {
  return `<script>${SOURCE}(${JSON.stringify(LABELS).replace(/</g, '\\u003c')});</script>`;
}
