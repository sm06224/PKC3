/**
 * 🔴 **囲いの中のアプリを、ページ内リンクで消さない**(2026-08-05。調査 doc 1-7)。
 *
 * ## 何が起きていたか(実測)
 * 外殻は `srcdoc` + `<base href="…/pkc3-app/">` で開く。この形だと
 * **アプリ内の `<a href="#sec">` を押しただけで**、リンクは base に対して
 * `…/pkc3-app/#sec` に解決される ── document URL(`about:srcdoc`)とは
 * **別の文書**なので、ブラウザは**本当に遷移する**。行き先は SPA fallback で
 * **PKC3 自身の index.html** で、不透明オリジンでは起動できず**真っ白**になる。
 * **JS を 1 行も使わないアプリでも起きる。**
 *
 * 🔴 反証役の指摘(調査 doc):**`<base>` は「相対 URL が全滅」を直したのではなく、
 * 沈黙をアプリ消滅に格上げした**。base 無しならアンカーのクリックは拒否されるだけで
 * **アプリは生きたまま**、base ありだと**アプリが消える**。
 *
 * ## どう直したか
 * `<base>` は外さない(相対 URL の解決に要る)。代わりに**ページ内リンクだけを
 * こちらで処理する** ── 既定の動作を止めて、その id へ自分でスクロールする。
 * これは「遷移を止める」だけでなく、**押しても何も起きなかったリンクを実際に効かせる**
 * (base 無しの版でも、押下はブロックされて動かなかった)。
 *
 * ⚠ **アプリの routing を邪魔しない**。バブリング段で聴き、アプリが
 * `preventDefault()` していたら**何もしない** ── ページ内リンクを自分で扱う SPA
 * (`react-router` の `HashRouter` 等)はそこで既定を止めるので、こちらの出番は無い。
 * ⚠ **`stopPropagation()` だけして既定を止めないアプリ**には効かない(document まで
 * 届かないため)。その形は事実上存在しないので、捕らえるために capture 段へ上げて
 * アプリより先に既定を止めることはしない ── **先に止めるほうが害が大きい**。
 *
 * ## もう 1 つ: 死んだことを言う
 * 実測では、アプリの中で例外が出ても **pageerror は在るのに誰も拾っていなかった**
 * ── user から見ると真っ白なだけで理由が無い。囲いの中で拾って、**その場に 1 行出す**
 * (外殻へ postMessage しない ── 受け口を増やさずに済む形を選ぶ)。
 *
 * ⚠ **pure module**。browser API を使わない(文字列を組むだけ)。
 */

/** 例外の 1 行を出す器(test / smoke がここで観測する)。 */
export const APP_ERROR_FIELD = 'app-error';

/**
 * prelude の `<script>`。`insertPrelude()` で doctype の直後へ挿す。
 *
 * ⚠ ES5 で書く(取り込んだアプリと同じ document で動くので、古い環境でも
 * ここが原因で落ちないほうがよい)。⚠ アプリの変数を汚さない(即時関数)。
 */
export function buildAnchorShim(): string {
  return (
    '<script>(function(){' +
    // ── ページ内リンク: 既定の遷移を止めて自分でスクロールする
    'document.addEventListener("click",function(ev){' +
    // ⚠ アプリが自分で扱ったなら何もしない(routing を奪わない)
    'if(ev.defaultPrevented)return;' +
    // ⚠ 修飾キー / 中クリックは「別のタブで開く」意図 ── 触らない
    'if(ev.button!==0||ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey)return;' +
    'var t=ev.target;' +
    'var a=t&&t.closest?t.closest("a[href]"):null;' +
    'if(!a)return;' +
    // ⚠ 属性の生値で見る(`a.href` は base で絶対化されるので判別できない)
    'var href=a.getAttribute("href");' +
    'if(!href||href.charAt(0)!=="#")return;' +
    // ⚠ 別のタブへ出す指定は尊重する(こちらで潰さない)
    'var tgt=a.getAttribute("target");' +
    'if(tgt&&tgt!=="_self")return;' +
    'ev.preventDefault();' +
    'var id=href.slice(1);' +
    'if(id===""||id==="top"){' +
    'if(window.scrollTo)window.scrollTo(0,0);return;}' +
    // ⚠ `name` 属性の古いアンカーも拾う(素の HTML の資料に実在する)
    'var el=null;' +
    'try{el=document.getElementById(decodeURIComponent(id))||document.getElementById(id);}catch(e){el=document.getElementById(id);}' +
    'if(!el){var named=document.getElementsByName(id);el=named&&named[0]?named[0]:null;}' +
    'if(el&&el.scrollIntoView)el.scrollIntoView();' +
    '},false);' +
    // ── 死んだことを言う(真っ白 + 理由なしを作らない)
    'var noted=false;' +
    'function say(msg){if(noted)return;noted=true;' +
    'var host=document.body||document.documentElement;if(!host)return;' +
    'var p=document.createElement("p");' +
    `p.setAttribute("data-pkc-field",${JSON.stringify(APP_ERROR_FIELD)});` +
    'p.style.cssText="position:fixed;left:0;right:0;bottom:0;margin:0;padding:6px 10px;' +
    'font:12px/1.5 system-ui,sans-serif;background:#4a1f1f;color:#f4dede;z-index:2147483647";' +
    'p.textContent="このアプリでエラーが起きました: "+msg;host.appendChild(p);}' +
    'window.addEventListener("error",function(e){' +
    // ⚠ 画像の読み込み失敗(target が要素)は「アプリが死んだ」ではない
    'if(e.target&&e.target!==window)return;' +
    'say(e.message||"(理由不明)");},true);' +
    'window.addEventListener("unhandledrejection",function(e){' +
    'var r=e.reason;say((r&&r.message)||String(r));});' +
    '})()</script>'
  );
}
