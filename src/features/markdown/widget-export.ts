/**
 * 🔴 **ウィジェットを単体の HTML ファイルにする**(#2090 ③。v4.1 Phase 1 / PR-2)。
 *
 * ノートの中の HTML / React のウィジェット(` ```html id="…" ` / ` ```html asset:鍵 ` / ` ```react id="…" `)を、
 * **1 枚の `.html`** としてブラウザで直に開ける形に組む純関数。
 * 🔑 DOM を持たない(後段の #2098 ── 持ち出し用の zip の `tools/*.html` ── でもそのまま使う)。
 *
 * ## 書き出した 1 枚が持つ物
 *
 * 1. 完全な文書(`<!DOCTYPE html><html lang="ja" data-pkc-tone="…">`・`<meta charset>`・`<title>`)
 * 2. 書き出した時点の親の配色(`--pkc-*` を `:root` に焼く ── 親が居なくても同じ見た目で読める)
 * 3. `window.pkcWidget`(`id` / `getTheme` / `onTheme` / `storage` / `readNoteContext` ほか)── 親が居ないので
 *    ノートの参照は**待たずに空**で答える(`widget-bridge.ts` の prelude が `window.parent === window` を見る)
 * 4. `id=` の在るウィジェットは、書き出した時点の保存(`seed`)── 1 行目の同期 `localStorage.getItem` が続きの値を返す。
 *    ブラウザの保存が使えれば**最初に開いたときだけ** `seed` を入れ、以後の変更はそこに残る
 *    (鍵は `pkc3-widget-export.<id>.` の下に分ける ── `file://` では全ファイルが同じ保存を共有するため)。
 *    使えない環境(投げる・opaque origin)ではその場限りの保存に落ちる(止まらない)。
 *
 * ## 🔴 安全の既定
 *
 * - HTML のウィジェットは、画面の箱と**同じ文書の組み方**(`buildHtmlSandboxDoc`)を通す ── CSP
 *   (`connect-src 'none'`・外部の script 不可・外部画像は書き出した人の設定のまま)も同じ。外へ出る口を足さない。
 *   ⚠ 例外は添付 HTML ウィジェットに user が許した権限(#2090 ②)だけ ── 画面の箱と同じ CSP をそのまま引き継ぐ。
 * - `<script>` に埋める値は必ず `inlineJson`(`</script>` / `<!--` で文書を切らせない)。
 */
import { safeName } from '@features/export/file-name';
import { inlineJson, storageShimInvocation } from '@features/launcher/app-storage-shim';
import { buildHtmlSandboxDoc } from './html-sandbox';
import { DEFAULT_WIDGET_PERMISSIONS, type WidgetPermissionSet } from './widget-permissions';
import {
  safeTokenValue,
  WIDGET_ID_RE,
  WIDGET_STORAGE_LIMIT,
  WIDGET_STORAGE_MESSAGE,
  WIDGET_THEME_MSG_TYPE,
  WIDGET_THEME_TOKENS,
  widgetThemePreludeScript,
  type WidgetTheme,
} from './widget-bridge';

/** 単体の HTML の中の箱の名乗り(親が居ないので照合されない。固定でよい)。 */
export const STANDALONE_WIDGET_FRAME_ID = 'pkc-widget-standalone';

/** 単体の HTML がブラウザの保存に使う前置き(`file://` の共有の保存の中で、他のファイルと混ぜない)。 */
export const STANDALONE_STORAGE_ROOT = 'pkc3-widget-export.';

export interface StandaloneWidgetHeadOptions {
  /** `id=` の在るときだけ(状態を持つ)。 */
  readonly widgetId: string | null;
  /** 書き出した時点の保存(`id=` の在るときだけ使う)。 */
  readonly seed: Readonly<Record<string, string>>;
  /** 書き出した時点の親の配色。 */
  readonly theme: WidgetTheme;
}

export interface StandaloneWidgetOptions extends StandaloneWidgetHeadOptions {
  /** ウィジェットの HTML(添付の中身 / 本文に書いた HTML。断片でも完全な文書でもよい)。 */
  readonly content: string;
  /** `<title>` の字。 */
  readonly title: string;
  /** 外部の画像を読み込ませるか(書き出した面の設定のまま。⚠ 既定は塞ぐ側)。 */
  readonly allowExternalImages?: boolean;
  /**
   * 添付 HTML ウィジェットに許している追加権限(#2090 ②)── 保存した 1 枚にもそのまま引き継ぐ。
   * ⚠ 既定は全部オフ(厳格な CSP)。直書きの ` ```html ` の呼び手は渡さない。
   */
  readonly permissions?: WidgetPermissionSet;
}

