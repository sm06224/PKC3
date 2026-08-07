/**
 * P6d 段③: 可搬 HTML(`.html`)── **1 ファイルで配れて、その場で読める**。
 *
 * ⚠ **可逆ではない**(バックアップはアーカイブ ZIP)。これは「渡す・見せる」ための形。
 *
 * ## 🔑 base64 も流し込める(丸ごと文字列にしない)
 * 「単一 HTML は全部 base64 にするから必ず全量メモリに載る」は**誤り**。
 * base64 は 3 バイト → 4 文字の変換で**状態を持たない**ので、入力を **3 の倍数**で
 * 区切れば、チャンクごとに符号化して連結した結果が全体符号化と一致する。
 *
 * 実測で確認済み(2026-08-02、ランダム 200 本 × 最大 5000 バイト):
 * **3 の倍数 = 200/200 一致 / 3 の倍数でない対照 = 200/200 不一致**
 * (対照を置いたのは「一致した」だけでは*分割していないのと区別がつかない*から)。
 *
 * 🔴 ただし**チャンクにするだけでは足りない**(review H2 で実測):符号化した
 * 文字列を配列に積むと、`new Blob(parts)` まで全部が heap に常駐する
 * (16MB の添付で **21.34MB 常駐**)。チャンク化が抑えるのは*変換時のピーク*だけ。
 * **1 チャンクごとに即 `Blob` 化して文字列を手放す** ── 同じ計測で 0.00MB。
 * `AsyncGenerator` にしてあるのはそのため(配列に貯めた時点で負ける)。
 *
 * ## 🔴 `<` の退避 ── `</script` だけでは足りない
 * script data のトークナイザは `<!--` で **escaped** 状態に入り、続く `<script` で
 * **double escaped** 状態に入る。この状態では `</script>` が終了タグとして扱われず、
 * **data script が閉じない = ページが丸ごと真っ白**になる(エラーもコンソールも出ない)。
 * 本文に「HTML のコメントは `<!--` で始まる」「`<script>` を書くと…」と書くだけで
 * 起きる。しかも 1 個の script に全 entry を詰めているので、**無関係な 2 つのノートが
 * 合成して**全体を壊す(題名だけでも起きる。review H1 で実 Chromium 実測)。
 *
 * → `<` を**すべて** `<` へ退避する。JSON の文字列としては同値なので、
 * 読み手は素の `JSON.parse` でよい。
 */
import BODY_CSS from 'virtual:pkc-body-css';
import { parseFrontmatter, type FrontmatterValue } from '../markdown/frontmatter';
import { renderMarkdown, type RenderMarkdownOptions } from '../markdown/markdown-render';
import { extractVars } from '../markdown/frontmatter';
import {
  extractDocumentGlobals,
  extractHeadingNumberConfig,
  globalsToDataAttrs,
} from '../markdown/document-globals';
import { scanAssetRefsInto } from '@features/asset/asset-ref-scan';
import type { ArchiveSource } from './pkc3-archive';

export const HTML_FORMAT = 'pkc3-portable';
export const HTML_VERSION = 1;
/** base64 の 1 チャンク(**3 の倍数**でなければならない ── 冒頭の解説参照)。 */
const B64_CHUNK = 3 * 64 * 1024;
/** 1 バッチで取る本文の目安。 */
const BODY_BATCH_BYTES = 4 * 1024 * 1024;


export interface HtmlResult {
  blob: Blob;
  warnings: string[];
  counts: { entries: number; assets: number };
}

/**
 * script data に埋め込める JSON にする。⚠ **JSON にしたあと**に掛ける。
 *
 * `</script` だけでなく `<` を全部退避するのは、`<!--` → `<script` の並びで
 * トークナイザが double escaped 状態へ入るため(冒頭の解説)。
 */
export function escapeForScriptData(json: string): string {
  return json.replace(/</g, '\\u003c');
}

const j = (v: unknown): string => escapeForScriptData(JSON.stringify(v));

const str = (v: FrontmatterValue | undefined): string => (typeof v === 'string' ? v : '');

/**
 * 本文が **markdown の外**で参照している添付(key と表示名)を集める。
 *
 * 🔴 添付 entry の body は **frontmatter だけ**(`attachment.asset_key: …`)で、
 * `asset:` 参照を**一切含まない**。本文を `asset:` で走査するだけの閲覧側は
 * 「添付が 1 個も無いノート」に見える ── 実際 smoke で踏んだ。
 * ⚠ 解決は**書き出し側**でやる:閲覧側(依存ゼロのインライン JS)に
 * frontmatter parser を持たせると、本物の parser と二重実装になって必ずずれる。
 *
 * ⚠ **判定を自前で持たない**(review M2)。`body.startsWith('---\n')` のような
 * 手軽なガードを置くと、本物より狭い**3 つめのルール**になる ── 開始 fence の
 * 末尾空白や CRLF を落とし、「アプリでは見えている添付が書出しでは消える」。
 * `parseFrontmatter` は fence 無しなら正規表現 1 発で返るので、ガードは何も買わない。
 *
 * `*asset_key` で終わる key を総なめするので、`attachment.app_icon_asset_key`
 * のような将来 field も archetype を知らずに拾える。表示名は同じ prefix の
 * `…name`(`attachment.asset_key` → `attachment.name`)を引く。
 */
