/**
 * 🔴 **配る HTML(閲覧用 HTML・次の PR のマルチノート ZIP の `index.html`)に同梱する、軽い Widget Bridge の親**
 * (v4.1 Phase 2 / PR-5、#2097 / #2098)。
 *
 * PKC3 本体では埋め込み HTML / ウィジェットの箱の親は `adapter/ui/render/widget-bridge.ts` + `widget-io-bar.ts` が務める。
 * 配った HTML には本体が居ないので、**同じ契約の親**をインラインの JS(依存ゼロ・ES5)として焼く。
 *
 * ## 受け持つ 4 つ
 *
 * 1. 高さ追従(`pkc-html-render-resize`)── 上限は `HTML_SANDBOX_MAX_HEIGHT`。縦幅を固定した箱(`data-pkc-fixed-height`。v4.2 PR-1)は上書きしない
 * 2. テーマ連動(`pkc-widget-ready` → `pkc-widget-theme`)── OS の明暗の切り替え・親の `<html>` の属性の変化でも配り直す
 * 3. 同じノートの参照(`pkc-widget-context-req` → `pkc-widget-context-res`)── 答えはホストの `getFrameContext(iframe)` だけ
 * 4. 安全なファイルの入出力(`pkc-widget-dl-req` / `pkc-widget-file-req`)── 本体の確認バーと同じ契約
 *
 * ## 🔴 セキュリティの不変条件(本体と同じ)
 *
 * - 送り主は `iframe.contentWindow === ev.source` + `data-pkc-html-render-id` の照合だけで決める(`ev.origin` は使わない)。
 * - **自動では何もしない** ── 保存もファイル選択も、確認バーのボタンを user が押した処理の中でだけ走る。
 * - 1 つの箱に確認バーは最新の 1 件だけ(前の要求は「置き換わりました」で閉じ、預かった bytes を手放す。処理中なら新しい要求を断る)。
 * - 流量は 1 つの箱につき 1 秒に 3 回まで(中身を検める前に数える)。出した直後・差し替えた直後は 400ms 押せない。
 * - 大きさは 50 MB・20 件まで。ファイル名は無害化し、要注意の拡張子には注意の文を出す。`accept` は選んだ後に検め直す。
 * - 「このノートの添付から選ぶ」は、ホストの `getFrameAssets(iframe)` が返す**その箱のノートの添付だけ**(他のノートへ越境しない)。
 * - 閲覧用 HTML は読むだけ ── 「このノートへ添付」は出さない。
 *
 * ## 🔑 1 本化(CLAUDE.md §7)
 *
 * 型名・上限・断りの文・要注意の拡張子・MIME の表・正規表現・確認バーの字・テーマの変数名は、正本
 * (`widget-bridge.ts` / `widget-io.ts` / `html-sandbox.ts` / `file-name.ts`)から `inlineJson` で焼く。
 * ⚠ ファイル名の無害化・`accept` の照合・大きさの字は**別の実行系**なので式を書き写している ── 正本と同じ答えを返すことを
 *   `tests/features/portable-widget-bridge.test.ts` が入力の束で突き合わせる(片方だけ変えると落ちる)。
 *
 * ## 定常のコスト
 *
 * - 受け口は `message` 1 本。箱が外れたかの見張り(`MutationObserver`)は確認バーが出ている間だけ。
 * - テーマの見張りは `matchMedia` の `change` と `<html>` の属性だけ(箱が 0 個なら配る先も 0)。
 */
