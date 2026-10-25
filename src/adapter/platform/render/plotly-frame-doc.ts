/**
 * plotly を焼く sandbox の箱の中身(HTML 全文)を組む(#528 ①)。
 *
 * 🔴 **箱は外へ出られない**:`default-src 'none'`(= `connect-src` も `frame-src` も無し)、画像は `data:` / `blob:` だけ。
 * plotly.js が地図のタイルや CDN の地形データ・設定に書かれた外部画像を取りに行っても、**要求が飛ばない**
 * (本文に書かれた JSON が、読んだ人の IP を第三者へ渡す道にならない)。
 * ⚠ `script-src` は `'unsafe-inline'` と `'unsafe-eval'`:plotly.js 本体が式を組む(`new Function`)ため。箱は
 *   `allow-same-origin` を持たず(opaque origin)、通信もできないので、評価を許しても外へ出せるものが無い。
 *
 * 依頼の封筒は `WorkerLease` の `{ id, payload }`(`frame-worker.ts` が運ぶ):
 *   payload = `{ fig: { data, layout }, width, height, scale }`
 * 返事は `{ id, ok: true, result: { png: ArrayBuffer, cssWidth } }` か `{ id, ok: false, error }`。
 * ⚠ 送り主は `event.source === parent` だけで決める(`event.origin` は箱では "null")。
 */

export const PLOTLY_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

/** 箱の中の台本(ES5 で書く ── 箱の中で変換は掛からない)。 */
export const PLOTLY_FRAME_HARNESS = `
(function(){
  function post(m,t){ try{ parent.postMessage(m,'*',t||[]); }catch(e){} }
  function fail(id,e){ post({id:id,ok:false,error:String((e&&e.message)||e).slice(0,200)}); }
  function toBuffer(url){
    var i=url.indexOf(',');
    var bin=atob(url.slice(i+1));
    var u=new Uint8Array(bin.length);
    for(var k=0;k<bin.length;k++)u[k]=bin.charCodeAt(k);
    return u.buffer;
  }
  window.addEventListener('message',function(ev){
    if(ev.source!==parent)return;
    var d=ev.data;
    if(!d||typeof d.id!=='number')return;
    var p=d.payload||{};
    try{
      if(typeof Plotly==='undefined'){ fail(d.id,'plotly.js を読み込めませんでした'); return; }
      Plotly.toImage(
        { data:p.fig.data, layout:p.fig.layout },
        { format:'png', width:p.width, height:p.height, scale:p.scale }
      ).then(function(url){
        var buf=toBuffer(url);
        post({id:d.id,ok:true,result:{png:buf,cssWidth:p.width}},[buf]);
      }).catch(function(e){ fail(d.id,e); });
    }catch(e){ fail(d.id,e); }
  });
  post({ready:true});
})();
`;

/** `</script` を字面のまま script の中へ置くと箱の構文が途切れる ── JS の字の中では `<\/script` と同じ意味になる。 */
function escapeScript(src: string): string {
  return src.split('</script').join('<\\/script');
}

/**
 * @param plotlySource plotly.js の本体(`plotly.min.js` の字)
 */
export function plotlyFrameDoc(plotlySource: string): string {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${PLOTLY_FRAME_CSP}">` +
    '</head><body style="margin:0">' +
    `<script>${escapeScript(plotlySource)}</script>` +
    `<script>${PLOTLY_FRAME_HARNESS}</script>` +
    '</body></html>'
  );
}
