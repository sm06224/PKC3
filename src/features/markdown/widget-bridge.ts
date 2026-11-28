/**
 * 🔴 **ノートに埋め込んだ HTML / React(JSX)のウィジェット**の純関数の契約(v4.0 Phase 2 / PR-07、ビジョン 5-A)。
 *
 * ## 何を足すか
 *
 * 1. **テーマ連動** ── 親(PKC3)の配色・角丸・字体を `--pkc-*` の CSS 変数として箱(sandbox iframe)へ渡す。
 *    箱は**読み直さない**(`postMessage` で値だけ差し替える)。
 * 2. **ウィジェット単位の状態保存** ── コードブロックの見出しに `id="…"` を書いた囲みだけ、
 *    `localStorage` 互換の保存領域を貸す(ランチャーのアプリと**同じ prelude**:`app-storage-shim.ts`)。
 *
 * ## 🔴 セキュリティの不変条件(ここで決めて、adapter はそれに従う)
 *
 * - 箱は `sandbox="allow-scripts"` のみ(`allow-same-origin` は付けない)。CSP も緩めない。
 * - 箱が名乗る `id` / `lid` は**信頼しない** ── 保存先は**親の DOM が持つ `(lid, widgetId)`** から決める
 *   (`adapter/ui/render/widget-bridge.ts`)。ここの prelude は保存要求に `lid` も `widgetId` も載せない。
 * - 保存先の名前空間は `widgetStoragePrefix` 1 か所(`.` を符号化して越境させない)。
 *
 * ## `id=` の書き方
 *
 * ```` ```html id="budget" ```` / ```` ```html-render id="timer" ```` / ```` ```react id="counter" ```` / ```` ```jsx id="c" ````
 * ⚠ 読めない id(許す字の外・長すぎる)は**無視して今までどおりの状態を持たない表示**に落とす(本文を壊さない)。
 * ⚠ `id=` の無い囲みは**何も保存しない**(既存の挙動のまま。テーマ連動だけ効く)。
 */
import { buildStorageShim, inlineJson } from '@features/launcher/app-storage-shim';
import { fenceSizeAttrs, type FenceSize } from './fence-size';
import {
  WIDGET_DL_REQ_MSG_TYPE,
  WIDGET_DL_RES_MSG_TYPE,
  WIDGET_FILE_REQ_MSG_TYPE,
  WIDGET_FILE_RES_MSG_TYPE,
  WIDGET_IO_MAX_BYTES,
  WIDGET_IO_MAX_FILES,
  WIDGET_IO_REASONS,
  WIDGET_IO_TIMEOUT_MS,
} from './widget-io';

/** id に許す字(先頭は英数字、全体で 1〜64 字)。 */
export const WIDGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 1 ウィジェットあたりの上限(512 KB ── 鍵と値の字数の合計)。⚠ 親側でも同じ値で数える(箱の改竄対策)。 */
export const WIDGET_STORAGE_LIMIT = 512 * 1024;

/**
 * 🔴 **全ウィジェットの合計の上限**(2 MB)。1 つあたりの上限だけでは、id を 10 個書いたノート 1 件で origin の
 * `localStorage`(約 5 MB)を使い切れる ── 設定・履歴・ピン留めの書込が入らなくなる(PR-07 レビュー)。
 */
export const WIDGET_TOTAL_STORAGE_LIMIT = 2 * 1024 * 1024;

/** 全ウィジェットの保存の前置き。 */
export const WIDGET_STORAGE_ROOT = 'pkc3.widget.';

/** 保存の差分の合図(箱 → 親)。⚠ ランチャーの `pkc3.app.storage` と分ける(受け手が違う)。 */
export const WIDGET_STORAGE_MESSAGE = 'pkc3.widget.storage';
/** テーマの配信(親 → 箱)。 */
export const WIDGET_THEME_MSG_TYPE = 'pkc-widget-theme';
/** 箱の準備ができた合図(箱 → 親。1 回だけ)。 */
export const WIDGET_READY_MSG_TYPE = 'pkc-widget-ready';
/**
 * 同じノートのデータの問い合わせ(箱 → 親。PR-08)。`{ type, id: 箱の id, reqId }`。
 * 🔴 親は**登録した箱**にだけ、その箱を置いたノート 1 件の本文から組んだ答えを返す(`widget-bridge.ts`)。
 */