function frontmatterAssets(body: string): {
  /** frontmatter の文字数(閲覧側はここまで読み飛ばす)。 */
  skip: number;
  refs: Array<{ key: string; name: string }>;
} {
  const r = parseFrontmatter(body);
  const skip = body.length - r.body.length; // parseFrontmatter の残骸は常に suffix
  const refs: Array<{ key: string; name: string }> = [];
  for (const [k, v] of Object.entries(r.meta)) {
    if (!k.endsWith('asset_key')) continue;
    const key = str(v);
    if (key === '' || refs.some((x) => x.key === key)) continue;
    refs.push({ key, name: str(r.meta[`${k.slice(0, -'asset_key'.length)}name`]) });
  }
  return { skip, refs };
}

/** Blob を **3 バイト境界**で base64 にして 1 チャンクずつ渡す(配列に貯めない)。 */
async function* base64Chunks(blob: Blob): AsyncGenerator<string> {
  for (let off = 0; off < blob.size; off += B64_CHUNK) {
    const slice = blob.slice(off, Math.min(off + B64_CHUNK, blob.size));
    const bytes = new Uint8Array(await slice.arrayBuffer());
    let bin = '';
    // ⚠ `String.fromCharCode(...bytes)` は引数が多すぎて落ちる ── 小分けにする
    for (let i = 0; i < bytes.length; i += 8192) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    yield btoa(bin);
  }
}