import { FIXED_HEIGHT_ATTR } from '../markdown/fence-size';
import { inlineJson } from '@features/launcher/app-storage-shim';
import {
  HTML_SANDBOX_MAX_HEIGHT,
  HTML_SANDBOX_RESIZE_MSG_TYPE,
  WIDGET_FRAME_ATTR,
} from '../markdown/html-sandbox';
import {
  WIDGET_CONTEXT_REQ_MSG_TYPE,
  WIDGET_CONTEXT_RES_MSG_TYPE,
  WIDGET_READY_MSG_TYPE,
  WIDGET_THEME_MSG_TYPE,
  WIDGET_THEME_TOKENS,
} from '../markdown/widget-bridge';
import {
  WIDGET_DL_REQ_MSG_TYPE,
  WIDGET_DL_RES_MSG_TYPE,
  WIDGET_FILE_REQ_MSG_TYPE,
  WIDGET_FILE_RES_MSG_TYPE,
  WIDGET_IO_ACCEPT_TOKEN_RE,
  WIDGET_IO_LABELS,
  WIDGET_IO_MAX_BYTES,
  WIDGET_IO_MAX_FILES,
  WIDGET_IO_MIME_EXT,
  WIDGET_IO_MIME_RE,
  WIDGET_IO_PRESS_GUARD_MS,
  WIDGET_IO_RATE_LIMIT,
  WIDGET_IO_RATE_WINDOW_MS,
  WIDGET_IO_REASONS,
  WIDGET_IO_RISK_NOTICE,
  WIDGET_IO_RISKY_EXTS,
  WIDGET_IO_SAFE_EXT_RE,
  WIDGET_IO_TIMEOUT_MS,
} from '../markdown/widget-io';
import { RESERVED_FILE_NAMES } from './file-name';

/** 確認バーの印(本体の `WIDGET_IO_BAR_FIELD` と同じ綴り ── smoke・test が同じ選択子で引ける)。 */
export const PORTABLE_WIDGET_IO_BAR_FIELD = 'widget-io-bar';

/**
 * 確認バーの見た目(本体の `app.css` の `.pkc-widget-io-*` に揃えた簡潔な版)。
 * 🔑 色は配る HTML に焼かれた変数(`--surface` / `--border` / `--fg` / `--muted` / `--warn`)を使い、無ければ半透明の無彩色に落ちる
 *   (明暗どちらでも読める)。⚠ 紙には混ぜない(`@media print`)。
 */
export function portableWidgetBridgeCss(): string {
  return (
    '.pkc-widget-io-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:6px 0;padding:6px 10px;' +
    'border:1px solid var(--border,#8886);border-radius:8px;background:var(--surface,#8881);color:var(--fg,inherit);font-size:13px;line-height:1.5}' +
    '.pkc-widget-io-text{flex:1 1 16em;min-width:0;overflow-wrap:anywhere}' +
    '.pkc-widget-io-risk{flex-basis:100%;color:var(--warn,#b45309);font-weight:600}' +
    '.pkc-widget-io-actions{display:inline-flex;flex-wrap:wrap;gap:6px}' +
    '.pkc-widget-io-bar button{font:inherit;padding:3px 10px;border-radius:6px;border:1px solid var(--border,#8886);' +
    'background:var(--accent,#2563eb);color:#fff;cursor:pointer}' +
    '.pkc-widget-io-bar button[data-pkc-variant=ghost]{background:transparent;color:inherit}' +
    '.pkc-widget-io-bar button:disabled{opacity:.5;cursor:default}' +
    '.pkc-widget-io-bar button[hidden]{display:none}' +
    '.pkc-widget-io-list{flex-basis:100%;display:flex;flex-direction:column;gap:2px;padding:4px 0}' +
    '.pkc-widget-io-item{display:flex;gap:6px;align-items:center;color:var(--fg,inherit)}' +
    '@media print{.pkc-widget-io-bar{display:none!important}}'
  );
}