export const WIDGET_CONTEXT_REQ_MSG_TYPE = 'pkc-widget-context-req';
/** 問い合わせの答え(親 → 箱)。`{ type, reqId, context }`。 */
export const WIDGET_CONTEXT_RES_MSG_TYPE = 'pkc-widget-context-res';
/** 箱が答えを待つ上限(親の居ない書き出しの HTML では、これを過ぎたら空の答えで返す)。 */
export const WIDGET_CONTEXT_TIMEOUT_MS = 3000;

/**
 * 箱へ渡す CSS 変数(箱の中の名前 → 親の名前)。
 * 🔑 **配色・角丸・字体の値だけ**(ユーザーのデータを含まない)── ここに無い名前は渡さない。
 */
export const WIDGET_THEME_TOKENS: readonly (readonly [string, string])[] = [
  ['--pkc-bg', '--bg'],
  ['--pkc-surface', '--surface'],
  ['--pkc-surface-2', '--surface-2'],
  ['--pkc-fg', '--fg'],
  ['--pkc-muted', '--muted'],
  ['--pkc-accent', '--accent'],
  ['--pkc-border', '--border'],
  ['--pkc-hairline', '--hairline'],
  ['--pkc-radius', '--radius'],
  ['--pkc-font', '--font'],
  ['--pkc-font-mono', '--font-mono'],
];

export type WidgetTone = 'light' | 'dark';

export interface WidgetTheme {
  readonly tone: WidgetTone;
  /** 箱の中の名前(`--pkc-*`)→ 値。 */
  readonly tokens: Readonly<Record<string, string>>;
}

/**
 * コードブロックの見出しの残り(`id="budget"` / `tool id='calc'` / `id=x`)から id を取り出す。
 * ⚠ 読めない id は `null`(= 状態を持たない表示に落とす)。
 */
