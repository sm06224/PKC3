/**
 * **Options のコンボ含有ペインが描画されるか**を測る(#166)。
 *
 * ## 何を 1 つ主張するか
 *
 * 「Tools → Options を開き、コンボを含むペイン(表示)へ移ったとき、
 * 右ペインに**中身が描かれるか**」── これだけ。付随で #166-2(空ペインを
 * Escape で閉じると `memory access out of bounds` 停止)も観る。
 *
 * ## 観測点(CLAUDE.md §4)
 *
 * - 右ペインの**切り抜き画像の情報量**(distinct color 数)。空 = ほぼ単色。
 *   ⚠ 「色数 < N」の N は対照群で決める ── **既定ペイン(ユーザーデータ、
 *   テキストのみ)は正常描画される**(レポート #10/#11)ので、まずそれを撮り、
 *   同じ物差しで比べる(N を先に固めない ── 後条件は確かめた事実の上にだけ書く)
 * - 停止は **host 自身の信号**(停止面の文言が document に出る)で見る
 *
 * 使い方:
 *   node build/office-wasm/make-pages-bundle.mjs <LO 展開先> /tmp/pages-out
 *   npm run build
 *   node build/office-wasm/options-pane-probe.mjs /tmp/pages-out out.json
 *
 * 座標 knob(CSS px。screenshot を読んで合わせる):
 *   PKC3_O_WRITER="133,315"  Start Center の Writer(窓相対)
 *   PKC3_O_TOOLS="536,71"    メニューバーの ツール(T)(画面座標)
 *   PKC3_O_VIEW="0.5,-3"     Options ツリーの「表示」項目(ダイアログ相対。下記)
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const PACK = resolve(process.argv[2] ?? '/tmp/pages-out');
const OUT = process.argv[3] ?? '';
const DIST = resolve('dist');
const SHOTS = '/tmp/pkc3-options-shots';
const VIEWPORT = { width: 1280, height: 800 };

const C_WRITER = (process.env.PKC3_O_WRITER ?? '133,315').split(',').map(Number);
const C_TOOLS = (process.env.PKC3_O_TOOLS ?? '536,71').split(',').map(Number);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.metadata': 'application/json',
  '.gz': 'application/gzip',
  '.ttf': 'font/ttf',
  '.data': 'application/octet-stream',
};

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
          res.writeHead(404, head);
          res.end();
        });
    });
    server.listen(0, '127.0.0.1', () => ok(server));
  });
}

/** 窓(qt-window)の rect を shadow ごしに全部集める。 */
const SURVEY = `(() => {
  const out = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      if (el.classList && el.classList.contains('qt-window')) {
        const r = el.getBoundingClientRect();
        out.push({ x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height) });
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return out;
})()`;

/**
 * 切り抜きの**情報量の代理** = PNG 圧縮後のバイト数(依存を足さない)。
 * 空(ほぼ単色)のペインは数 KB へ潰れ、中身のあるペインは 1 桁大きい ──
 * 絶対値は使わず、**対照群(正常描画される既定ペイン)との比**でだけ読む。
 */
