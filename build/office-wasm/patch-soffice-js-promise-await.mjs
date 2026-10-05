#!/usr/bin/env node
/**
 * 🔴 **`emscripten_promise_await` の起こしに shadow stack の門を置く**(#1344。焼いた `soffice.js` を置換する)。
 *
 * ## 何が起きていたか(2026-10-05、実ブラウザの trace で確定 ── #1344 コメント 6003088998)
 *
 * LibreOffice 0c031979 の JSPI 構成(`HAVE_EMSCRIPTEN_JSPI && !HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD`)では、
 * main thread の `QtInstance::ProcessEvent` が user event を `eventHandlerThread` へ proxy し、その結果を
 * **`emscripten_promise_await` で待つ**。その待ちの間に DOM event(pointer)が来ると、Qt の
 * `qstdweb::EventListener` の invoker(promising export)が**別の計算**として走り、右クリックなら
 * `QMenu::exec` の loop を Qt の wait(`qt_asyncify_suspend_js`)で止める。
 * 🔴 ここで proxy の結果が返ると、Emscripten の promise が **main を直に起こす** ── JSPI は wasm の
 * 実行 stack は退避するが C の shadow stack(`__stack_pointer`)は 1 本の global で、保存も復元もしない。
 * main は止まったときの sp から下へ frame を積む = **生きているメニューの frame を踏む**。
 * 後でメニューが起きると `QEventLoop::exit` で `unaligned accesses` の trap(v1 と同じ署名)。
 * Qt 側の LIFO(v2)も sp の門(v3)も Qt の起こししか見ていないので、ここは止められない。
 *
 * ## 直し
 *
 * `_emscripten_promise_await` で await に入るとき `stackSave()`(= `_emscripten_stack_get_current()`)を控え、
 * promise が解決したとき **同じ値へ戻っていなければ起こさず待つ**(上に生きている frame が在る)。
 * 直列化(同じ stack に載せる)ではない ── 自分の sp が戻るまで `setTimeout` で見る。
 * 診断(`PKC3-UEV pa-defer …`)は 3 点で出す ── 待ちに入った 1 周目 / 約 1 秒(250 周)戻らないとき /
 * 戻って起こしたとき(`pa-defer end`)。250 周を超えたら 100 ms に間引く。
 * ⚠ `stackSave` は Emscripten の runtime が必ず出す(`var stackSave=()=>_emscripten_stack_get_current();`)。
 * 🔴 **無ければこの script は落ちる**(門が黙って無くなる形を作らない)── 置換後の JS に残る
 * `typeof stackSave` の控えは、焼いた物の検品ではなく、実行時に名前が届かなかったときの最後の保険である。
 *
 * ## なぜ焼きの後に置換するのか
 *
 * `_emscripten_promise_await` は Emscripten の library JS(`src/lib/libpromise.js`)で、LO の source にも
 * Qt の source にも無い。`--js-library` で上書きするには LO の link 行へ手を入れる必要が在り、
 * `--post-js` では `wasmImports` に束ねられた後になる。**焼けた `soffice.js` の字を置換する**のがいちばん
 * 確実で、同じ置換を手元の pack で**焼かずに**検めた(scratchpad 121q)。
 * 🔑 当てる先は **配る一式**(`workdir/installation/LibreOffice/emscripten/soffice.js`)── `instdir` を直しても
 * `make instsetoo_native` が集め直すので、集めた後に当てて、同じ file で印を検める。
 * ⚠ 錨は **Emscripten 4.0.10 の minify 後の字**(`tests/fixtures/emscripten/promise-await-4.0.10.excerpt.txt`)。
 * Emscripten を上げて字が変わったら、この script は**落ちる**(黙って素通りしない)。
 *
 * 使い方: `node build/office-wasm/patch-soffice-js-promise-await.mjs <soffice.js>`
 * 印は `pkc3PaGuard`(置換後の字に 1 度だけ入る。二重当ての検出と、配った物の検品に使う)。
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const MARK = 'pkc3PaGuard';

/** 診断行の頭(probe の ring はこの字で拾う)。 */
export const DIAG_PREFIX = 'PKC3-UEV pa-defer';

