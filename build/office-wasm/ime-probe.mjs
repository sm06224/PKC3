/**
 * **日本語入力(IME)の配管が在るか**を実測する(user 報告 2026-08-14
 * 「少なくとも Mac で日本語入力はできません」)。
 *
 * ## 何を 1 つ主張する probe か
 *
 * **「Qt wasm が IME 用の編集可能要素を作り、版面へ入力するとき focus しているか」**
 * ── これだけ。⚠ 変換が正しく通るかは**測らない**(合成 event では
 * composition を本物どおりに再現できない ── 実機の仕事である)。
 *
 * 🔑 それでも意味がある: ブラウザの IME は **focus された編集可能要素**を要求する。
 * 要素が無い / focus されていないなら、**原理的に変換窓すら出ない** ──
 * 実機の症状の説明になり、直す場所も決まる。
 *
 * ## ⚠ 疑っているのは自分たちのパッチである
 *
 * #134 の直しで `QWasmInputContext::setFocusObject` から
 * `QInputMethodQueryEvent` の送信を削っている(上流 6.10 と同じ形)。
 * **そこはまさに IME の配管**なので、まず「要素が在るか」から確かめる。
 *
 * 使い方:
 *   node build/office-wasm/ime-probe.mjs <配信ディレクトリ> [出力 JSON]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { armWatchdog } from './probe-watchdog.mjs';

/**
 * 🔴 **全体の締切**(#624)。`open-doc-probe` が **4h58m** 固まって
 * JSON を 1 バイトも残さなかったので、probe 全部に置いた。
 *
 * ⚠ `page.evaluate()` に**既定の締切は無い** ── 版面が 100% で回り続けると
 * `await` は永久に返らず、例外を投げないので **`finally` も走らない**。
 * 🔑 だから「**何段目で止まったか**」を残せるのは見張りだけである。
 * ⚠ 締切は `PKC3_HARD_LIMIT_SEC` で伸ばせる(既定 900 秒)。
 * ⚠ 出るのは**時間切れの記録**であって、probe の通常の出力ではない ──
 *   `timedOut: true` は「できなかった」ではなく **判定不能**と読む。
 */
let live = null;
const watched = {};
const wd = armWatchdog({
  result: watched,
  out: '',
  limitSec: Number(process.env.PKC3_HARD_LIMIT_SEC ?? 900),
  browser: () => live,
});

const ROOT = resolve(process.argv[2]);
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript',
  '.wasm':'application/wasm', '.svg':'image/svg+xml', '.json':'application/json',
  '.metadata':'application/json', '.data':'application/octet-stream' };
const server = createServer((req,res)=>{
  const p=(req.url??'/').split('?')[0];
  const head={'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp',
    'Cross-Origin-Resource-Policy':'same-origin','Cache-Control':'no-store'};
  readFile(join(ROOT,p)).then(b=>{res.writeHead(200,{...head,'Content-Type':MIME[extname(p)]??'application/octet-stream'});res.end(b);})
    .catch(()=>{res.writeHead(p==='/favicon.ico'?204:404,head);res.end('');});
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const port=server.address().port;

const DEEP = `(() => {
  const inputs = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      const t = el.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || el.isContentEditable) {
        const r = el.getBoundingClientRect();
        inputs.push({ tag: t, type: el.getAttribute('type'), id: el.id || null,
          cls: (el.className && el.className.toString().slice(0,40)) || null,
          w: Math.round(r.width), h: Math.round(r.height),
          focused: el === document.activeElement,
          inputmode: el.getAttribute('inputmode'),
          // 🔴 #156 の診断(Qt patch が書く)── 早期 return の 4 条件のうち、
          //    どれで落ちているかを名指しする(obj0-win1-panel1-accept0 の形)。
          //    ⚠ ここは template literal の中なので**逆引用符を書かない**(壊れる)
          ime: el.getAttribute('data-pkc-ime'),
          autocapitalize: el.getAttribute('autocapitalize') });
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const ae = document.activeElement;
  return { inputs, active: ae ? (ae.tagName + (ae.id ? '#'+ae.id : '')) : null };
})()`;

const browser = await chromium.launchPersistentContext('/tmp/pkc3-ime-'+process.pid, {
  headless:true, viewport:{width:1280,height:900},
  args:['--no-sandbox','--disable-dev-shm-usage'], executablePath:'/opt/pw-browsers/chromium',
});
// 🔑 見張りが閉じる相手(起動してから渡す)
live = browser;
wd.mark('起動');
const page = await browser.newPage();
const out = { steps: [] };
wd.mark('qt_soffice.html を開く');
await page.goto(`http://127.0.0.1:${port}/qt_soffice.html`, { waitUntil:'commit' });
wd.mark('版面を待つ');
await page.waitForFunction(()=> {
  const s=document.querySelector('#screen'); if(!s) return false;
  const walk=(n)=>{for(const e of n.querySelectorAll('*')){if(e.tagName==='CANVAS')return true;if(e.shadowRoot&&walk(e.shadowRoot))return true;}return false;};
  return walk(s);
}, null, { timeout: 600000, polling: 1000 });
await page.waitForTimeout(15000);
out.steps.push({ at:'起動直後', ...await page.evaluate(DEEP) });

// Writer を開く(Start Center の Writer Document)
await page.mouse.click(133, 341);
await page.waitForTimeout(15000);
out.steps.push({ at:'Writer を開いた', ...await page.evaluate(DEEP) });

// 版面をクリックして文字入力の状態にする
const box = await page.evaluate(`(() => {
  const walk=(n)=>{for(const e of n.querySelectorAll('*')){if(e.tagName==='CANVAS'){const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}if(e.shadowRoot){const f=walk(e.shadowRoot);if(f)return f;}}return null;};
  return walk(document.querySelector('#screen')||document.body);
})()`);
await page.mouse.click(box.x + box.w*0.4, box.y + box.h*0.4);
await page.waitForTimeout(4000);
out.steps.push({ at:'版面をクリック', ...await page.evaluate(DEEP) });

await page.keyboard.type('abc', { delay: 120 });
await page.waitForTimeout(3000);
out.steps.push({ at:'abc を打った', ...await page.evaluate(DEEP) });

console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
