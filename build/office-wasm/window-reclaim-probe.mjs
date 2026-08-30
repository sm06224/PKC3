/**
 * O2 の受入条件を測る ── **Office の窓を閉じたら常駐が還るか**(#88、2026-08-11)。
 *
 * 🔴 これが成立しないなら統合設計は不成立である。
 * 不可侵「重い処理はワーカーへ / アイドルで kill と解放」に対し、LO は worker へ
 * 出せない(Qt6 の wasm plugin が DOM を直に触る)。代わりに **realm ごと捨てられる
 * 境界**として別窓を使う ── その「捨てたら還る」を、言うだけでなく測る。
 *
 * ## 何を 1 つ主張するか
 *
 * **「Office の窓を開いて閉じると、常駐 RSS が開く前の水準へ戻る」** ── これだけ。
 * 起動の速さも組版の正しさも主張しない(それぞれ別の probe の仕事)。
 *
 * ## 対照群
 *
 * ⚠ 「何もしない」ではなく「**測りたい操作以外を全部同じにしたもの**」。
 * ここでは **同じ窓を開いて、同じだけ待って、閉じずに残す**のが対照群になる ──
 * 「閉じたこと」だけが差になる。
 *
 * ## 🔴 空振り対策
 *
 * ① 開いたあとの RSS が**十分に増えている**こと(増えていなければ LO が起動して
 *    おらず、「還った」は**開かなかっただけ**である)
 * ② 版面が実際に出たこと(shadow root を越えて canvas を見る)
 * ⚠ ①が無いと、host.html が「未配備」で即諦めた場合でも「還った」と言えてしまう。
 *
 * 使い方:
 *   node build/office-wasm/window-reclaim-probe.mjs <配信ディレクトリ> [出力 JSON]
 *   # 配信ディレクトリ = make-pages-bundle.mjs の出力(index.html は使わない)
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { armWatchdog } from './probe-watchdog.mjs';

const ROOT = resolve(process.argv[2] ?? '/tmp/pages-out');
const OUT = process.argv[3] ?? '';

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
  out: OUT,
  limitSec: Number(process.env.PKC3_HARD_LIMIT_SEC ?? 900),
  browser: () => live,
});
const SETTLE_MS = Number(process.env.PKC3_SETTLE_MS ?? 8000);
/** `opener`(既定)/ `noopener`。後者は別 process になりやすいが opener が切れる。 */
const MODE = process.env.PKC3_OPEN_MODE ?? 'noopener';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.gz': 'application/gzip',
  '.ttf': 'font/ttf',
};

/** proc の status から、この起動だけの RSS 合計(KB)を採る。 */
function rssKb(tag) {
  let total = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf-8').includes(tag)) continue;
      const m = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf-8'));
      if (m) total += Number(m[1]);
    } catch { /* 消えたプロセスは数えない */ }
  }
  return total;
}

const DEEP = `(root)=>{const o=[];const w=(n)=>{for(const e of n.querySelectorAll('*')){`
  + `if(e.tagName==='CANVAS')o.push(e);if(e.shadowRoot)w(e.shadowRoot);}};if(root)w(root);return o;}`;

/**
 * PKC3 本体を模した「親ページ」。COOP/COEP は本体と同じ値を配る。
 * ⚠ 親も分離されていないと、子の窓で SharedArrayBuffer が使えない。
 */
const PARENT = `<!doctype html><meta charset="utf-8"><title>parent</title><body>
<script>
// 製品と同じやり方: **noopener で開き、放送で話す**(office-window.ts と同型)
globalThis.__events = [];
var ch = new BroadcastChannel('pkc3-office');
ch.onmessage = function (ev) {
  if (ev.data && ev.data.pkc3Office) globalThis.__events.push(ev.data.pkc3Office);
};
globalThis.openOffice = (mode) => {
  if (mode === 'opener') { globalThis.__win = open('office/host.html', 'pkc3-office'); return; }
  open('office/host.html', '_blank', 'noopener');
};
globalThis.closeOffice = () => {
  if (globalThis.__win) { globalThis.__win.close(); return; }
  ch.postMessage({ pkc3Office: 'close-request', payload: {} });
};
</script></body>`;