/** 親の runtime へ焼く定数(正本から引く ── 書き写さない)。 */
function bridgeConstants(guardMs: number): Record<string, unknown> {
  return {
    resize: HTML_SANDBOX_RESIZE_MSG_TYPE,
    maxH: HTML_SANDBOX_MAX_HEIGHT,
    fixedH: FIXED_HEIGHT_ATTR,
    frameAttr: WIDGET_FRAME_ATTR,
    theme: WIDGET_THEME_MSG_TYPE,
    ready: WIDGET_READY_MSG_TYPE,
    creq: WIDGET_CONTEXT_REQ_MSG_TYPE,
    cres: WIDGET_CONTEXT_RES_MSG_TYPE,
    tokens: WIDGET_THEME_TOKENS.map(([inner, outer]) => [inner, outer]),
    dlReq: WIDGET_DL_REQ_MSG_TYPE,
    dlRes: WIDGET_DL_RES_MSG_TYPE,
    fReq: WIDGET_FILE_REQ_MSG_TYPE,
    fRes: WIDGET_FILE_RES_MSG_TYPE,
    max: WIDGET_IO_MAX_BYTES,
    maxf: WIDGET_IO_MAX_FILES,
    rate: WIDGET_IO_RATE_LIMIT,
    win: WIDGET_IO_RATE_WINDOW_MS,
    to: WIDGET_IO_TIMEOUT_MS,
    guard: guardMs,
    R: WIDGET_IO_REASONS,
    L: WIDGET_IO_LABELS,
    risk: WIDGET_IO_RISK_NOTICE,
    risky: WIDGET_IO_RISKY_EXTS,
    mimeExt: WIDGET_IO_MIME_EXT,
    mimeRe: WIDGET_IO_MIME_RE.source,
    extRe: WIDGET_IO_SAFE_EXT_RE.source,
    accRe: WIDGET_IO_ACCEPT_TOKEN_RE.source,
    reserved: RESERVED_FILE_NAMES,
    field: PORTABLE_WIDGET_IO_BAR_FIELD,
  };
}

/**
 * 親の runtime の本体(ES5)。`H` はホストの口、`C` は上の定数。
 * ⚠ ここは `String.raw` の中 ── `${` を書かない(定数は呼び手が引数で渡す)。バッククォートも書かない。
 * ⚠ 配る HTML の `<script>` に入るので、`</` と `<!--` を書かない。
 */
