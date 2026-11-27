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
import { renderMarkdown, type RenderMarkdownOptions } from '../markdown/markdown-render';
import type { FigureBakers } from './figure-bake';
import type { SqlEmbedAnswer } from '../markdown/sql-embed';
import { createWarnCollector } from './warn-cap';
import { PHONE_MAX_PX } from '../phone-layout';
import { assetPreviewKind } from '@features/asset/asset-preview-kind';
import {
  DEFAULT_PAGE_FORMAT,
  pageFormatCss,
  type PageFormat,
} from '../page-format';
import { DEFAULT_PROSE_ALIGN, proseAlignCss, type ProseAlign } from '../prose-align';
import { DEFAULT_FONT, fontSpec, type FontChoice } from '../appearance-choice';
import { hasNoteLayout, readNoteLayout, resolveEffectiveLayout, type NoteLayoutSpec, type PageMargin } from '../page-layout';
import { DEFAULT_READ_COLUMNS } from '../read-columns';
import type { ArchiveSource } from './pkc3-archive';
import { buildPortableWidgetBridgeScript, portableWidgetBridgeCss } from './portable-widget-bridge';
import { portableHydrateJs } from './portable-hydrate';
import {
  emptyCounts,
  openedAsSourceNotices,
  renderPortableNote,
  type CountKind,
  type PortableNoteDeps,
} from './portable-note';

/** 閲覧用 HTML と Word / PowerPoint が同じ文面を使う注意(正本は `portable-note.ts`)。 */
export { embedSourceNotice, mathSourceNotice } from './portable-note';

export const HTML_FORMAT = 'pkc3-portable';
export const HTML_VERSION = 1;
/** base64 の 1 チャンク(**3 の倍数**でなければならない ── 冒頭の解説参照)。 */
const B64_CHUNK = 3 * 64 * 1024;
/** 1 バッチで取る本文の目安。 */
const BODY_BATCH_BYTES = 4 * 1024 * 1024;
const NOTE_ID_KEY = 'lid';

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


/**
 * Blob を **3 バイト境界**で base64 にして 1 チャンクずつ渡す(配列に貯めない)。
 *
 * 🔑 **可搬単一 HTML(#400 段④)も同じ規則を使う** ── `export` にしてあるのは
 * そのため。⚠ もう 1 本書くと、3 の倍数で区切る規則が 2 か所になる(CLAUDE.md §7)。
 */