function serve() {
  return new Promise((ok) => {
    const s = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      // 🔑 本体と同じ 2 つ。`credentialless` を選んだ理由は README の表を参照
      const head = {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'Cache-Control': 'no-store',
      };
      if (path === '/' || path === '/parent.html') {
        res.writeHead(200, { ...head, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PARENT);
        return;
      }
      readFile(join(ROOT, path))
        .then((b) => {
          res.writeHead(200, { ...head, 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
          res.end(b);
        })
        .catch(() => { res.writeHead(path === '/favicon.ico' ? 204 : 404, head); res.end(); });
    });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
}

/**
 * 一式を IndexedDB へ入れる(host.html はそこから読む)。
 * ⚠ 本物の `OfficePackStore` と**同じ形**で書く ── 形がずれると
 *   「probe では動くが製品では動かない」を作る。
 */
async function installPack(page, base, files) {
  return page.evaluate(async ([b, names]) => {
    const db = await new Promise((ok, ng) => {
      const r = indexedDB.open('pkc3-office-pack', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('files');
        r.result.createObjectStore('meta');
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ng(r.error);
    });
    const blobs = [];
    for (const n of names) {
      const res = await globalThis.fetch(`${b}/${n}`);
      if (!res.ok) throw new Error(`${n}: ${res.status}`);
      blobs.push([n, await res.blob()]);
    }
    await new Promise((ok, ng) => {
      const t = db.transaction(['files', 'meta'], 'readwrite');
      const fs = t.objectStore('files');
      for (const [n, blob] of blobs) fs.put(blob, n);
      t.objectStore('meta').put({
        version: 'probe', installedAt: Date.now(), source: 'url',
        totalBytes: blobs.reduce((a, [, x]) => a + x.size, 0),
        files: blobs.map(([n, x]) => ({ name: n, bytes: x.size, sha256: 'probe' })),
      }, 'pack');
      t.oncomplete = () => ok();
      t.onabort = () => ng(t.error);
      t.onerror = () => ng(t.error);
    });
    return true;
  }, [base, files]);
}

async function main() {
  const fonts = existsSync(join(ROOT, 'fonts'))
    ? readdirSync(join(ROOT, 'fonts')).filter((f) => f.toLowerCase().endsWith('.ttf')) : [];
  if (fonts.length === 0) {
    console.error(`ERROR: ${join(ROOT, 'fonts')} に .ttf が無い ── 日本語が豆腐になる一式では測らない`);
    process.exitCode = 1;
    return;
  }
  const packFiles = ['soffice.js', 'qtloader.js', 'soffice.data.js.metadata',
    'soffice.wasm.gz', 'soffice.data.gz', ...fonts.map((f) => `fonts/${f}`)];

  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const tag = `/tmp/pkc3-reclaim-${process.pid}`;
  const bundled = process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium';
  const browser = await chromium.launchPersistentContext(tag, {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    viewport: { width: 1280, height: 800 },
    ...(existsSync(bundled) ? { executablePath: bundled } : {}),
  });
  // 🔑 見張りが閉じる相手(起動してから渡す)
  live = browser;
  wd.mark('起動');

  const result = { base, settleMs: SETTLE_MS, mode: MODE };
  try {
    const page = await browser.newPage();
    wd.mark('頁 を開く');
    await page.goto(`${base}/`, { waitUntil: 'load' });
    result.isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);
    await installPack(page, base, packFiles);

    await page.waitForTimeout(SETTLE_MS);
    result.beforeKb = rssKb(tag);

    // ── 開く ─────────────────────────────────────────────
    const [officePage] = await Promise.all([
      browser.waitForEvent('page', { timeout: 60_000 }),
      page.evaluate((m) => { globalThis.openOffice(m); }, MODE),
    ]);
    wd.mark('版面を待つ');
    const painted = await officePage.waitForFunction((fn) => {
      for (const c of eval(fn)(document.querySelector('#screen'))) if (c.width > 0) return true;
      return false;
    }, DEEP, { timeout: 300_000, polling: 500 })
      .then(() => true).catch((e) => `timeout ${String(e).slice(0, 60)}`);
    result.painted = painted;
    await page.waitForTimeout(SETTLE_MS);
    result.openKb = rssKb(tag);

    // ── 対照群: 同じだけ待つ(閉じない)。ここでの増減は「時間の分」である ──
    await page.waitForTimeout(SETTLE_MS);
    result.stillOpenKb = rssKb(tag);

    // ── 閉じる ───────────────────────────────────────────
    // ⚠ noopener だと親から閉じられない ── 窓側から閉じる(user が × を押すのと同じ)
    // 🔑 **製品と同じ閉じ方**で測る ── 放送で「閉じてくれ」と頼み、窓が自分で閉じる
    await page.evaluate(() => { globalThis.closeOffice(); });
    await officePage.waitForEvent('close', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS * 2);
    result.afterKb = rssKb(tag);
    result.events = await page.evaluate(() => globalThis.__events).catch(() => []);
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  const mb = (kb) => Math.round((kb / 1024) * 10) / 10;
  result.openedMb = mb(result.openKb - result.beforeKb);
  result.driftMb = mb(result.stillOpenKb - result.openKb); // 対照群: 待っただけの分
  result.remainingMb = mb(result.afterKb - result.beforeKb);
  result.reclaimedPct = result.openedMb > 0
    ? Math.round(((result.openedMb - result.remainingMb) / result.openedMb) * 100) : null;

  // 🔴 空振り対策 ── 開いて増えていなければ「還った」は言えない
  const grew = result.openedMb >= 200;
  result.ok = Boolean(result.painted === true && grew && result.reclaimedPct !== null
    && result.reclaimedPct >= 80);
  if (!grew) {
    result.notApplied = `開いても常駐が ${result.openedMb}MB しか増えていない`
      + ' ── LO が起動していない可能性がある。この結果で「還った」とは言えない';
  }

  const text = JSON.stringify(result, null, 2);
  console.log(text);
  if (OUT) await writeFile(OUT, text);
  if (!result.ok) process.exitCode = 1;
}

await main();
