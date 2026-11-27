/**
 * 🔴 **配る HTML の閲覧側で、描いた本文を DOM に据える処理**(閲覧用 HTML と配布パッケージの `index.html` が共有する 1 本)。
 *
 * v4.1 Phase 2 / PR-6(#2098 後半)で `pkc3-html.ts` の閲覧側 script から切り出した(中身は 1 文字も書き換えていない ──
 * 変えたのは呼び手に依存していた 2 か所を関数にしたことと、画像を新しいタブで開く対象に `./assets/` を足したことだけ)。
 * ⚠ 2 本目の hydrate を書かない(CLAUDE.md §7)── 添付の差し込み・ノート間リンク・札・[[題名]]・図と数式の原文・
 *   表の並べ替え・見出し id の振り直しは、すべてここを通す。
 *
 * ## 呼び手(閲覧側の IIFE)が先に用意する名前
 *
 * | 名前 | 中身 |
 * |---|---|
 * | `has(key)` | この配布物にその添付が入っているか |
 * | `urlFor(key, sink)` | 添付を開く URL(閲覧用 HTML は ObjectURL を作って `sink` に積む / 配布パッケージは `./assets/…`) |
 * | `names` / `kinds` | 添付の表示名 / 見せ方(書き出し側が決めた答え) |
 * | `noteAt` / `titleAt` | ノートの id / 題名 → 何番目のノートか |
 * | `go(at, hid)` | そのノートを開く(見出しへの参照つき) |
 * | `eiOf(e)` | 器に付ける「何番目のノートか」(ウィジェットの親が箱のノートを引く印) |
 * | `titleOfAt(at)` | 何番目のノートの題名 |
 *
 * ⚠ これは**閲覧側の JS の字**を返す(ES5・依存ゼロ)。template literal の中なのでバックティックを書かない。
 */
import { BODY_MEDIA_CLASS, BODY_MEDIA_FIELD } from '@features/asset/asset-preview-kind';
import { MINUS_LIKE, PLAIN_DECIMAL } from '../markdown/table-sort-key';

/** 本文の中のノート間リンクの属性(閲覧側の `a[...]` と同じ物)。 */
export const NOTE_LINK_ATTR = 'data-pkc-entry-ref';
/** `@[card](entry:…)` の札の属性。 */
export const NOTE_CARD_ATTR = 'data-pkc-card-target';