/** 箱の中の名前(`--pkc-*`)として渡してよい物だけを、値を確かめて残す(呼び手の値を信じない)。 */
function cleanTheme(theme: WidgetTheme): WidgetTheme {
  const allowed = new Set(WIDGET_THEME_TOKENS.map(([n]) => n));
  const tokens: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme.tokens)) {
    if (!allowed.has(k) || typeof v !== 'string') continue;
    const ok = safeTokenValue(v);
    if (ok !== null) tokens[k] = ok;
  }
  return { tone: theme.tone === 'dark' ? 'dark' : 'light', tokens };
}

/** 名前空間の 1 区画を符号化する(`widget-bridge.ts` の保存先と同じ規則 ── `.` も逃がす)。 */
function seg(s: string): string {
  return encodeURIComponent(s).replace(/\./g, '%2E');
}

/**
 * ブラウザの保存の続きを読むか、`seed` を入れるかを**開いたときに**決める台本(ES5)。
 * 返す値が保存の shim の初期値になる。⚠ 本物の `localStorage` を一旦隠す(shim は本物が読めると何もしない)。
 */
const STANDALONE_STORAGE_BOOT =
  '(function(seed,ns,tag){' +
  "'use strict';" +
  'var real=null;var has=Object.prototype.hasOwnProperty;var pre=ns+\'k.\';' +
  "try{real=window.localStorage;real.getItem(ns+'seeded');}catch(e){real=null;}" +
  'var init=seed;' +
  'if(real){try{' +
  "if(real.getItem(ns+'seeded')==='1'){init={};" +
  'for(var i=0;i<real.length;i++){var k=real.key(i);if(k!==null&&k.indexOf(pre)===0)init[k.slice(pre.length)]=real.getItem(k);}}' +
  'else{for(var s in seed){if(has.call(seed,s))real.setItem(pre+s,String(seed[s]));}' +
  "real.setItem(ns+'seeded','1');}" +
  '}catch(e){init=seed;}}' +
  "window.addEventListener('message',function(e){" +
  "if(e.source!==window)return;var d=e.data;if(!d||d.tag!==tag||d.op==='ack')return;" +
  'var ok=true;' +
  'if(real){try{' +
  "if(d.op==='set')real.setItem(pre+d.key,String(d.value));" +
  "else if(d.op==='remove')real.removeItem(pre+d.key);" +
  "else if(d.op==='clear'){var ks=[];for(var j=0;j<real.length;j++){var q=real.key(j);if(q!==null&&q.indexOf(pre)===0)ks.push(q);}" +
  'for(var m=0;m<ks.length;m++)real.removeItem(ks[m]);}' +
  '}catch(err){ok=false;}}' +
  "if(typeof d.seq==='number'){try{window.postMessage({tag:tag,op:'ack',seq:d.seq,ok:ok},'*');}catch(err){}}" +
  '});' +
  "try{Object.defineProperty(window,'localStorage',{value:undefined,writable:true,configurable:true});}catch(e){}" +
  'return init;' +
  '})';

/**
 * 単体の HTML の `<head>` に足す物(配色・保存・`pkcWidget`)。
 * 🔑 HTML のウィジェットと React のウィジェット(adapter が箱の文書を組む)の**両方が使う 1 本**。
 * ⚠ 置く場所は CSP の `<meta>` の後・ウィジェットの中身の前(`buildHtmlSandboxDoc` / `reactFrameDoc` の `headExtra`)。
 */
export function standaloneWidgetHead(opts: StandaloneWidgetHeadOptions): string {
  const theme = cleanTheme(opts.theme);
  const vars = Object.entries(theme.tokens)
    .map(([k, v]) => `${k}:${v};`)
    .join('');
  // 🔑 地の色は `html` に塗る(箱の既定の見た目は `body` を透かすので、親の居ない所では地が要る)
  const style =
    `<style>:root{${vars}color-scheme:${theme.tone};}` +
    'html{background:var(--pkc-bg,#fff);color:var(--pkc-fg,#222);}</style>';
  const widgetId = opts.widgetId !== null && WIDGET_ID_RE.test(opts.widgetId) ? opts.widgetId : null;
  const storage =
    widgetId === null
      ? ''
      : '<script>' +
        storageShimInvocation(
          `${STANDALONE_STORAGE_BOOT}(${inlineJson(opts.seed)},${inlineJson(`${STANDALONE_STORAGE_ROOT}${seg(widgetId)}.`)},${inlineJson(WIDGET_STORAGE_MESSAGE)})`,
          WIDGET_STORAGE_LIMIT,
          WIDGET_STORAGE_MESSAGE,
        ) +
        '</script>';
  // 🔑 `pkcWidget.getTheme()` / `onTheme` にも書き出した時点の配色を渡す(画面の箱と同じ合図を自分へ送る)
  const initialTheme =
    '<script>try{window.postMessage(' +
    `{type:${inlineJson(WIDGET_THEME_MSG_TYPE)},tone:${inlineJson(theme.tone)},tokens:${inlineJson(theme.tokens)}},'*');}catch(e){}` +
    '</script>';
  return style + storage + widgetThemePreludeScript(STANDALONE_WIDGET_FRAME_ID, widgetId) + initialTheme;
}

