/**
 * ランチャーの「アプリ」タイルを**隔離して**開くための外殻(P7b 段⑩ 修正 / P8 段⑭)。
 *
 * 🔴 **これは事故の修理である**。段⑩ の初版は取り込んだ HTML 添付の Blob を
 * そのまま `window.open` していた ── blob: URL は**生成したページの origin を
 * 継ぐ**ので、添付の中の script が**アプリ本体と同じ origin** で動いていた。
 * 実測(smoke で計測):
 *
 * ```
 * {"origin":"http://localhost:45732","ls":2,"idb":"pkc3-assets","opfs":".pkc3"}
 * ```
 *
 * つまり `localStorage` に書け、**IndexedDB(`pkc3-assets` = 添付の実体)**と
 * **OPFS(`.pkc3` = SQLite 本体)**を列挙できていた。取り込んだ他人の HTML が
 * ノート全体を読めるということで、これは通してはいけない。
 *
 * 🔑 **既にこのリポジトリには答えがある** ── `features/markdown/html-sandbox.ts`
 * が「`allow-same-origin` を**付けない**」という明文化された設計を持っている。
 * ランチャーだけがそれを迂回していた。同じ規律に載せる:
 *
 * 1. 開くのは**この外殻**(信頼できる自前の HTML)。添付そのものは開かない
 * 2. 添付は `<iframe sandbox="allow-scripts …">` の `srcdoc` に入れる ──
 *    `allow-same-origin` が無いので **opaque origin** になり、
 *    `localStorage` / `indexedDB` / OPFS のどれにも到達できない
 *
 * ⚠ **`allow-popups` を付けても sandbox は外れない** ── 開いた先の window は
 * 同じ sandbox flag を継ぐ(`allow-popups-to-escape-sandbox` を**付けない**限り)。
 *
 * ---
 *
 * ## P8 段⑭: 「隔離したら SPA が動かなくなった」の修理
 *
 * > user 報告 2026-08-03「**ランチャーから起動した単一 html の SPA アプリが動かない**」
 *
 * 実起動で測ったところ、**隔離そのものは正しく、壊れていたのは 3 つ**だった。
 * どれも `allow-same-origin` を足さずに直る(足す案は不可侵の設計に反する):
 *
 * | 症状 | 実測 | 直し方 |
 * |---|---|---|
 * | ① 1 行目で死ぬ | `window.localStorage` の**プロパティ読み**が同期に `SecurityError` | prelude で差し替える(`app-storage-shim.ts`) |
 * | ② 相対 URL が全滅 | `baseURI` が `blob:…`(opaque path)で `new URL(rel, base)` が `TypeError` | `<base>` を焼く |
 * | ③ クリップボードが無反応 | permissions policy(origin とは無関係) | `allow="clipboard-write"` |
 *
 * ⚠ **①は「router が死ぬ」ではない**。`history.pushState` は carve-out で、
 * **解決後の URL が document URL と fragment 以外で一致すれば通る**。
 * `<base>` があれば hash router(React Router 6 / vue-router 4)は無改造で動く
 * ── 逆に `<base>` が無いと HashRouter でも「押しても画面が変わらない」。
 * ⚠ path モードの router は動かないが、これは **`allow-same-origin` を足しても
 * 同じ**(document URL が `about:srcdoc` である以上 path は持てない)── 隔離の
 * 代償ではないので、オプトインでは買えない。
 *
 * ⚠ **`<base>` は `about:srcdoc` にする**。アプリ origin の実 URL にすると、
 * router の fallback(`location.assign('/route/42')`)が **PKC3 本体へ遷移して
 * アプリが消える**(全権側の対照実測でそうなった)。
 *
 * ⚠ **pure module**。browser API を使わない(文字列を組むだけ)。
 */
import {
  APP_STORAGE_LIMIT,
  APP_STORAGE_MESSAGE,
  buildStorageShim,
  inlineJson,
  insertPrelude,
  appStoragePrefix,
} from './app-storage-shim';

