/**
 * React(JSX)の囲みを描く sandbox の箱の中身(HTML 全文)を組む(#528 ②)。
 *
 * 🔴 **箱は外へ出られない**(外部 CDN は使わない):
 * - `sandbox="allow-scripts"` のみ(`allow-same-origin` 無し ── 親の localStorage / IndexedDB / cookie に触れない)
 * - CSP `default-src 'none'`(= `connect-src` も `frame-src` も無し)、画像は `data:` / `blob:` だけ
 * - `script-src 'unsafe-inline' 'unsafe-eval'`:JSX の変換結果を `new Function` で動かすため。通信できず親にも触れない
 *   箱の中なので、評価を許して外へ出せる物は無い
 * ランタイム(React / ReactDOM / sucrase / Tailwind)は**この HTML に inline で入る**。
 *
 * ## 書き方(マニュアル「React」の節と同じ)
 * - `export default` でコンポーネントを書く、または `App` という名前のコンポーネントを書く
 * - 本文が `<` で始まる(JSX の式 1 つだけ)なら、それを描く
 * - `import { useState } from 'react'` と書ける(他の import は使えない)
 * - Tailwind の class(`className="p-4 bg-blue-500"`)が効く
 */
import { sandboxResizeScript, sandboxViolationScript } from '@features/markdown/html-sandbox';

export const REACT_FRAME_CSP =
  "default-src 'none'; img-src data: blob:; font-src data:; style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'";

/** 箱の中の台本(ES5)。`__SOURCE__` に本文の字(JSON リテラル)が入る。 */
export const REACT_FRAME_HARNESS = `
(function(){
  var P=window.PkcReact;
  var root=document.getElementById('root');
  function showErr(e){
    root.textContent='';
    var pre=document.createElement('pre');
    pre.style.cssText='color:#b00020;white-space:pre-wrap;font:12px/1.5 monospace;margin:0';
    pre.textContent=String((e&&e.message)||e);
    root.appendChild(pre);
  }
  window.addEventListener('error',function(ev){ showErr(ev.error||ev.message); });
  try{
    if(!P) throw new Error('React を読み込めませんでした');
    var src=__SOURCE__;
    if(/^\\s*</.test(src)) src='export default function App(){ return (\\n'+src+'\\n); }';
    var out=P.transform(src,{transforms:['jsx','imports'],jsxRuntime:'classic',production:true}).code;
    var mod={exports:{}};
    var req=function(n){
      if(n==='react') return P.React;
      if(n==='react-dom'||n==='react-dom/client') return {createRoot:P.createRoot};
      throw new Error("import できるのは 'react' だけです: "+n);
    };
    new Function('require','exports','module','React',
      out+'\\n;if(typeof module.exports.default==="undefined"&&typeof App!=="undefined")module.exports.default=App;'
    )(req,mod.exports,mod,P.React);
    var C=mod.exports.default;
    if(typeof C!=='function'&&!(C&&C.$$typeof)) throw new Error('export default でコンポーネントを書くか、App という名前のコンポーネントを書いてください');
    P.createRoot(root,{onUncaughtError:function(e){ showErr(e); },onCaughtError:function(e){ showErr(e); }}).render(P.React.createElement(C));
  }catch(e){ showErr(e); }
})();
`;

/** 字を script の中の JS リテラルとして置く(`</script` や `<!--` で箱の構文が途切れない形)。 */
export function scriptLiteral(text: string): string {
  // ⚠ U+2028 / U+2029 は JSON では字のままで良いが、古い JS の字面では行末になる ── 逃がす(生の字をここへ書かない)
  return JSON.stringify(text)
    .replace(/</g, '\\u003c')
    .split(String.fromCharCode(0x2028))
    .join('\\u2028')
    .split(String.fromCharCode(0x2029))
    .join('\\u2029');
}

/** ランタイムの字を script の中へ置く(`</script` を字面のまま置かない)。 */
function escapeScript(src: string): string {
  return src.split('</script').join('<\\/script');
}

/**
 * @param iframeId 箱の id(`data-pkc-html-render-id`。高さ・止めた要求の申告の宛先を決める)
 */
export function reactFrameDoc(source: string, runtime: string, tailwind: string, iframeId: string): string {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<meta http-equiv="Content-Security-Policy" content="${REACT_FRAME_CSP}">` +
    // ⚠ CSP の `<meta>` より後・本文より前(止めた要求を取りこぼさない)
    sandboxViolationScript(iframeId) +
    '<style>body{margin:0;padding:0.5rem;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;line-height:1.5;color:#222}*{box-sizing:border-box}img,svg,video,canvas{max-width:100%;height:auto}</style>' +
    '</head><body><div id="root"></div>' +
    `<script>${escapeScript(runtime)}</script>` +
    `<script>${escapeScript(tailwind)}</script>` +
    `<script>${REACT_FRAME_HARNESS.replace('__SOURCE__', () => scriptLiteral(source))}</script>` +
    sandboxResizeScript(iframeId) +
    '</body></html>'
  );
}
