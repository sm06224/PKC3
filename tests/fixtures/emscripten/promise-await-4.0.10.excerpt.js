// Emscripten 4.0.10 の soffice.js(run 37303396759、LibreOffice 0c031979 を -sASYNCIFY=2 で link)から
// `_emscripten_promise_await` の定義の周りを字のまま切り出した物(minify 済み)。
// ⚠ 手で書き換えない ── patch-soffice-js-promise-await.mjs の錨はこの字で当たる。
(growMemViews(),HEAPU32)[ptr+4>>>2>>>0]=value};var _emscripten_promise_await=function(returnValuePtr,id){returnValuePtr>>>=0;id>>>=0;return Asyncify.handleAsync(()=>getPromise(id).then(value=>setPromiseResult(returnValuePtr,true,value),error=>setPromiseResult(returnValuePtr,false,error)))};_emscripten_promise_await.isAsync=true;var makePromise=()=>{var promiseInfo={};
