/**
 * LibreOffice wasm(Qt6)を**実ブラウザで起動させて、常駐メモリと応答を測る**(#88)。
 *
 * 🔴 不可侵指示「配る量は気にしない。効くのは定常」(user 2026-08-03)に従い、
 * 報告すべきは配布サイズではなく **継続使用の常駐メモリ**と**操作の応答**である。
 * したがってこの probe が出すのは byte 数ではなく **RSS の増分**を主役にする。
 *
 * ⚠ **対照群は「何もしない」ではなく「測りたい操作以外を全部同じにしたもの」**
 * (計測規律)。ベースラインは **同じサーバ・同じ COOP/COEP・同じブラウザ**で
 * 空ページを開いた状態にする ── ブラウザ自体の常駐を差し引くため。
 *
 * ⚠ **観測点はアプリ自身の信号**を使う(時間待ちで代用しない)。Qt の shell は
 * `qt.onLoaded` で `showUi(screen)` を呼び、`#screen` を `block` / `#qtspinner` を
 * `none` にする(`qtbase/src/plugins/platforms/wasm/wasm_shell.html`)。
 * 失敗側も塞ぐ ── catch は `console.error`、終了は `#qtstatus` に "Application exit"。
 * **沈黙を成功と読まない。**
 *
 * 🔴 **`onLoaded` を「UI が出た」と読んではいけない**(2026-08-10、run 31350624048 で
 * 実際に誤読した)。`onLoaded` は発火して `#screen` が `block` になったのに、
 * **canvas は 0 枚**・`window.Module` は未設定で、画面には何も無かった。
 * それでも probe は `ok:true` を返し、私は「起動した」と報告してしまった。
 * 🔑 主張したいのは「**LibreOffice の面が出た**」なので、判定は
 * **`#screen` の中に大きさを持つ canvas が在ること**にする ── `onLoaded` は
 * *途中経過*として別欄に残す(消すと、どこまで進んだか分からなくなる)。
 *
 * 🔴 **その次に、判定の「探し方」で 1 日溶かした**(2026-08-10)。上の直しは
 * 向きは正しかったのに `#screen.querySelectorAll('canvas')` と書いたので、
 * **常に 0 枚**を返し続けた ── Qt 6 の面は **shadow root の中**に在る:
 *   `#screen > #qt-shadow-container` →⟨shadowRoot⟩→ `.qt-screen`
 *     → `#qt-window-1` → `.qt-window > canvas.qt-window-canvas`
 * `querySelectorAll` は shadow 境界を越えないので、**動いている LibreOffice を
 * 「起動しない」と報告し**、私は在りもしないデッドロックを何時間も追った
 * (screenshot には Start Center が完全に描かれていた)。
 * 🔑 CLAUDE.md「検査の『主張そのもの』が間違っていることがある」の実例。
 * **観測点を直したら、その観測点自身にも対照群を当てる** ── ここでは
 * 「shallow(境界を越えない探索)は 0 枚」を**併記**して、次に読む人が
 * 同じ罠に落ちないようにする。⚠ screenshot を先に見ていれば 5 分で済んだ:
 * **数える前に、まず見る。**
 *
 * ⚠ `HEAPU8.byteLength` は「予約した量」であって「常駐」ではない
 * (LO は `-sTOTAL_MEMORY=1GB`)。**両方**出して、混同しないように別欄にする。
 *
 * 使い方: node boot-probe.mjs <配信ディレクトリ> [出力 JSON]
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { armWatchdog } from './probe-watchdog.mjs';

const ROOT = resolve(process.argv[2] ?? '.');
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
// ⚠ ハーネス自身の自己検品(起動しない題材を渡して**失敗として鳴る**か見る)を
//    現実的な時間で回せるように外へ出す。既定は wasm 149MB のコンパイルを見込んだ値。
// ⚠ 300 秒では足りなかった(run 31350624048 は timeout 時点で `onLoaded` までしか
//    進んでおらず、**その先を見られなかった**)。待ちが足りずに「動かない」と
//    結論するのは、環境の性質をアプリの不具合と読み違えるのと同じ型なので、
//    ビルド 1 回転(16 分〜3 時間)より probe の 15 分のほうがはるかに安い。
const BOOT_TIMEOUT_MS = Number(process.env.PKC3_BOOT_TIMEOUT_MS ?? 900_000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.metadata': 'application/json',
  '.data': 'application/octet-stream',
};

/**
 * ページ内へ流し込む「**shadow root を越えて canvas を数える**」関数の原文。
 * ⚠ `page.evaluate` はクロージャを持ち込めないので、文字列で渡して各所で使い回す ──
 *    数え方が 2 通りに分かれると、片方だけ直して**また 0 枚を信じる**ことになる。
 */