const RUNTIME = String.raw`(function(H,C){
'use strict';
var doc=document,win=window,R=C.R,L=C.L;
var MIME_RE=new RegExp(C.mimeRe),EXT_RE=new RegExp(C.extRe),ACC_RE=new RegExp(C.accRe,'i');
var RISKY={},RES={},i0;
for(i0=0;i0<C.risky.length;i0++)RISKY[C.risky[i0]]=1;
for(i0=0;i0<C.reserved.length;i0++)RES[C.reserved[i0]]=1;
function own(o,k){return Object.prototype.hasOwnProperty.call(o,k);}
function fill(t,v){for(var k in v){if(own(v,k))t=t.split('{'+k+'}').join(v[k]);}return t;}
function hook(name){return H&&typeof H[name]==='function'?H[name]:null;}
function guardMs(){return H&&typeof H.guardMs==='number'?H.guardMs:C.guard;}
function now(){return H&&typeof H.now==='function'?H.now():Date.now();}
/* sender = real contentWindow + claimed id (never ev.origin: sandboxed frames all report "null") */
function senderOf(src,id){
  if(!src||typeof id!=='string')return null;
  var fs=doc.querySelectorAll('iframe[data-pkc-html-render-id]');
  for(var i=0;i<fs.length;i++){
    if(fs[i].contentWindow===src)return fs[i].getAttribute('data-pkc-html-render-id')===id?fs[i]:null;
  }
  return null;
}
function post(f,msg,tr){var w=f.contentWindow;if(!w)return;try{w.postMessage(msg,'*',tr||[]);}catch(e){}}
/* size text (same answers as human-bytes.ts) */
function r1(x){return Math.round(x*10)/10;}
function hb(n){if(n<1024)return n+' B';var kb=r1(n/1024);if(kb<1024)return kb.toFixed(1)+' KB';
  var mb=r1(n/1048576);if(mb<1024)return mb.toFixed(1)+' MB';return r1(n/1073741824).toFixed(1)+' GB';}
/* names and types (same answers as widget-io.ts / file-name.ts) */
function normMime(raw){if(typeof raw!=='string')return 'application/octet-stream';
  var t=raw.split(';')[0].trim().toLowerCase();
  if(t.length===0||t.length>100)return 'application/octet-stream';
  return MIME_RE.test(t)?t:'application/octet-stream';}
function extFor(m){var n=normMime(m);return own(C.mimeExt,n)?C.mimeExt[n]:'bin';}
function chars(s){var out=[];for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);
  if(c>=0xd800&&c<=0xdbff&&i+1<s.length){var d=s.charCodeAt(i+1);if(d>=0xdc00&&d<=0xdfff){out.push(s.charAt(i)+s.charAt(i+1));i++;continue;}}
  out.push(s.charAt(i));}return out;}
function safeName(title){
  var cs=chars(title);
  for(var i=0;i<cs.length;i++){var c=cs[i].charCodeAt(0);if(cs[i].length===1&&(c<0x20||c===0x7f))cs[i]='-';}
  var s=cs.join('').replace(/[\\/:*?"<>| ]+/g,'-').replace(/^[-.\s]+|[-.\s]+$/g,'');
  var cut=chars(s).slice(0,60).join('')||'pkc3';
  var dot=cut.indexOf('.');var base=dot<0?cut:cut.slice(0,dot);
  return own(RES,base.toLowerCase())?base+'-file'+cut.slice(base.length):cut;
}
function sanitize(rawName,mime){
  var raw=typeof rawName==='string'?rawName:'';
  var parts=raw.split(/[\\/]/);var last=parts.length?parts[parts.length-1]:'';
  var dot=last.lastIndexOf('.');var extRaw=dot>0?last.slice(dot+1):'';
  var ok=EXT_RE.test(extRaw);
  var ext=ok?extRaw.toLowerCase():extFor(typeof mime==='string'?mime:'');
  var stemRaw=dot>0&&ok?last.slice(0,dot):last;
  var stem=stemRaw.replace(/^[-.\s]+/,'').trim()===''?'download':safeName(stemRaw);
  return stem+'.'+ext;
}
function isRisky(name){var d=name.lastIndexOf('.');if(d<0)return false;return own(RISKY,name.slice(d+1).toLowerCase());}
function normAccept(raw){
  if(raw===undefined||raw===null||raw==='')return '';
  if(typeof raw!=='string'||raw.length>300)return null;
  var ps=raw.split(','),out=[];
  for(var i=0;i<ps.length;i++){var p=ps[i].trim();if(p!=='')out.push(p);}
  if(out.length>20)return null;
  for(var j=0;j<out.length;j++)if(!ACC_RE.test(out[j]))return null;
  return out.join(',');
}
function accMatch(acc,name,mime){
  if(acc==='')return true;
  var lower=name.toLowerCase(),t=normMime(mime),ts=acc.split(',');
  for(var i=0;i<ts.length;i++){var a=ts[i].trim().toLowerCase();
    if(a.charAt(0)==='.'){if(lower.length>=a.length&&lower.slice(lower.length-a.length)===a)return true;}
    else if(a.slice(-2)==='/*'){if(t.indexOf(a.slice(0,-1))===0)return true;}
    else if(a===t)return true;}
  return false;
}
function checkPicked(files,req){
  if(files.length===0)return R.cancelled;
  if(files.length>(req.multiple?C.maxf:1))return R.tooMany;
  var total=0;
  for(var i=0;i<files.length;i++){if(files[i].size>req.maxBytes)return fill(L.perFileTooLarge,{size:hb(req.maxBytes)});total+=files[i].size;}
  if(total>C.max)return R.tooLarge;
  return null;
}
/* theme (same acceptance rule as widgetThemeFrom in widget-bridge.ts) */
function safeTok(v){var t=String(v==null?'':v).trim();if(t===''||t.length>300)return null;if(/[;{}<>\\]/.test(t))return null;return t;}
function tone(){
  var a=doc.documentElement.getAttribute('data-pkc-tone');
  if(a==='dark'||a==='light')return a;
  try{return win.matchMedia&&win.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}catch(e){return 'light';}
}
function themeMsg(){
  var st=null;try{st=win.getComputedStyle(doc.documentElement);}catch(e){}
  var t={};
  for(var i=0;i<C.tokens.length;i++){var v=safeTok(st?st.getPropertyValue(C.tokens[i][1]):'');if(v!==null)t[C.tokens[i][0]]=v;}
  return {type:C.theme,tone:tone(),tokens:t};
}
function broadcast(){
  var fs=doc.querySelectorAll('iframe['+C.frameAttr+']');
  if(fs.length===0)return 0;
  var m=themeMsg();for(var i=0;i<fs.length;i++)post(fs[i],m);return fs.length;
}
/* file I/O */
var pend=[];var limits=typeof WeakMap==='function'?new WeakMap():null;var mo=null;var seq=0;
function pendOf(f){for(var i=0;i<pend.length;i++)if(pend[i].f===f)return pend[i];return null;}
function release(p){
  p.settled=true;p.bytes=null;
  if(p.timer!==null){clearTimeout(p.timer);p.timer=null;}
  if(p.bar.parentNode)p.bar.parentNode.removeChild(p.bar);
  var k=pend.indexOf(p);if(k>=0)pend.splice(k,1);
  if(pend.length===0&&mo){mo.disconnect();mo=null;}
}
function settle(p,msg,tr){if(p.settled)return;release(p);post(p.f,msg,tr);}
function dlRes(reqId,ok,action,reason){var m={type:C.dlRes,reqId:reqId,ok:ok,action:action};if(reason!==undefined)m.reason=reason;return m;}
function fRes(reqId,ok,files,reason){var m={type:C.fRes,reqId:reqId,ok:ok,files:files};if(reason!==undefined)m.reason=reason;return m;}
function cancelMsg(p,reason){return p.kind==='download'?dlRes(p.reqId,false,'cancel',reason):fRes(p.reqId,false,[],reason);}
function sweep(){var n=0,list=pend.slice();for(var i=0;i<list.length;i++){if(list[i].f.isConnected)continue;settle(list[i],cancelMsg(list[i],R.closed));n++;}return n;}
/* call when leaving a note: closes every bar and drops held bytes */
function reset(){var list=pend.slice();for(var i=0;i<list.length;i++)settle(list[i],cancelMsg(list[i],R.closed));return list.length;}
function watch(){
  if(mo||typeof MutationObserver!=='function')return;
  mo=new MutationObserver(function(){sweep();});
  mo.observe(doc.documentElement,{childList:true,subtree:true});
}
function allow(f,t){
  var st=limits?limits.get(f):f.__pkcIoRate;
  if(!st){st=[];if(limits)limits.set(f,st);else f.__pkcIoRate=st;}
  while(st.length>0&&t-st[0]>=C.win)st.shift();
  if(st.length>=C.rate)return false;
  st.push(t);return true;
}
function reqIdOf(d){var r=d.reqId;return typeof r==='number'&&isFinite(r)&&Math.floor(r)===r&&r>=0?r:null;}
function parseDl(d){
  var reqId=reqIdOf(d);var data=d.data,bytes;
  if(reqId===null)return {ok:false,reqId:null,reason:R.badData};
  if(data instanceof ArrayBuffer){if(data.byteLength>C.max)return {ok:false,reqId:reqId,reason:R.tooLarge};bytes=new Uint8Array(data);}
  else if(ArrayBuffer.isView(data)){if(data.byteLength>C.max)return {ok:false,reqId:reqId,reason:R.tooLarge};bytes=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);}
  else if(typeof data==='string'){if(data.length>C.max)return {ok:false,reqId:reqId,reason:R.tooLarge};
    bytes=new TextEncoder().encode(data);if(bytes.byteLength>C.max)return {ok:false,reqId:reqId,reason:R.tooLarge};}
  else return {ok:false,reqId:reqId,reason:R.badData};
  var mime=normMime(d.mime);
  return {ok:true,req:{reqId:reqId,name:sanitize(d.name,mime),mime:mime,bytes:bytes}};
}
function parseF(d){
  var reqId=reqIdOf(d);if(reqId===null)return {ok:false,reqId:null,reason:R.badData};
  var acc=normAccept(d.accept);if(acc===null)return {ok:false,reqId:reqId,reason:R.badAccept};
  var m=d.maxBytes;
  var mx=typeof m==='number'&&isFinite(m)&&m>0?Math.min(Math.floor(m),C.max):C.max;
  return {ok:true,req:{reqId:reqId,accept:acc,multiple:d.multiple===true,maxBytes:mx}};
}
function btn(label,field,ghost,title){
  var b=doc.createElement('button');b.type='button';b.textContent=label;b.setAttribute('data-pkc-field',field);
  if(ghost)b.setAttribute('data-pkc-variant','ghost');if(title)b.title=title;return b;
}
function onPress(b,run){b.addEventListener('click',function(ev){ev.preventDefault();ev.stopPropagation();run();});}
function makeBar(f,kind,text){
  var bar=doc.createElement('div');bar.className='pkc-widget-io-bar';
  bar.setAttribute('data-pkc-field',C.field);bar.setAttribute('data-pkc-io-kind',kind);
  bar.setAttribute('role','region');bar.setAttribute('aria-label',kind==='download'?L.downloadAria:L.fileAria);
  var t=doc.createElement('span');t.className='pkc-widget-io-text';t.setAttribute('data-pkc-field','widget-io-text');t.textContent=text;
  var a=doc.createElement('span');a.className='pkc-widget-io-actions';
  bar.appendChild(t);bar.appendChild(a);
  f.parentNode.insertBefore(bar,f);
  return {bar:bar,actions:a};
}
function register(p){
  pend.push(p);
  p.timer=setTimeout(function(){p.timer=null;settle(p,cancelMsg(p,R.timeout));},C.to);
  watch();
}
/* buttons stay disabled right after a bar appears or is replaced (anti swap clickjacking) */
function arm(p,actions){
  var ms=guardMs();if(ms<=0)return;
  var bs=actions.querySelectorAll('button'),held=[];
  for(var i=0;i<bs.length;i++)if(!bs[i].disabled){bs[i].disabled=true;held.push(bs[i]);}
  setTimeout(function(){if(p.settled)return;for(var j=0;j<held.length;j++)held[j].disabled=false;},ms);
}
function showDl(f,req){
  var o=makeBar(f,'download',fill(L.downloadText,{name:req.name,size:hb(req.bytes.byteLength)}));
  var p={f:f,reqId:req.reqId,kind:'download',bar:o.bar,bytes:req.bytes,settled:false,busy:false,timer:null};
  register(p);
  if(isRisky(req.name)){
    var r=doc.createElement('span');r.className='pkc-widget-io-risk';r.setAttribute('data-pkc-field','widget-io-risk');
    r.setAttribute('role','note');r.textContent=C.risk;o.bar.insertBefore(r,o.actions);
  }
  var save=btn(L.save,'widget-io-save',false,L.saveTitle);
  onPress(save,function(){
    var b=p.bytes;if(p.settled||b===null)return;
    var u=URL.createObjectURL(new Blob([b],{type:req.mime}));
    var a=doc.createElement('a');a.href=u;a.download=req.name;a.style.display='none';
    (doc.body||doc.documentElement).appendChild(a);
    try{a.click();}finally{if(a.parentNode)a.parentNode.removeChild(a);setTimeout(function(){URL.revokeObjectURL(u);},1000);}
    settle(p,dlRes(req.reqId,true,'save'));
  });
  var cancel=btn(L.cancel,'widget-io-cancel',true);
  onPress(cancel,function(){settle(p,dlRes(req.reqId,false,'cancel'));});
  o.actions.appendChild(save);o.actions.appendChild(cancel);
  arm(p,o.actions);
}
function deliver(p,files){var tr=[];for(var i=0;i<files.length;i++)tr.push(files[i].data);settle(p,fRes(p.reqId,true,files),tr);}
function showF(f,req){
  var lab=req.accept===''?'':fill(L.fileTarget,{label:req.accept.split(',').join(L.acceptSep)});
  var o=makeBar(f,'file',L.fileText+lab);
  var p={f:f,reqId:req.reqId,kind:'file',bar:o.bar,bytes:null,settled:false,busy:false,timer:null};
  register(p);
  function fail(reason){settle(p,fRes(req.reqId,false,[],reason));}
  var pc=btn(L.pickPc,'widget-io-pick-pc',false,L.pickPcTitle);
  onPress(pc,function(){
    if(p.settled)return;
    var inp=doc.createElement('input');inp.type='file';if(req.accept!=='')inp.accept=req.accept;inp.multiple=req.multiple;
    inp.style.display='none';inp.setAttribute('data-pkc-field','widget-io-input');
    function done(){if(inp.parentNode)inp.parentNode.removeChild(inp);}
    inp.addEventListener('cancel',function(){done();fail(R.cancelled);});
    inp.addEventListener('change',function(){
      var fl=[].slice.call(inp.files||[]);done();
      var bad=checkPicked(fl,req);if(bad!==null){fail(bad);return;}
      for(var i=0;i<fl.length;i++)if(!accMatch(req.accept,fl[i].name,fl[i].type)){fail(R.wrongType);return;}
      p.busy=true;
      Promise.all(fl.map(function(x){return x.arrayBuffer().then(function(b){return {name:x.name,mime:x.type||'application/octet-stream',size:b.byteLength,data:b};});}))
        .then(function(got){if(!p.settled)deliver(p,got);},function(){fail(R.readFailed);});
    });
    o.bar.appendChild(inp);inp.click();
  });
  o.actions.appendChild(pc);
  /* only the attachments of this frame's own note (decided by the host) */
  var ga=hook('getFrameAssets'),rb=hook('readAssetBytes');
  if(ga&&rb){
    var list=[];try{list=ga(f)||[];}catch(e){list=[];}
    var cands=[];
    for(var i=0;i<list.length;i++){var a=list[i];
      if(a&&typeof a.key==='string'&&typeof a.name==='string'&&typeof a.size==='number'&&accMatch(req.accept,a.name,a.mime||'')&&a.size<=req.maxBytes)cands.push(a);}
    if(cands.length>0){
      var note=btn(L.pickNote,'widget-io-pick-note',true,L.pickNoteTitle);
      onPress(note,function(){if(p.settled||o.bar.querySelector('[data-pkc-field="widget-io-note-list"]'))return;picker(p,o.bar,cands,req,rb,fail);});
      o.actions.appendChild(note);
    }
  }
  var cancel=btn(L.cancel,'widget-io-cancel',true);
  onPress(cancel,function(){fail(R.cancelled);});
  o.actions.appendChild(cancel);
  arm(p,o.actions);
}
function picker(p,bar,cands,req,rb,fail){
  var box=doc.createElement('div');box.className='pkc-widget-io-list';box.setAttribute('data-pkc-field','widget-io-note-list');
  box.setAttribute('role','group');box.setAttribute('aria-label',L.noteListAria);
  seq++;var group='pkc-widget-io-p'+seq,ins=[];
  for(var i=0;i<cands.length;i++){
    var row=doc.createElement('label');row.className='pkc-widget-io-item';
    var inp=doc.createElement('input');inp.type=req.multiple?'checkbox':'radio';inp.name=group;
    inp.setAttribute('data-pkc-field','widget-io-note-asset');inp.setAttribute('data-pkc-asset-key',cands[i].key);
    var nm=doc.createElement('span');nm.textContent=fill(L.noteItem,{name:cands[i].name,size:hb(cands[i].size)});
    row.appendChild(inp);row.appendChild(nm);box.appendChild(row);ins.push({i:inp,a:cands[i]});
  }
  var give=btn(L.give,'widget-io-note-give',false);give.disabled=true;
  box.addEventListener('change',function(){var any=false;for(var j=0;j<ins.length;j++)if(ins[j].i.checked)any=true;give.disabled=!any;});
  onPress(give,function(){
    if(p.settled)return;
    var chosen=[];for(var j=0;j<ins.length;j++)if(ins[j].i.checked)chosen.push(ins[j].a);
    var bad=checkPicked(chosen,req);if(bad!==null){fail(bad);return;}
    give.disabled=true;p.busy=true;
    Promise.all(chosen.map(function(a){return Promise.resolve(rb(a.key)).then(function(buf){
      if(!(buf instanceof ArrayBuffer))throw new Error('missing');
      return {name:a.name,mime:a.mime||'application/octet-stream',size:buf.byteLength,data:buf};});}))
      .then(function(files){if(!p.settled)deliver(p,files);},function(){fail(R.readFailed);});
  });
  box.appendChild(give);bar.appendChild(box);
}
function onIo(f,d){
  var isDl=d.type===C.dlReq;
  function rej(reqId,reason){if(reqId===null)return;post(f,isDl?dlRes(reqId,false,'rejected',reason):fRes(reqId,false,[],reason));}
  /* rate limit before parsing the payload */
  if(!allow(f,now())){rej(reqIdOf(d),R.rateLimited);return;}
  var r=isDl?parseDl(d):parseF(d);
  if(!r.ok){rej(r.reqId,r.reason);return;}
  var prev=pendOf(f);
  if(prev){if(prev.busy){rej(r.req.reqId,R.busy);return;}settle(prev,cancelMsg(prev,R.replaced));}
  if(isDl)showDl(f,r.req);else showF(f,r.req);
}
function onMessage(ev){
  var d=ev.data;if(!d||typeof d!=='object')return;
  var t=d.type;
  if(t===C.resize){
    if(typeof d.height!=='number')return;
    var rf=senderOf(ev.source,d.id);if(!rf)return;
    if(rf.hasAttribute(C.fixedH))return;
    rf.style.height=Math.max(0,Math.min(C.maxH,d.height))+'px';return;
  }
  if(t!==C.ready&&t!==C.creq&&t!==C.dlReq&&t!==C.fReq)return;
  var f=senderOf(ev.source,d.id);if(!f)return;
  if(t===C.ready){if(f.hasAttribute(C.frameAttr))post(f,themeMsg());return;}
  if(t===C.creq){
    var rid=d.reqId;if(typeof rid!=='number'||Math.floor(rid)!==rid)return;
    var c=null,gc=hook('getFrameContext');try{c=gc?gc(f):null;}catch(e){c=null;}
    if(!c||typeof c!=='object')c={frontmatter:{},tables:[]};
    post(f,{type:C.cres,reqId:rid,context:c});return;
  }
  if(!f.isConnected||!f.parentNode)return;
  onIo(f,d);
}
win.addEventListener('message',onMessage);
/* theme watchers (OS scheme and root attributes) */
try{var mq=win.matchMedia?win.matchMedia('(prefers-color-scheme: dark)'):null;
  if(mq){if(mq.addEventListener)mq.addEventListener('change',broadcast);else if(mq.addListener)mq.addListener(broadcast);}}catch(e){}
try{if(typeof MutationObserver==='function')new MutationObserver(function(){broadcast();})
  .observe(doc.documentElement,{attributes:true,attributeFilter:['data-pkc-tone','data-pkc-theme','data-pkc-accent','style','class']});}catch(e){}
var api={reset:reset,sweep:sweep,broadcastTheme:broadcast,pending:function(){return pend.length;},
  _t:{pendOf:pendOf,sanitize:sanitize,isRisky:isRisky,normAccept:normAccept,accMatch:accMatch,normMime:normMime,humanBytes:hb,safeTok:safeTok,checkPicked:checkPicked}};
try{win.__pkcWidgetBridgeSweep=reset;}catch(e){}
return api;
})`;