/** 閲覧 UI(依存ゼロ・インライン)。**読めるだけ**に留める(P7 の Pages product が本番)。 */
const VIEWER = `
<style>
:root{color-scheme:light dark}
body{margin:0;font:15px/1.7 system-ui,sans-serif;display:grid;grid-template-columns:280px 1fr;height:100vh}
nav{overflow:auto;border-right:1px solid #8884;padding:8px}
nav h1{font-size:13px;opacity:.7;margin:4px 8px}
nav button{display:block;width:100%;text-align:left;padding:6px 8px;border:0;background:0;
  font:inherit;color:inherit;cursor:pointer;border-radius:6px}
nav button:hover{background:#8882}
nav button[aria-current=true]{background:#8883;font-weight:600}
main{overflow:auto;padding:24px 32px}
main h2{margin:0 0 16px}
img{max-width:100%;height:auto;display:block;margin:8px 0}
/* ── 折りたたみ(F-1)。details の既定マーカーだけで畳める ── JS を足さない */
nav details{margin:6px 0}
nav summary{cursor:pointer;font-size:12px;opacity:.7;padding:3px 8px;border-radius:6px;
  list-style-position:inside}
nav summary:hover{background:#8882}
nav ol{list-style:none;margin:0;padding:0}
nav ol button{font-size:.94em;opacity:.88;padding:3px 8px}
/* 見出しの深さぶんだけ下げる(番号は付けない ── 原文の見出しに番号があると二重になる) */
nav ol li[data-l="2"] button{padding-left:22px}
nav ol li[data-l="3"] button{padding-left:36px}
nav p.e{font-size:12px;opacity:.6;margin:2px 10px}
/* 印刷の 2 つは**ノートの行に見せない**(同じ見た目だと一覧の 1 件と読み違える) */
nav button.p{width:auto;font-size:12px;padding:4px 10px;margin:2px 8px 0;
  border:1px solid #8885;border-radius:6px}
/* 印刷用の目次と「全体」の入れ物は**画面には出さない**(@media print で出す) */
#ptoc,#all{display:none}
/* 描いた本文(P8 段⑲)。⚠ **配色トークンは持ち込まない** ── ここは
   単体で開くファイルで、地の色は閲覧環境の light/dark に従う。
   #8884 のような半透明の無彩色なら、どちらでも読める */
.b{max-width:46em}
.b>*:first-child{margin-top:0}
.b h1,.b h2,.b h3,.b h4{line-height:1.3;margin:1.4em 0 .5em}
.b h1{font-size:1.5em}.b h2{font-size:1.3em}.b h3{font-size:1.1em}
.b p,.b ul,.b ol,.b blockquote,.b table{margin:0 0 1em}
.b ul,.b ol{padding-left:1.5em}
.b li{margin:.2em 0}
.b code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;
  background:#8882;border-radius:3px;padding:0 3px}
.b pre{white-space:pre-wrap;word-break:break-word;margin:0 0 1em;padding:10px 12px;
  background:#8881;border:1px solid #8883;border-radius:6px;overflow-x:auto}
.b pre code{background:0;padding:0}
.b blockquote{padding-left:1em;border-left:3px solid #8884;opacity:.85}
.b table{border-collapse:collapse}
/* ⚠ セルは start(left ではない)── 文書が rtl なら右が行頭。アプリ側
   (src/styles/app.css の .pkc-md-rendered td,th)と同じにする */
.b th,.b td{border:1px solid #8884;padding:4px 8px;text-align:start}
.b th{background:#8881}
.b hr{border:0;border-top:1px solid #8884;margin:1.5em 0}
.b a{color:inherit}
/* 🔴 **寄せの規則をここにも置く**(2026-08-06)。⚠ 直す前は align の規則が
   **1 行も無かった** ── 中央寄せ(|| 行頭)を書いた段落が、アプリでは中央なのに
   **配った HTML では左のまま**だった(属性は載っているのに消費されていない)。
   アプリ側は src/styles/app.css の同名の節。**片方だけ直さない**。
   ⚠ この template literal の中に**バッククォートを書かない**(build が壊れる ──
   この file で 4 度踏んだ)。
   規約: PKC2 docs/development/notation-redesign-2026-05/02-frontmatter-and-globals.md */
.b [data-pkc-align=center]{text-align:center}
.b [data-pkc-align=end]{text-align:end}
.b [data-pkc-align=start]{text-align:start}
/* physical(formal 専用)は反転させない ── 物理強制なので logical と混ぜない */
.b [data-pkc-align=right]{text-align:right}
.b [data-pkc-align=left]{text-align:left}
.b [data-pkc-align=justify]{text-align:justify}
.b p[data-pkc-indent="1"]{text-indent:1em}
/* 文書 globals(frontmatter の writing / direction / align)。
   🔴 縦書きは direction を ltr に固定する(規約 §2.3.5「縦書き右起こしは text 内
   direction は ltr」)── vertical-rl の inline 軸は垂直なので、rtl を残すと
   本文が**下から上へ**流れる。右起こし / 左起こしの区別は dir 属性が持つ。
   ⚠ |> は logical end のまま(align では入れ替えない)── 規約が 2 通りに書いている
   ので裁定待ち。理由は app.css の同名の節に書いた。 */
.b[data-pkc-writing=vertical]{writing-mode:vertical-rl;direction:ltr}
.b[data-pkc-writing=vertical][dir=ltr]{writing-mode:vertical-lr}
.b[data-pkc-doc-align=left]{text-align:left}
.b[data-pkc-doc-align=right]{text-align:right}
.b[data-pkc-doc-align=center]{text-align:center}
/* 縦書き × top / bottom は inline 軸の両端なので text-align で効く */
.b[data-pkc-writing=vertical][data-pkc-doc-align=top]{text-align:start}
.b[data-pkc-writing=vertical][data-pkc-doc-align=bottom]{text-align:end}
.b[data-pkc-writing=vertical] [data-pkc-align=top]{text-align:start}
.b[data-pkc-writing=vertical] [data-pkc-align=bottom]{text-align:end}
/* 図表キャプションも文書既定の寄せに従わせない(アプリ側 app.css と同じ) */
.b .pkc-fig-figure > figcaption,.b .pkc-fig-table > figcaption{text-align:start}
.b .pkc-fig-equation{text-align:center}
/* 🔴 **fence の「描画 / 原文」切替**(F-1 で紙にも波及して判明)。
   描画は .pkc-render-slot、原文は .pkc-render-source で、どちらを見せるかは
   CSS-only トグル(.pkc-render-toggle-input)が決める ── **規則が無いと両方出る**。
   閲覧用 HTML は .b 前置きの独自 CSS しか持っていなかったので、
   表の下に原文が丸ごと出て、押しても効かないチェックボックスが並んでいた。
   ⚠ 紙ではもっと悪い ── F-1 の「全体を印刷」が**表と原文を二重に刷る**。
   ⚠ アプリ側(app.css:944-1023)と**同じ向き**にする ── checked = 原文面。
      逆にすると、同じファイルなのにアプリと閲覧側で見えるものが食い違う */
.b .pkc-md-block{position:relative}
.b .pkc-render-source{margin:0}
/* ⚠ display:none にしない ── キーボードで到達できなくなる */
.b .pkc-render-toggle-input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.b .pkc-render-toggle{position:absolute;top:2px;right:2px;z-index:1;padding:0 6px;
  border:1px solid #8884;border-radius:6px;background:#8881;color:inherit;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;
  line-height:18px;cursor:pointer;opacity:0}
.b .pkc-md-block:hover .pkc-render-toggle,
.b .pkc-md-block:focus-within .pkc-render-toggle{opacity:1}
.b .pkc-render-toggle-input:focus-visible + .pkc-render-toggle{opacity:1;outline:2px solid #888}
.b .pkc-render-toggle-input:not(:checked) ~ .pkc-render-source,
.b .pkc-render-toggle-input:checked ~ .pkc-render-slot{display:none}
/* 切替そのものが無い形(-render)は原文を常に隠す */
.b [data-pkc-render-mode='render'] > .pkc-render-source{display:none}
/* 図は原文のまま(閲覧側に mermaid を積まない)*/
.b pre.d{font-size:.9em;opacity:.85}
.b [data-pkc-asset-missing]{opacity:.75;outline:1px dashed #8886}
/* 読み込んでいない外部画像(2026-08-06)。⚠ 画面側 app.css の
   .pkc-external-img:not([src]) の対面 ── 片面だけだと寸法 0 で「消えた」に見える。
   ⚠ 下の hydrate が src を入れると、この見た目は自動で外れる */
.b .pkc-external-img:not([src]){display:inline-block;min-width:8rem;min-height:3rem;
  max-width:100%;border:1px dashed #8886;border-radius:6px;vertical-align:middle}
/* 一覧の行(表)は溢れさせない */
.b>*{max-width:100%}
a.f{display:inline-block;margin:8px 0;padding:6px 10px;border:1px solid #8884;border-radius:6px;
  color:inherit;text-decoration:none}
#fail{display:block;margin:24px;font:15px/1.7 system-ui,sans-serif;white-space:pre-wrap}

/* ── 印刷(F-1)。⚠ 画面用の grid と 100vh をほどくのが本題 ── ほどかないと
   1 ページ目だけ出て残りが切れる(main が overflow:auto のスクロール箱なので) */
@media print{
  body{display:block;height:auto;overflow:visible;font-size:10.5pt;line-height:1.6}
  nav{display:none}
  main{overflow:visible;padding:0}
  main h2{font-size:1.5em}
  .b{max-width:none}
  /* 折りたたみは**紙では展開する**(印刷時に details を開くのは JS 側) */
  #ptoc{display:block;margin:0 0 1.5em;padding:0 0 1em;border-bottom:1px solid #8884}
  #ptoc h3{font-size:1.05em;margin:0 0 .4em}
  /* ⚠ 紙の目次は 2 か所に出る(1 件の先頭 = #ptoc / 全体の先頭 = ol.x)──
     体裁は**両方に当てる**。片方だけだと、全体印刷の目次が
     既定の連番つき青リンクのまま出る(実機で踏んだ) */
  #ptoc ol,ol.x{list-style:none;margin:0;padding:0}
  #ptoc li[data-l="2"],ol.x li[data-l="2"]{padding-left:1.2em}
  #ptoc li[data-l="3"],ol.x li[data-l="3"]{padding-left:2.4em}
  ol.x li[data-l="4"]{padding-left:3.6em}
  #ptoc li.n,ol.x li.n{margin-top:.5em;font-weight:600}
  #ptoc a,ol.x a{color:inherit;text-decoration:none}
  /* 🔴 **+++ は改頁である**(2026-08-07。出典: PKC2 catalog #14 section break /
     page break)。直す前は**配る HTML でも改頁が起きていなかった**(break-after が
     auto)。しかも hr.pkc-section-break と素の hr は**見た目まで同じ**だった ──
     ここに .pkc-section-break の規則が 1 行も無かったので。
     ⚠ 出し分けは DOM でもう成立している(kind=rule は class 無しの hr)。
     ⚠ display:none にしてはいけない ── 箱が消えると改頁も消えるのに、計算後の
       break-after は page のまま残る(緑のまま壊れる。画面側 app.css の同名の節と同じ)。
     ⚠ #all(全体印刷)の中の本文も .b 配下なのでここで一緒に効く */
  .b .pkc-section-break{break-after:page;border:0;margin:0}
  /* 見出しが行末で独りにならない・切ってはいけない箱を切らない */
  .b h1,.b h2,.b h3,.b h4,main h2{break-after:avoid-page}
  .b pre,.b table,.b blockquote,.b img{break-inside:avoid}
  .b a{color:inherit;text-decoration:none}
  /* 紙に操作子は要らない(切替の見た目だけ消す ── どちらの面を見せるかは
     画面での選択をそのまま持ち込む) */
  .b .pkc-render-toggle{display:none}
  /* 「全体を印刷」── main を隠して #all を出す */
  body[data-print="all"] main{display:none}
  body[data-print="all"] #all{display:block}
  #all section{break-before:page}
  #all section:first-child{break-before:auto}
  #all section h2{font-size:1.5em;margin:0 0 .6em}
}
/* ── 🔴 **本文の見た目の正本は app.css**(2026-08-07)。ここから下は
   src/styles/app.css の .pkc-md-rendered 前置きの規則を build 時に抜いて焼いたもの
   (build/body-css.ts + build/body-css-plugin.ts)。器は class .b、本文の規則は
   class .pkc-md-rendered ── **両方**を本文の箱に付けてある。

   ⚠ **上の .b 前置きより後に置く**。詳細度は同じ(0,1,1)なので後に来た側が勝つ =
     app.css が正本になる。順を入れ替えると .b の古い値が勝ち、この節が無意味になる。
   ⚠ 直す前、書き出した HTML には .pkc-* の規則が **10 個**しか無かった(app.css は 71 個)。
     実ブラウザの 21 の観測点のうち **17 が違って**いた ── :::note / :::danger は枠も地も
     無く本文の段落と見分けが付かず、タスク行は丸ポチとチェック欄が二重に出て、
     圏点が付かず、_3(空行 3 つ)の高さが 0 だった。
   ⚠ **トークンも一緒に焼く**(先頭の :root 群)── 規則だけ写すと var() が
     computed-value time で無効になり、**先行する規則へ fall back しない**ので
     「いま効いているものまで消える」= 何もしないより悪くなる(実測)。
   ⚠ **値を静的に解決しない** ── light で潰すと暗い環境で白箱に白文字になる。 */
${BODY_CSS}
</style>
<nav>
  <h1 id="t"></h1>
  <button id="print" class="p" type="button" hidden>この文書を印刷</button>
  <button id="printall" class="p" type="button" hidden>全体を印刷</button>
  <details id="dnotes" open><summary>ノート</summary><div id="list"></div></details>
  <details id="dtoc" open><summary>この文書の目次</summary><ol id="toc"></ol><p class="e" id="tocempty" hidden>見出しがありません</p></details>
</nav>
<main><div id="ptoc"></div><h2 id="title"></h2><div id="body" class="b pkc-md-rendered"></div></main>
<div id="all"></div>
<noscript><p id="fail">このファイルは JavaScript で中身を表示します。有効にして開き直してください。</p></noscript>
<script>
(function(){
// 🔴 黙って真っ白にしない ── 途中で切れたファイル / 壊れた JSON でも理由を出す
function fail(msg){
  var p=document.createElement('p');p.id='fail';
  p.textContent='このファイルを表示できませんでした: '+msg+
    '\\nダウンロードが途中で終わっている可能性があります。';
  document.body.textContent='';document.body.appendChild(p);
}
try{
  var el=document.getElementById('pkc-data');
  if(!el)throw new Error('データが見つかりません');
  var d=JSON.parse(el.textContent);
  document.title=d.title||'PKC3';
  document.getElementById('t').textContent=(d.title||'PKC3')+' ('+d.entries.length+' 件)';
  var mimes={},names={};
  d.assets.forEach(function(a){
    mimes[a.key]=a.mime||'application/octet-stream';
    if(a.name)names[a.key]=a.name;
  });
  var has=function(k){return Object.prototype.hasOwnProperty.call(d.assetData,k)};
  // ⚠ **開いた添付だけ**復号する(起動時に全部やると、本文 1 行を読みたいだけでも
  // メインスレッドが止まる)。作った object URL は表示を離れた時点で捨てる
  var live=[];
  function release(){for(var i=0;i<live.length;i++)URL.revokeObjectURL(live[i]);live=[]}
  // ⚠ **寿命の持ち主を引数で受ける**(F-1)。画面表示と「全体を印刷」は寿命が別
  //    ── 画面は次のノートを開いた時点、紙は印刷が終わった時点で捨てる。
  //    1 本の配列に混ぜると、印刷後の revoke が画面の画像を壊す(逆も同じ)
  function urlFor(key,sink){
    var b=atob(d.assetData[key]),u=new Uint8Array(b.length);
    for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);
    var url=URL.createObjectURL(new Blob([u],{type:mimes[key]||'application/octet-stream'}));
    sink.push(url);return url;
  }
  // 添付は画像なら見せる、それ以外は保存できる導線にする(開けないより落とせる方がよい)
  function view(key,alt,sink){
    var name=names[key]||alt||key;
    if((mimes[key]||'').indexOf('image/')===0){
      var im=document.createElement('img');im.src=urlFor(key,sink);im.alt=name;return im;
    }
    var a=document.createElement('a');a.className='f';a.href=urlFor(key,sink);
    a.download=name;a.textContent='⬇ '+name;return a;
  }
  // 🔑 **本文を DOM に据える処理は 1 本に寄せる**(F-1)。画面表示と「全体を印刷」で
  // 同じ関数を使う ── 2 か所に書くと、添付の差し込みや欠落の見せ方がずれる
  // (CLAUDE.md「同じ判定が 2 か所に生えたら規則を 1 つに寄せる」)。
  // @param sink 作った object URL を積む配列(寿命の管理は呼び手が持つ)
  // @param idp  見出し id の接頭辞(全体印刷では entry ごとに変えて衝突を避ける)
  /* 🔴 **html fence の高さを受ける**(2026-08-06。user 報告 2-5)。
     ⚠ ここは VIEWER のテンプレート文字列の中 ── **バックティックを書けない**
     (書いた瞬間にテンプレートが閉じて、意味不明な構文エラーになる。実際に踏んだ)。
     囲いの中の文書は自分の高さを親へ postMessage するが、**配る HTML には
     受ける側が居なかった** ── iframe は height:0 のまま = **完全に不可視**だった。
     ⚠ 上限は画面側と同じ 5000px(暴走する中身に画面を占領させない)。
     ⚠ 受け口は 1 回だけ張る(entry ごとに張ると listener が積む)。 */
  window.addEventListener('message',function(ev){
    var d=ev.data;
    if(!d||typeof d!=='object')return;
    if(d.type!=='pkc-html-render-resize')return;
    if(typeof d.id!=='string'||typeof d.height!=='number')return;
    /* 🔴 **宛先は「名乗った id」ではなく「実際の送り主」で決める**(2026-08-06)。
       id は中身の hash なので**文書側から計算できる** ── 直す前は箱 A が箱 B の
       id を名乗って **B の高さを 0px にできた**(= B の中身を隠せた)。
       ⚠ ev.origin は条件に足さない ── sandbox の箱では "null" になり、
       安全な箱と攻撃者の箱が同じ値になる(画面側 html-sandbox.ts の同名の節)。
       ⚠ 名乗りと実体が食い違ったら**何もしない**(別の箱へ当てない)。 */
    var fs=document.querySelectorAll('iframe[data-pkc-html-render-id]');
    var f=null;
    for(var fi=0;fi<fs.length;fi++){
      if(fs[fi].contentWindow===ev.source){
        f=fs[fi].getAttribute('data-pkc-html-render-id')===d.id?fs[fi]:null;
        break;
      }
    }
    if(!f)return;
    f.style.height=Math.max(0,Math.min(5000,d.height))+'px';
  });
  function hydrate(box,e,sink,idp){
    // 🔑 本文は**書出し側で描いた HTML**(P8 段⑲)。かつてここは本文を素のまま
    // pre で出しており、見出しも表も箇条書きも**記号のまま**だった ──
    // 「単体で開いて読める」と案内している当のファイルが一番読みにくかった。
    // ⚠ 描くのは**アプリと同じ関数**(閲覧側に parser を持たせない ── 二重実装は必ずずれる)
    var seen={};
    box.innerHTML=e.html||'';
    /* 🔴 文書属性(書字方向など)を当てる ── 画面の applyDocumentGlobals と同じ
       見え方にする(user 報告 2-7)。書出し側が attrs に載せてある。
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
        miss.textContent='asset:'+k+'(添付が入っていません)';
        if(el.parentNode)el.parentNode.replaceChild(miss,el);
        return;
      }
      seen[k]=1;
      if(el.tagName==='IMG'){el.src=urlFor(k,sink);if(!el.alt)el.alt=names[k]||k;return}
      el.href=urlFor(k,sink);el.download=names[k]||k;
    });
    // 🔴 **押しても何も起きない操作子は取り除く**(F-1)。描画はアプリと同じ関数なので、
    //    コード・表・図の見出しに付く「コピー」ボタン(data-pkc-action="copy-md-block")が
    //    そのまま焼き込まれる ── 閲覧側に binder は無いので**沈黙する飾り**であり、
    //    紙にも印字される。⚠ 消す判定は**狭く当てる**(この action 名だけ)──
    //    属性名だけで総なめにすると、将来 action を持つ本文要素まで消える
    Array.prototype.forEach.call(box.querySelectorAll('[data-pkc-action="copy-md-block"]'),function(el){
      if(el.parentNode)el.parentNode.removeChild(el);
    });
    // 図は**原文のまま**見せる(閲覧側に mermaid を積まない ── 読めれば足りる)
    Array.prototype.forEach.call(box.querySelectorAll('[data-pkc-mermaid-src]'),function(el){
      var s=el.getAttribute('data-pkc-mermaid-src')||'';
      el.textContent='';var p=document.createElement('pre');p.className='d';
      p.textContent=s;el.appendChild(p);
    });
    // 本文の外(frontmatter)から参照している添付 ── 添付 entry はこちらだけを持つ。
    // ⚠ 本文に書かれていて**描画に現れなかった**参照(裸の asset:key など)も
    //    ここで拾う ── 黙って消さない
    (e.attach||[]).concat(e.refs||[]).forEach(function(key){
      if(has(key)&&!seen[key]){seen[key]=1;box.appendChild(view(key,e.title,sink));}
    });
    // 🔴 見出し id は **entry ごとに namespace を切る**(F-1)。書出し側の描画は
    //    entry ごとに独立した slug counter を回すので、別ノートの同名見出しは
    //    **同じ id** になる。画面は 1 件ずつなので衝突しないが、全体印刷は
    //    全件を同じ document に置く ── 目次のリンクが最初の 1 件へ全部飛ぶ
    return headings(box,idp);
  }

  /**
   * 見出しを拾って [{el,text,level}] を返す。id が無いものには振る。
   * ⚠ h1〜h3 だけ(書出し側の描画が id を振るのも h1〜h3。h4 以降を混ぜると
   *    「目次にあるのに飛べない」行が出る)。
   */
  function headings(box,idp){
    var out=[];
    Array.prototype.forEach.call(box.querySelectorAll('h1,h2,h3'),function(h,i){
      var text=(h.textContent||'').trim();
      if(!text)return;
      // 全体印刷では必ず振り直す(書出し側の id が entry 間で衝突している)
      if(idp||!h.id)h.id=(idp||'h')+'-'+i;
      out.push({el:h,text:text,level:+h.tagName.slice(1)});
    });
    return out;
  }

  var list=document.getElementById('list'),cur=null;
  var toc=document.getElementById('toc'),tocEmpty=document.getElementById('tocempty');
  var ptoc=document.getElementById('ptoc'),all=document.getElementById('all');

  /**
   * 目次を作る。link が真なら a[href="#id"](紙・PDF 向け)、偽なら button。
   * off は深さの下駄 ── 全体印刷の目次は「ノート名」が 1 段目なので、
   * その中の見出しは 1 段下げる(下げないと h1 がノート名と同じ段に並ぶ)。
   */
  function fillToc(ol,hs,link,off){
    hs.forEach(function(h){
      var li=document.createElement('li');
      li.setAttribute('data-l',String(h.level+(off||0)));
      var a;
      if(link){a=document.createElement('a');a.href='#'+h.el.id}
      else{
        a=document.createElement('button');a.type='button';
        a.onclick=function(){h.el.scrollIntoView()};
      }
      a.textContent=h.text;
      li.appendChild(a);ol.appendChild(li);
    });
  }

  function show(e,btn){
    release();
    dropAll();  // 紙用に組んだ全件は、読みに戻った時点で捨てる(ObjectURL も)
    document.getElementById('title').textContent=e.title;
    var box=document.getElementById('body');box.textContent='';
    var hs=hydrate(box,e,live,'');
    // 画面の目次(折りたたみ)と、紙の目次(常に展開)── 同じ見出し列から作る
    toc.textContent='';fillToc(toc,hs,false);
    tocEmpty.hidden=hs.length>0;
    ptoc.textContent='';
    if(hs.length>0){
      var h3=document.createElement('h3');h3.textContent='目次';ptoc.appendChild(h3);
      var ol=document.createElement('ol');fillToc(ol,hs,true);ptoc.appendChild(ol);
    }
    if(cur)cur.setAttribute('aria-current','false');
    cur=btn;btn.setAttribute('aria-current','true');
  }

  // ── 全体を印刷(F-1)。全件を 1 つの document に組んで印刷し、**終わったら捨てる**
  var plive=[];
  function dropAll(){
    for(var i=0;i<plive.length;i++)URL.revokeObjectURL(plive[i]);
    plive=[];all.textContent='';document.body.removeAttribute('data-print');
  }
  function buildAll(){
    dropAll();
    var index=document.createElement('section');
    var h=document.createElement('h2');h.textContent=(d.title||'PKC3')+' 目次';
    index.appendChild(h);
    var ol=document.createElement('ol');ol.className='x';index.appendChild(ol);
    all.appendChild(index);
    d.entries.forEach(function(e,i){
      var sec=document.createElement('section');
      var t=document.createElement('h2');t.id='pe-'+i;t.textContent=e.title||'(無題)';
      sec.appendChild(t);
      // ⚠ 本文の CSS は **class .b** に付けてある ── 同じ id を 2 個作らないため。
      // 🔴 **pkc-md-rendered も要る**(2026-08-07)── app.css から焼いた本文の規則は
      //    そちらに付いている。**器は 2 か所ある**(#body と、ここ「全体を印刷」)ので
      //    片方だけに足すと、全体印刷の紙だけ素の見た目で出る(誰も見ていない経路)
      var box=document.createElement('div');box.className='b pkc-md-rendered';
      var hs=hydrate(box,e,plive,'pe'+i);
      sec.appendChild(box);all.appendChild(sec);
      // 目次: ノート名 + その見出し
      var li=document.createElement('li');li.className='n';li.setAttribute('data-l','1');
      var a=document.createElement('a');a.href='#pe-'+i;a.textContent=e.title||'(無題)';
      li.appendChild(a);ol.appendChild(li);
      fillToc(ol,hs,true,1);
    });
    document.body.setAttribute('data-print','all');
    return all.querySelectorAll('section').length;
  }

  // ⚠ **紙では折りたたみを展開する**。CSS では details をこじ開けられないので
  //    印刷の直前に open を立て、終わったら**元に戻す**(畳んでいた人の状態を壊さない)
  var reclose=[];
  function onBefore(){
    reclose=[];
    Array.prototype.forEach.call(document.querySelectorAll('details'),function(x){
      if(!x.open){x.open=true;reclose.push(x)}
    });
  }
  function onAfter(){
    for(var i=0;i<reclose.length;i++)reclose[i].open=false;
    reclose=[];dropAll();
  }
  if(window.addEventListener){
    window.addEventListener('beforeprint',onBefore);
    window.addEventListener('afterprint',onAfter);
  }
  function doPrint(){if(typeof window.print==='function')window.print()}

  /**
   * 🔴 **画像が載るまで印刷を待つ**。組んだ直後に print() を呼ぶと、
   * 画像の読み込みが終わる前に印刷が完了し、afterprint の revoke が
   * **読み込み中の blob URL を消す** ── 紙から画像が落ちる
   * (headless_shell で Not allowed to load local resource: blob:null/… として実測)。
   * ⚠ 上限を置く ── 画像が返らないときに**永久に印刷できない**ほうが困る。
   */
  function whenImagesReady(root,done){
    var imgs=root.querySelectorAll('img'),left=0,fired=false;
    function fin(){if(!fired&&left===0){fired=true;done()}}
    function dec(){left--;fin()}
    for(var i=0;i<imgs.length;i++){
      if(imgs[i].complete)continue;
      left++;
      imgs[i].addEventListener('load',dec);
      imgs[i].addEventListener('error',dec);
    }
    setTimeout(function(){if(!fired){fired=true;done()}},5000);
    fin();
  }

  var pb=document.getElementById('print'),pa=document.getElementById('printall');
  pb.hidden=false;pb.onclick=function(){dropAll();doPrint()};
  pa.hidden=false;
  pa.textContent='全体を印刷('+d.entries.length+' 件)';
  pa.onclick=function(){buildAll();whenImagesReady(all,doPrint)};

  d.entries.forEach(function(e,i){
    var b=document.createElement('button');
    b.textContent=e.title||'(無題)';
    b.onclick=function(){show(e,b)};
    list.appendChild(b);
    if(i===0)setTimeout(function(){show(e,b)},0);
  });
}catch(err){fail(err&&err.message?err.message:String(err))}
})();
</script>`;