function infoBytes(buf) {
  return buf.length;
}

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  await mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launchPersistentContext(`/tmp/pkc3-options-${process.pid}`, {
    headless: true,
    viewport: VIEWPORT,
    deviceScaleFactor: Number(process.env.PKC3_O_DPR ?? 1),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: '/opt/pw-browsers/chromium',
  });
  const result = { coords: { writer: C_WRITER, tools: C_TOOLS } };
  const page = await browser.newPage();
  const lines = [];
  page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`.slice(0, 200)));

  try {
    // 仕込み(combo-popup-probe と同じ ── host.html は IDB しか読まない)
    await page.goto(`${base}/office/host.html`, { waitUntil: 'domcontentloaded' });
    result.staged = await page.evaluate(async () => {
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
      await put('meta', 'pack', {
        version: manifest.version,
        installedAt: Date.now(),
        source: 'url',
        totalBytes: bytes,
        files: names.map((n) => ({ name: n })),
      });
      return { count: names.length, bytes };
    });

    // #166 実験: 実機相当の復元プロファイルを seed(PKC3_O_SEED=<xcu file>)
    if (process.env.PKC3_O_SEED) {
      const xcu = await readFile(process.env.PKC3_O_SEED, 'utf8');
      await page.evaluate((v) => globalThis.localStorage.setItem('pkc3-office-profile', v), xcu);
      result.seeded = xcu.length;
    }

    // 実 user 経路で起動 → Writer
    await page.goto(`${base}/office/host.html`, { waitUntil: 'commit' });
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
    const win = (await page.evaluate(SURVEY))[0];
    result.window = win;
    if (!win) throw new Error('窓が 1 つも無い');
    await page.mouse.click(win.x + C_WRITER[0], win.y + C_WRITER[1]);
    await page.waitForTimeout(12_000);
    await page.screenshot({ path: join(SHOTS, '01-writer.png') });

    // ツール(T)→ オプション(メニューの**最終行**)
    const beforeMenu = await page.evaluate(SURVEY);
    await page.mouse.click(C_TOOLS[0], C_TOOLS[1]);
    await page.waitForTimeout(2500);
    const key = (w) => `${w.x},${w.y},${w.w},${w.h}`;
    const olds = new Set(beforeMenu.map(key));
    const menu = (await page.evaluate(SURVEY)).filter((w) => !olds.has(key(w))).pop();
    result.menu = menu ?? null;
    await page.screenshot({ path: join(SHOTS, '02-tools-menu.png') });
    if (!menu) throw new Error('ツールのメニューが開かない(座標 PKC3_O_TOOLS を疑う)');
    // オプション(O)… は最終行 ── 下端から半行(13px)上を押す
    await page.mouse.click(menu.x + 60, menu.y + menu.h - 13);
    await page.waitForTimeout(4000);
    const dlg = (await page.evaluate(SURVEY))
      .filter((w) => !olds.has(key(w)))
      .sort((a, b) => b.w * b.h - a.w * a.h)[0];
    result.dialog = dlg ?? null;
    await page.screenshot({ path: join(SHOTS, '03-options.png') });
    if (!dlg || dlg.w < 300) throw new Error('Options ダイアログが開かない(02/03 の screenshot を読む)');

    /**
     * 🔑 **対照群が先**(§4 ── これが無い回は以降の判定が全部無意味)。
     * 開いた直後の既定ペイン(ユーザーデータ = テキストのみ)は**正常に
     * 描かれる**(レポート #10/#11)── その色数を物差しにする。
     * 右ペイン = ダイアログの右 55%(ツリーと縁を除く)。
     */
    const pane = {
      x: Math.round(dlg.x + dlg.w * 0.42),
      y: Math.round(dlg.y + 70),
      width: Math.round(dlg.w * 0.54),
      height: Math.round(dlg.h - 140),
    };
    const ctrl = await page.screenshot({ clip: pane, path: join(SHOTS, '04-pane-default.png') });
    result.defaultPaneBytes = infoBytes(ctrl);

    /**
     * ツリーの「表示」へ。LibreOfficeDev 節は既定で展開されており、
     * 「表示」はその子(上から: ユーザーデータ / 全般 / 表示 / …)。
     * 位置はダイアログ相対で概ね x = dlg.x+70、y = dlg.y+112(3 行目)──
     * ずれたら 03 の screenshot を読んで PKC3_O_VIEW で合わせる。
     */
    const vKnob = (process.env.PKC3_O_VIEW ?? '70,112').split(',').map(Number);
    await page.mouse.click(dlg.x + vKnob[0], dlg.y + vKnob[1]);
    await page.waitForTimeout(3500);
    await page.screenshot({ path: join(SHOTS, '05-after-tree-click.png') });
    const shot1 = await page.screenshot({ clip: pane, path: join(SHOTS, '06-pane-view-0.png') });
    await page.waitForTimeout(1200);
    const shot2 = await page.screenshot({ clip: pane, path: join(SHOTS, '06-pane-view-1.png') });
    result.viewPaneBytes = [infoBytes(shot1), infoBytes(shot2)];

    // 判定は対照群比 ── 既定ペインの 1/4 未満なら「空」とみなす(向きだけを信頼)
    result.paneLooksBlank =
      Math.max(...result.viewPaneBytes) < result.defaultPaneBytes / 4;

    // ── #166-2: Escape で閉じる → host の停止面が出るか ──
    await page.keyboard.press('Escape');
    await page.waitForTimeout(4000);
    await page.screenshot({ path: join(SHOTS, '07-after-escape.png') });
    result.escapeCrash = await page.evaluate(() => {
      // ⚠ 文言の常在に空振りしない ── #msg は hidden 属性で畳まれて DOM に
      //   常在するので、**見えている**停止面だけを数える(1 回目の実測で
      //   textContent 検査が常在文言に満たされて偽陽性を出した)
      const msg = document.getElementById('msg');
      if (!msg || msg.hidden) return false;
      const t = msg.textContent ?? '';
      return t.includes('停止') || t.includes('memory access');
    });
    result.oobInConsole = lines.some((l) => l.includes('memory access out of bounds'));

    /**
     * ── #166 実験(2026-08-15): **同一セッションでの開き直し** ──
     * 元報告 #126 の文言は「2 回目以降」。1 回目の測定と Escape のあと、
     * PKC3_O_REOPEN=N 回だけ ツール → オプション を開き直し、毎回
     * 既定ペイン / 表示ペインの両方を測る(判定は毎回の対照群比 ── §4)。
     * 停止面が出たらそこで打ち切る(以降の測定は無意味)。
     */
    const reopenN = Number(process.env.PKC3_O_REOPEN ?? 0);
    result.reopens = [];
    for (let round = 1; round <= reopenN; round += 1) {
      if (result.escapeCrash) break;
      const r = { round };
      const before = await page.evaluate(SURVEY);
      const seen = new Set(before.map(key));
      await page.mouse.click(C_TOOLS[0], C_TOOLS[1]);
      await page.waitForTimeout(2500);
      const menu2 = (await page.evaluate(SURVEY)).filter((w) => !seen.has(key(w))).pop();
      if (!menu2) {
        r.error = 'メニューが開かない(#168 の dead click と同根の可能性)';
        result.reopens.push(r);
        await page.screenshot({ path: join(SHOTS, `08-reopen-${round}-nomenu.png`) });
        break;
      }
      await page.mouse.click(menu2.x + 60, menu2.y + menu2.h - 13);
      await page.waitForTimeout(4000);
      const dlg2 = (await page.evaluate(SURVEY))
        .filter((w) => !seen.has(key(w)))
        .filter((w) => w.w >= 300)
        .sort((a, b) => b.w * b.h - a.w * a.h)[0];
      if (!dlg2) {
        r.error = 'ダイアログが開かない';
        result.reopens.push(r);
        await page.screenshot({ path: join(SHOTS, `08-reopen-${round}-nodlg.png`) });
        break;
      }
      const pane2 = {
        x: Math.round(dlg2.x + dlg2.w * 0.42),
        y: Math.round(dlg2.y + 70),
        width: Math.round(dlg2.w * 0.54),
        height: Math.round(dlg2.h - 140),
      };
      r.defaultPaneBytes = infoBytes(
        await page.screenshot({ clip: pane2, path: join(SHOTS, `08-reopen-${round}-default.png`) }),
      );
      await page.mouse.click(dlg2.x + vKnob[0], dlg2.y + vKnob[1]);
      await page.waitForTimeout(3500);
      const s1 = await page.screenshot({
        clip: pane2,
        path: join(SHOTS, `08-reopen-${round}-view-0.png`),
      });
      await page.waitForTimeout(1200);
      const s2 = await page.screenshot({
        clip: pane2,
        path: join(SHOTS, `08-reopen-${round}-view-1.png`),
      });
      r.viewPaneBytes = [infoBytes(s1), infoBytes(s2)];
      r.blank = Math.max(...r.viewPaneBytes) < r.defaultPaneBytes / 4;
      await page.keyboard.press('Escape');
      await page.waitForTimeout(4000);
      r.escapeCrash = await page.evaluate(() => {
        const msg = document.getElementById('msg');
        if (!msg || msg.hidden) return false;
        const t = msg.textContent ?? '';
        return t.includes('停止') || t.includes('memory access');
      });
      result.reopens.push(r);
      if (r.escapeCrash) break;
    }
    result.profileLen = await page.evaluate(
      () => (globalThis.localStorage.getItem('pkc3-office-profile') ?? '').length,
    );
    if (process.env.PKC3_O_CAPTURE) {
      const v = await page.evaluate(() => globalThis.localStorage.getItem('pkc3-office-profile') ?? '');
      if (v) await writeFile(process.env.PKC3_O_CAPTURE, v);
    }
  } finally {
    result.console = lines.slice(-12);
    const text = JSON.stringify(result, null, 1);
    console.log(text);
    if (OUT) await writeFile(OUT, text);
    await browser.close();
    server.close();
  }
}

await main();
