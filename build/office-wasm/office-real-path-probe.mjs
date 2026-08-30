/**
 * **実 user 経路**で Office を起動して、マウスの当たり判定を測る(#157)。
 *
 * ## なぜ別の probe が要るのか
 *
 * `io-layer-probe.mjs` は `qt_soffice.html` を**直接**配信するので、
 * host.html がやっていること ── **窓の幾何の仕込み**(`seedWindowSize`、
 * `devicePixelRatio` を掛ける)/ キーのガード / 停止の検知 ── を**通らない**。
 * 🔴 そのため **幾何と当たり判定について何も主張できない**(DPR 2 で窓が半分に
 * 見えたのはこの副作用だった)。user が触るのはこちらの経路である。
 *
 * ## 何を 1 つ主張するか
 *
 * **「メニューの項目を押したとき、命令が実行されるか」** ── これだけ。
 * ⚠ 起動の速さも組版も主張しない。
 *
 * ## 仕込み(host.html は **IDB の中身しか読まない**)
 *
 * | store | 鍵 | 中身 |
 * |---|---|---|
 * | `meta` | `pack` | `{ files: [{name}…] }` |
 * | `files` | 各 file 名 | Blob(`soffice.wasm.gz` / `soffice.data.gz` は **gz のまま**) |
 *
 * だから配信一式(`make-pages-bundle.mjs` の出力)をそのまま入れればよい。
 *
 * 使い方:
 *   node build/office-wasm/make-pages-bundle.mjs <LO 展開先> /tmp/pages-out
 *   npm run build   # dist/office/host.html が要る
 *   node build/office-wasm/office-real-path-probe.mjs /tmp/pages-out [出力 JSON]
 *   PKC3_DPR=2 node …
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { armWatchdog } from './probe-watchdog.mjs';

const PACK = resolve(process.argv[2] ?? '/tmp/pages-out');
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
const DIST = resolve('dist');
const DPR = Number(process.env.PKC3_DPR ?? 1);
const SHOTS = `/tmp/pkc3-real-shots-dpr${DPR}`;
const VIEWPORT = { width: 1280, height: 800 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.metadata': 'application/json',
  '.gz': 'application/gzip',
  '.ttf': 'font/ttf',
  '.data': 'application/octet-stream',
};

/** `/office-pack/…` は配信一式、それ以外は dist。⚠ 同一 origin にする(取る側の前提)。 */
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
      const file = path.startsWith('/office-pack/')
        ? join(PACK, path.slice('/office-pack/'.length))
        : join(DIST, path);
      readFile(file)
        .then((buf) => {
          res.writeHead(200, {
            ...head,
            'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
          });
          res.end(buf);
        })
        .catch(() => {
          res.writeHead(path === '/favicon.ico' ? 204 : 404, head);
          res.end('');
        });
    });
    server.listen(0, '127.0.0.1', () => ok(server));
  });
}

