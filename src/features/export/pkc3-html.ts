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
 * → 添付が何 MB あっても **同時に heap へ載るのは 1 チャンク**。
 *
 * ## `</script` の退避
 * 🔴 JSON の中に `</script` が現れると **そこで script 要素が終わる**。本文に
 * `</script>` と書いただけで壊れる(user が書ける文字列である)。`<\/script` へ
 * 退避する ── JSON の文字列としては同値なので、読み手は素の `JSON.parse` でよい。
 */
import { parseFrontmatter } from '../markdown/frontmatter';
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
 * `</script` を退避する。⚠ **JSON にしたあと**に掛ける(前だと値が変わる)。
 * 大文字小文字を問わない ── HTML のタグ名は case-insensitive。
 */
export function escapeScriptEnd(json: string): string {
  return json.replace(/<\/(script)/gi, '<\\/$1');
}

const j = (v: unknown): string => escapeScriptEnd(JSON.stringify(v));

/**
 * 本文が **markdown の外**で参照している添付 key を集める。
 *
 * 🔴 添付 entry の body は **frontmatter だけ**(`attachment.asset_key: …`)で、
 * `asset:` 参照を**一切含まない**。本文を `asset:` で走査するだけの閲覧側は
 * 「添付が 1 個も無いノート」に見える ── 実際 smoke で踏んだ。
 * ⚠ 解決は**書き出し側**でやる:閲覧側(依存ゼロのインライン JS)に
 * frontmatter parser を持たせると、本物の parser と二重実装になって必ずずれる。
 *
 * `*_asset_key` で終わる key を総なめするので、`attachment.app_icon_asset_key`
 * のような将来 field も archetype を知らずに拾える。
 */
function referencedAssetKeys(body: string): string[] {
  if (!body.startsWith('---\n')) return []; // frontmatter が無いなら見るものが無い
  const { meta } = parseFrontmatter(body);
  const out: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (k.endsWith('asset_key') && typeof v === 'string' && v !== '' && !out.includes(v)) {
      out.push(v);
    }
  }
  return out;
}

/** Blob を **3 バイト境界**で base64 にして部品として返す(全量を heap に載せない)。 */
async function base64Parts(blob: Blob): Promise<string[]> {
  const parts: string[] = [];
  for (let off = 0; off < blob.size; off += B64_CHUNK) {
    const slice = blob.slice(off, Math.min(off + B64_CHUNK, blob.size));
    const bytes = new Uint8Array(await slice.arrayBuffer());
    let bin = '';
    // ⚠ `String.fromCharCode(...bytes)` は引数が多すぎて落ちる ── 小分けにする
    for (let i = 0; i < bytes.length; i += 8192) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    parts.push(btoa(bin));
  }
  return parts;
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
pre{white-space:pre-wrap;word-break:break-word;font:inherit;margin:0}
img{max-width:100%;height:auto;display:block;margin:8px 0}
a.f{display:inline-block;margin:8px 0;padding:6px 10px;border:1px solid #8884;border-radius:6px;
  color:inherit;text-decoration:none}
</style>
<nav><h1 id="t"></h1><div id="list"></div></nav>
<main><h2 id="title"></h2><div id="body"></div></main>
<script>
(function(){
  var d=JSON.parse(document.getElementById('pkc-data').textContent);
  document.title=d.title||'PKC3';
  document.getElementById('t').textContent=(d.title||'PKC3')+' ('+d.entries.length+' 件)';
  var urls={},mimes={};
  d.assets.forEach(function(a){mimes[a.key]=a.mime||'application/octet-stream'});
  for(var k in d.assetData){
    var b=atob(d.assetData[k]),u=new Uint8Array(b.length);
    for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);
    urls[k]=URL.createObjectURL(new Blob([u],{type:mimes[k]||'application/octet-stream'}));
  }
  // 添付は画像なら見せる、それ以外は保存できる導線にする(開けないより落とせる方がよい)
  function view(key,name){
    if((mimes[key]||'').indexOf('image/')===0){
      var im=document.createElement('img');im.src=urls[key];im.alt=name||key;return im;
    }
    var a=document.createElement('a');a.className='f';a.href=urls[key];
    a.download=name||key;a.textContent='⬇ '+(name||key);return a;
  }
  // frontmatter は本文ではなくメタ ── 表示からは畳む(データは JSON 側に丸ごと残る)
  function prose(s){
    if(s.indexOf('---\\n')!==0)return s;
    var i=s.indexOf('\\n---\\n',3);
    if(i>=0)return s.slice(i+5);
    return s.slice(-4)==='\\n---'?'':s;
  }
  var list=document.getElementById('list'),cur=null;
  function show(e,btn){
    document.getElementById('title').textContent=e.title;
    var box=document.getElementById('body');box.textContent='';
    // 本文は**素のまま**出す(markdown を解釈しない ── 読めるだけに留める)。
    // ただし添付参照だけは中身として見せる
    var seen={},parts=prose(e.body).split(/asset:([A-Za-z0-9_.-]+)/);
    for(var i=0;i<parts.length;i++){
      var t=parts[i];
      if(i%2===1){
        if(urls[t]){seen[t]=1;box.appendChild(view(t,e.title));continue;}
        t='asset:'+t; // 中身の無い参照は**参照のまま**見せる(黙って key だけ出さない)
      }
      if(t!==''){var p=document.createElement('pre');p.textContent=t;box.appendChild(p);}
    }
    // 本文の外(frontmatter)から参照している添付 ── 添付 entry はこちらだけを持つ
    (e.attach||[]).forEach(function(key){
      if(urls[key]&&!seen[key]){seen[key]=1;box.appendChild(view(key,e.title));}
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
})();
</script>`;

/**
 * 可搬 HTML を書く。
 * @throws entry 0 件のときは**断る**(「書き出したつもりで空」を作らない)
 */
export async function writePortableHtml(
  src: ArchiveSource,
  exportedAt: string,
): Promise<HtmlResult> {
  const warnings: string[] = [];
  const metas = await src.listEntryMetas();
  const metaOf = new Map(metas.map((m) => [m.lid, m]));

  const parts: Array<string | Blob> = [
    '<!doctype html><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<script id="pkc-data" type="application/json">',
    `{"format":${j(HTML_FORMAT)},"version":${HTML_VERSION},`,
    `"exported_at":${j(exportedAt)},"title":${j(src.title)},"entries":[`,
  ];

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
      const attach = referencedAssetKeys(r.body);
      const e = {
        lid: m.lid,
        title: m.title,
        archetype: m.archetype,
        body: r.body,
        ...(attach.length > 0 ? { attach } : {}),
      };
      chunk += entryCount === 0 ? j(e) : `,${j(e)}`;
      entryCount++;
    }
    if (chunk !== '') parts.push(new Blob([chunk]));
    if (done || !next) break;
    after = next;
  }

  const assetMetas = await src.listAssetMetas();
  parts.push('],"assets":[');
  assetMetas.forEach((a, i) => {
    const meta = { key: a.key, mime: a.mime ?? 'application/octet-stream', size: a.size ?? 0 };
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
    // ⚠ base64 は `"` `\` `<` を含まないので、ここは退避不要(英数 + `+/=` のみ)
    for (const p of await base64Parts(blob)) parts.push(p);
    parts.push('"');
    assetCount++;
  }
  parts.push('}}');
  parts.push('</script>', VIEWER);

  if (entryCount === 0) {
    throw new Error('書き出せる entry が 1 件もありません');
  }

  return {
    blob: new Blob(parts, { type: 'text/html;charset=utf-8' }),
    warnings,
    counts: { entries: entryCount, assets: assetCount },
  };
}