export interface PortableWidgetBridgeOptions {
  /**
   * ホストの口(JS の式)。次の関数を持つオブジェクトに評価されること:
   * - `getFrameContext(iframe)` → `{ frontmatter, tables }` | `null`(その箱のノートだけ)
   * - `getFrameAssets(iframe)` → `[{ key, name, mime, size }]`(その箱のノートの添付だけ)
   * - `readAssetBytes(key)` → `Promise<ArrayBuffer | null>`
   * 省略すると同じノートの参照は空の答え・「このノートの添付から選ぶ」は出ない。
   */
  readonly hooks?: string;
  /** 押せない時間(test 用。既定は `WIDGET_IO_PRESS_GUARD_MS`)。 */
  readonly pressGuardMs?: number;
}

/**
 * 親の runtime を起こす**式**(評価すると `{ reset, sweep, broadcastTheme, pending }` を返す)。
 * 呼び手は `var bridge=<この式>;` のように置く。⚠ `</script` を含まない(定数は `inlineJson` が逃がす)。
 */
export function buildPortableWidgetBridgeScript(opts: PortableWidgetBridgeOptions = {}): string {
  return `${RUNTIME}(${opts.hooks ?? 'null'},${inlineJson(bridgeConstants(opts.pressGuardMs ?? WIDGET_IO_PRESS_GUARD_MS))})`;
}
