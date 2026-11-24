/**
 * 🔴 **別ウィンドウのマニュアル(`manual.html`)の「マニュアルの中を探す」**(Stage 2 PR-3 の 8-2)。
 *
 * 左の目次の上に検索欄を置く ── ① 目次の絞り込み ② 本文の全文検索のヒット一覧(節ごとの件数と当たった所の 1 行)
 * ③ 押すと該当の節へ**確実に**送り(本文の箱の中だけを動かす)、見出しを一時的に光らせ、本文の一致箇所を塗る。
 *
 * ## ⚠ なぜ inline script を足すのか(`manual-page.ts` の「script は配色の 1 本だけ」の例外)
 *
 * 検索は振る舞いなので script が要る。だが**配色の script には混ぜない**(2 本目の独立した IIFE)── 配色は `<head>` で
 * 最初の描画の前に走り、検索は `</body>` の直前で DOM が揃ってから走る(役目も走る時期も違う)。
 * 🔑 本文は**ぜんぶ焼かれて DOM に在る**(遅延描画しない)ので、ブラウザの Ctrl+F(`window.find`)でも末尾の節まで当たる。
 *   この検索はそれと**別の道具**(節の一覧と件数が出る)であって、Ctrl+F の代わりではない。
 * ⚠ この file は features 層なので browser API を**実行しない**(文字列を組むだけ)。走るのは焼いた page の中。
 * ⚠ 字は ES2017 まで(`let` / 矢印 / `normalize`)。`</script>` を含めない。
 */

/** 探す欄の HTML(目次の `<details>` の中、`<nav>` の前に置く)。 */
export const MANUAL_FIND_HTML = [
  '<div data-pkc-region="manual-window-find">',
  '<input type="search" data-pkc-field="manual-window-find" placeholder="マニュアルの中を探す" ',
  'aria-label="マニュアルの中を探す" title="目次を絞り込み、本文の全文から探します(Esc で消します)" autocomplete="off">',
  '<div data-pkc-field="manual-window-find-count" aria-live="polite"></div>',
  '<div data-pkc-region="manual-window-find-hits"></div>',
  '</div>',
].join('');

/** 探す欄の CSS(`MANUAL_CHROME_CSS` へ足す)。⚠ 地・字はトークンから取り、無ければ UA の色へ落ちる。 */
export const MANUAL_FIND_CSS: readonly string[] = [
  '[data-pkc-region="manual-window-find"]{padding:0 0 8px}',
  '[data-pkc-field="manual-window-find"]{display:block;width:100%;box-sizing:border-box;font:inherit;',
  'padding:4px 8px;color:inherit;background:var(--surface,Canvas);border:1px solid var(--border,#8886);',
  'border-radius:4px}',
  '[data-pkc-field="manual-window-find-count"]{font-size:12px;opacity:.75;padding:4px 6px 0}',
  '[data-pkc-field="manual-window-find-count"]:empty{display:none}',
  '[data-pkc-region="manual-window-find-hits"]{max-height:40vh;overflow:auto;margin-top:4px}',
  '[data-pkc-region="manual-window-find-hits"] button{white-space:normal;line-height:1.4}',
  '[data-pkc-region="manual-window-find-hits"] [data-pkc-field="manual-window-find-excerpt"]{display:block;',
  'font-size:12px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  // 絞り込みで外した目次の行(`display:block` の規則に負けないよう `!important`)
  '[data-pkc-region="manual-window-toc"] [hidden]{display:none!important}',
  // 🔴 着いた見出しを 1.8 秒だけ光らせる(動きは使わず地の色だけ ── 動きを減らす設定でも同じ)。一致箇所の塗りも同じ色
  '[data-pkc-region="manual-window-main"] [data-pkc-jump-flash]{background:var(--accent-dim,#fd06);',
  'color:var(--accent-dim-fg,inherit);border-radius:3px}',
  '::highlight(pkc-manual-hit){background:var(--accent-dim,#fd0);color:var(--accent-dim-fg,inherit)}',
];

/** 節の件数の上限(一覧が本文より長くならないように)。 */
export const MANUAL_FIND_MAX_HITS = 50;

/**
 * 探す欄の振る舞い(`</body>` の直前の 1 本)。
 *
 * 🔑 節 = 見出し 1 本と、次の見出しまでの text node。本文を 1 度だけ歩いて控える(初めて打たれたとき)。
 * 🔑 一致は**節の字をつなげて**数える(太字・リンクをまたぐ語も当たる)。NFKC + 小文字へ寄せて比べる
 *   (全角英数・大文字小文字の違いで外さない)── 寄せて長さが変わる字が混じる節は、塗りだけ諦めて件数と送りは出す。
 */