/**
 * 添付に許す権限。**`allow-same-origin` は絶対に入れない**
 * ── 入れた瞬間に opaque origin ではなくなり、上の実測の穴が開く。
 *
 * 付けてあるものはどれも「アプリとして成り立つための最低限」で、
 * origin を渡すものは 1 つも無い:
 * - `allow-scripts` … 動かないとアプリではない
 * - `allow-forms` … 入力して送る形の道具が動かない
 * - `allow-modals` … `alert` / `confirm` を潰すと黙って壊れて見える
 * - `allow-popups` … 中のリンクを新しいタブで開ける(sandbox は継がれる)
 * - `allow-downloads` … 生成したファイルを保存できる
 */
export const LAUNCHER_APP_SANDBOX =
  'allow-scripts allow-forms allow-modals allow-popups allow-downloads';

/**
 * permissions policy で明け渡すもの。
 *
 * ⚠ **`clipboard-read` は入れない**(実測で無応答になるうえ、user が他のアプリで
 * コピーした内容を吸えるので危険側)。書く側だけ渡す ── 「結果をコピー」は
 * 道具として要るが、「勝手に読む」は要らない。
 */
export const LAUNCHER_APP_ALLOW = 'clipboard-write';

/**
 * 相対 URL の解決先を組む。
 *
 * 🔴 **階層 URL でなければ意味が無い**(実測で 1 度外した)。`about:srcdoc` や
 * blob: は **opaque path** なので、`new URL('assets/app.js', document.baseURI)` が
 * `TypeError: Failed to construct 'URL': Invalid URL` で落ちる ── 実際、
 * `about:srcdoc` を base にした版では SPA が**そこで死んだ**。
 *
 * ⚠ **origin の根にしてはいけない** ── `new URL('assets/x.js', origin + '/')` が
 * **PKC3 自身の資産**に解決してしまう(アプリの中に PKC3 の JS が降ってくる)。
 * だから**何も置いていない専用のパス**にする。
 *
 * ⚠ ここへ遷移されても危険は無い ── sandbox に `allow-top-navigation` が無いので
 * 動かせるのは iframe 自身だけで、その中は opaque origin のままである。
 */
export const LAUNCHER_APP_PATH = '/pkc3-app/';