export async function* base64Chunks(blob: Blob): AsyncGenerator<string> {
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

/**
 * ノートの字体の指定(`page_font`)を焼く分。⚠ 指定が無ければ空文字(従来の出力のまま)。
 * 器(`body`)に `--font` を置き、本文の箱(`.b`)の字体をそれで当て直す。
 */
function noteFontCss(font: FontChoice | null): string {
  return font === null ? '' : `body{--font:${fontSpec(font).ui}}.b{font-family:var(--font)}`;
}

/**
 * 閲覧 UI(依存ゼロ・インライン)。**読めるだけ**に留める(P7 の Pages product が本番)。
 *
 * ⚠ **紙面フォーマットを受ける**(2026-08-08)ので関数である ── 書き出した瞬間の
 * 設定を焼く。器(`<body>`)に印を 1 つ付け、値の差し替えは style の末尾で行う。
 */
function viewer(pageFormat: PageFormat, proseAlign: ProseAlign, margin: PageMargin | null = null, font: FontChoice | null = null): string {
  return `
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
/* 🔴 **スマホの幅では、一覧を本文の上に置く**(台帳 #1852 束 S1、依頼 77-2 B)。直す前は左の一覧が 280px のまま残り、
   本文に 100px ほどしか残らなかった。ノートを選ぶと一覧(details)を畳む(JS 側)── 開き直せば一覧に戻れる。
   幅の境目はアプリのスマホ画面と同じ数字(PHONE_MAX_PX)。⚠ 画面だけの規則 ── 紙は下の print が nav を消す。 */
@media screen and (max-width:${PHONE_MAX_PX}px){
  body{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
  nav{max-height:45vh;border-right:0;border-bottom:1px solid #8884}
  main{padding:16px}
}
img{max-width:100%;height:auto;display:block;margin:8px 0}
/* 画像を押すと元の大きさで開く(依頼 77-5) */
a[data-pkc-img-open]{cursor:zoom-in;display:block;width:fit-content;max-width:100%}
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
#pkc-ptoc,#pkc-all{display:none}
/* ── 閲覧 HTML だけの素の体裁(2026-08-07 に掃除した)────────────────
   本文の記法の見た目は、style の末尾に焼いた app.css が**正本**である。

   🔴 **ここに残っているのは「焼いた側に対応物が無いもの」だけ**。
   2026-08-07 に実測(書き出した HTML を実ブラウザで開き、#body 配下の
   **全要素 × 全 computed プロパティ**を画面 light / 画面 dark / 紙の 3 通りで
   突き合わせ)して、**焼いた側と重複していた 38 本を削除・5 本を絞り込んだ**。
   削除の前後で **158,475 点すべて一致**、当たり先が 0 件の規則も 0 件
   (「fixture のゼロ件の次元は測っていない次元」)。

   ⚠ ここの規則は焼いた分より**手前**にあるので、同じ詳細度なら**負ける**。
     「上書きしたい」を書く場所ではない ── 書くなら焼いた分の後ろ(style の末尾)。
     ⇒ **足す前に「焼いた側が同じプロパティを宣言していないか」を確かめる。**
     宣言していれば、ここに書いた行は**最初から 1 度も効かない**。
   ⚠ #8884 のような半透明の無彩色は、焼いた規則が触らないプロパティの
     受け皿(下敷き)である。配色の方針ではない。
   ⚠ この template literal の中に**バッククォートを書かない**(build が壊れる ──
     この file で 5 度目)。 */
/* 🔑 読み幅はここに無い ── **app.css の規則が焼き込みで届く**(user 裁定 2026-08-08 で
 * 統一。46em/器 → 42rem/各ブロック + 表・図・コードは対象外)。あちらの規則は
 * .pkc-md-rendered[data-pkc-prose] 起点なので、抜き出しの判定
 * (build/body-css.ts の isBodyRule)を通る。だから器(#pkc-body と「全体を印刷」の箱)には
 * **class 2 つに加えて散文の印も**付けてある ── 落とすとその面だけ全幅に伸びる。
 * ⚠ ここは注記なので、印の綴り data-pkc-prose を**行頭が * の行に置く** ──
 * 器の数と印の数を突き合わせる検査(page-format-surfaces)は注記を剥いで数えるので、
 * 剥がれない行に綴りを書くと**器を増やしていないのに数が合わなくなる**。 */
.b>*:first-child{margin-top:0}
/* ⚠ 段落 / 箇条書きの margin は **app.css が書いていない**(UA 既定に任せている)。
   焼いた側に対応物が無いので、消すと配った HTML だけ行間が変わる。 */
.b p,.b ul,.b ol{margin:0 0 1em}
.b li{margin:.2em 0}
/* ⚠ 折り返しは**紙で要る** ── 焼いた側は overflow-x:auto だけで、紙では
   overflow が効かないので、これを消すと印刷でコードの長い行が切れる。 */
.b pre{white-space:pre-wrap;word-break:break-word;margin:0 0 1em}
/* ⚠ 焼いた側は色(--muted)だけ ── 濃さはこちらの持ち物。 */
.b blockquote{opacity:.85}
/* ⚠ 焼いた側は border 系だけ ── 余白はこちらの持ち物。 */
.b hr{margin:1.5em 0}
/* 図の原文(閲覧側に mermaid を積まないので、原文のまま出す)。
   ⚠ pre.d は**閲覧側だけが作る要素** ── アプリに対応物が無い。 */
.b pre.d{font-size:.9em;opacity:.85}
/* 絵にして埋め込んだ図とグラフ(#1648)。⚠ 閲覧側にだけ在る規則。幅は器に収める。 */
.b [data-pkc-figure-baked] img{max-width:100%;height:auto}
/* ⚠ 焼いた側は outline / color / min-height だけ ── 薄さはこちらの持ち物。 */
.b [data-pkc-asset-missing]{opacity:.75}
/* 入っていないノートへのリンク(依頼 77-3)。字を薄くし、点線の下線で「押せない」ことを見せる
   (理由は title だけで、指で触る端末では読めない)。⚠ 閲覧側だけが作る要素 ── アプリに対応物が無い。 */
.b [data-pkc-outside-note]{opacity:.6;text-decoration:underline dotted}
/* 本文の [[題名]] で、入っているノートへ飛べる字(#1174 段②)。⚠ 閲覧側だけが作る要素。 */
.b [data-pkc-title-ref][role=link]{text-decoration:underline;cursor:pointer}
/* 一覧の行(表)は器から溢れさせない。⚠ 焼いた側に対応物なし。 */
.b>*{max-width:100%}
a.f{display:inline-block;margin:8px 0;padding:6px 10px;border:1px solid #8884;border-radius:6px;
  color:inherit;text-decoration:none}
/* 3D モデルの案内(PR-12。配る HTML では描かない)。 */
p.m3{margin:8px 0 0;opacity:.8;font-size:.9em}
/* 🔴 **PDF は読める大きさで出す**(2026-08-15)。⚠ object 要素は固有寸法を持たないので、
   規則を書かないと **300×150** に落ちる(アプリ側で実際に踏んだ症状がこれ)。 */
object.p{display:block;width:100%;height:calc(100vh - 12rem);min-height:320px;
  border:1px solid #8884;border-radius:6px;margin:8px 0}
#pkc-fail{display:block;margin:24px;font:15px/1.7 system-ui,sans-serif;white-space:pre-wrap}

/* ── 印刷(F-1)。⚠ 画面用の grid と 100vh をほどくのが本題 ── ほどかないと
   1 ページ目だけ出て残りが切れる(main が overflow:auto のスクロール箱なので) */
@media print{
  /* 🔴 紙は白地に濃い字(#1387)── 暗い環境でも light dark のままだと、枠の字が白で出る */
  :root{color-scheme:light}
  body{display:block;height:auto;overflow:visible;font-size:10.5pt;line-height:1.6}
  nav{display:none}
  main{overflow:visible;padding:0}
  main h2{font-size:1.5em}
  /* ⚠ 画面の calc(100vh - 12rem) は紙では版面いっぱいになり、**1 個で 1 頁**を
     食って改頁を崩す。⚠ **この file はテンプレート文字列の中なのでバックティックを
     書けない**(書いた瞬間に閉じる ── 冒頭の注記のとおりで、実際に踏んだ)。
     ⚠ 埋め込んだ PDF の中身が紙に出るかはブラウザ次第で、
     **こちらでは確かめていない** ── 確かめていない以上、**版面を壊さないこと**
     だけを保証する(高さを抑え、途中で割らない)。 */
  object.p{height:50vh;min-height:0;break-inside:avoid}
  /* ⚠ 読み幅を紙でほどく規則(かつての .b の none)は置かない(2026-08-08)──
     器の cap が消えた今は死文で、紙もアプリの印刷と同じ 42rem/ブロックが裁定の向き。 */
  /* 折りたたみは**紙では展開する**(印刷時に details を開くのは JS 側) */
  #pkc-ptoc{display:block;margin:0 0 1.5em;padding:0 0 1em;border-bottom:1px solid #8884}
  #pkc-ptoc h3{font-size:1.05em;margin:0 0 .4em}
  /* ⚠ 紙の目次は 2 か所に出る(1 件の先頭 = #pkc-ptoc / 全体の先頭 = ol.x)──
     体裁は**両方に当てる**。片方だけだと、全体印刷の目次が
     既定の連番つき青リンクのまま出る(実機で踏んだ) */
  #pkc-ptoc ol,ol.x{list-style:none;margin:0;padding:0}
  #pkc-ptoc li[data-l="2"],ol.x li[data-l="2"]{padding-left:1.2em}
  #pkc-ptoc li[data-l="3"],ol.x li[data-l="3"]{padding-left:2.4em}
  ol.x li[data-l="4"]{padding-left:3.6em}
  #pkc-ptoc li.n,ol.x li.n{margin-top:.5em;font-weight:600}
  #pkc-ptoc a,ol.x a{color:inherit;text-decoration:none}
  /* 🔴 **+++ は改頁である**(2026-08-07。出典: PKC2 catalog #14 section break /
     page break)。直す前は**配る HTML でも改頁が起きていなかった**(break-after が
     auto)。しかも hr.pkc-section-break と素の hr は**見た目まで同じ**だった ──
     ここに .pkc-section-break の規則が 1 行も無かったので。
     ⚠ 出し分けは DOM でもう成立している(kind=rule は class 無しの hr)。
     ⚠ display:none にしてはいけない ── 箱が消えると改頁も消えるのに、計算後の
       break-after は page のまま残る(緑のまま壊れる。画面側 app.css の同名の節と同じ)。
     ⚠ #pkc-all(全体印刷)の中の本文も .b 配下なのでここで一緒に効く */
  /* 見出しが行末で独りにならない・切ってはいけない箱を切らない */
  main h2{break-after:avoid-page}
  /* 🔴 **紙のリンクは濃緑のまま。正本を 1 本にする**(user 裁定 2026-08-07)。
     選択肢を出して user が選んだ ── 「A: このまま(アプリも紙も濃緑。正本が 1 本に
     なる)」。⚠ **裁定済みなので、ここを黒へ戻す変更は user の明示裁定なしに入れない。**

     経緯: ここには color:inherit があったが、焼いた app.css の
     .pkc-md-rendered a{color:var(--accent)} と詳細度が同じ(0,1,1)で後に来るため
     **必ず負ける** ── 実測でも紙は rgb(20,102,60) だった。効いていない宣言を
     「効いているように見える形」で残さないので、判断ごと取り下げてある。
     ⚠ 紙で黒へ戻す変異は、export-body-css の smoke の観測点
       「本文のリンク色」が鳴らす(紙の側でも見ている)。
     ⚠ 仮に将来 user が黒へ倒すなら、**app.css 側で決めて両面に効かせる** ──
       この面だけ足すと正本が 2 本に戻る。
     下線を消すのはここの仕事(焼いた側は text-decoration を触らない)。 */
  .b a{text-decoration:none}
  /* 紙に操作子は要らない(切替の見た目だけ消す ── どちらの面を見せるかは
     画面での選択をそのまま持ち込む) */
  .b .pkc-render-toggle{display:none}
  /* 「全体を印刷」── main を隠して #pkc-all を出す */
  body[data-print="all"] main{display:none}
  body[data-print="all"] #pkc-all{display:block}
  #pkc-all section{break-before:page}
  #pkc-all section:first-child{break-before:auto}
  #pkc-all section h2{font-size:1.5em;margin:0 0 .6em}
}
/* 🔴 **紙面フォーマット**(2026-08-08。user 裁定)── 書き出した瞬間の設定を焼く。
   ⚠ ここは VIEWER のテンプレート文字列の中 ── **バッククォートを書かない**
     (この file で 6 度目。書いた瞬間に文字列が閉じて build ごと壊れる)。
   ⚠ 当たる先は**器の body 要素**(data-pkc-page-format を下に付けてある)で、
     焼いたトークンの :root{--read-w:42rem} とは**別の要素**である ──
     カスタムプロパティの継承で本文へ届くので、**順序も詳細度も争わない**。
     だから焼いた分より**前**に置ける ── 後ろは「この面に対応物が無いもの」
     だけの場所なので、そこを侵さない(pkc3-html.test の等値 pin)。
   ⚠ 値の正本は features/page-format.ts の表 1 枚(アプリの tokens.css と同じ値)。
   ⚠ 紙系(A4 / A3)のときだけ @page が出る ── 画面用(フル HD / 4:3)は
     受け手の既定紙に任せる。 */
${pageFormatCss(pageFormat, margin)}${noteFontCss(font)}
/* 🔴 **本文の置き場所**(#722、2026-09-08)── 書き出した瞬間の設定を焼く。
   ⚠ 当たる先は上と同じ**器の body 要素**(data-pkc-prose-align を下に付けてある)で、
     焼いたトークンの :root{--prose-lead:auto} とは**別の要素**である ──
     カスタムプロパティの継承で本文へ届くので、順序も詳細度も争わない。
   ⚠ **既定(中央)でも書く** ── 空にすると、既定の人だけ :root の値へ暗黙に
     依存する形になり、「焼いた側が正本」が 1 通りでなくなる。
   ⚠ 値の正本は features/prose-align.ts の表 1 枚(アプリの tokens.css と同じ値)。 */
${proseAlignCss(proseAlign)}
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
/* 🔴 ウィジェットの確認バー(#2097)。⚠ 紙には出さない(規則の中に @media print がある)。
   ⚠ 焼いた本文の規則より**前**に置く(後ろに規則を足すと、そこだけ app.css に勝つ ── 下の検査が止める)。
   確認バーは .pkc-md-rendered の規則ではないので、焼いた側とは重ならない。 */
${portableWidgetBridgeCss()}
${BODY_CSS}
/* ── 焼いた分より**後**に置くもの ── 書き出し側の DOM が アプリと違う 2 点だけ。
   ⚠ ここは「app.css を上書きしたい」ではなく「**この面には対応する要素が無い**」
     という理由に限る。見た目の好みで足し始めると、正本が 2 本に戻る。 */
/* ① 添付のボタンは**本文のリンクではない**(閲覧側だけが作る操作子)。
   ⚠ 焼いた .pkc-md-rendered a{color:var(--accent)} と a.f は詳細度が同じ(0,1,1)
     なので後が勝ち、**ダウンロードボタンの字が緑になっていた**(実測)。
     アプリに対応物が無いので、これは parity ではなく退行である。 */
.b a.f{color:inherit}
/* ② 切替ボタンは右端に寄せる。app.css は隣のコピーボタン(right:2px)を避けて
   right:26px にしているが、**閲覧側はコピーボタンを DOM から外す**
   (押しても何も起きない飾りなので)── 26px のままだと 24px の空きが残る(実測)。 */
.b .pkc-render-toggle{right:2px}
</style>
<body data-pkc-page-format="${pageFormat}" data-pkc-prose-align="${proseAlign}">
<nav>
  <h1 id="pkc-t"></h1>
  <button id="pkc-print" class="p" type="button" hidden>この文書を印刷</button>
  <button id="pkc-printall" class="p" type="button" hidden>全体を印刷</button>
  <details id="pkc-dnotes" open><summary>ノート</summary><div id="pkc-list"></div></details>
  <details id="pkc-dtoc" open><summary>この文書の目次</summary><ol id="pkc-toc"></ol><p class="e" id="pkc-tocempty" hidden>見出しがありません</p></details>
</nav>
<main><div id="pkc-ptoc"></div><h2 id="pkc-title"></h2><div id="pkc-body" class="b pkc-md-rendered" data-pkc-field="detail-body" data-pkc-prose></div></main>
<div id="pkc-all"></div>
<noscript><p id="pkc-fail">このファイルは JavaScript で中身を表示します。有効にして開き直してください。</p></noscript>
<script>
(function(){
// 🔴 黙って真っ白にしない ── 途中で切れたファイル / 壊れた JSON でも理由を出す
function fail(msg){
  var p=document.createElement('p');p.id='pkc-fail';
  p.textContent='このファイルを表示できませんでした: '+msg+
    '\\nダウンロードが途中で終わっている可能性があります。';
  document.body.textContent='';document.body.appendChild(p);
}
try{
  var el=document.getElementById('pkc-data');
  if(!el)throw new Error('データが見つかりません');
  var d=JSON.parse(el.textContent);
  document.title=d.title||'PKC3';
  document.getElementById('pkc-t').textContent=(d.title||'PKC3')+' ('+d.entries.length+' 件)';
  var mimes={},names={},kinds={};
  d.assets.forEach(function(a){
    mimes[a.key]=a.mime||'application/octet-stream';
    if(a.name)names[a.key]=a.name;
    /* 🔴 見せ方は**書き出す側が決めた答え**(#413 段②)── ここでは判定しない */
    if(a.kind)kinds[a.key]=a.kind;
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
  // 🔑 **本文を DOM に据える処理は 1 本に寄せる**(F-1)。画面表示と「全体を印刷」で
  // 同じ関数を使う ── 2 か所に書くと、添付の差し込みや欠落の見せ方がずれる
  // (CLAUDE.md「同じ判定が 2 か所に生えたら規則を 1 つに寄せる」)。
  // @param sink 作った object URL を積む配列(寿命の管理は呼び手が持つ)
  // @param idp  見出し id の接頭辞(全体印刷では entry ごとに変えて衝突を避ける)
  /* 🔴 **埋め込み HTML / ウィジェットの箱の親**(#2097 / #2098)── 高さ追従・テーマ連動・同じノートの参照・
     確認つきのファイルの入出力を 1 本の受け口で持つ(portable-widget-bridge.ts。本体と同じ契約)。
     ⚠ ここは VIEWER のテンプレート文字列の中 ── バックティックを書かない。
     ⚠ 受け口は 1 回だけ張る(entry ごとに張ると listener が積む)。
     🔴 箱が読めるのは**その箱のノートだけ**(器の data-pkc-ei から引く。他のノートの添付・表へ越境しない)。 */
  var sizes={};
  d.assets.forEach(function(a){sizes[a.key]=typeof a.size==='number'?a.size:0});
  function noteOfFrame(f){
    var b=f&&f.closest?f.closest('[data-pkc-ei]'):null;
    if(!b)return null;
    return d.entries[Number(b.getAttribute('data-pkc-ei'))]||null;
  }
  function frameAssets(f){
    var e=noteOfFrame(f),out=[],sn={};
    if(!e)return out;
    (e.attach||[]).concat(e.refs||[]).forEach(function(k){
      if(sn[k]||!has(k))return;sn[k]=1;
      out.push({key:k,name:names[k]||k,mime:mimes[k]||'application/octet-stream',size:sizes[k]||0});
    });
    return out;
  }
  function assetBytes(k){
    if(!has(k))return Promise.resolve(null);
    var b=atob(d.assetData[k]),u=new Uint8Array(b.length);
    for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);
    return Promise.resolve(u.buffer);
  }
  var bridge=${buildPortableWidgetBridgeScript({
    hooks:
      '{getFrameContext:function(f){var e=noteOfFrame(f);return e&&e.ctx?e.ctx:null},' +
      'getFrameAssets:frameAssets,readAssetBytes:assetBytes}',
  })};
  ${portableHydrateJs()}
  function eiOf(e){return d.entries.indexOf(e)}
  function titleOfAt(at){return d.entries[at]?d.entries[at].title:''}

  var list=document.getElementById('pkc-list'),cur=null;
  // ノート間リンクの行き先 ── ノートの番号 → 一覧の何番目か / 一覧のボタン(下で作る)
  var noteAt={},btns=[];
  d.entries.forEach(function(e,i){if(e.${NOTE_ID_KEY})noteAt[e.${NOTE_ID_KEY}]=i});
  // 題名 → 一覧の何番目か(同名は先に載っているほう。[[題名]] の行き先)
  var titleAt={};
  d.entries.forEach(function(e,i){if(e.title&&!Object.prototype.hasOwnProperty.call(titleAt,e.title))titleAt[e.title]=i});
  var toc=document.getElementById('pkc-toc'),tocEmpty=document.getElementById('pkc-tocempty');
  var ptoc=document.getElementById('pkc-ptoc'),all=document.getElementById('pkc-all');

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

  /* 🔴 **ブラウザの「戻る」「進む」で、ノートを行き来できる**(台帳 #1852 束 U1 残り、依頼 77-4 C)。
     直す前は、本文のリンクで別のノートへ移った後に「戻る」を押すと、ファイルを開く前のページへ出てしまった。
     ⚠ ノートへ移る道(本文のリンク・札・一覧)は**この 1 本**を通す。how: 'replace' = 最初の表示 / 'pop' = 戻る・進むで来た(履歴を作らない)。
     ⚠ URL は変えない(state だけ積む)── ファイルの場所に # を足さない。使えない環境では黙って今までどおり動く。 */
  var hist={i:-1,h:''};
  function go(i,hid,how){
    var h=hid||'';
    show(d.entries[i],btns[i],h);
    if(how!=='pop'){
      try{
        var st={pkcI:i,pkcH:h};
        if(how==='replace')history.replaceState(st,'');
        else if(hist.i!==i||hist.h!==h)history.pushState(st,'');
      }catch(_h){}
    }
    hist={i:i,h:h};
  }
  window.addEventListener('popstate',function(ev){
    var st=ev.state;
    if(!st||typeof st.pkcI!=='number'||!d.entries[st.pkcI])return;
    go(st.pkcI,typeof st.pkcH==='string'?st.pkcH:'','pop');
  });

  function show(e,btn,hid){
    // 🔴 旧ノートの確認バーと預かった bytes を、本文を差し替える前に手放す(#2097)
    bridge.reset();
    release();
    dropAll();  // 紙用に組んだ全件は、読みに戻った時点で捨てる(ObjectURL も)
    document.getElementById('pkc-title').textContent=e.title;
    var box=document.getElementById('pkc-body');box.textContent='';
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
    // 🔴 前のノートの読み位置を引き継がない(#1087)。スクロールするのは main
    var mainEl=document.querySelector('main');
    if(mainEl)mainEl.scrollTop=0;
    if(hid){
      var want=hid;
      try{want=decodeURIComponent(hid)}catch(_x){}
      var hl=box.querySelectorAll('h1,h2,h3,h4,h5,h6');
      for(var hj=0;hj<hl.length;hj++){if(hl[hj].id===want){hl[hj].scrollIntoView();break}}
    }
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
      //    そちらに付いている。**器は 2 か所ある**(#pkc-body と、ここ「全体を印刷」)ので
      //    片方だけに足すと、全体印刷の紙だけ素の見た目で出る(誰も見ていない経路)
      // 🔴 **data-pkc-prose も要る**(2026-08-08)── 読み幅の規則は
      //    .pkc-md-rendered[data-pkc-prose] 起点で焼かれてくる。
      //    落とすと全体印刷の本文だけ全幅に伸びる(同じ「片方だけ」の罠)
      var box=document.createElement('div');box.className='b pkc-md-rendered';
      box.setAttribute('data-pkc-field','detail-body');
      box.setAttribute('data-pkc-prose','');
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
    // 🔴 **PDF の箱も数える**(2026-08-15、着地前レビューで判明)。⚠ ここは
    //    2026-08-05 に「印刷が読み込み中の blob URL を revoke して紙から画像が落ちる」
    //    ために足した門で、object を数えないと **PDF がその門を素通りする**
    //    (afterprint の dropAll が読み込み途中の blob を消す)。object も load/error を出す。
    var imgs=root.querySelectorAll('img,object[type="application/pdf"]'),left=0,fired=false;
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

  var pb=document.getElementById('pkc-print'),pa=document.getElementById('pkc-printall');
  pb.hidden=false;pb.onclick=function(){dropAll();doPrint()};
  pa.hidden=false;
  pa.textContent='全体を印刷('+d.entries.length+' 件)';
  pa.onclick=function(){buildAll();whenImagesReady(all,doPrint)};

  d.entries.forEach(function(e,i){
    var b=document.createElement('button');
    b.textContent=e.title||'(無題)';
    /* 🔴 スマホの幅では、ノートを選んだら一覧を畳む(依頼 77-2 B。見出しの数字は CSS と同じ PHONE_MAX_PX) */
    b.onclick=function(){
      go(i,'');
      if(window.matchMedia&&window.matchMedia('(max-width:${PHONE_MAX_PX}px)').matches)document.getElementById('pkc-dnotes').open=false;
    };
    btns.push(b);
    list.appendChild(b);
    if(i===0)setTimeout(function(){go(0,'','replace')},0);
  });
}catch(err){fail(err&&err.message?err.message:String(err))}
})();
</script>`;
}

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
  /**
   * 🔴 **紙面フォーマット**(2026-08-08、user 裁定)。**書き出した瞬間の設定**を焼く。
   *
   * ⚠ 渡さないと既定(A4 縦)── 呼び手が忘れても「配った HTML が全幅に伸びる」
   *   ではなく「いままでと同じ 42rem」に倒れる(安全な向き)。
   * ⚠ この値は**読み手の設定を書き換えない** ── 配った HTML の中だけの話である
   *   (`localStorage` にも container にも触らない)。
   */
  pageFormat: PageFormat = DEFAULT_PAGE_FORMAT,
  /**
   * 🔴 **本文の置き場所**(#722、2026-09-08)。**書き出した瞬間の設定**を焼く。
   * ⚠ 渡さないと既定(中央)── 呼び手が忘れても「いままでと同じ」に倒れる。
   */
  proseAlign: ProseAlign = DEFAULT_PROSE_ALIGN,
  /**
   * 🔴 **本文に埋め込んだ SQL の答えを引く口**(#1223 Q3 = B)。
   *
   * 渡すと、書き出した**その時点の答え**を表にして焼く(原文の SQL もコード枠として残る)。
   * ⚠ 渡さない(test 等)と器は**空のまま**出る ── 引けないときは 1 行の注記が焼かれる。
   * ⚠ アプリからは必ず渡す(`ExportDeps.askSql` は optional にしていない)。
   */
  askSql?: (sql: string) => Promise<SqlEmbedAnswer>,
  /**
   * 🔴 **図とグラフを絵にして埋め込む産出器**(#1648)。渡すと、図(mermaid)は SVG、グラフは PNG の
   *   `<img>` として焼く。⚠ 渡さない(test 等)と原文の字のまま出る(従来どおり)。アプリからは必ず渡す。
   */
  figures?: FigureBakers,
): Promise<HtmlResult> {
  const warnings: string[] = [];
  /**
   * 🔴 **注意は同種 10 件で畳む**(#202)。⚠ 直す前はここだけ素の `push` で、
   * バックアップと Markdown ZIP には効いている規則が**閲覧用 HTML にだけ無かった**
   * ── 1 件につき 1 行積む所が 2 つあるので、該当が多い文書では注意が件数ぶん出る。
   * (`warn-cap.ts` 冒頭が「200 行の注意で 3 列が数十 px に潰れた」事故を記録している)
   * ⚠ `finish()` を呼び忘れると「10 件までは出るが、超えたことは誰も知らない」になる。
   */
  const warn = createWarnCollector(warnings);
  const metas = await src.listEntryMetas();
  // ⚠ 断るなら**変換の前に**断る(0 entry + 大量添付で全部 base64 にしてから
  // 投げると、捨てるためだけに数十秒かかる ── review L2)
  if (metas.length === 0) throw new Error('書き出せるノートが 1 件もありません');
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
  const noteDeps: PortableNoteDeps = {
    src,
    render,
    allowExternalImages,
    ...(askSql ? { askSql } : {}),
    ...(figures ? { figures } : {}),
    assetKeys,
    titleOf: (id) => metaOf.get(id)?.title ?? null,
    warn,
  };

  let entryCount = 0;
  /** ノート 1 件だけの書き出しで、そのノートにページ設定が書いてあればその値(v4.0 Phase 1 / PR-03)。 */
  let singleLayout: NoteLayoutSpec | null = null;
  /**
   * 🔴 **入っていないノートへのリンクを数える**(#1087 の見直し 2026-10-13)── 閲覧側ではそのリンクを押せない字に
   *   するが、渡す側には何も言っていなかった(会議メモは別ノートへのリンクが多い ── 渡してから気づく)。
   */
  const exportedLids = new Set<string>();
  const linkTargets: string[] = [];
  /** 開いた先で原文の字・空の枠になる物の数(#1087)。 */
  const opened: Record<CountKind, number> = emptyCounts();
  let after: { entryOrder: number; lid: string } | undefined;
  for (;;) {
    const { rows, done, next } = await src.listBodies(after, BODY_BATCH_BYTES);
    // バッチぶんを 1 個の Blob にして手放す(文字列のまま積むと全本文が heap に残る)
    let chunk = '';
    for (const r of rows) {
      const m = metaOf.get(r.lid);
      if (!m) {
        warn.add(
          'orphan-body',
          '一覧に無いノートの注意',
          `本文はあるが一覧に無いノートを飛ばしました: ${r.lid}`,
        );
        continue;
      }
      if (metas.length === 1) {
        const layout = readNoteLayout(r.body);
        if (hasNoteLayout(layout)) singleLayout = layout;
      }
      /**
       * 🔑 **1 件の描き方は `portable-note.ts` の 1 本**(配布パッケージと共有 ── v4.1 PR-6 で切り出した)。
       * 前書きの添付・本文の添付参照・コードブロックの添付・vars と見出し番号・SQL の答え・図とグラフ・板の題名・
       * 文書属性・ウィジェットの「同じノートのデータ」の扱いは、切り出す前と 1 つも変わらない。
       */
      const note = await renderPortableNote(r.body, noteDeps);
      for (const ref of note.attach) {
        used.add(ref.key);
        if (ref.name !== '' && !nameOf.has(ref.key)) nameOf.set(ref.key, ref.name);
      }
      for (const k of note.refs) used.add(k);
      const html = note.html;
      const e = {
        lid: m.lid,
        title: m.title,
        archetype: m.archetype,
        html,
        ...(Object.keys(note.attrs).length > 0 ? { attrs: note.attrs } : {}),
        ...(note.attach.length > 0 ? { attach: note.attach.map((x) => x.key) } : {}),
        ...(note.refs.length > 0 ? { refs: note.refs } : {}),
        // 🔴 ウィジェットが読む「同じノートのデータ」(#2097)── 箱の在るノートにだけ焼く
        ...(note.ctx !== null ? { ctx: note.ctx } : {}),
      };
      chunk += entryCount === 0 ? j(e) : `,${j(e)}`;
      entryCount++;
      exportedLids.add(m.lid);
      for (const l of note.links) linkTargets.push(l);
      for (const k of Object.keys(note.counts) as CountKind[]) opened[k] += note.counts[k];
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

  if (entryCount === 0) throw new Error('書き出せるノートが 1 件もありません');

  const outside = linkTargets.filter((lid) => !exportedLids.has(lid)).length;
  if (outside > 0) {
    warnings.push(`このファイルに入っていないノートへのリンク ${outside} 件は、押せない字だけになります`);
  }
  warnings.push(...openedAsSourceNotices(opened));
  const assetMetas = allAssets.filter((a) => used.has(a.key));
  const skipped = allAssets.length - assetMetas.length;
  if (skipped > 0) {
    warnings.push(`どの本文からも参照されていない添付 ${skipped} 件は含めませんでした`);
  }
  parts.push('],"assets":[');
  assetMetas.forEach((a, i) => {
    const name = nameOf.get(a.key);
    const mime = a.mime ?? 'application/octet-stream';
    /**
     * 🔴 **見せ方は書き出す側で決める**(#413 段②)。
     *
     * ⚠ 閲覧側(この下の `viewer`)は**別の実行系**なので import できない ──
     *   そこで判定を書くと、`assetPreviewKind` と**同じ規則が 2 か所**になる(§7)。
     *   だから**答えを焼いて渡す**。閲覧側は switch するだけにする。
     * ⚠ 元にしているのは添付の目録の MIME(この file が画像・PDF の判定で
     *   既に使っている物と同じ)── ここで別の出所に変えない。
     */
    // 🔑 名前も渡す(3D モデルは `text/plain` や種類なしで登録されうる ── PR-12)
    const kind = assetPreviewKind(mime, name);
    const meta = {
      key: a.key,
      mime,
      size: a.size ?? 0,
      ...(name ? { name } : {}),
      ...(kind ? { kind } : {}),
    };
    parts.push(i === 0 ? j(meta) : `,${j(meta)}`);
  });

  // ── 添付の bytes は base64 で **チャンクごとに**流し込む
  parts.push('],"assetData":{');
  let assetCount = 0;
  for (const a of assetMetas) {
    const blob = await src.getAssetBlob(a.key);
    if (!blob) {
      warn.add(
        'missing-asset',
        '中身の見つからない添付',
        `添付の中身が見つかりませんでした: ${a.key}`,
      );
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
  /**
   * 🔴 **ノート 1 件の書き出しは、そのノートのページ設定を優先する**(v4.0 Phase 1 / PR-03)── 前書きの
   *   `page_format` / `page_margin` / `page_font` を読み幅・`@page`・字体へ焼く。
   * ⚠ 書いていないノート・複数件の書き出しは従来と 1 バイトも変わらない(引数をそのまま渡す)。
   */
  const eff = singleLayout === null ? null : resolveEffectiveLayout(singleLayout, { pageFormat, readColumns: DEFAULT_READ_COLUMNS, font: DEFAULT_FONT });
  parts.push(
    '</script>',
    eff === null ? viewer(pageFormat, proseAlign) : viewer(eff.pageFormat, proseAlign, eff.pageMargin, singleLayout!.pageFont),
  );

  // 🔴 畳んだぶんの行をここで足す(#202)── 呼ばないと「超えた件数」が消える
  warn.finish();
  return {
    blob: new Blob(parts, { type: 'text/html;charset=utf-8' }),
    warnings,
    counts: { entries: entryCount, assets: assetCount },
  };
}