export function parseWidgetId(rest: string | null | undefined): string | null {
  if (!rest) return null;
  const m = /(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/.exec(rest);
  if (m === null) return null;
  const id = m[1] ?? m[2] ?? m[3] ?? '';
  return WIDGET_ID_RE.test(id) ? id : null;
}

/** 名前空間の 1 区画を符号化する(`.` も逃がす ── 区切りと衝突させない)。 */
function seg(s: string): string {
  return encodeURIComponent(s).replace(/\./g, '%2E');
}

/**
 * 保存先の名前空間(`pkc3.widget.<lid>.<widgetId>.`)。
 * 🔴 `lid` も `widgetId` も**符号化する**(`app-storage-shim.ts` の `appStoragePrefix` と同じ規則)──
 *   `lid="a"` の `b.c` と `lid="a.b"` の `c` を同じ所へ落とさない。
 */
export function widgetStoragePrefix(entryLid: string, widgetId: string): string {
  return `${widgetEntryPrefix(entryLid)}${seg(widgetId)}.`;
}

/** 1 ノートぶんの前置き(ノートを完全に消したときの後始末に使う)。 */
export function widgetEntryPrefix(entryLid: string): string {
  return `${WIDGET_STORAGE_ROOT}${seg(entryLid)}.`;
}

/** 値の受け入れ条件(色・長さ・字体名の範囲。`;` `{` `}` `<` `>` は持たない)。⚠ 単体の HTML の書き出しも同じ 1 本で見る。 */
export function safeTokenValue(v: string): string | null {
  const t = v.trim();
  if (t === '' || t.length > 300) return null;
  if (/[;{}<>\\]/.test(t)) return null;
  return t;
}

/**
 * 親の計算済みスタイルからテーマを抜き出す(`read` は `getPropertyValue`)。
 * ⚠ 値の読めない変数は渡さない(箱の中の既定値 `var(--pkc-fg, #222)` が効く)。
 */
export function widgetThemeFrom(read: (name: string) => string, toneAttr: string | null): WidgetTheme {
  const tokens: Record<string, string> = {};
  for (const [inner, outer] of WIDGET_THEME_TOKENS) {
    const v = safeTokenValue(read(outer) ?? '');
    if (v !== null) tokens[inner] = v;
  }
  return { tone: toneAttr === 'dark' ? 'dark' : 'light', tokens };
}

/**
 * 箱の中の既定の見た目。🔑 親のテーマが来れば `--pkc-fg` で馴染み、親の居ない書き出し(単体 HTML)でも
 * 今までどおり `#222` で読める。背景は透かす(親の地が見える)。
 */
export const WIDGET_BASE_STYLE =
  'body{margin:0;padding:0.5rem;font-family:var(--pkc-font,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif);' +
  'line-height:1.5;color:var(--pkc-fg,#222);background:transparent;}' +
  '*{box-sizing:border-box;}' +
  'img,svg,video,canvas{max-width:100%;height:auto;}';

/** 箱の中のファイルの入出力に渡す定数(#2097)。⚠ 綴りと上限の正本は `widget-io.ts`。 */
const WIDGET_IO_PRELUDE_ARGS = {
  dlReq: WIDGET_DL_REQ_MSG_TYPE,
  dlRes: WIDGET_DL_RES_MSG_TYPE,
  fReq: WIDGET_FILE_REQ_MSG_TYPE,
  fRes: WIDGET_FILE_RES_MSG_TYPE,
  to: WIDGET_IO_TIMEOUT_MS,
  max: WIDGET_IO_MAX_BYTES,
  maxf: WIDGET_IO_MAX_FILES,
  big: WIDGET_IO_REASONS.tooLarge,
  can: WIDGET_IO_REASONS.cancelled,
  tmo: WIDGET_IO_REASONS.timeout,
  rf: WIDGET_IO_REASONS.readFailed,
  many: WIDGET_IO_REASONS.tooMany,
} as const;

/**
 * 🔴 **箱の中のファイルの入出力**(#2097。`THEME_PRELUDE_SOURCE` の中に入る ── `api` / `iframeId` / `IO` を使う)。
 *
 * - `pkcWidget.requestDownload({ name, mime, data })` ── 親へ保存を頼む(親の確認バーで user が押したときだけ保存)。
 *   `data` は `Blob` / `ArrayBuffer` / 型付き配列 / 文字列。🔑 箱の中で作った buffer(`Blob` の中身・文字列の符号化)は
 *   Transferable で渡す(写さない)。⚠ 呼び手が渡した `ArrayBuffer` は**移さない**(呼び手の手元の値を使えなくしない)。
 * - `pkcWidget.requestFile({ accept, multiple, maxBytes })` ── 親へファイルの読み込みを頼む。答えは
 *   `{ ok, files: [{ name, mime, size, data: ArrayBuffer }], reason? }`。
 * - 親の居ない所(単体の HTML としてブラウザで直に開いた等 ── `window.parent === window`)では、ブラウザ標準の
 *   `<a download>` / `<input type="file">` で同じ形の答えを返す(確認バーは出ない ── 箱の外なので sandbox も無い)。
 * - 🔴 **`<a download>` の救済**(箱の中だけ):`pkcWidget` を知らない HTML ツールが `blob:` / `data:` の
 *   `<a download>` を押す(`a.click()` を含む)と、sandbox で黙って失敗する。それを捕まえて `requestDownload` へ渡す。
 *   ⚠ `blob:` / `data:` だけ(`https:` などの外の URL は捕まえない ── CSP を回り道させない)。
 *   ⚠ CSP の `connect-src 'none'` で箱の中の `fetch(blob:…)` は止まる ── `URL.createObjectURL` の対応表から Blob を引く。
 *   ⚠ 親の居ない所では救済を付けない(自分の `<a download>` を自分で捕まえて回り続けない)。
 *   ⚠ グローバルは `window.*` から引く(test が prelude を偽の window で走らせても、test 自身の `URL` を書き換えない)。
 */
const WIDGET_IO_PRELUDE_SOURCE =
  'var iop={};var iq=0;' +
  'function ioAsk(msg,resType,transfer,fail){return new Promise(function(res){iq+=1;var n=iq;' +
  'var t=setTimeout(function(){delete iop[n];res(fail(IO.tmo));},IO.to);' +
  'iop[n]={t:resType,f:function(d){clearTimeout(t);delete iop[n];res(d);}};' +
  'msg.id=iframeId;msg.reqId=n;' +
  "try{window.parent.postMessage(msg,'*',transfer);}catch(e){clearTimeout(t);delete iop[n];res(fail(String(e&&e.message||e)));}});}" +
  "function normDl(d){var r={ok:!!d&&d.ok===true,action:d&&typeof d.action==='string'?d.action:'cancel'};" +
  "if(d&&typeof d.reason==='string')r.reason=d.reason;return r;}" +
  'function normF(d){var fs=[];if(d&&Array.isArray(d.files)){for(var i=0;i<d.files.length;i++){var f=d.files[i];' +
  "if(f&&typeof f.name==='string'&&f.data instanceof ArrayBuffer)fs.push({name:f.name,mime:String(f.mime||'application/octet-stream'),size:f.data.byteLength,data:f.data});}}" +
  "var r={ok:!!d&&d.ok===true&&fs.length>0,files:fs};if(d&&typeof d.reason==='string')r.reason=d.reason;return r;}" +
  'function toData(x){try{' +
  "if(typeof window.Blob==='function'&&x instanceof window.Blob)return x.arrayBuffer().then(function(b){return {d:b,t:[b],mime:x.type};});" +
  'if(x instanceof ArrayBuffer)return Promise.resolve({d:x,t:[]});' +
  // ⚠ 大きな buffer の一部だけを指す型付き配列は、その部分だけを切り出して移す(buffer 全体を写さない)
  'if(ArrayBuffer.isView(x)){if(x.byteOffset===0&&x.byteLength===x.buffer.byteLength)return Promise.resolve({d:x,t:[]});' +
  'var c=x.buffer.slice(x.byteOffset,x.byteOffset+x.byteLength);return Promise.resolve({d:c,t:[c]});}' +
  "if(typeof x==='string'){if(typeof window.TextEncoder==='function'){var u=new window.TextEncoder().encode(x);return Promise.resolve({d:u.buffer,t:[u.buffer]});}" +
  'return Promise.resolve({d:x,t:[]});}}catch(e){}' +
  "return Promise.reject(new TypeError('pkcWidget.requestDownload: data must be a Blob, ArrayBuffer, typed array or string'));}" +
  'function saveHere(name,mime,d){var b=new window.Blob([d],{type:mime});var u=window.URL.createObjectURL(b);' +
  "var a=document.createElement('a');a.href=u;a.download=name||'download';a.style.display='none';" +
  '(document.body||document.documentElement).appendChild(a);' +
  'try{a.click();}finally{a.remove();setTimeout(function(){window.URL.revokeObjectURL(u);},1000);}' +
  "return {ok:true,action:'save'};}" +
  'api.requestDownload=function(o){o=o||{};return toData(o.data).then(function(p){' +
  "var size=typeof p.d==='string'?p.d.length:p.d.byteLength;" +
  "if(size>IO.max)return {ok:false,action:'rejected',reason:IO.big};" +
  "var mime=typeof o.mime==='string'&&o.mime!==''?o.mime:(p.mime||'application/octet-stream');" +
  "var name=typeof o.name==='string'?o.name:'';" +
  'if(window.parent===window)return saveHere(name,mime,p.d);' +
  "return ioAsk({type:IO.dlReq,name:name,mime:mime,data:p.d},IO.dlRes,p.t,function(r){return {ok:false,action:'cancel',reason:r};}).then(normDl);});};" +
  'function pickHere(acc,mul,mx){return new Promise(function(res){' +
  "var inp=document.createElement('input');inp.type='file';if(acc)inp.accept=acc;inp.multiple=mul;inp.style.display='none';" +
  'var done=false;function fin(r){if(done)return;done=true;try{inp.remove();}catch(e){}res(r);}' +
  "inp.addEventListener('cancel',function(){fin({ok:false,files:[],reason:IO.can});});" +
  "inp.addEventListener('change',function(){var fl=[].slice.call(inp.files||[]);" +
  'if(fl.length===0)return fin({ok:false,files:[],reason:IO.can});' +
  'if(fl.length>(mul?IO.maxf:1))return fin({ok:false,files:[],reason:IO.many});' +
  'for(var i=0;i<fl.length;i++)if(fl[i].size>mx)return fin({ok:false,files:[],reason:IO.big});' +
  "Promise.all(fl.map(function(f){return f.arrayBuffer().then(function(b){return {name:f.name,mime:f.type||'application/octet-stream',size:b.byteLength,data:b};});}))" +
  '.then(function(a){fin({ok:true,files:a});},function(){fin({ok:false,files:[],reason:IO.rf});});});' +
  '(document.body||document.documentElement).appendChild(inp);inp.click();});}' +
  "api.requestFile=function(o){o=o||{};var acc=typeof o.accept==='string'?o.accept:'';var mul=o.multiple===true;" +
  "var mx=typeof o.maxBytes==='number'&&o.maxBytes>0?Math.min(o.maxBytes,IO.max):IO.max;" +
  'if(window.parent===window)return pickHere(acc,mul,mx);' +
  'return ioAsk({type:IO.fReq,accept:acc,multiple:mul,maxBytes:mx},IO.fRes,[],function(r){return {ok:false,files:[],reason:r};}).then(normF);};' +
  // 🔴 `<a download>` の救済(箱の中だけ)
  'if(window.parent!==window){try{' +
  'var bl={};var U=window.URL;var oc=U.createObjectURL;var orv=U.revokeObjectURL;' +
  'U.createObjectURL=function(o){var u=oc.apply(U,arguments);try{if(o instanceof window.Blob)bl[u]=o;}catch(e){}return u;};' +
  'U.revokeObjectURL=function(u){delete bl[u];return orv.apply(U,arguments);};' +
  "var fromData=function(h){var c=h.indexOf(',');if(c<0)return null;var meta=h.slice(5,c);var body=h.slice(c+1);" +
  "var b64=/;base64$/i.test(meta);var mime=meta.replace(/;base64$/i,'').split(';')[0]||'text/plain';" +
  'try{if(b64){var s=window.atob(body);var u8=new Uint8Array(s.length);for(var i=0;i<s.length;i++)u8[i]=s.charCodeAt(i);' +
  'return {mime:mime,data:u8.buffer};}return {mime:mime,data:decodeURIComponent(body)};}catch(e){return null;}};' +
  // 🔑 押した時点で Blob を掴む(直後に revoke されても届く)
  "var grab=function(a){var h=a.getAttribute('href')||'';var nm=a.getAttribute('download')||'';" +
  "if(/^blob:/i.test(h)){var b=bl[h];if(!b)return false;api.requestDownload({name:nm,mime:b.type,data:b});return true;}" +
  'if(/^data:/i.test(h)){var p=fromData(h);if(!p)return false;api.requestDownload({name:nm,mime:p.mime,data:p.data});return true;}' +
  'return false;};' +
  "var isDl=function(a){return !!a&&a.hasAttribute('download')&&/^(blob|data):/i.test(a.getAttribute('href')||'');};" +
  "document.addEventListener('click',function(ev){var t=ev.target;var a=t&&t.closest?t.closest('a[download]'):null;" +
  'if(!isDl(a))return;if(grab(a))ev.preventDefault();},true);' +
  // ⚠ 文書に繋いでいない `<a>` の `click()` は文書まで届かない ── そこだけ直に捕まえる(繋いだ物は上の見張りへ流す)
  'var AP=window.HTMLAnchorElement.prototype;var oclk=AP.click;' +
  'AP.click=function(){if(!this.isConnected&&isDl(this)&&grab(this))return;return oclk.apply(this,arguments);};' +
  '}catch(e){}}';

/**
 * 箱の中で走る台本(ES5。外側のテンプレートリテラルと衝突する記法を使わない)。
 * - `pkc-widget-theme` を受けたら `--pkc-*`・`data-pkc-tone`・`color-scheme` を当て、`onTheme` の購読者へ知らせる
 * - 起動時に親へ `pkc-widget-ready` を 1 回送る(初回のテーマを受け取る)
 * - `window.pkcWidget`(`id` / `getTheme` / `onTheme` / `storage` / `readNoteContext` / `readTables` / `readFrontmatter` /
 *   `requestDownload` / `requestFile`)を置く
 * ⚠ 受けるのは**親から来た**合図だけ(`e.source === parent`)。
 */
const THEME_PRELUDE_SOURCE =
  '(function(iframeId,wid,names,THEME,READY,CREQ,CRES,CTO,IO){' +
  "'use strict';" +
  'var subs=[];var cur={tone:null,tokens:{}};' +
  'function copy(o){var r={};for(var k in o){if(Object.prototype.hasOwnProperty.call(o,k))r[k]=o[k];}return r;}' +
  'var api={id:wid,' +
  'getTheme:function(){return {tone:cur.tone,tokens:copy(cur.tokens)};},' +
  "onTheme:function(cb){if(typeof cb!=='function')return function(){};subs.push(cb);" +
  'return function(){var i=subs.indexOf(cb);if(i>=0)subs.splice(i,1);};},' +
  'storage:null};' +
  // 🔑 同じノートのデータの問い合わせ(PR-08)── 答えが来なければ CTO ミリ秒で空の答え(書き出しでも止まらない)
  'var pend={};var rq=0;' +
  'function empty(){return {frontmatter:{},tables:[]};}' +
  "function norm(c){if(!c||typeof c!=='object')return empty();" +
  "return {frontmatter:(c.frontmatter&&typeof c.frontmatter==='object'&&!Array.isArray(c.frontmatter))?c.frontmatter:{}," +
  'tables:Array.isArray(c.tables)?c.tables:[]};}' +
  // 🔑 親の居ない所(単体の HTML としてブラウザで直に開いた等。#2090)では待たずに空の答え ── 3 秒止めない
  'function ask(){if(window.parent===window)return Promise.resolve(empty());' +
  'return new Promise(function(res){rq+=1;var n=rq;' +
  'var t=setTimeout(function(){delete pend[n];res(empty());},CTO);' +
  'pend[n]=function(c){clearTimeout(t);delete pend[n];res(norm(c));};' +
  "try{window.parent.postMessage({type:CREQ,id:iframeId,reqId:n},'*');}catch(e){clearTimeout(t);delete pend[n];res(empty());}});}" +
  'api.readNoteContext=function(){return ask();};' +
  'api.readTables=function(){return ask().then(function(c){return c.tables;});};' +
  'api.readFrontmatter=function(){return ask().then(function(c){return c.frontmatter;});};' +
  WIDGET_IO_PRELUDE_SOURCE +
  // 🔑 id の在る箱だけ:前の script(保存の prelude)が差し替えた localStorage と同じ物を指す
  'if(wid!==null){try{api.storage=window.localStorage;}catch(e){api.storage=null;}}' +
  "try{Object.defineProperty(window,'pkcWidget',{value:Object.freeze(api),writable:false,enumerable:true,configurable:true});}" +
  'catch(e){window.pkcWidget=api;}' +
  'function apply(d){var root=document.documentElement;var t=(d&&d.tokens)||{};var next={};' +
  'for(var i=0;i<names.length;i++){var n=names[i];var v=t[n];' +
  "if(typeof v==='string'&&v.length<=300&&!/[;{}<>\\\\]/.test(v)){root.style.setProperty(n,v);next[n]=v;}" +
  'else root.style.removeProperty(n);}' +
  "var tone=d&&d.tone==='dark'?'dark':'light';" +
  "root.setAttribute('data-pkc-tone',tone);root.style.colorScheme=tone;" +
  'cur={tone:tone,tokens:next};' +
  'var list=subs.slice();for(var j=0;j<list.length;j++){try{list[j](api.getTheme());}catch(e){}}}' +
  "window.addEventListener('message',function(e){if(e.source!==window.parent)return;var d=e.data;" +
  "if(d&&d.type===CRES&&typeof d.reqId==='number'){var f=pend[d.reqId];if(f)f(d.context);return;}" +
  // 🔑 ファイルの入出力の答え(#2097)── 頼んだ種類の答えだけを受ける(番号が合っても種類が違えば捨てる)
  "if(d&&(d.type===IO.dlRes||d.type===IO.fRes)&&typeof d.reqId==='number'){var g=iop[d.reqId];if(g&&g.t===d.type)g.f(d);return;}" +
  'if(!d||d.type!==THEME)return;apply(d);});' +
  // ⚠ 文書の解析より前に送る ── 早く受け取れば、最初の描画から親の配色で出る(白く光らない)
  'try{window.parent.postMessage({type:READY,id:iframeId},\'*\');}catch(e){}' +
  '})';

/**
 * テーマ連動の prelude(`<script>`)。⚠ `</script>` は `inlineJson` が逃がす。
 * @param iframeId 箱の `data-pkc-html-render-id`(親が送り主を照合する名乗り)
 * @param widgetId `id=` を書いた囲みだけ。無ければ `null`(`pkcWidget.storage` も `null`)
 */
export function widgetThemePreludeScript(iframeId: string, widgetId: string | null = null): string {
  return (
    '<script>' +
    THEME_PRELUDE_SOURCE +
    `(${inlineJson(iframeId)},${inlineJson(widgetId)},${inlineJson(WIDGET_THEME_TOKENS.map(([n]) => n))},` +
    `${inlineJson(WIDGET_THEME_MSG_TYPE)},${inlineJson(WIDGET_READY_MSG_TYPE)},` +
    `${inlineJson(WIDGET_CONTEXT_REQ_MSG_TYPE)},${inlineJson(WIDGET_CONTEXT_RES_MSG_TYPE)},${String(WIDGET_CONTEXT_TIMEOUT_MS)},` +
    `${inlineJson(WIDGET_IO_PRELUDE_ARGS)});` +
    '</script>'
  );
}

/**
 * `id=` の在るウィジェットの prelude 一式:保存の shim(前回の値を `seed` で焼く ── 1 行目の同期 `getItem` が
 * 前回の値を返す)+ テーマ連動。⚠ **保存の shim が先**(テーマの prelude が差し替え後の `localStorage` を掴む)。
 */
export function widgetPrelude(
  iframeId: string,
  widgetId: string,
  seed: Readonly<Record<string, string>>,
): string {
  return (
    buildStorageShim({ seed, limit: WIDGET_STORAGE_LIMIT, tag: WIDGET_STORAGE_MESSAGE }) +
    widgetThemePreludeScript(iframeId, widgetId)
  );
}

/** 属性値の escape。 */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const WIDGET_SRC_ATTR = 'data-pkc-widget-src';
export const WIDGET_ID_ATTR = 'data-pkc-widget-id';
export const WIDGET_KIND_ATTR = 'data-pkc-widget-kind';
/** 保存つきの面で描いた器の印(React の器に付く。` ```html ` の器は器そのものが保存つきの面でしか出ない)。 */
export const WIDGET_LIVE_ATTR = 'data-pkc-widget-live';
/**
 * 保存しない面の React の器に添える、本文の状態ブロックの写し(JSON。PR-08)。箱の中だけの `localStorage` の初期値になる。
 * ⚠ 保存つきの面の器には付けない(保存のたびに塊の HTML を変えない)。
 */
export const WIDGET_SEED_ATTR = 'data-pkc-widget-seed';
/**
 * 🔴 **添付から読み込んだ HTML のウィジェットの器の印**(#2090。値は添付の鍵)。
 * ⚠ 次の PR(アセット単位の権限)がこの属性を読んで対象を決める ── 綴りはここが正本(adapter に 2 本目を書かない)。
 * 🔑 `id=` の無い添付の HTML も、読む面ではこの印を持つ器になる(テーマ連動・同じノートの参照・単体の HTML で保存)。
 */
export const WIDGET_ASSET_ATTR = 'data-pkc-widget-asset';

/**
 * `id=` の在る ` ```html ` の器(placeholder)。
 * 🔑 器は**原文と id だけ**を持つ ── 保存の中身を HTML に焼かないので、状態が変わっても
 *   無関係な段落を編集しても**塊の HTML が変わらず**、動いている箱は作り直されない(`apply-blocks.ts`)。
 * ⚠ 誰も埋めない面(書き出した HTML)では原文が字のまま読める。
 */
export function widgetPlaceholderHtml(
  content: string,
  /** `id=` の在るときだけ(状態を持つ)。`null` = 添付の HTML の `id=` 無し(状態を持たない。#2090)。 */
  widgetId: string | null,
  allowExternalImages: boolean,
  /** 添付から読み込んだ HTML の鍵(#2090)。 */
  assetKey: string | null = null,
  /** 🔴 囲みに書いた縦横の固定(v4.2 PR-1)。無指定(`{}`)なら属性を足さない(出力は不変)。 */
  size: FenceSize = {},
): string {
  const src = escapeAttr(content);
  const idAttrs = widgetId === null ? '' : ` ${WIDGET_ID_ATTR}="${escapeAttr(widgetId)}" ${WIDGET_LIVE_ATTR}="1"`;
  const assetAttr = assetKey === null ? '' : ` ${WIDGET_ASSET_ATTR}="${escapeAttr(assetKey)}"`;
  return (
    `<div class="pkc-widget-placeholder" ${WIDGET_SRC_ATTR}="${src}"${idAttrs}${assetAttr}${fenceSizeAttrs(size)}` +
    ` ${WIDGET_KIND_ATTR}="html"${allowExternalImages ? ' data-pkc-widget-ext="1"' : ''} data-pkc-md-block-kind="html">` +
    `<pre class="pkc-widget-source"><code class="language-html">${src}</code></pre></div>`
  );
}

/** 箱の id(中身・id・何番目かから決める ── 乱数にしない)。 */
export function widgetFrameId(kind: string, widgetId: string, content: string, occurrence: number): string {
  let h = 0x811c9dc5;
  const text = `${kind}\u0000${widgetId}\u0000${content}\u0000${String(occurrence)}`;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `pkc-widget-${h.toString(36).padStart(7, '0')}`;
}