/** Emscripten の runtime が出す `stackSave` の定義(これが無い一式には当てない)。 */
export const STACK_SAVE_DEF = 'var stackSave=()=>_emscripten_stack_get_current();';

/** Emscripten 4.0.10 が出す `_emscripten_promise_await` の定義(minify 済み。⚠ 1 字も変えない)。 */
export const ANCHOR =
  'var _emscripten_promise_await=function(returnValuePtr,id){returnValuePtr>>>=0;id>>>=0;' +
  'return Asyncify.handleAsync(()=>getPromise(id).then(value=>setPromiseResult(returnValuePtr,true,value),' +
  'error=>setPromiseResult(returnValuePtr,false,error)))};';

/**
 * 置換後。`pkc3WaitSp(sp, r)` は sp が戻るまで待ってから `r` を返す。
 * - `n === 1` で `pa-defer`(待ちに入った)、`n === 250` で約 1 秒の診断、戻ったら `pa-defer end`。
 * - 250 周を超えたら 100 ms に間引く(空転を抑える)。
 * - `Module.pkc3PaGuard = 1` は印(配った物の検品 / 二重当ての検出)。
 */
export const REPLACEMENT =
  'var _emscripten_promise_await=function(returnValuePtr,id){returnValuePtr>>>=0;id>>>=0;' +
  'const pkc3sp=(typeof stackSave==="function")?stackSave():null;' +
  'return Asyncify.handleAsync(()=>getPromise(id).then(value=>setPromiseResult(returnValuePtr,true,value),' +
  'error=>setPromiseResult(returnValuePtr,false,error)).then(r=>pkc3WaitSp(pkc3sp,r)))};' +
  'Module.pkc3PaGuard=1;' +
  'function pkc3WaitSp(sp,r){' +
  'if(sp===null||typeof stackSave!=="function"||stackSave()===sp)return r;' +
  'return new Promise(res=>{let n=0;const tick=()=>{' +
  'if(stackSave()===sp){console.error("PKC3-UEV pa-defer end n="+n);res(r);return}' +
  'n++;' +
  'if(n===1||n===250)console.error("PKC3-UEV pa-defer n="+n+" sp="+stackSave()+" want="+sp+" dir="+(stackSave()<sp?"above":"unwound"));' +
  'setTimeout(tick,n>=250?100:0)};setTimeout(tick)})}';

/** 置換して新しい字を返す。⚠ 落ちる条件: 既に当たっている / `stackSave` の定義が無い / 錨が 1 件でない。 */
export function patchText(text) {
  if (text.includes(MARK)) throw new Error(`既に当たっている(${MARK} が在る)── 二重当ては受けない`);
  if (!text.includes(STACK_SAVE_DEF)) {
    throw new Error(
      `stackSave の定義が無い(\`${STACK_SAVE_DEF}\` が 0 件)── 門が黙って無くなる形になるので当てない。` +
        ' Emscripten の版が変わって runtime の字が変わったなら、錨と一緒に STACK_SAVE_DEF を更新する',
    );
  }
  const hits = text.split(ANCHOR).length - 1;
  if (hits !== 1) {
    throw new Error(
      `錨が ${hits} 件(1 件でない)── Emscripten の版が変わって \`_emscripten_promise_await\` の字が変わった。` +
        ' tests/fixtures/emscripten/promise-await-*.excerpt.txt を新しい版で切り出し直してから錨を更新する',
    );
  }
  return text.replace(ANCHOR, () => REPLACEMENT);
}

function main(argv) {
  if (argv.length !== 1) {
    console.error('usage: patch-soffice-js-promise-await.mjs <soffice.js>');
    return 2;
  }
  const path = argv[0];
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    console.error(`ERROR: ${path} を読めない: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  let out;
  try {
    out = patchText(text);
  } catch (e) {
    console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}(${path})`);
    return 1;
  }
  writeFileSync(path, out);
  console.log(`patched: ${path}(#1344 ── emscripten_promise_await の起こしに shadow stack の門。印 ${MARK})`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