/** 箱の文書の組み手(`buildHtmlSandboxDoc` / `reactFrameDoc`)が必ず出す書き出し。 */
const DOC_HEAD_PREFIX = '<!DOCTYPE html><html><head><meta charset="utf-8">';

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 箱の文書を**単体の文書**の外形にする(`lang` / 配色の印 / `<title>`)。
 * ⚠ 受けるのはこのリポジトリの組み手が作った文書だけ(書き出しの形が決まっている)── 形が違えばそのまま返す。
 */
export function standaloneShell(doc: string, title: string, tone: WidgetTheme['tone']): string {
  if (!doc.startsWith(DOC_HEAD_PREFIX)) return doc;
  const t = tone === 'dark' ? 'dark' : 'light';
  const name = title.trim() === '' ? 'ウィジェット' : title.trim();
  return (
    `<!DOCTYPE html><html lang="ja" data-pkc-tone="${t}"><head><meta charset="utf-8">` +
    `<title>${escapeText(name)}</title>` +
    doc.slice(DOC_HEAD_PREFIX.length)
  );
}

/**
 * 🔴 **HTML のウィジェットを単体の 1 枚にする**。
 * 中身は画面の箱と同じ組み方(`buildHtmlSandboxDoc`)で包む ── 断片も、完全な文書(`<!DOCTYPE html>`〜)も
 * 画面と同じに読める(完全な文書は `body` の中に入り、ブラウザが `<html>` / `<head>` の重なりを畳む)。
 */
export function buildStandaloneWidgetHtml(opts: StandaloneWidgetOptions): string {
  const doc = buildHtmlSandboxDoc(
    opts.content,
    STANDALONE_WIDGET_FRAME_ID,
    opts.allowExternalImages === true,
    standaloneWidgetHead(opts),
    opts.permissions ?? DEFAULT_WIDGET_PERMISSIONS,
  );
  return standaloneShell(doc, opts.title, opts.theme.tone);
}

/** 拡張子 `.html` / `.htm` を外した名前。 */
function stripHtmlExt(name: string): string {
  return name.replace(/\.x?html?$/i, '');
}

/**
 * 🔴 **書き出すファイルの名前**。サニタイズは `safeName` の 1 本(2 本目を作らない)。
 * 優先は `id=` → 添付のファイル名 → ノートの題名 → `widget`。
 */
export function widgetExportFileName(opts: {
  readonly widgetId?: string | null;
  readonly assetName?: string | null;
  readonly noteTitle?: string | null;
}): string {
  const candidates = [opts.widgetId, opts.assetName ? stripHtmlExt(opts.assetName) : null, opts.noteTitle];
  const base = candidates.find((c): c is string => typeof c === 'string' && c.trim() !== '') ?? 'widget';
  return `${safeName(base)}.html`;
}

/**
 * 添付のファイル名から `id=` に書ける名前を作る(`WIDGET_ID_RE` に合う形)。
 * ⚠ 英数字の残らない名前(日本語だけ等)は `widget` に落とす。
 */
export function widgetIdFromFileName(name: string): string {
  const slug = stripHtmlExt(name)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64)
    .replace(/[-_]+$/, '');
  return WIDGET_ID_RE.test(slug) ? slug : 'widget';
}

/**
 * 🔴 **添付の HTML をウィジェットとして本文に置く記法**(添付の画面の「ウィジェット記法をコピー」。#2090)。
 * 中身は空の囲み ── 中身は添付から読む(`fence-asset.ts`)。
 */
export function widgetFenceForAsset(assetKey: string, fileName: string): string {
  return `\`\`\`html asset:${assetKey} id="${widgetIdFromFileName(fileName)}"\n\`\`\``;
}