/** 窓を shadow root 越しに拾う(幾何 + 当たり判定に効く CSS)。 */
const SURVEY = `(() => {
  const out = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      if (el.classList && el.classList.contains('qt-window')) {
        const r = el.getBoundingClientRect();
        out.push({ x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          z: getComputedStyle(el).zIndex });
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return out;
})()`;

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  await mkdir(SHOTS, { recursive: true });

  const browser = await chromium.launchPersistentContext(`/tmp/pkc3-real-${process.pid}`, {
    headless: true,
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: '/opt/pw-browsers/chromium',
  });
  // 🔑 見張りが閉じる相手(起動してから渡す)
  live = browser;
  wd.mark('起動');
  const result = { dpr: DPR, base, steps: [] };
  const page = await browser.newPage();
  const lines = [];
  page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`.slice(0, 200)));
  page.on('pageerror', (e) => lines.push(`[pageerror] ${String(e).slice(0, 200)}`));

  try {
    // ① まず host.html を開いて origin を作り、IDB へ一式を仕込む
    wd.mark('host.html を開く');
    await page.goto(`${base}/office/host.html`, { waitUntil: 'domcontentloaded' });
    result.staged = await page.evaluate(async () => {
      // ⚠ browser の global を裸で書かない(lint は node として読む ── 1 度 CI を赤にした)
      const { fetch, indexedDB } = /** @type {any} */ (globalThis);
      const manifest = await (await fetch('/office-pack/pack.json')).json();
      const names = [...manifest.files, ...manifest.fonts];
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('pkc3-office-pack', 1);
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains('files')) r.result.createObjectStore('files');
          if (!r.result.objectStoreNames.contains('meta')) r.result.createObjectStore('meta');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const put = (store, key, val) =>
        new Promise((res, rej) => {
          const t = db.transaction(store, 'readwrite');
          t.objectStore(store).put(val, key);
          t.oncomplete = () => res();
          t.onerror = () => rej(t.error);
        });
      let bytes = 0;
      for (const n of names) {
        const blob = await (await fetch(`/office-pack/${n}`)).blob();
        bytes += blob.size;
        await put('files', n, blob);
      }
      // ⚠ host.html は `meta.files` を **{name} の配列**として読む
      await put('meta', 'pack', {
        version: manifest.version,
        installedAt: Date.now(),
        source: 'url',
        totalBytes: bytes,
        files: names.map((n) => ({ name: n })),
      });
      return { count: names.length, bytes };
    });

    // ② 実 user 経路で起動(host.html が幾何を仕込む)
    wd.mark('host.html を開く');
    await page.goto(`${base}/office/host.html`, { waitUntil: 'commit' });
    wd.mark('版面を待つ');
    await page.waitForFunction(
      () => {
        const s = document.querySelector('#screen');
        if (!s) return false;
        const walk = (n) => {
          for (const e of n.querySelectorAll('*')) {
            if (e.tagName === 'CANVAS') return true;
            if (e.shadowRoot && walk(e.shadowRoot)) return true;
          }
          return false;
        };
        return walk(s);
      },
      null,
      { timeout: 600_000, polling: 1000 },
    );
    await page.waitForTimeout(15_000);
    result.steps.push({ at: 'booted', windows: await page.evaluate(SURVEY) });

    /**
     * 🔴 **起動後に器の大きさを変える**(`PKC3_RESIZE=1`)。
     *
     * host.html が明記している既知の限界:
     * 「**起動後にブラウザを縮めても窓は追従しない**(状態ビットを変えても同じ、実測)」
     *
     * ⚠ 追従しないだけなら「余白ができる」で済むが、**canvas の CSS 寸法だけが
     * 変わって Qt 内部の寸法が変わらない**なら、当たり判定は**倍率でずれる** ──
     * 原点に近いメニューバーは当たり、遠い項目ほど外す。
     * 🔑 user の症状(**メニューは開くが項目が効かない**)と形が一致する。
     */
    if (process.env.PKC3_RESIZE === '1') {
      await page.setViewportSize({ width: 1000, height: 700 });
      await page.waitForTimeout(3000);
      result.steps.push({ at: 'resized', windows: await page.evaluate(SURVEY) });
      await page.screenshot({ path: join(SHOTS, '00b-resized.png') });
    }
    await page.screenshot({ path: join(SHOTS, '00-booted.png') });

    /**
     * 🔴 **座標は固定で持たない。** 窓の実寸から相対で採る ──
     * DPR や器の大きさで版面が動くので、固定値は**別の場所を押す**
     * (`io-layer-probe` で実際に外した)。
     */
    const win = (await page.evaluate(SURVEY))[0];
    result.window = win;
    if (!win) throw new Error('窓が 1 つも無い');

    // Start Center の「Writer Document」を押す(左の一覧・窓の相対位置)
    await page.mouse.click(win.x + 133, win.y + 315);
    await page.waitForTimeout(12_000);
    result.steps.push({ at: 'writer', windows: await page.evaluate(SURVEY) });
    await page.screenshot({ path: join(SHOTS, '01-writer.png') });

    /**
     * Tools メニュー。⚠ **窓の相対で採らない** ── `.qt-window` の rect の上端は
     * LO の題名バーより下に在るので、`win.y + 37` は**ツールバーの行**を押した
     * (1 稿目で実際に外した)。screenshot から採った**画面の実座標**を使う。
     * ⚠ CSS 座標なので DPR を変えても同じ位置である。
     */
    /**
     * ⚠ **開いたことを確かめてから次へ行く。** 1 回目で開かない回が実在した
     * (LO が busy だと押下が落ちる)。開かないまま項目を押すと、
     * 「押し方のせいで効かない」と**誤読する** ── 空振りを結果と読まない。
     */
    let opened = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await page.mouse.click(476, 71);
      await page.waitForTimeout(3000);
      opened = await page.evaluate(SURVEY);
      result.menuAttempts = attempt;
      if (opened.length > 1) break;
    }
    result.steps.push({ at: 'menu-open', windows: opened });
    await page.screenshot({ path: join(SHOTS, '02-menu-open.png') });

    // 🔴 メニューの項目 ── **開いた popup の実位置**から相対で押す
    const popup = opened.length > 1 ? opened[opened.length - 1] : null;
    result.popup = popup;
    if (popup) {
      /**
       * 🔴 **押し方を変えられるようにする**(`PKC3_PICK=drag`)。
       *
       * ⚠ mac の user は**メニュー題名を押したまま項目へ滑らせて離す**ことが多い。
       * その形だと `pointerdown` で**暗黙のポインタ捕捉**が起き、`pointerup` が
       * **メニューバー側の要素**へ配送されうる ── Qt から見ると「popup の外で
       * 離した」= **閉じるだけで実行しない**。user の症状と形が一致する。
       * 🔑 `click`(押して離すだけ)と `drag`(押したまま滑らせて離す)を
       * **同じ probe で比べる**ことで、そこが原因かどうかが決まる。
       */
      if (process.env.PKC3_PICK === 'drag') {
        await page.mouse.move(476, 71);
        await page.mouse.down();
        await page.mouse.move(popup.x + 83, popup.y + 121, { steps: 8 });
        await page.waitForTimeout(300);
        await page.mouse.up();
      } else {
        await page.mouse.click(popup.x + 83, popup.y + 121);
      }
      await page.waitForTimeout(6000);
      const after = await page.evaluate(SURVEY);
      result.steps.push({ at: 'menu-pick', windows: after });
      await page.screenshot({ path: join(SHOTS, '03-menu-pick.png') });
      /**
       * 🔑 **命令が走ったか**は「窓が 1 枚に戻っていないか」で見る ──
       * メニューが閉じてダイアログが開けば 2 枚のまま、何も起きなければ 1 枚。
       * ⚠ 窓の数は「効いた/効かない」の**代理**でしかない。screenshot も残す。
       */
      result.windowsAfter = after.length;
      result.commandRan = after.length > 1;
    }
  } finally {
    result.console = lines.slice(-30);
    await page.screenshot({ path: join(SHOTS, '99-final.png') }).catch(() => {});
    await browser.close().catch(() => {});
    server.close();
  }

  const text = JSON.stringify(result, null, 1);
  console.log(text);
  if (OUT) await writeFile(OUT, text);
}

await main();
