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
import { parseFrontmatter, type FrontmatterValue } from '../markdown/frontmatter';
import { renderMarkdown } from '../markdown/markdown-render';
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
/* 描いた本文(P8 段⑲)。⚠ **配色トークンは持ち込まない** ── ここは
   単体で開くファイルで、地の色は閲覧環境の light/dark に従う。
   #8884 のような半透明の無彩色なら、どちらでも読める */
#body{max-width:46em}
#body>*:first-child{margin-top:0}
#body h1,#body h2,#body h3,#body h4{line-height:1.3;margin:1.4em 0 .5em}
#body h1{font-size:1.5em}#body h2{font-size:1.3em}#body h3{font-size:1.1em}
#body p,#body ul,#body ol,#body blockquote,#body table{margin:0 0 1em}
#body ul,#body ol{padding-left:1.5em}
#body li{margin:.2em 0}
#body code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em;
  background:#8882;border-radius:3px;padding:0 3px}
#body pre{white-space:pre-wrap;word-break:break-word;margin:0 0 1em;padding:10px 12px;
  background:#8881;border:1px solid #8883;border-radius:6px;overflow-x:auto}
#body pre code{background:0;padding:0}
#body blockquote{padding-left:1em;border-left:3px solid #8884;opacity:.85}
#body table{border-collapse:collapse}
#body th,#body td{border:1px solid #8884;padding:4px 8px;text-align:left}
#body th{background:#8881}
#body hr{border:0;border-top:1px solid #8884;margin:1.5em 0}
#body a{color:inherit}
/* 図は原文のまま(閲覧側に mermaid を積まない)*/
#body pre.d{font-size:.9em;opacity:.85}
#body [data-pkc-asset-missing]{opacity:.75;outline:1px dashed #8886}
/* 一覧の行(表)は溢れさせない */
#body>*{max-width:100%}
a.f{display:inline-block;margin:8px 0;padding:6px 10px;border:1px solid #8884;border-radius:6px;
  color:inherit;text-decoration:none}
#fail{display:block;margin:24px;font:15px/1.7 system-ui,sans-serif;white-space:pre-wrap}
</style>
<nav><h1 id="t"></h1><div id="list"></div></nav>
<main><h2 id="title"></h2><div id="body"></div></main>
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
  function urlFor(key){
    var b=atob(d.assetData[key]),u=new Uint8Array(b.length);
    for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);
    var url=URL.createObjectURL(new Blob([u],{type:mimes[key]||'application/octet-stream'}));
    live.push(url);return url;
  }
  // 添付は画像なら見せる、それ以外は保存できる導線にする(開けないより落とせる方がよい)
  function view(key,alt){
    var name=names[key]||alt||key;
    if((mimes[key]||'').indexOf('image/')===0){
      var im=document.createElement('img');im.src=urlFor(key);im.alt=name;return im;
    }
    var a=document.createElement('a');a.className='f';a.href=urlFor(key);
    a.download=name;a.textContent='⬇ '+name;return a;
  }
  var list=document.getElementById('list'),cur=null;
  function show(e,btn){
    release();
    document.getElementById('title').textContent=e.title;
    var box=document.getElementById('body');box.textContent='';
    // 🔑 本文は**書出し側で描いた HTML**(P8 段⑲)。かつてここは本文を素のまま
    // pre で出しており、見出しも表も箇条書きも**記号のまま**だった ──
    // 「単体で開いて読める」と案内している当のファイルが一番読みにくかった。
    // ⚠ 描くのは**アプリと同じ関数**(閲覧側に parser を持たせない ── 二重実装は必ずずれる)
    var seen={};
    box.innerHTML=e.html||'';
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
      if(el.tagName==='IMG'){el.src=urlFor(k);if(!el.alt)el.alt=names[k]||k;return}
      el.href=urlFor(k);el.download=names[k]||k;
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
      if(has(key)&&!seen[key]){seen[key]=1;box.appendChild(view(key,e.title));}
    });
    if(cur)cur.setAttribute('aria-current','false');
    cur=btn;btn.setAttribute('aria-current','true');
  }
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
  render: (text: string) => string | Promise<string> = (text) => renderMarkdown(text),
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
      const html = await render(r.body.slice(skip));
      const e = {
        lid: m.lid,
        title: m.title,
        archetype: m.archetype,
        html,
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