export const MANUAL_FIND_SCRIPT: string = [
  '(function(){',
  'var inp=document.querySelector(\'[data-pkc-field="manual-window-find"]\');',
  'var main=document.querySelector(\'[data-pkc-region="manual-window-main"]\');',
  'var toc=document.querySelector(\'[data-pkc-region="manual-window-toc"]\');',
  'var count=document.querySelector(\'[data-pkc-field="manual-window-find-count"]\');',
  'var hitsEl=document.querySelector(\'[data-pkc-region="manual-window-find-hits"]\');',
  'if(!inp||!main||!toc||!count||!hitsEl)return;',
  'var rows=Array.prototype.slice.call(toc.querySelectorAll("nav a"));',
  'var secs=null,flashEl=null,flashT=0,MAX=' + String(MANUAL_FIND_MAX_HITS) + ';',
  'function norm(s){try{return String(s).normalize("NFKC").toLowerCase()}catch(e){return String(s).toLowerCase()}}',
  // 節を 1 度だけ作る
  'function build(){if(secs)return secs;secs=[];var cur=null;',
  'var w=document.createTreeWalker(main,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);',
  'for(var n=w.nextNode();n;n=w.nextNode()){',
  'if(n.nodeType===1){if(/^H[1-6]$/.test(n.tagName)){cur={head:n,nodes:[],text:"",n:"",ok:true};secs.push(cur)}}',
  'else if(cur)cur.nodes.push(n)}',
  'secs.forEach(function(s){s.text=s.nodes.map(function(t){return t.data}).join("");s.n=norm(s.text);',
  // 字数が変わる寄せ方が混ざる節は塗らない
  's.ok=s.n.length===s.text.length});',
  'return secs}',
  'function all(s,q){var out=[],i=s.n.indexOf(q);while(i>=0){out.push(i);i=s.n.indexOf(q,i+q.length)}return out}',
  'function flash(el){if(flashEl)flashEl.removeAttribute("data-pkc-jump-flash");clearTimeout(flashT);',
  'el.setAttribute("data-pkc-jump-flash","");flashEl=el;',
  'flashT=setTimeout(function(){if(flashEl)flashEl.removeAttribute("data-pkc-jump-flash");flashEl=null},1800)}',
  'function clearPaint(){try{if(window.CSS&&CSS.highlights)CSS.highlights["delete"]("pkc-manual-hit")}catch(e){}}',
  // 位置 → (node, offset)
  'function at(s,pos){var acc=0;for(var i=0;i<s.nodes.length;i++){var len=s.nodes[i].data.length;',
  'if(pos<acc+len)return[s.nodes[i],pos-acc];acc+=len}var l=s.nodes[s.nodes.length-1];return l?[l,l.data.length]:null}',
  'function paint(s,q){clearPaint();if(!s.ok||!(window.CSS&&CSS.highlights&&window.Highlight))return null;',
  'var h=new Highlight(),first=null,idx=all(s,q).slice(0,200);',
  'idx.forEach(function(p){var a=at(s,p),b=at(s,p+q.length);if(!a||!b)return;var r=document.createRange();',
  'try{r.setStart(a[0],a[1]);r.setEnd(b[0],b[1])}catch(e){return}h.add(r);if(!first)first=r});',
  'if(first)CSS.highlights.set("pkc-manual-hit",h);return first}',
  // 本文の箱の中だけを動かす(見出しを上端の少し下へ)。一致箇所が画面の外に残る長い節は、一致箇所へも寄せる
  'function go(s,q){var mr=main.getBoundingClientRect();',
  'main.scrollTop+=s.head.getBoundingClientRect().top-mr.top-8;',
  'var r=q?paint(s,q):null;',
  'if(r){var rr=r.getBoundingClientRect();if(rr.height>0&&(rr.bottom>mr.bottom-24||rr.top<mr.top)){',
  'main.scrollTop+=rr.top-mr.top-mr.height*0.35}}',
  'flash(s.head);',
  // 狭い窓は目次(と一覧)を畳んで本文を見せる
  'try{if(matchMedia("(max-width:760px)").matches)toc.open=false}catch(e){}}',
  'function run(){var q=norm(inp.value).trim();hitsEl.textContent="";clearPaint();',
  'rows.forEach(function(a){a.hidden=q!==""&&norm(a.textContent).indexOf(q)<0});',
  'if(q===""){count.textContent="";return}',
  'var found=[],total=0;build().forEach(function(s){var h=all(s,q).length;',
  'if(h>0){found.push({s:s,c:h,i:s.n.indexOf(q)});total+=h}});',
  'if(!found.length){count.textContent="見つかりませんでした。別の言い方でも試せます";return}',
  'count.textContent=total+" か所("+found.length+" 節)"+(found.length>MAX?"。下に出すのは "+MAX+" 節、あと "+(found.length-MAX)+" 節":"");',
  'found.slice(0,MAX).forEach(function(f){var b=document.createElement("button");b.type="button";',
  'b.setAttribute("data-pkc-find-index",String(secs.indexOf(f.s)));',
  'var t=document.createElement("span");t.textContent=f.s.head.textContent.replace(/[*`_]/g,"")+"("+f.c+")";b.appendChild(t);',
  'if(f.i>=0){var x=document.createElement("span");x.setAttribute("data-pkc-field","manual-window-find-excerpt");',
  'var src=f.s.ok?f.s.text:f.s.n;var from=Math.max(0,f.i-14);',
  'x.textContent=(from>0?"…":"")+src.slice(from,f.i+q.length+30).replace(/\\s+/g," ");b.appendChild(x)}',
  'b.addEventListener("click",function(){go(f.s,q)});hitsEl.appendChild(b)})}',
  'var timer=0;inp.addEventListener("input",function(){clearTimeout(timer);timer=setTimeout(run,60)});',
  'inp.addEventListener("keydown",function(ev){',
  // 変換中の Enter / Esc は IME のもの
  'if(ev.isComposing||ev.keyCode===229)return;',
  'if(ev.key==="Escape"){inp.value="";run()}',
  'else if(ev.key==="Enter"){clearTimeout(timer);run();var b=hitsEl.querySelector("button");if(b)b.click()}});',
  // 目次を押したときも、着いた見出しを光らせる(送るのはブラウザ / 配色の script の `g`)
  'toc.addEventListener("click",function(ev){var a=ev.target&&ev.target.closest?ev.target.closest("a[href^=\\"#\\"]"):null;if(!a)return;',
  'var id=a.getAttribute("href").slice(1);try{id=decodeURIComponent(id)}catch(e){}',
  'setTimeout(function(){var e=document.getElementById(id);if(e)flash(e)},0);',
  'try{if(matchMedia("(max-width:760px)").matches)toc.open=false}catch(e){}});',
  '})();',
].join('');
