/**
 * **コンボボックスの popup へのマウス配送**を実 user 経路で測る(#157)。
 *
 * ## なぜコンボか
 *
 * 実機レポート #8(2026-08-14)で、オプションの UI 言語コンボが
 * **マウスでは選択できず(2/2)、キーボード(↓ + Enter)では選択できた**。
 * メニューの再現は非決定的だったが、**コンボは再現率が高い** ── 当たりを引きに
 * 行くならこちらである。メニューとコンボは Qt では同じ popup window 機構。
 *
 * ## 何を 1 つ主張するか
 *
 * **「コンボの popup の項目をマウスで押したとき、値が変わるか」** ── これだけ。
 *
 * ## 観測点(CLAUDE.md §4 に従う)
 *
 * - 値が変わったか = **コンボ領域の切り抜き画像**の前後比較。⚠ 領域にカーソルの
 *   点滅は無いが、規律どおり**間隔をあけて 2 枚**撮り、集合で比べる
 * - popup の増減 = **数ではなく個体**(SURVEY の rect)で見る
 * - 🔑 **対照群**: 同じ popup をキーボード(↓ + Enter)で選ぶ。実機で「キーは
 *   通る」と確定しているので、**これが失敗する回は手順側が壊れている**
 *
 * 使い方:
 *   node build/office-wasm/make-pages-bundle.mjs <LO 展開先> /tmp/pages-out
 *   npm run build
 *   PKC3_DPR=2 node build/office-wasm/combo-popup-probe.mjs /tmp/pages-out out.json
 *
 * 座標の knob(CSS px、screenshot を読んで合わせる):
 *   PKC3_C_WRITER="133,315"   Start Center の Writer(窓相対)
 *   PKC3_C_COMBO="379,96"     フォントサイズコンボの▼(画面座標)
 *   PKC3_C_ITEM="0.5,2.5"     popup 内の押し先(幅比, 行数 ── 行高 ≈ popup.h/件数)
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, extname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const PACK = resolve(process.argv[2] ?? '/tmp/pages-out');
const OUT = process.argv[3] ?? '';
const DIST = resolve('dist');
const DPR = Number(process.env.PKC3_DPR ?? 1);
const SHOTS = `/tmp/pkc3-combo-shots-dpr${DPR}`;
const VIEWPORT = { width: 1280, height: 800 };

const C_WRITER = (process.env.PKC3_C_WRITER ?? '133,315').split(',').map(Number);
const C_COMBO = (process.env.PKC3_C_COMBO ?? '379,96').split(',').map(Number);
const C_ITEM = (process.env.PKC3_C_ITEM ?? '0.5,2.5').split(',').map(Number);

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
          res.writeHead(path === '/favicon.ico' ? 204 : 404, head);
          res.end('');
        });
    });
    server.listen(0, '127.0.0.1', () => ok(server));
  });
}

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

/** コンボ周辺の切り抜きを 2 枚(700ms あけて)撮り、hash の集合で返す。 */
async function comboHashes(page, tag) {
  const clip = { x: C_COMBO[0] - 90, y: C_COMBO[1] - 14, width: 120, height: 28 };
  // 🔴 撮る前に pointer を切り抜きの**外**へ駐め直す(着地前レビュー ⚠)。
  //    openPopup の最後のクリックで pointer は C_COMBO(= 切り抜きの内側)に
  //    駐まったままになる ── ▼の hover 描画が写れば、値が変わっていなくても
  //    hash が入れ替わり「変わった」と誤読する(kbd 対照群が空洞化する)。
  await page.mouse.move(C_COMBO[0] - 200, C_COMBO[1] + 300);
  await page.waitForTimeout(300);
  const hashes = [];
  for (let i = 0; i < 2; i += 1) {
    const buf = await page.screenshot({ clip, path: join(SHOTS, `crop-${tag}-${i}.png`) });
    hashes.push(createHash('sha1').update(buf).digest('hex').slice(0, 12));
    if (i === 0) await page.waitForTimeout(700);
  }
  return hashes;
}