/** 閲覧側の `view` / `dl` / `sortTables` / `hydrate` / `headings` を定義する JS(関数宣言だけ ── 置いた IIFE の中で巻き上がる)。 */
export function portableHydrateJs(): string {
  return `
  // 添付は画像なら見せる、それ以外は保存できる導線にする(開けないより落とせる方がよい)
  // 🔴 **PDF もその場で見せる**(2026-08-15)。⚠ 直す前はここが画像だけで、
  //    アプリ側の画面と**見え方が食い違っていた**(あちらは器いっぱいで出る)。
  //    面ごとに違う見え方にしない ── 出せる物は同じように出す。
  //    ⚠ 出せないブラウザに空白を残さないよう、**中にダウンロードの導線**を置く。
  function view(key,alt,sink){
    var name=names[key]||alt||key;
    var kind=kinds[key]||'';
    if(kind==='image'){
      var im=document.createElement('img');im.src=urlFor(key,sink);im.alt=name;return im;
    }
    /* 🔴 **音・動画はその場で聞ける / 見られる**(#413 段②)。
       ⚠ URL は 1 本しか作らない(下の保存の導線にも同じ物を渡す ── PDF と同じ規律)。
       ⚠ **保存の導線を消さない** ── 器を置き換えると、落とす道が無くなる。 */
    if(kind==='audio'||kind==='video'){
      var mu=urlFor(key,sink);
      var wrap=document.createElement('div');
      var med=document.createElement(kind);
      med.setAttribute('data-pkc-field','${BODY_MEDIA_FIELD}');med.className='${BODY_MEDIA_CLASS}';
      med.controls=true;med.preload='metadata';med.src=mu;
      wrap.appendChild(med);wrap.appendChild(dl(key,name,sink,mu));return wrap;
    }
    if(kind==='pdf'){
      // ⚠ **URL は 1 本しか作らない** ── fallback の a にも同じ URL を渡す。
      //    直す前は object と a で urlFor() を 2 回呼んでおり、PDF 1 件につき
      //    atob → Uint8Array → Blob が **2 組**できていた(全体を印刷では全 entry ぶん
      //    同時に生きる)。ゼロコピー・即破棄の不可侵指示と逆向きだった。
      var u=urlFor(key,sink);
      var o=document.createElement('object');o.className='p';
      o.type='application/pdf';o.data=u;
      o.appendChild(dl(key,name,sink,u));return o;
    }
    /* 🔴 **3D モデルは配る HTML では描かない**(v4.0 PR-12)── Three.js を同梱しないので、保存の導線と案内を出す。
       ⚠ 黙ってリンクだけにしない(なぜ見えないのかを 1 行で言う)。 */
    if(kind==='model3d'){
      var mw=document.createElement('div');
      var mn=document.createElement('p');mn.className='m3';
      mn.textContent='3D モデルはこの HTML では表示できません。保存して 3D に対応したアプリで開くか、PKC3 で開いてください';
      mw.appendChild(mn);mw.appendChild(dl(key,name,sink));return mw;
    }
    return dl(key,name,sink);
  }
  function dl(key,name,sink,url){
    var a=document.createElement('a');a.className='f';a.href=url||urlFor(key,sink);
    a.download=name;a.textContent='⬇ '+name;return a;
  }

  /* 🔴 表の並べ替え(#1163 依頼 223)。⚠ 規則は table-sort-key.ts の正規表現を埋めた物 ── 書き写さない */
  var SORT_NUM=new RegExp(${JSON.stringify(PLAIN_DECIMAL.source)});
  var SORT_MINUS=new RegExp(${JSON.stringify(MINUS_LIKE.source)},'g');
  function sortKey(raw){
    var s=String(raw||'').trim();
    if(s==='')return{n:NaN,ok:false,s:''};
    var h=(s.normalize?s.normalize('NFKC'):s).replace(SORT_MINUS,'-');
    var m=SORT_NUM.exec(h);
    var n=m?Number((m[1]||m[2]||'')+String(m[3]||'').replace(/,/g,'')):NaN;
    return{n:n,ok:!!m&&isFinite(n),s:s};
  }
  function sortTables(box){
    Array.prototype.forEach.call(box.querySelectorAll('table'),function(table){
      var tbody=table.querySelector('tbody');if(!tbody)return;
      var head=table.querySelector('thead')||table;
      var ths=head.querySelectorAll('tr:first-child th');if(!ths.length)return;
      Array.prototype.forEach.call(tbody.querySelectorAll('tr'),function(tr,i){tr.setAttribute('data-pkc-orig-index',String(i))});
      Array.prototype.forEach.call(ths,function(th,col){
        th.setAttribute('data-pkc-sort-direction','none');th.setAttribute('aria-sort','none');
        th.setAttribute('role','button');th.setAttribute('tabindex','0');th.title='クリックで並び替え';
        var ic=document.createElement('span');ic.className='pkc-table-sort-icon';ic.setAttribute('aria-hidden','true');th.appendChild(ic);
        function go(){
          var cur=th.getAttribute('data-pkc-sort-direction')||'none';
          var nx=cur==='none'?'asc':cur==='asc'?'desc':'none';
          Array.prototype.forEach.call(ths,function(o){o.setAttribute('data-pkc-sort-direction','none');o.setAttribute('aria-sort','none')});
          th.setAttribute('data-pkc-sort-direction',nx);
          th.setAttribute('aria-sort',nx==='asc'?'ascending':nx==='desc'?'descending':'none');
          var rows=Array.prototype.slice.call(tbody.querySelectorAll('tr'));
          var oi=function(r){return Number(r.getAttribute('data-pkc-orig-index')||0)};
          rows.sort(function(a,b){
            if(nx==='none')return oi(a)-oi(b);
            var ca=a.children[col],cb=b.children[col];
            var x=sortKey(ca?ca.textContent:''),y=sortKey(cb?cb.textContent:'');
            var d=x.ok&&y.ok?x.n-y.n:x.s.localeCompare(y.s,undefined,{numeric:true,sensitivity:'base'});
            if(d===0)return oi(a)-oi(b);
            return nx==='desc'?-d:d;
          });
          for(var i=0;i<rows.length;i++)tbody.appendChild(rows[i]);
        }
        th.addEventListener('click',function(ev){var t=ev.target;if(t&&t.tagName==='A')return;go()});
        th.addEventListener('keydown',function(ev){if(ev.target!==th)return;if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();go()}});
      });
    });
  }
  function hydrate(box,e,sink,idp){
    // 🔑 本文は**書出し側で描いた HTML**(P8 段⑲)。かつてここは本文を素のまま
    // pre で出しており、見出しも表も箇条書きも**記号のまま**だった ──
    // 「単体で開いて読める」と案内している当のファイルが一番読みにくかった。
    // ⚠ 描くのは**アプリと同じ関数**(閲覧側に parser を持たせない ── 二重実装は必ずずれる)
    var seen={};
    /* 🔴 どのノートの器か(#2097)── ウィジェットの親が、箱から「その箱のノート」だけを引くための印 */
    box.setAttribute('data-pkc-ei',String(eiOf(e)));
    box.innerHTML=e.html||'';
    /* 🔴 文書属性(書字方向など)を当てる ── 画面の applyDocumentGlobals と同じ
       見え方にする(user 報告 2-7)。書き出し側が attrs に載せてある。
       🔴 **先に全部消す**(2026-08-06)── box は使い回しなので、付けるだけだと
       **前のノートの書字方向が残る**(align: right のノートを見た後に宣言の無い
       ノートを開くと右寄せのまま / 縦書きのままになる)。画面側の
       applyDocumentGlobals と同じ規律。⚠ この一覧は
       src/features/markdown/document-globals.ts の DOCUMENT_GLOBAL_ATTRS と揃える
       (pkc3-html.test.ts が突合する)。
       ⚠ ここは VIEWER のテンプレート文字列の中なのでバックティックを書かない */
    var GA=['data-pkc-writing','data-pkc-direction','data-pkc-doc-align','data-pkc-layout','dir'];
    for(var gi=0;gi<GA.length;gi++)box.removeAttribute(GA[gi]);
    if(e.attrs){for(var ak in e.attrs){if(Object.prototype.hasOwnProperty.call(e.attrs,ak))box.setAttribute(ak,e.attrs[ak])}}
    // 描いた HTML の中の添付参照(画像 / リンクの markdown)に実体を差す。
    // ⚠ 参照の**走査**は書出し側の 1 本に寄せてある ── ここは差すだけ
    Array.prototype.forEach.call(box.querySelectorAll('[data-pkc-asset-key]'),function(el){
      var k=el.getAttribute('data-pkc-asset-key');
      // 🔴 中身の無い参照は**参照のまま見せる**(黙って消さない)。img の alt は
      //    textContent に出ないので、そのまま置くと「何も無かった」ように見える
      if(!has(k)){
        var miss=document.createElement('code');miss.className='m';
        miss.setAttribute('data-pkc-asset-missing','');
        // 🔴 内部の id を字にしない(#1087)。名前が分かれば名前で、id は title に退避する
        miss.title='asset:'+k;
        miss.textContent=names[k]?('「'+names[k]+'」の添付ファイルが、このファイルに入っていません'):'添付ファイルが、このファイルに入っていません';
        if(el.parentNode)el.parentNode.replaceChild(miss,el);
        return;
      }
      seen[k]=1;
      if(el.tagName==='IMG'){el.src=urlFor(k,sink);if(!el.alt)el.alt=names[k]||k;return}
      var au=urlFor(k,sink);
      el.href=au;el.download=names[k]||k;
      /* 🔴 **本文に書いた音・動画は、その場で聞ける**(#413 段②)。
         ⚠ リンクは**残す**(字は「何のファイルか」、器は「その場で聞く」)。
         ⚠ 同じ URL を使う ── 1 つの添付に 2 本作らない。 */
      var mk=kinds[k]||'';
      if(mk==='audio'||mk==='video'){
        var m2=document.createElement(mk);
        m2.setAttribute('data-pkc-field','${BODY_MEDIA_FIELD}');m2.className='${BODY_MEDIA_CLASS}';
        m2.controls=true;m2.preload='metadata';m2.src=au;
        if(el.parentNode)el.parentNode.insertBefore(m2,el.nextSibling);
      }
    });
    // 🔴 **押しても何も起きない操作子は取り除く**(F-1)。描画はアプリと同じ関数なので、
    //    コード・表・図の見出しに付く「コピー」ボタン(data-pkc-action="copy-md-block")が
    //    そのまま焼き込まれる ── 閲覧側に binder は無いので**沈黙する飾り**であり、
    //    紙にも印字される。⚠ 消す判定は**狭く当てる**(この action 名だけ)──
    //    属性名だけで総なめにすると、将来 action を持つ本文要素まで消える
    Array.prototype.forEach.call(box.querySelectorAll('[data-pkc-action="copy-md-block"]'),function(el){
      if(el.parentNode)el.parentNode.removeChild(el);
    });
    // 🔴 **表は見出しを押して並べ替えられる**(#1163 依頼 223 ── 読む面と同じ: 昇順 → 降順 → 元の順)。
    //    ⚠ 「数として読むか」の規則は読む面と同じ 1 本(table-sort-key.ts の正規表現をそのまま埋める)
    // ⚠ 全体の印刷(#pkc-all。idp が付く)には付けない(着地前レビュー ⚠4 ── 紙に並べ替えの印が出る)
    if(!idp)sortTables(box);
    // 🔴 **自分宛の添付リンク(pkc://自分/asset/…)も効かせる**(#1087)。直す前は書き換わらずに残り、
    //    押しても何も起きなかった。このファイルに添付が入っていれば他の添付リンクと同じく保存 / 開くリンクに、
    //    入っていなければ字だけにする(押せる顔で動かない物を残さない)
    Array.prototype.forEach.call(box.querySelectorAll('a[data-pkc-asset-ref]'),function(a){
      var k=a.getAttribute('data-pkc-asset-ref')||'';
      if(k&&has(k)){
        seen[k]=1;
        a.href=urlFor(k,sink);a.download=names[k]||k;
        a.removeAttribute('data-pkc-action');a.removeAttribute('data-pkc-asset-ref');
        return;
      }
      var sp=document.createElement('span');
      sp.setAttribute('data-pkc-asset-missing','');
      sp.title='このファイルには入っていない添付です';
      while(a.firstChild)sp.appendChild(a.firstChild);
      if(a.parentNode)a.parentNode.replaceChild(sp,a);
    });
    // 🔴 **ノート間リンクを、このファイルの中で効かせる**(#1087 の見直し 2026-10-13)。
    //    直す前はリンク先が書き換わらずに残り、押しても何も起きなかった(普通のリンクの見た目のまま)。
    //    ⚠ このファイルに入っているノートだけを開く。入っていないノートへのリンクは字だけにする
    //    (押せる顔で動かない物を残さない)。全体印刷では、そのノートの見出しへ飛ばす。
    Array.prototype.forEach.call(box.querySelectorAll('a[${NOTE_LINK_ATTR}]'),function(a){
      var ref=a.getAttribute('${NOTE_LINK_ATTR}')||'';
      var nid=ref.slice(6).split('#')[0];
      var at=Object.prototype.hasOwnProperty.call(noteAt,nid)?noteAt[nid]:-1;
      if(at<0){
        var sp=document.createElement('span');
        sp.setAttribute('data-pkc-outside-note','');
        sp.title='このファイルには入っていないノートです';
        while(a.firstChild)sp.appendChild(a.firstChild);
        if(a.parentNode)a.parentNode.replaceChild(sp,a);
        return;
      }
      if(idp){a.href='#pe-'+at;return}
      a.href='#';
      // 見出しへの参照(#h/…)は飛び先を運ぶ。見つからなければ先頭のまま
      var hi=ref.indexOf('#h/');
      var hid=hi<0?'':ref.slice(hi+3);
      a.onclick=function(ev){ev.preventDefault();go(at,hid)};
    });
    // 🔴 @[card](entry:…) の札も同じ ── 入っているノートなら押して開く / 入っていなければ字だけ。
    //    (⚠ この節は template literal の中 ── 注記に逆引用符を書かない)
    //    全体印刷では飛ばす先の見出しが無い(札は紙の上の字のまま)。
    Array.prototype.forEach.call(box.querySelectorAll('span[${NOTE_CARD_ATTR}^="entry:"]'),function(c){
      var ref=c.getAttribute('${NOTE_CARD_ATTR}')||'';
      var nid=ref.slice(6).split('#')[0];
      var at=Object.prototype.hasOwnProperty.call(noteAt,nid)?noteAt[nid]:-1;
      if(at<0){
        c.setAttribute('data-pkc-outside-note','');
        c.title='このファイルには入っていないノートです';
        c.removeAttribute('role');c.removeAttribute('tabindex');
        return;
      }
      if(idp)return;
      var hi=ref.indexOf('#h/');
      var hid=hi<0?'':ref.slice(hi+3);
      var goCard=function(){go(at,hid)};
      // 枠の字は指したノートの題名にする(画面と同じ。入っていなければ、元の字のまま)
      var tt=titleOfAt(at);if(tt)c.textContent=tt;
      c.onclick=function(ev){ev.preventDefault();goCard()};
      c.onkeydown=function(ev){if(ev.key==='Enter'){ev.preventDefault();goCard()}};
    });
    // 🔴 本文の [[題名]](#1174 段②)── このファイルに同じ題名のノートが入っていれば、押して開く。無ければ字のまま。
    //    (⚠ 描く側は書き出しでは生の括弧を出さず、表示の字だけを span に載せる)
    //    全体印刷では飛ばす先の見出しが無いので、紙の上の字のままにする。
    Array.prototype.forEach.call(box.querySelectorAll('span[data-pkc-title-ref]'),function(c){
      if(idp)return;
      var t=c.getAttribute('data-pkc-title-ref')||'';
      if(!Object.prototype.hasOwnProperty.call(titleAt,t))return;
      var at=titleAt[t];
      c.setAttribute('role','link');c.setAttribute('tabindex','0');
      c.onclick=function(ev){ev.preventDefault();go(at,'')};
      c.onkeydown=function(ev){if(ev.key==='Enter'){ev.preventDefault();go(at,'')}};
    });
    // 図とグラフは**原文のまま**見せる(閲覧側に mermaid / chart.js を積まない)。
    // ⚠ **両方を回す** ── mermaid だけ書くと、グラフが**空の器**で出荷される
    //    (#188 のレビューで判明。片側だけ直す型の再演)
    ['data-pkc-mermaid-src','data-pkc-chart-src','data-pkc-plotly-src','data-pkc-react-src'].forEach(function(attr){
      Array.prototype.forEach.call(box.querySelectorAll('['+attr+']'),function(el){
        var s=el.getAttribute(attr)||'';
        el.textContent='';var p=document.createElement('pre');p.className='d';
        p.textContent=s;el.appendChild(p);
      });
    });
    // 数式も原文のまま見せる(#707)── 閲覧側に KaTeX と 250 KB の書体を積まない。
    // ⚠ 器の中は KaTeX の 2 本立て(MathML + 見た目の span)なので、素通しすると
    //    同じ式が 2 回、崩れて出る ── だから必ず原文へ戻す。
    // 🔴 図と同じ pre にしてはいけない(着地前レビュー 2026-09-06・欠陥 2):
    //    ① 行の中の数式の器は span なので、中にブロックの pre を入れると
    //       文が 3 行に割れる(渡した側は自分の画面しか見ないので気づけない)
    //    ② data-pkc-math-src は区切りを含まないので、区切りの付かない字が出る
    //       ── マニュアルとお知らせは「打った字のまま」と約束しており、
    //       4 つの出口のうちここだけが違っていた
    // ⚠ この節は template literal の中なので、注記に逆引用符を書かない
    //    (書くと器の文字列が閉じて build が壊れる ── 1 稿目で踏んだ)
    // 🔑 打った字(区切りごと)を、素の文字として置く。
    Array.prototype.forEach.call(box.querySelectorAll('[data-pkc-math-src]'),function(el){
      var t=el.getAttribute('data-pkc-math-src')||'';
      var d=el.getAttribute('data-pkc-math-display')==='1';
      el.textContent=d?('$$'+t+'$$'):('$'+t+'$');
    });
    // 本文の外(frontmatter)から参照している添付 ── 添付 entry はこちらだけを持つ。
    // ⚠ 本文に書かれていて**描画に現れなかった**参照(裸の asset:key など)も
    //    ここで拾う ── 黙って消さない
    (e.attach||[]).concat(e.refs||[]).forEach(function(key){
      if(has(key)&&!seen[key]){seen[key]=1;box.appendChild(view(key,e.title,sink));}
    });
    /* 🔴 **画像を押すと、元の大きさで新しいタブに開く**(台帳 #1852 束 U1 残り、依頼 77-5 B)。
       直す前は画面の幅に縮むだけで、押しても何も起きなかった(大きい画像の細部が読めない)。
       ⚠ 画面の表示だけ(全体印刷の紙には要らない)。⚠ すでにリンクの中にある画像は触らない。
       ⚠ 開けるのは blob / http(s) の画像だけ(data: は最上位の移動をブラウザが止める)。 */
    if(!idp){
      Array.prototype.forEach.call(box.querySelectorAll('img'),function(im){
        var u=im.getAttribute('src')||'';
        if(!/^(blob:|https?:|\\.\\/assets\\/)/.test(u)||im.closest('a'))return;
        var ia=document.createElement('a');
        ia.href=u;ia.target='_blank';ia.rel='noopener';
        ia.setAttribute('data-pkc-img-open','');
        ia.title='押すと、元の大きさで新しいタブに開きます';
        im.parentNode.insertBefore(ia,im);ia.appendChild(im);
      });
    }
    // 🔴 見出し id は **entry ごとに namespace を切る**(F-1)。書出し側の描画は
    //    entry ごとに独立した slug counter を回すので、別ノートの同名見出しは
    //    **同じ id** になる。画面は 1 件ずつなので衝突しないが、全体印刷は
    //    全件を同じ document に置く ── 目次のリンクが最初の 1 件へ全部飛ぶ
    return headings(box,idp);
  }

  /**
   * 見出しを拾って [{el,text,level}] を返す(目次に並べるのは h1〜h3)。id が無いものには振る。
   * 🔴 #2018 から書出し側の描画は h4〜h6 にも id を振る ── 全体印刷の振り直し(ノート間の衝突よけ)は
   *    h1〜h6 の全部に掛ける。目次(返す並び)は 3 段のまま。
   */
  function headings(box,idp){
    var out=[],renamed={};
    var has=Object.prototype.hasOwnProperty;
    Array.prototype.forEach.call(box.querySelectorAll('h1,h2,h3,h4,h5,h6'),function(h,i){
      var text=(h.textContent||'').trim();
      if(!text)return;
      // 全体印刷では必ず振り直す(書出し側の id が entry 間で衝突している)
      if(idp||!h.id){
        if(idp&&h.id&&!has.call(renamed,h.id))renamed[h.id]=(idp||'h')+'-'+i;
        h.id=(idp||'h')+'-'+i;
      }
      var lv=+h.tagName.slice(1);
      if(lv<=3)out.push({el:h,text:text,level:lv});
    });
    if(idp){
      // 🔴 脚注の id(fn1 / fnref1)もノートごとに衝突する ── 見出しと同じく接頭辞を付ける
      Array.prototype.forEach.call(box.querySelectorAll('[id^="fn"]'),function(el){
        var old=el.id;
        if(!has.call(renamed,old))renamed[old]=idp+'-'+old;
        el.id=renamed[old];
      });
      // 🔴 ノート内の #slug リンク(本文のリンク・:::toc・脚注)を、振り直した id へ向け直す。
      //    向け直さないと全体印刷で「別のノートの同名の見出し」や何も無い所へ飛ぶ。
      //    ノート間リンク(data-pkc-entry-ref)は上で #pe-N へ向けた物なので触らない
      Array.prototype.forEach.call(box.querySelectorAll('a[href^="#"]'),function(a){
        if(a.hasAttribute('${NOTE_LINK_ATTR}'))return;
        var f=(a.getAttribute('href')||'').slice(1);
        var dec=f;
        try{dec=decodeURIComponent(f)}catch(_x){}
        var key=has.call(renamed,f)?f:(has.call(renamed,dec)?dec:null);
        if(key!==null)a.setAttribute('href','#'+renamed[key]);
      });
    }
    return out;
  }
`;
}