/**
 * 可搬 HTML を書く。
 * @throws entry 0 件のときは**断る**(「書き出したつもりで空」を作らない)
 */
export async function writePortableHtml(
  src: ArchiveSource,
  exportedAt: string,
  /**
   * 本文 1 件を HTML にする。
   *
   * 🔴 **差し替えられるようにしてある**(P8 段⑲)。既定はその場で描く
   * 同期版だが、アプリからは**markdown ワーカー**を渡す ── 5000 件の書出しで
   * 本文を全部その場で描くと、メインスレッドが長時間止まる
   * (user 指示 2026-08-03「基本的に重い処理はワーカーにしてください」)。
   * ⚠ 返る HTML は**同じ関数**から出る(ワーカーは速さの話であって正しさの話ではない)。
   */
  render: (
    text: string,
    opts?: RenderMarkdownOptions,
  ) => string | Promise<string> = (text, opts) => renderMarkdown(text, opts),
  /**
   * 🔴 **書き出す HTML に外部画像を焼くか**(2026-08-06、user 裁定)。
   *
   * 規則は 1 つ ── **設定が「常にオン」のときだけ焼く**。
   * ⚠ ノートごとの同意(「常に確認」で押した分)は**持ち込まない**。書き出した
   *   HTML は**別の人が開く文書**であり、開いた人は追跡に同意していない。
   *   焼かなければ URL は `data-pkc-external-src` に残るので情報は失われない。
   * ⚠ 閲覧側の script は**自分で `src` を入れない** ── 入れたら、この判断が
   *   閲覧の瞬間に無かったことになる(見た目だけ `.pkc-external-img:not([src])`
   *   で「読み込んでいない画像」として置く)。
   */
  allowExternalImages: boolean = false,
): Promise<HtmlResult> {
  const warnings: string[] = [];
  const metas = await src.listEntryMetas();
  // ⚠ 断るなら**変換の前に**断る(0 entry + 大量添付で全部 base64 にしてから
  // 投げると、捨てるためだけに数十秒かかる ── review L2)
  if (metas.length === 0) throw new Error('書き出せる entry が 1 件もありません');
  const metaOf = new Map(metas.map((m) => [m.lid, m]));

  const parts: Array<string | Blob> = [
    '<!doctype html><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<script id="pkc-data" type="application/json">',
    `{"format":${j(HTML_FORMAT)},"version":${HTML_VERSION},`,
    `"exported_at":${j(exportedAt)},"title":${j(src.title)},"entries":[`,
  ];

  // 🔴 **参照されている添付だけ**を載せる(review H3)。`listAssetMetas` は
  // container の全 asset を返し、削除したノートの添付も残る(GC は P4b の別機構)。
  // バックアップなら正しいが、これは**人に配るファイル** ── 消したつもりの
  // 添付が丸ごと入る。keep-set は本文走査のついでに作れるので追加コストはほぼ無い
  const used = new Set<string>();
  const nameOf = new Map<string, string>();
  // ⚠ 候補の key を**先に**取る ── 包含の判定(`scanAssetRefsInto`)は
  //    「この key が本文に現れるか」で決めるので、候補が要る
  const allAssets = await src.listAssetMetas();
  const assetKeys = allAssets.map((a) => a.key).filter((k) => k !== '');

  let entryCount = 0;
  let after: { entryOrder: number; lid: string } | undefined;
  for (;;) {
    const { rows, done, next } = await src.listBodies(after, BODY_BATCH_BYTES);
    // バッチぶんを 1 個の Blob にして手放す(文字列のまま積むと全本文が heap に残る)
    let chunk = '';
    for (const r of rows) {
      const m = metaOf.get(r.lid);
      if (!m) {
        warnings.push(`本文はあるが一覧に無い entry を飛ばしました: ${r.lid}`);
        continue;
      }
      const { skip, refs } = frontmatterAssets(r.body);
      for (const ref of refs) {
        used.add(ref.key);
        if (ref.name !== '' && !nameOf.has(ref.key)) nameOf.set(ref.key, ref.name);
      }
      // 🔴 本文が参照している添付。**判定は正本 1 本**(P8 段㉑)──
      //    `features/asset/asset-ref-scan.ts`。直す前はここに自前の狭い正規表現が
      //    あり、**unescape をしなかった**ので `asset:ast\-abc`(markdown の
      //    escape 済み宛先。画面では正しく画像が出る)を取りこぼしていた ──
      //    開くと「添付が入っていません」になる。誤差は false-keep 側だけに出す
      const inBody: string[] = [];
      {
        const remaining = new Set(assetKeys);
        scanAssetRefsInto(r.body, remaining, (k) => {
          used.add(k);
          inBody.push(k);
        });
      }
      // 🔑 本文は**ここで描く**(閲覧側に parser を積まない)。frontmatter は
      //    本文ではなくメタなので、書出し側が数えた文字数ぶん読み飛ばす
      //    ── 判定を閲覧側に持たせると本物の parser と二重実装になってずれる
      /**
       * 🔴 **詳細ペインと同じ材料を渡す**(2026-08-06。user 報告 2-7)。
       *
       * 直す前は `render(body)` だけで、**`vars` も見出し番号も渡していなかった**
       * ── 配る HTML に `{{vars.x}}` が**生のまま載り**、`heading-number: true` の
       * 文書は番号が付かなかった。⚠ どれも**全文 body**(frontmatter 込み)から
       * 取る ── 読み飛ばした本文からでは frontmatter が見えない。
       */
      const globals = extractDocumentGlobals(r.body);
      const html = await render(r.body.slice(skip), {
        vars: extractVars(r.body),
        headingNumber: extractHeadingNumberConfig(r.body),
        allowExternalImages,
      });
      /**
       * 🔴 **書字方向などの文書属性も一緒に配る**(同 2-7)。画面では
       * `applyDocumentGlobals` が DOM 属性として当てているので、配る側でも
       * 同じ属性を entry に持たせて閲覧側で当てる(面ごとに違う見え方にしない)。
       */
      const attrs = globalsToDataAttrs(globals);
      if (globals.direction) attrs['dir'] = globals.direction;
      const e = {
        lid: m.lid,
        title: m.title,
        archetype: m.archetype,
        html,
        ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
        ...(refs.length > 0 ? { attach: refs.map((x) => x.key) } : {}),
        ...(inBody.length > 0 ? { refs: inBody } : {}),
      };
      chunk += entryCount === 0 ? j(e) : `,${j(e)}`;
      entryCount++;
    }
    if (chunk !== '') parts.push(new Blob([chunk]));
    if (done || !next) break;
    // ⚠ 前進しないカーソルを返す source があると `for(;;)` は永久に回り、
    // parts が膨らんで落ちる(UI は「書き出しています…」のまま)── 必ず進む
    if (
      after !== undefined &&
      !(next.entryOrder > after.entryOrder ||
        (next.entryOrder === after.entryOrder && next.lid > after.lid))
    ) {
      throw new Error('本文の読み出しが進みません(カーソルが前進していません)');
    }
    after = next;
  }

  if (entryCount === 0) throw new Error('書き出せる entry が 1 件もありません');

  const assetMetas = allAssets.filter((a) => used.has(a.key));
  const skipped = allAssets.length - assetMetas.length;
  if (skipped > 0) {
    warnings.push(`どの本文からも参照されていない添付 ${skipped} 件は含めませんでした`);
  }
  parts.push('],"assets":[');
  assetMetas.forEach((a, i) => {
    const name = nameOf.get(a.key);
    const meta = {
      key: a.key,
      mime: a.mime ?? 'application/octet-stream',
      size: a.size ?? 0,
      ...(name ? { name } : {}),
    };
    parts.push(i === 0 ? j(meta) : `,${j(meta)}`);
  });

  // ── 添付の bytes は base64 で **チャンクごとに**流し込む
  parts.push('],"assetData":{');
  let assetCount = 0;
  for (const a of assetMetas) {
    const blob = await src.getAssetBlob(a.key);
    if (!blob) {
      warnings.push(`添付の中身が見つかりませんでした: ${a.key}`);
      continue;
    }
    parts.push(`${assetCount === 0 ? '' : ','}${j(a.key)}:"`);
    // ⚠ base64 は `"` `\` `<` を含まないので、ここは退避不要(英数 + `+/=` のみ)。
    // ⚠ **1 チャンクずつ Blob にする** ── 文字列で積むと全添付が heap に常駐する
    for await (const p of base64Chunks(blob)) parts.push(new Blob([p]));
    parts.push('"');
    assetCount++;
  }
  parts.push('}}');
  parts.push('</script>', VIEWER);

  return {
    blob: new Blob(parts, { type: 'text/html;charset=utf-8' }),
    warnings,
    counts: { entries: entryCount, assets: assetCount },
  };
}