/** popup を開く(3 回まで)。開いたら popup rect、開かなければ null。 */
async function openPopup(page, result, tag) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const before = await page.evaluate(SURVEY);
    await page.mouse.click(C_COMBO[0], C_COMBO[1]);
    await page.waitForTimeout(2500);
    const after = await page.evaluate(SURVEY);
    // ⚠ 増減は数でなく**個体**で見る(before に無い rect が現れたか)
    const key = (w) => `${w.x},${w.y},${w.w},${w.h}`;
    const olds = new Set(before.map(key));
    const fresh = after.filter((w) => !olds.has(key(w)));
    result[`open-${tag}-attempt`] = attempt;
    if (fresh.length > 0) {
      await page.screenshot({ path: join(SHOTS, `popup-${tag}.png`) });
      return fresh[fresh.length - 1];
    }
  }
  await page.screenshot({ path: join(SHOTS, `popup-${tag}-FAILED.png`) });
  return null;
}

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  await mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launchPersistentContext(`/tmp/pkc3-combo-${process.pid}`, {
    headless: true,
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: '/opt/pw-browsers/chromium',
  });
  const result = { dpr: DPR, coords: { writer: C_WRITER, combo: C_COMBO, item: C_ITEM } };
  const page = await browser.newPage();
  const lines = [];
  page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`.slice(0, 200)));

  try {
    // 仕込み(office-real-path-probe と同じ ── host.html は IDB しか読まない)
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

    // 実 user 経路で起動
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
    await page.screenshot({ path: join(SHOTS, '00-booted.png') });

    // Writer を開く(Start Center の一覧・窓相対)
    await page.mouse.click(win.x + C_WRITER[0], win.y + C_WRITER[1]);
    await page.waitForTimeout(12_000);
    await page.screenshot({ path: join(SHOTS, '01-writer.png') });

    // 🔑 対照群の対照 ── 文字が入ること(届いていない回は以降が全部無意味)
    await page.mouse.click(win.x + Math.round(win.w / 2), win.y + Math.round(win.h / 2));
    await page.keyboard.type('abc');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(SHOTS, '02-typed.png') });

    // ── ① マウスでの選択 ──
    result.before = await comboHashes(page, 'before');
    const popup1 = await openPopup(page, result, 'mouse');
    result.popupMouse = popup1;
    if (popup1) {
      const px = popup1.x + Math.round(popup1.w * C_ITEM[0]);
      const py = popup1.y + Math.round(C_ITEM[1] * 26);
      // 🔴 押し先が popup の**中**であることを先に確かめる(着地前レビュー ⚠)。
      //    行高 26px 決め打ちなので、低い popup では外へ落ち「選択されなかった =
      //    修正が効いていない」という**偽の赤**を黙って返す ── 黙らせず止める。
      if (py >= popup1.y + popup1.h || px >= popup1.x + popup1.w) {
        throw new Error(
          `PKC3_C_ITEM の押し先 (${px},${py}) が popup の外(rect ${JSON.stringify(popup1)})── C_ITEM を下げること`,
        );
      }
      result.mouseClickAt = [px, py];
      /**
       * 🔴 **event がどの要素へ落ちるかを計装してから押す**(#157 の本丸)。
       *
       * Qt wasm は pointer を **DIV(窓の器)**で拾う(io-layer-probe の実測)。
       * popup の DIV に落ちていれば Qt の中の話、**main 窓の DIV に落ちていれば
       * DOM の重なり(z-index / pointer-events)の話** ── 直す層がここで分かれる。
       * ⚠ composedPath の先頭(実際の的)を記録する ── shadow DOM 越しでも本物が出る。
       */
      result.hitTest = await page.evaluate(([x, y]) => {
        const g = /** @type {any} */ (globalThis);
        g.__hits = [];
        const label = (el) =>
          el && el.tagName
            ? `${el.tagName}${el.id ? '#' + el.id : ''}.${(el.className || '').toString().split(' ').slice(0, 2).join('.')}`
            : String(el);
        for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
          g.document.addEventListener(
            t,
            (e) => {
              g.__hits.push({ t, target: label(e.composedPath()[0]), x: e.clientX, y: e.clientY });
            },
            { capture: true },
          );
        }
        // elementFromPoint は shadow を貫かない ── 貫くまで潜る
        let el = g.document.elementFromPoint(x, y);
        const chain = [];
        while (el) {
          chain.push(label(el));
          const deeper = el.shadowRoot && el.shadowRoot.elementFromPoint(x, y);
          if (!deeper || deeper === el) break;
          el = deeper;
        }
        return chain;
      }, [px, py]);
      /**
       * 🔴 **押下と解放を分ける**(PKC3_SPLIT=1)。「閉じたのはどちらか」を確定する ──
       * down で閉じるなら Qt の press 側の判定(grab / 外側判定)、up まで生きて
       * いるなら release 側の配送、と直す場所が分かれる。
       */
      if (process.env.PKC3_SPLIT === '1') {
        await page.mouse.move(px, py);
        await page.mouse.down();
        await page.waitForTimeout(600);
        result.betweenDownUp = {
          windows: await page.evaluate(SURVEY),
          hits: await page.evaluate(() => /** @type {any} */ (globalThis).__hits),
        };
        await page.screenshot({ path: join(SHOTS, '03a-between-down-up.png') });
        await page.mouse.up();
      } else {
        await page.mouse.click(px, py);
      }
      result.hits = await page.evaluate(() => /** @type {any} */ (globalThis).__hits);
      await page.waitForTimeout(2500);
      await page.screenshot({ path: join(SHOTS, '03-after-mouse-pick.png') });
      result.afterMouse = await comboHashes(page, 'after-mouse');
      result.popupGoneAfterMouse = (await page.evaluate(SURVEY)).length <= 1;
      // 値が変わったか = before の集合と after の集合が交わらない
      result.mouseChanged = !result.afterMouse.some((h) => result.before.includes(h));
    }

    // ── ② キーボードでの選択(対照群 ── 実機で「キーは通る」と確定済み)──
    const popup2 = await openPopup(page, result, 'kbd');
    result.popupKbd = popup2;
    if (popup2) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(400);
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(400);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2500);
      await page.screenshot({ path: join(SHOTS, '04-after-kbd-pick.png') });
      result.afterKbd = await comboHashes(page, 'after-kbd');
      const seen = [...result.before, ...(result.afterMouse ?? [])];
      result.kbdChanged = !result.afterKbd.some((h) => seen.includes(h));
    }
  } finally {
    result.console = lines.slice(-15);
    await page.screenshot({ path: join(SHOTS, '99-final.png') }).catch(() => {});
    await browser.close().catch(() => {});
    server.close();
  }

  const text = JSON.stringify(result, null, 1);
  console.log(text);
  if (OUT) await writeFile(OUT, text);
}

await main();