export function launcherAppBase(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${LAUNCHER_APP_PATH}`;
}

/**
 * `srcdoc` 属性に入れるための escape。
 *
 * ⚠ `&` を**最初に**置き換える(後にすると自分が作った `&lt;` を壊す)。
 * ⚠ `<` `>` も escape してよい ── 属性値は parse 時に実体参照が解決されるので、
 * iframe には元の HTML が渡る(html-sandbox と同じ考え方)。
 *
 * ⚠ **往復で保存されない文字が 2 つある**(実測。escape の責任ではなく、
 * 属性値の parse の仕様):`U+000D` → `U+000A`(改行正規化)と
 * `U+0000` → `U+FFFD`(NULL の置換)。直接開いた場合は NUL が**消える**ので、
 * srcdoc 経由だけ**見える文字が 1 つ増える** ── そこで NUL は先に落とす。
 */
export function escapeForSrcdoc(html: string): string {
  return html
    // ⚠ NUL は**先に落とす**。正規表現に制御文字を書かない規律なので、
    //    `split`/`join` で落とす(`no-control-regex` に触れない書き方)
    .split(NUL)
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** NUL。⚠ 生バイトで書かない(この repo の規律)。 */
const NUL = '\u0000';

/** テキストノード用(題名)。属性には使わない。 */
function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 属性値用。 */
function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}

export interface AppShellOptions {
  /**
   * 保存領域の名前。**entry の lid**。
   * ⚠ 省略すると保存領域を貸さない(shim も入れない)── test / 旧経路のため。
   */
  appId?: string;
  /** 起動前に外殻が読んだ保存内容(外殻の script がここを埋める)。 */
  seed?: Readonly<Record<string, string>>;
  /**
   * 相対 URL の解決先(`launcherAppBase(location.origin)`)。
   * ⚠ 省略すると `<base>` を焼かない ── blob: が base のままになり、
   * `new URL(相対, base)` が落ちる。**本番では必ず渡す**。
   */
  base?: string;
}

/**
 * 外殻 HTML を組む。`html` は添付の中身(**信頼しない**)。
 *
 * ⚠ 返り値は `text/html` の Blob にして `window.open` する想定。
 * 外殻自体はアプリ origin で動くが、**中身は入っていない**
 * (アプリの HTML は `srcdoc` の中だけ)。
 *
 * 🔴 外殻は **`message` を聴くようになった**(段⑭)。聴かないと保存が届かない。
 * ⚠ 判定は **`event.source === iframe.contentWindow` だけ**にする。
 * 実測で 3 方向の攻撃(アプリが `allow-popups` で開いた popup からの
 * `opener.parent` / 外殻に生えた別の sandboxed iframe / 外殻自身の
 * `postMessage`)が**全部外殻まで届き**、`event.origin` は
 * **正規も攻撃も一律 `"null"`**、逆に外殻自身の攻撃は**アプリ origin を名乗った**。
 * つまり `event.origin` は両方向に嘘をつく ── 効いたのは source の同一性だけ。
 */
export function buildLauncherAppShell(
  title: string,
  html: string,
  opts: AppShellOptions = {},
): string {
  const t = escapeAttr(title);
  const lends = opts.appId !== undefined && opts.appId !== '';
  // 🔴 prelude は **`<!doctype>` の直後**(先頭に前置すると quirks mode に落ちる)
  const inner = lends
    ? insertPrelude(html, buildStorageShim({ seed: opts.seed ?? {} }))
    : html;

  const head =
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeText(title)}</title>` +
    '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#1b1d21}' +
    'iframe{display:block;border:0;width:100%;height:100%}' +
    // ⚠ 保存が上限に当たったことを**黙って落とさない**(1 行だけ出す)
    '[data-pkc-field="app-note"]{position:fixed;left:0;right:0;bottom:0;margin:0;padding:6px 10px;' +
    'font:12px/1.5 system-ui,sans-serif;background:#4a1f1f;color:#f4dede}' +
    '</style></head><body>';

  const frame =
    `<iframe sandbox="${LAUNCHER_APP_SANDBOX}" allow="${LAUNCHER_APP_ALLOW}"` +
    ` referrerpolicy="no-referrer" data-pkc-field="launcher-app" title="${t}"` +
    // ⚠ `<base>` は prelude と同じく**中に**焼く(外殻の base ではアプリに効かない)
    ` srcdoc="${escapeForSrcdoc(insertBase(inner, opts.base))}"></iframe>`;

  if (!lends) return `${head}${frame}</body></html>`;

  // 外殻の script。**アプリ origin なので本物の localStorage が使える**。
  // 🔴 受信ハンドラの中で**同期に**書く ── 実測で、IDB や debounce に逃がすと
  //    タブを閉じた瞬間に 20 件中 0〜8 件しか残らなかった(`beforeunload` を
  //    足しても救えない ── 受け手の外殻も同時に落ちるので task が捌かれない)。
  //    同期に書けば損失窓は消える。
  const shellScript =
    '<script>(function(){' +
    `var PREFIX=${inlineJson(appStoragePrefix(opts.appId!))},TAG=${inlineJson(APP_STORAGE_MESSAGE)};` +
    `var LIMIT=${String(APP_STORAGE_LIMIT)};` +
    'var frame=document.querySelector("iframe");' +
    'var noted=false;' +
    'function note(msg){if(noted)return;noted=true;' +
    'var p=document.createElement("p");p.setAttribute("data-pkc-field","app-note");' +
    'p.textContent=msg;document.body.appendChild(p);}' +
    // 🔴 **使用量は外殻が数える**(P8 段⑯。レビュー H-2)。
    //    かつて上限は shim(= untrusted 側)にしか無く、shim を使わず
    //    `parent.postMessage` を直に投げるだけで **origin の localStorage を
    //    丸ごと占有できた**(実測: 1 アプリで 5,239,731 文字 = 枠の 99.94%。
    //    以後 PKC3 自身の設定書込も他アプリの保存も入らない)。
    //    ⚠ 起動時に前置きを走査して初期値を作る ── 覚えているだけだと
    //    タブを開き直したときに 0 から数え直して、また埋められる
    'var used=0;' +
    'function scan(){used=0;for(var i=0;i<localStorage.length;i++){' +
    'var k=localStorage.key(i);if(k&&k.indexOf(PREFIX)===0){' +
    'used+=(k.length-PREFIX.length)+(localStorage.getItem(k)||"").length;}}}' +
    'scan();' +
    // ⚠ **結果をアプリへ返す**(レビュー H-3)。返さないと、規約を守るアプリの
    //    書込が無言で消える(実測: 例外 none・読み戻しも成功なのに、次回起動で
    //    1 件も残っていなかった)
    'function reply(seq,ok){if(seq===undefined||!frame||!frame.contentWindow)return;' +
    'try{frame.contentWindow.postMessage({tag:TAG,op:"ack",seq:seq,ok:ok},"*");}catch(e){}}' +
    'window.addEventListener("message",function(e){' +
    // 🔴 唯一の判定。⚠ e.origin は使わない(両方向に嘘をつく)
    'if(!frame||e.source!==frame.contentWindow)return;' +
    'var d=e.data;if(!d||d.tag!==TAG)return;' +
    'try{' +
    'if(d.op==="set"){' +
    'var key=String(d.key),val=String(d.value);' +
    'var prev=localStorage.getItem(PREFIX+key);' +
    'var next=used-(prev===null?0:key.length+prev.length)+key.length+val.length;' +
    // 🔴 **信頼側で断る**。shim の上限は「本物の意味論をアプリへ見せる」ためのもので、
    //    安全性の根拠にはならない(アプリは shim を使わずに投げられる)
    'if(next>LIMIT){note("このアプリの保存領域が一杯です(これ以上は保存されません)");' +
    'reply(d.seq,false);return;}' +
    'localStorage.setItem(PREFIX+key,val);used=next;reply(d.seq,true);' +
    '}else if(d.op==="remove"){' +
    'var rk=String(d.key),old=localStorage.getItem(PREFIX+rk);' +
    'if(old!==null){localStorage.removeItem(PREFIX+rk);used-=rk.length+old.length;}' +
    'reply(d.seq,true);' +
    '}else if(d.op==="quota"){' +
    // ⚠ アプリ側の上限で止まったときも**画面に出す**(P8 段⑱)── shim が
    //    同期に投げるので、アプリが握り潰すと何も起きないように見える
    'note("このアプリの保存領域が一杯です(これ以上は保存されません)");' +
    '}else if(d.op==="clear"){var ks=[];for(var i=0;i<localStorage.length;i++){' +
    'var k=localStorage.key(i);if(k&&k.indexOf(PREFIX)===0)ks.push(k);}' +
    'for(var j=0;j<ks.length;j++)localStorage.removeItem(ks[j]);used=0;reply(d.seq,true);' +
    '}}catch(err){note("このアプリの保存領域が一杯です(これ以上は保存されません)");' +
    'scan();reply(d.seq,false);}' +
    '});' +
    '})()</script>';

  return `${head}${frame}${shellScript}</body></html>`;
}

/**
 * `<base>` を焼く。⚠ prelude と同じ場所(doctype の直後)へ ── `<head>` を
 * 探して入れる実装にすると、`<head>` を書いていない HTML で入らない
 * (パーサは補うが、文字列としては存在しない)。
 */
function insertBase(html: string, base: string | undefined): string {
  if (base === undefined || base === '') return html;
  return insertPrelude(html, `<base href="${escapeAttr(base)}">`);
}
