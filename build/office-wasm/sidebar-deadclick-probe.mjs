/**
 * #167(サイドバーで停止)と #168(Options キャンセル後の dead click)の headless 再現器。
 *
 * ⚠ **1 回の boot で 2 つのことを主張する**が、判定は別々に出す(粒度の規律:
 *   落ちたときに何が壊れたか名前で言える)。前段が crash したら後段は測らない
 *   ── 停止した器の上で押しても意味が無いので、`skipped` と明記して打ち切る。
 *
 * ## 観測点(§4)
 *
 * - **crash**: `#msg` が**見えている**こと(hidden で常在するので textContent 検査は
 *   空振りする)+ console の `memory access out of bounds`
 * - **押せたか**: 窓の**枚数**ではなく**個体**(rect の鍵)で見る ── メニューが閉じて
 *   ダイアログが開くと ±1 が相殺して「効かなかった」と誤読する(2026-08-14)
 * - 🔑 **対照群を先に置く**: #168 は「Options を開く前に同じ操作が効くこと」を
 *   先に測る ── これが届いていない回は、後段の「効かない」は何も言っていない
 *
 * 使い方:
 *   node build/office-wasm/sidebar-deadclick-probe.mjs <配信ディレクトリ> [out.json]
 *
 * 座標の調整(既定は #169 のフォント修正**後**の実グリフ幅に合わせてある ──
 * 豆腐だった頃より右へずれている):
 *   PKC3_S_VIEW="210,71"   表示(V)(画面座標)
 *   PKC3_S_TOOLS="681,71"  ツール(T)(画面座標)
 *   PKC3_S_SIDEBAR="60,N"  表示メニュー内のサイドバー行(メニュー相対。N は上端からの px)
 *   PKC3_S_CANCEL="-150,-28"  Options のキャンセル(ダイアログの**右下**からの相対)
 *   PKC3_S_SC_FILE / PKC3_S_SC_TOOLS  Start Center の ファイル(F) / ツール(T)
 *
 * 🔴 **面を取り違えない**(2026-08-15 に踏んだ)。#168 の報告は **Start Center** の
 *   タイルが無反応になる話であって、Writer のメニューではない ── Writer で測った
 *   「再現しない」は、**別の面の話**なので何も言っていない。だから段① は
 *   Writer を開く**前**に、Start Center の上で完結させる。
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const PACK = resolve(process.argv[2] ?? '/tmp/pages-new');
const OUT = process.argv[3] ?? '';
const DIST = resolve('dist');
// ⚠ 置き場は**一式ごとに分ける** ── 共有すると対照群(旧一式)の絵を上書きして、
//   比べる相手を自分で消す
const SHOTS = `/tmp/pkc3-sidebar-shots/${PACK.split('/').pop()}`;
const VIEWPORT = { width: 1280, height: 800 };

const C_WRITER = [133, 315];
const C_VIEW = (process.env.PKC3_S_VIEW ?? '210,71').split(',').map(Number);
const C_TOOLS = (process.env.PKC3_S_TOOLS ?? '681,71').split(',').map(Number);
// 実測(1 巡目の 02-view-menu.png)── サイドバー(P) はメニュー上端から 565px
const C_SIDEBAR = (process.env.PKC3_S_SIDEBAR ?? '60,565').split(',').map(Number);
const C_CANCEL = (process.env.PKC3_S_CANCEL ?? '-150,-28').split(',').map(Number);
// Start Center のメニューバーは 3 項目(ファイル(F) / ツール(T) / ヘルプ(H))
const C_SC_FILE = (process.env.PKC3_S_SC_FILE ?? '57,71').split(',').map(Number);
const C_SC_TOOLS = (process.env.PKC3_S_SC_TOOLS ?? '135,71').split(',').map(Number);

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

const key = (w) => `${w.x},${w.y},${w.w},${w.h}`;

/** 見えている停止面だけを数える(hidden の常在文言に空振りしない)。 */
const CRASHED = () => {
  const msg = document.getElementById('msg');
  if (!msg || msg.hidden) return false;
  const t = msg.textContent ?? '';
  return t.includes('停止') || t.includes('memory access');
};

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  await mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launchPersistentContext(`/tmp/pkc3-sidebar-${process.pid}`, {
    headless: true,
    viewport: VIEWPORT,
    deviceScaleFactor: Number(process.env.PKC3_S_DPR ?? 1),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: '/opt/pw-browsers/chromium',
  });
  const result = {
    coords: { view: C_VIEW, tools: C_TOOLS, sidebar: C_SIDEBAR, cancel: C_CANCEL },
    sidebar: {},
    deadClick: {},
  };
  const page = await browser.newPage();
  const lines = [];
  page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`.slice(0, 200)));
  const oob = () => lines.some((l) => l.includes('memory access out of bounds'));

  /**
   * 絵を残す。⚠ **失敗しても計測ごと落とさない**(2 巡目で実際に踏んだ ──
   * 1 枚目の screenshot が 30 秒 timeout し、判定 2 件が両方とも空で終わった)。
   * 🔑 しかも「撮れなかった」= **その瞬間ページが応答していない**という観測結果
   *   なので、捨てずに記録する(#167 / #168 は「固まる」系の疑いである)。
   */
  const shoot = async (name) => {
    try {
      await page.screenshot({ path: join(SHOTS, name), timeout: 15_000 });
      return true;
    } catch {
      (result.unresponsiveAt ??= []).push(name);
      return false;
    }
  };

  /** メニューを開いて、**新しく現れた窓**を返す(個体で見る ── 枚数では見ない)。 */
  const openMenu = async (xy, shot) => {
    const before = new Set((await page.evaluate(SURVEY)).map(key));
    await page.mouse.click(xy[0], xy[1]);
    await page.waitForTimeout(2500);
    if (shot) await shoot(shot);
    return (await page.evaluate(SURVEY)).filter((w) => !before.has(key(w))).pop() ?? null;
  };

  try {
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
      const put = (store, k, val) =>
        new Promise((res, rej) => {
          const t = db.transaction(store, 'readwrite');
          t.objectStore(store).put(val, k);
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
      return { count: names.length, bytes, version: manifest.version };
    });

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
    await shoot('00-startcenter.png');

    // ───── #168: Start Center の dead click(**報告どおりの面**) ─────
    // 🔴 ここを Writer で測ると別の面の話になる(2026-08-15 に踏んだ)
    {
      const dc = result.deadClick;
      // 対照群: Options を開く**前**に、Start Center のクリックが届くこと
      const pre = await openMenu(C_SC_FILE, '00a-sc-file-menu.png');
      dc.scControlMenuOpened = Boolean(pre);
      if (pre) await page.keyboard.press('Escape');
      await page.waitForTimeout(1500);

      const beforeAll = new Set((await page.evaluate(SURVEY)).map(key));
      const toolsMenu = await openMenu(C_SC_TOOLS, '00b-sc-tools-menu.png');
      dc.scToolsMenuOpened = Boolean(toolsMenu);
      if (toolsMenu) {
        await page.mouse.click(toolsMenu.x + 60, toolsMenu.y + toolsMenu.h - 13);
        await page.waitForTimeout(4000);
        const dlg = (await page.evaluate(SURVEY))
          .filter((w) => !beforeAll.has(key(w)))
          .filter((w) => w.w >= 300)
          .sort((a, b) => b.w * b.h - a.w * a.h)[0];
        dc.scDialog = dlg ?? null;
        await shoot('00c-sc-options.png');
        if (dlg) {
          await page.mouse.click(dlg.x + dlg.w + C_CANCEL[0], dlg.y + dlg.h + C_CANCEL[1]);
          await page.waitForTimeout(4000);
          await shoot('00d-sc-after-cancel.png');
          dc.scDialogClosed = (await page.evaluate(SURVEY)).every((w) => key(w) !== key(dlg));
          /**
           * 🔑 **観測点**: タイルを押しても窓の**枚数は増えない**(Start Center が
           * Writer に化ける)ので、枚数でも rect でも判定できない。代わりに
           * **Writer にしか無いメニュー**(表示(V) の位置)が開くかで見る ──
           * Start Center のメニューバーは 3 項目しかなく、その x には何も無い。
           */
          await page.mouse.click(win.x + C_WRITER[0], win.y + C_WRITER[1]);
          await page.waitForTimeout(12_000);
          await shoot('00e-sc-after-tile.png');
          const viewProbe = await openMenu(C_VIEW, '00f-sc-view-menu.png');
          dc.writerOpenedAfterCancel = Boolean(viewProbe);
          dc.reproducedOnStartCenter =
            Boolean(dc.scControlMenuOpened) && Boolean(dlg) && !viewProbe;
          if (viewProbe) await page.keyboard.press('Escape');
          await page.waitForTimeout(1500);
        }
      }
    }

    // 上の段で Writer が開いていなければ、ここで開く(#167 の前提)
    const hasWriter = result.deadClick.writerOpenedAfterCancel === true;
    if (!hasWriter) {
      await page.mouse.click(win.x + C_WRITER[0], win.y + C_WRITER[1]);
      await page.waitForTimeout(12_000);
    }
    await shoot('01-writer.png');
    result.crashedAfterBoot = await page.evaluate(CRASHED);

    // ───────────────────────── #167: サイドバー ─────────────────────────
    // 🔑 対照群 = 「表示(V) が開くこと」。開かない回は、以降の判定が無意味
    const viewMenu = await openMenu(C_VIEW, '02-view-menu.png');
    result.sidebar.menuOpened = Boolean(viewMenu);
    result.sidebar.menu = viewMenu;
    if (viewMenu) {
      const beforeItem = new Set((await page.evaluate(SURVEY)).map(key));
      await page.mouse.click(viewMenu.x + C_SIDEBAR[0], viewMenu.y + C_SIDEBAR[1]);
      await page.waitForTimeout(6000);
      await shoot('03-after-sidebar.png');
      result.sidebar.crashed = await page.evaluate(CRASHED);
      result.sidebar.oob = oob();
      const after = await page.evaluate(SURVEY);
      result.sidebar.windowsAfter = after.length;
      /**
       * 🔑 **空振りの検出**(1 巡目で実際に踏んだ)。サイドバーは終端の項目なので、
       * 押せばメニューは**閉じる**。新しい窓が出たなら、それは**サブメニューを持つ
       * 別の行**を押したということ ── 「停止しなかった」は何も言っていない。
       */
      result.sidebar.unexpectedSubmenu = after.some((w) => !beforeItem.has(key(w)));
      result.sidebar.menuClosed = !after.some((w) => key(w) === key(viewMenu));
      result.sidebar.verdictValid =
        !result.sidebar.unexpectedSubmenu && result.sidebar.menuClosed;
    } else {
      result.sidebar.note = '表示メニューが開かない ── 座標(PKC3_S_VIEW)か dead click を疑う';
    }

    // ─── 参考: 同じことを Writer の面でも見る(#168 本体は Start Center 段) ───
    if (result.sidebar.crashed) {
      result.deadClick.writerStageSkipped = '前段(#167)で停止したので測らない';
    } else {
      // 対照群①: Options を開く**前**に、ツール(T) が開くこと
      const beforeAll = new Set((await page.evaluate(SURVEY)).map(key));
      const before = await openMenu(C_TOOLS, '04-tools-before.png');
      result.deadClick.controlMenuOpened = Boolean(before);
      if (before) {
        // オプション… は最終行(下端から半行上)
        await page.mouse.click(before.x + 60, before.y + before.h - 13);
        await page.waitForTimeout(4000);
        /**
         * 🔴 **「新しく現れた窓」から選ぶ**(1 巡目はここを落として**本体窓**を
         * Options と誤認し、以降の判定が全部無意味になった ── §1 の空振り)。
         * ⚠ 「大きい窓」で選ぶと本体窓が常に勝つ ── 面積は代替物である。
         */
        const dlg = (await page.evaluate(SURVEY))
          .filter((w) => !beforeAll.has(key(w)))
          .filter((w) => w.w >= 300)
          .sort((a, b) => b.w * b.h - a.w * a.h)[0];
        result.deadClick.dialog = dlg ?? null;
        result.deadClick.dialogIsMainWindow = Boolean(
          dlg && dlg.w === win.w && dlg.h === win.h,
        );
        await shoot('05-options.png');
        if (dlg) {
          // 🔴 **キャンセルのボタンで閉じる**(Escape ではない ── #168 の報告は
          //    「キャンセル後」であり、Escape 経路は #166 側で測っている)
          await page.mouse.click(dlg.x + dlg.w + C_CANCEL[0], dlg.y + dlg.h + C_CANCEL[1]);
          await page.waitForTimeout(4000);
          await shoot('06-after-cancel.png');
          result.deadClick.crashedAfterCancel = await page.evaluate(CRASHED);
          result.deadClick.dialogClosed =
            (await page.evaluate(SURVEY)).every((w) => key(w) !== key(dlg));
          // 実験: **同じ操作**(ツール(T))がまだ効くか
          const after = await openMenu(C_TOOLS, '07-tools-after.png');
          result.deadClick.menuOpensAfterCancel = Boolean(after);
          result.deadClick.reproduced = Boolean(before) && !after;
          if (after) await page.keyboard.press('Escape');
        }
      }
    }
    result.oobInConsole = oob();
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