const DEEP_CANVAS_FN = `(root) => {
  const out = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      if (el.tagName === 'CANVAS') out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  if (root) walk(root);
  return out;
}`;

/** COOP/COEP を必ず付ける ── SharedArrayBuffer(= LO の -pthread)に要る。 */
function serve() {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      const head = {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-store',
      };
      if (path === '/__blank') {
        res.writeHead(200, { ...head, 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>blank</title><body></body>');
        return;
      }
      readFile(join(ROOT, path))
        .then((buf) => {
          res.writeHead(200, { ...head, 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
          res.end(buf);
        })
        .catch(() => {
          // ⚠ favicon の 404 は**常在ノイズ**になり、本物のエラーがそこに紛れる
          //    (CLAUDE.md「全スイートの stderr は 0 行を保つ」と同じ向き)。
          //    握り潰すのではなく、**無いときだけ**内容なしで返す
          if (path === '/favicon.ico') {
            res.writeHead(204, head);
            res.end();
            return;
          }
          res.writeHead(404, head);
          res.end('not found');
        });
    });
    server.listen(0, '127.0.0.1', () => ok(server));
  });
}

/**
 * このブラウザだけの RSS 合計(KB)。
 * ⚠ ブラウザは複数プロセスに分かれるので、**起動時の一意な user-data-dir で絞る** ──
 * 同じ箱で走る他の chrome を巻き込むと、増分が別物になる。
 */
function browserRssKb(tag) {
  let total = 0;
  let procs = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let cmd;
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    } catch {
      continue;
    }
    if (!cmd.includes(tag)) continue;
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
      const m = /^VmRSS:\s+(\d+) kB$/m.exec(status);
      if (m) {
        total += Number(m[1]);
        procs += 1;
      }
    } catch {
      /* 消えたプロセスは数えない */
    }
  }
  return { rssKb: total, procs };
}

