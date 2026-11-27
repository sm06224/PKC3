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

/**
 * 箱の中で走る台本(ES5。外側のテンプレートリテラルと衝突する記法を使わない)。
 * - `pkc-widget-theme` を受けたら `--pkc-*`・`data-pkc-tone`・`color-scheme` を当て、`onTheme` の購読者へ知らせる
 * - 起動時に親へ `pkc-widget-ready` を 1 回送る(初回のテーマを受け取る)
 * - `window.pkcWidget`(`id` / `getTheme` / `onTheme` / `storage` / `readNoteContext` / `readTables` / `readFrontmatter`)を置く
 * ⚠ 受けるのは**親から来た**合図だけ(`e.source === parent`)。
 */
const THEME_PRELUDE_SOURCE =
  '(function(iframeId,wid,names,THEME,READY,CREQ,CRES,CTO){' +
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
    `${inlineJson(WIDGET_CONTEXT_REQ_MSG_TYPE)},${inlineJson(WIDGET_CONTEXT_RES_MSG_TYPE)},${String(WIDGET_CONTEXT_TIMEOUT_MS)});` +
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
): string {
  const src = escapeAttr(content);
  const idAttrs = widgetId === null ? '' : ` ${WIDGET_ID_ATTR}="${escapeAttr(widgetId)}" ${WIDGET_LIVE_ATTR}="1"`;
  const assetAttr = assetKey === null ? '' : ` ${WIDGET_ASSET_ATTR}="${escapeAttr(assetKey)}"`;
  return (
    `<div class="pkc-widget-placeholder" ${WIDGET_SRC_ATTR}="${src}"${idAttrs}${assetAttr}` +
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