async function main() {
  const server = await serve();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const tag = `/tmp/pkc3-lo-probe-${process.pid}`;

  // ⚠ **どのブラウザで測ったかを必ず記録する**(CLAUDE.md: CI と手元で別のバイナリが
  //    動いている)。既存 smoke と同じ解決順にし、結果 JSON にも残す。
  const bundled = process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium';
  const executablePath = existsSync(bundled) ? bundled : undefined;
  // CI には `/opt/pw-browsers` が無い。playwright 既定に落ちると
  // **`chromium_headless_shell`**(= 手元と別のバイナリ)になるので、
  // `channel` で**フル chromium** を名指しできるようにする。
  const channel = process.env.PKC3_CHROMIUM_CHANNEL || undefined;

  const result = {
    ok: false,
    base,
    browser: executablePath ?? (channel ? `channel:${channel}` : 'playwright default'),
  };
  const consoleAll = [];
  const consoleErrors = [];
  const pageErrors = [];

  const browser = await chromium.launchPersistentContext(tag, {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(executablePath ? { executablePath } : {}),
    ...(executablePath ? {} : channel ? { channel } : {}),
  });
  // 🔑 見張りが閉じる相手(起動してから渡す)
  live = browser;
  wd.mark('起動');

  let page;
  let sampler;
  try {
    page = await browser.newPage();
    page.on('console', (m) => {
      const line = `[${m.type()}] ${m.text()}`.slice(0, 400);
      // ⚠ **error だけ拾うと、どこで止まったか分からない。** LO / Qt は進行を
      //    log で出すので全部残す(上限つき)。error は別欄にも積む。
      consoleAll.push(line);
      if (m.type() === 'error') consoleErrors.push(line);
    });
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 400)));

    // ── 対照群: 同じサーバ・同じヘッダ・同じブラウザで空ページ ──────────
    wd.mark('__blank を開く');
    await page.goto(`${base}/__blank`, { waitUntil: 'load' });
    result.isolatedBaseline = await page.evaluate(() => globalThis.crossOriginIsolated === true);
    // 落ち着かせてから測る(ブラウザ起動直後の伸び縮みを拾わない)
    await page.waitForTimeout(3000);
    result.baseline = browserRssKb(tag);

    // ── 本番: LibreOffice を起動 ────────────────────────────────────
    const t0 = Date.now();
    wd.mark('qt_soffice.html を開く');
    await page.goto(`${base}/qt_soffice.html`, { waitUntil: 'commit' });
    result.isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true);

    // 🔴 **「遅い」と「死んでいる」を区別する**(2026-08-10)。
    //    LO はスレッドを立てたあと**無音のまま timeout** した。沈黙だけでは
    //    「初期化が重い」のか「詰まった」のか分からない ── 定期的に標本を取り、
    //    **最後に動きがあった時刻**が分かるようにする。
    //    ⚠ これが無いと、待ち時間を延ばすたびに 25 分を捨てて同じ疑問に戻る。
    const samples = [];
    sampler = setInterval(() => {
      page
        .evaluate((fnSrc) => {
          const deep = eval(fnSrc);
          return {
            canvases: deep(document.querySelector('#screen')).length,
            // ⚠ 対照群: 境界を越えない数え方。**0 のままなのが正常** ──
            //    ここが canvases と同じ値になったら、Qt が shadow root を
            //    やめたということなので、上の deep 探索を疑ってよい
            shallow: document.querySelectorAll('#screen canvas').length,
            status: (document.querySelector('#qtstatus')?.textContent ?? '').slice(0, 60),
          };
        }, DEEP_CANVAS_FN)
        .then((v) => {
          samples.push({ atMs: Date.now() - t0, console: consoleAll.length, ...v });
        })
        .catch(() => {});
    }, 15_000);

    // ⚠ 成功だけでなく**失敗側も**待つ。沈黙を成功と読まないため、
    //    「起動した」「終了した」「例外が出た」の 3 つを同じ待ちで拾う。
    const outcome = await page
      .waitForFunction(
        (fnSrc) => {
          const spinner = document.querySelector('#qtspinner');
          const screen = document.querySelector('#screen');
          const status = document.querySelector('#qtstatus');
          if (!spinner || !screen) return 'no-shell';
          const css = globalThis.getComputedStyle;
          // ⚠ onLoaded は**途中経過**。記録はするが、これを成功と読まない
          if (css(screen).display === 'block' && css(spinner).display === 'none') {
            globalThis.__pkc3OnLoadedAt ??= Date.now();
          }
          // 🔑 主張は「LibreOffice の面が出た」── **shadow root を越えて**
          //    大きさを持つ canvas を要求する(境界を越えないと永遠に 0 枚)
          for (const c of eval(fnSrc)(screen)) {
            const box = c.getBoundingClientRect();
            if (c.width > 0 && c.height > 0 && box.width > 0 && box.height > 0) return 'painted';
          }
          if ((status?.textContent ?? '').includes('Application exit')) return 'exited';
          return false;
        },
        DEEP_CANVAS_FN,
        { timeout: BOOT_TIMEOUT_MS, polling: 500 },
      )
      .then((h) => h.jsonValue())
      .catch((e) => `timeout: ${String(e).slice(0, 200)}`);

    result.outcome = outcome;
    result.bootMs = Date.now() - t0;
    result.samples = samples;

    result.onLoadedFired = await page
      .evaluate(() => globalThis.__pkc3OnLoadedAt !== undefined)
      .catch(() => null);

    if (outcome === 'painted') {
      // 起動直後は伸びるので、落ち着かせてから常駐を測る
      await page.waitForTimeout(5000);
      result.afterBoot = browserRssKb(tag);
      result.rssDeltaMb = Math.round(
        ((result.afterBoot.rssKb - result.baseline.rssKb) / 1024) * 10,
      ) / 10;

      result.wasm = await page.evaluate((fnSrc) => {
        const m = globalThis.Module;
        const cs = eval(fnSrc)(document.querySelector('#screen'));
        return {
          // ⚠ これは「予約した量」── 常駐ではない(-sTOTAL_MEMORY=1GB)
          heapReservedBytes: m?.HEAPU8?.byteLength ?? null,
          hasModule: Boolean(m),
          canvases: cs.length,
          canvasSizes: cs.map((c) => `${c.width}x${c.height}`),
          // ⚠ 対照群(上の sampler と同じ理由)。**0 が正常**
          shallowCanvases: document.querySelectorAll('#screen canvas').length,
        };
      }, DEEP_CANVAS_FN);

      result.uaMemory = await page
        .evaluate(async () => {
          if (typeof performance.measureUserAgentSpecificMemory !== 'function') return null;
          const r = await performance.measureUserAgentSpecificMemory();
          return { bytes: r.bytes };
        })
        .catch((e) => ({ error: String(e).slice(0, 200) }));

      result.ok = true;
    }
  } finally {
    if (sampler !== undefined) clearInterval(sampler);
    // ⚠ **失敗したときこそ残す** ── 成功時だけ撮ると、原因を追う材料が無い
    await page?.screenshot({ path: join(ROOT, 'boot.png'), fullPage: false }).catch(() => {});
    result.console = consoleAll.slice(-120);
    result.consoleErrors = consoleErrors.slice(0, 40);
    result.pageErrors = pageErrors.slice(0, 20);
    await browser.close().catch(() => {});
    server.close();
  }

  const text = JSON.stringify(result, null, 2);
  console.log(text);
  if (OUT) await writeFile(OUT, text);
  // 起動しなかったら**失敗として落とす**(沈黙を成功と読まない)
  if (!result.ok) process.exitCode = 1;
}

await main();
