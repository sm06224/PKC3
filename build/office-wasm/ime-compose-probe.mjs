/**
 * **日本語入力(変換)が Office の文書に届くか**を実測する probe(#1438)。
 *
 * ## 何を主張する probe か
 *
 * 1. 文書を開いて版面を押した後、**どの要素に焦点が在るか**(Qt の入力用 `<input>` / canvas / body)と、
 *    `<input>` の `data-pkc-ime`(Qt の早期 return の 4 条件)。
 * 2. CDP の `Input.imeSetComposition` → `Input.insertText` で「にほんご」→「日本語」を流したとき、
 *    **composition の event がどの要素に着いたか**と、**文書に字が入ったか**(版面の画素 + Ctrl+A/Ctrl+C の外の値)。
 *
 * ## 腕(PKC3_ARMS)
 *
 * | 腕 | 手 |
 * |---|---|
 * | `noclick` | 開いた直後(版面を押さない。caret は先頭)に IME を流す |
 * | `click`   | 版面の本文を 1 回押してから IME を流す |
 * | `menu`    | 版面を押した後、メニューバーを Alt+E で開いて Escape で閉じ(焦点の往復)、それから IME を流す |
 * | `menu-esc2` | `menu` と同じだが Escape を 1.5 秒あけて 2 回押す(1 回で焦点がメニューバーに残るなら、2 回目で文書へ戻るか) |
 * | `menu-click` | `menu`(Escape 1 回)の後、`click` 腕と同じ点で版面を押してから IME を流す |
 * | `force`   | 版面を押した後、`<input>` を **page から `focus()`** してから IME を流す
 *               (「焦点さえ在れば下流は通る」の対照群。焦点が移らないことと下流が壊れていることを割る) |
 *
 * 全部 **半角の `abc` を先に打つ**(入力そのものが LO に届いているかの対照群)。
 *
 * 使い方:
 *   node build/office-wasm/make-pages-bundle.mjs <LO 展開先> /tmp/pack     # 日本語フォントは <展開先>/inject/*.ttf
 *   python3 build/office-wasm/make-clipboard-fixtures.py /tmp/fx           # text.odt を使う
 *   node build/office-wasm/ime-compose-probe.mjs /tmp/pack /tmp/fx out.json [回数=1]
 *
 *   PKC3_ARMS=noclick,click,force   腕を絞る
 *   PKC3_DOC=text.odt               開く文書(Calc は sheet.ods を fx に置く)
 *   PKC3_SHOTDIR=<dir>              各段の PNG(⚠ 自作の fixture を開いたときだけ)
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { armWatchdog } from './probe-watchdog.mjs';

const PACK = resolve(process.argv[2] ?? '');
const FX = resolve(process.argv[3] ?? '');
const OUT = process.argv[4] ?? '';
const ROUNDS = Number(process.argv[5] ?? 1);
const DIST = resolve(process.env.PKC3_DIST ?? 'public');
const SHOTDIR = process.env.PKC3_SHOTDIR ?? '';
const DOC = process.env.PKC3_DOC ?? 'text.odt';
const ARMS = (process.env.PKC3_ARMS ?? 'noclick,click,force').split(',');
const ROUND_SEC = Number(process.env.PKC3_ROUND_SEC ?? 300);
/** `1` なら `office-popup-keys.js`(#1360 の直し)を空にして起こす = 「直る前」の腕(ctx-* 腕の対照群)。 */
const WITHOUT_POPUPKEYS = process.env.PKC3_WITHOUT_POPUPKEYS === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.metadata': 'application/json', '.gz': 'application/gzip', '.ttf': 'font/ttf', '.data': 'application/octet-stream',
};
const server = await new Promise((ok) => {
  const s = createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0];
    const head = {
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store',
    };
    const f = p.startsWith('/office-pack/') ? join(PACK, p.slice('/office-pack/'.length)) : join(DIST, p);
    readFile(f)
      .then((b) => { res.writeHead(200, { ...head, 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream' }); res.end(b); })
      .catch(() => { res.writeHead(404, head); res.end(); });
  });
  s.listen(0, '127.0.0.1', () => ok(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const safeLine = (s) => (/[^\x20-\x7e]/.test(s) ? null : s.slice(0, 160));

const CANVAS_BOX = `(() => {
  let best = null;
  const walk = (n) => { for (const el of n.querySelectorAll('*')) {
    if (el.tagName === 'CANVAS' && el.width > 0) {
      const r = el.getBoundingClientRect();
      if (!best || r.width > best.w) best = { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  return best;
})()`;

/** 入力要素と焦点(shadow を潜る)。`activeChain` = document から shadow を降りた activeElement の連なり。 */
const DEEP = `(() => {
  const inputs = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      const t = el.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || el.isContentEditable) {
        const r = el.getBoundingClientRect();
        inputs.push({ tag: t, w: Math.round(r.width), h: Math.round(r.height),
          focused: (el.getRootNode().activeElement === el),
          ime: el.getAttribute('data-pkc-ime'), value: (el.value ?? '').slice(0, 20) });
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const chain = [];
  let r = document;
  for (let i = 0; i < 6 && r && r.activeElement; i += 1) {
    const a = r.activeElement;
    chain.push(a.tagName + (a.id ? '#' + a.id : ''));
    r = a.shadowRoot || null;
  }
  return { inputs, activeChain: chain, hasFocus: document.hasFocus() };
})()`;

/** 全 composition / input event を capture で記録(shadow の中の target も composedPath で拾う)。 */
const EVSPY = `(() => {
  const log = (globalThis.__ime = []);
  const t0 = Date.now();
  for (const n of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
    window.addEventListener(n, (e) => {
      const p = e.composedPath ? e.composedPath()[0] : e.target;
      log.push({ dt: Date.now() - t0, type: n, target: p && p.tagName, data: e.data ?? null, inputType: e.inputType ?? null });
    }, true);
  }
})()`;

const row = (arm, n) => ({ arm, n, steps: [], faults: [], console: [] });
const result = { how: { probe: 'build/office-wasm/ime-compose-probe.mjs', pack: PACK, doc: DOC, arms: ARMS }, rounds: [] };
let current = null;
const wd = armWatchdog({ result, out: OUT, limitSec: ARMS.length * ROUNDS * ROUND_SEC + 300, browser: () => current });
const flush = async () => { if (OUT) await writeFile(OUT, JSON.stringify(result, null, 1)); };

async function oneRound(arm, n) {
  const r = row(arm, n);
  const docB64 = (await readFile(join(FX, DOC))).toString('base64');
  const ctx = await chromium.launchPersistentContext(`${tmpdir()}/pkc3-imec-${process.pid}-${arm}-${n}`, {
    headless: true, viewport: { width: 1280, height: 800 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium',
  });
  current = ctx;
  const t0 = Date.now();
  const step = (name, extra = {}) => r.steps.push({ at: Date.now() - t0, name, ...extra });
  const page = await ctx.newPage();
  if (WITHOUT_POPUPKEYS) {
    await page.route('**/office-popup-keys.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    r.withoutPopupKeys = true;
  }
  try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write']); } catch { /* */ }
  page.on('console', (m) => {
    const t = safeLine(`[${m.type()}] ${m.text()}`);
    if (t !== null && r.console.length < 30) r.console.push(`[+${Date.now() - t0}ms]${t}`);
  });
  page.on('pageerror', (e) => {
    if (/memory access out of bounds|RuntimeError|Aborted\(/.test(String(e))) r.faults.push({ at: Date.now() - t0, text: String(e).split('\n')[0].slice(0, 120) });
  });
  const alive = () => Promise.race([page.evaluate('1').then(() => true, () => false), new Promise((ok) => setTimeout(() => ok(false), 8000))]);
  const shot = async (label) => {
    if (!SHOTDIR) return;
    await mkdir(SHOTDIR, { recursive: true });
    try { await page.screenshot({ path: join(SHOTDIR, `${arm}-${n}-${label}.png`) }); } catch { /* */ }
  };
  const framesOf = async (clip, k = 3) => {
    const set = new Set();
    for (let i = 0; i < k; i += 1) {
      const png = await Promise.race([page.screenshot({ clip }), new Promise((ok) => setTimeout(() => ok(null), 20000))]);
      if (png === null) return null;
      set.add(createHash('sha256').update(png).digest('hex').slice(0, 12));
      await page.waitForTimeout(400);
    }
    return [...set];
  };
  const swapped = (a, b) => (a === null || b === null ? null : b.every((h) => !a.includes(h)));
  const readClip = () => Promise.race([
    page.evaluate(`navigator.clipboard.readText().catch((e) => 'ERR:' + e.name)`),
    new Promise((ok) => setTimeout(() => ok('HUNG'), 15000)),
  ]).catch(() => 'ERR');
  const deep = () => Promise.race([page.evaluate(DEEP), new Promise((ok) => setTimeout(() => ok({ hung: true }), 8000))]);

  try {
    step('一式を IDB へ');
    await page.goto(`${base}/office/host.html`, { waitUntil: 'domcontentloaded' });
    r.staged = await page.evaluate(async () => {
      const { fetch, indexedDB } = globalThis;
      const grab = async (path) => { const x = await fetch(path); if (!x.ok) throw new Error(`${path} HTTP ${x.status}`); return x; };
      const m = await (await grab('/office-pack/pack.json')).json();
      const names = [...m.files, ...m.fonts];
      const db = await new Promise((res, rej) => {
        const q = indexedDB.open('pkc3-office-pack', 1);
        q.onupgradeneeded = () => {
          if (!q.result.objectStoreNames.contains('files')) q.result.createObjectStore('files');
          if (!q.result.objectStoreNames.contains('meta')) q.result.createObjectStore('meta');
        };
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
      const put = (s, k, v) => new Promise((res, rej) => {
        const t = db.transaction(s, 'readwrite'); t.objectStore(s).put(v, k);
        t.oncomplete = () => res(); t.onerror = () => rej(t.error);
      });
      let bytes = 0;
      for (const nm of names) {
        const b = new globalThis.Blob([await (await grab(`/office-pack/${nm}`)).arrayBuffer()]);
        bytes += b.size; await put('files', nm, b);
      }
      await put('meta', 'pack', { version: m.version, installedAt: Date.now(), source: 'url', totalBytes: bytes, files: names.map((nm) => ({ name: nm })) });
      return { count: names.length, version: m.version, coi: globalThis.crossOriginIsolated };
    });

    await page.addInitScript(EVSPY);
    await page.addInitScript(({ doc, name }) => {
      const ch = new globalThis.BroadcastChannel('pkc3-office');
      ch.onmessage = (ev) => {
        const d = ev.data;
        if (!d || !d.pkc3Office) return;
        if (d.pkc3Office === 'ready-for-document') {
          const raw = globalThis.atob(doc); const u8 = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i += 1) u8[i] = raw.charCodeAt(i);
          ch.postMessage({ pkc3Office: 'document', payload: { name, bytes: u8 } });
        }
      };
    }, { doc: docB64, name: DOC });

    step('文書を渡して開く');
    await page.goto(`${base}/office/host.html?await-doc=1&name=${encodeURIComponent(DOC)}`, { waitUntil: 'commit' });
    let opened = null;
    for (let i = 0; i < 40 && opened === null; i += 1) {
      await page.waitForTimeout(3000);
      try {
        const x = await Promise.race([
          page.evaluate((NAME) => {
            const titles = [];
            const wt = (node) => { for (const el of node.querySelectorAll('*')) { if (el.shadowRoot) wt(el.shadowRoot); else if (el.children.length === 0) titles.push(el.textContent ?? ''); } };
            const screen = document.getElementById('screen'); if (screen) wt(screen);
            const all = titles.join(' ');
            return { docOpen: all.includes(NAME), loTitle: /LibreOffice/i.test(all) };
          }, DOC),
          new Promise((_, rej) => setTimeout(() => rej(new Error('unresponsive')), 4000)),
        ]);
        if (x.docOpen && x.loTitle) opened = { atMs: Date.now() - t0 };
      } catch { /* */ }
      if (r.faults.length) break;
    }
    r.opened = opened;
    if (opened === null) { r.undecidable = '文書が開かなかった'; return r; }
    await page.bringToFront();
    await page.waitForTimeout(4000);
    step('開いた', { deep: await deep() });
    await shot('1-opened');
    const box = await page.evaluate(CANVAS_BOX);
    if (!box) { r.undecidable = 'canvas が無い'; return r; }
    const clip = { x: box.x, y: box.y, width: box.w, height: box.h };

    if (arm === 'click' || arm === 'force' || arm === 'menu' || arm === 'menu-esc2' || arm === 'menu-click' || arm === 'refocus' || arm === 'refocus-click') {
      // 本文の字の上(text.odt は 1 行目。Calc は A1 付近)
      await page.mouse.click(box.x + box.w * 0.3, box.y + box.h * 0.31);
      await page.waitForTimeout(2500);
      step('版面を押した', { deep: await deep() });
    }
    if (arm === 'refocus' || arm === 'refocus-click') {
      // 窓を離れて戻る(canvas の blur → focus)。Qt の焦点窓が変わり setFocusObject が再び走るか
      r.refocus = await page.evaluate(`(() => {
        let c = null;
        const walk = (n) => { for (const e of n.querySelectorAll('*')) { if (e.tagName === 'CANVAS' && e.width > 0 && !c) c = e; if (e.shadowRoot) walk(e.shadowRoot); } };
        walk(document);
        if (!c) return { found: false };
        c.blur();
        return { found: true, tabindex: c.getAttribute('tabindex') };
      })()`);
      await page.waitForTimeout(800);
      step('canvas を blur した', { deep: await deep() });
      await page.evaluate(`(() => {
        let c = null;
        const walk = (n) => { for (const e of n.querySelectorAll('*')) { if (e.tagName === 'CANVAS' && e.width > 0 && !c) c = e; if (e.shadowRoot) walk(e.shadowRoot); } };
        walk(document);
        c.focus();
      })()`);
      await page.waitForTimeout(1500);
      step('canvas を focus した', { deep: await deep() });
    }
    if (arm === 'menu' || arm === 'menu-esc2' || arm === 'menu-click') {
      // 焦点の移動(メニューを開いて閉じる)で Qt の setFocusObject が再び走るか
      await page.keyboard.press('Alt+e');
      await page.waitForTimeout(1500);
      step('メニューを開いた', { deep: await deep() });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1500);
      step('メニューを閉じた', { deep: await deep() });
      if (arm === 'menu-esc2') {
        // 2 回目の Escape(メニューバーに残った焦点が文書へ戻るか)
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1500);
        step('2 回目の Escape の後', { deep: await deep() });
      }
      if (arm === 'menu-click') {
        // 1 回の Escape の後に本文を押す(`click` 腕と同じ点)
        await page.mouse.click(box.x + box.w * 0.3, box.y + box.h * 0.31);
        await page.waitForTimeout(2500);
        step('メニューを閉じた後に版面を押した', { deep: await deep() });
      }
    }
    if (!(await alive())) { r.undecidable = '押した後に固まった'; return r; }

    // 対照群: 半角を打つ(入力が LO に届いているか)
    const fA = await framesOf(clip);
    await page.keyboard.type('abc', { delay: 120 });
    await page.waitForTimeout(1500);
    const fB = await framesOf(clip);
    r.asciiArrived = swapped(fA, fB);
    step('abc を打った', { deep: await deep() });

    if (arm.startsWith('ctx')) {
      // #1360: 右クリックのメニューと、日本語入力・メニューの鍵(mnemonic)。本文を全部選んでから右クリックする。
      return await ctxArm({ arm, n, r, page, ctx, box, clip, step, shot, framesOf, swapped, readClip, deep });
    }

    if (arm === 'force') {
      r.forced = await page.evaluate(`(() => {
        let el = null;
        const walk = (n) => { for (const e of n.querySelectorAll('*')) { if (e.tagName === 'INPUT') el = el || e; if (e.shadowRoot) walk(e.shadowRoot); } };
        walk(document);
        if (!el) return { found: false };
        el.focus();
        return { found: true, focused: el.getRootNode().activeElement === el };
      })()`);
      await page.waitForTimeout(500);
      step('input を focus した', { deep: await deep() });
    }

    // IME を流す(CDP)
    await page.evaluate('globalThis.__ime.length = 0');
    const cdp = await ctx.newCDPSession(page);
    const f0 = await framesOf(clip);
    for (const t of ['に', 'にほ', 'にほん', 'にほんご']) {
      await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
      await page.waitForTimeout(250);
    }
    const fMid = await framesOf(clip);
    step('変換中(にほんご)', { deep: await deep() });
    await shot('3-composing');
    await cdp.send('Input.insertText', { text: '日本語' });
    await page.waitForTimeout(1500);
    const f1 = await framesOf(clip);
    r.imePreeditShown = swapped(f0, fMid);
    r.imeCommitChanged = swapped(fMid, f1);
    r.imeNetChanged = swapped(f0, f1);
    step('確定(日本語)', { deep: await deep() });
    await shot('4-committed');
    r.imeEvents = await page.evaluate('globalThis.__ime.slice(0, 40)');

    // 文書の中身を外へ(Ctrl+A → Ctrl+C → 外を読む)
    await page.evaluate(`navigator.clipboard.writeText('SEED-${arm}-${n}')`).catch(() => {});
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(800);
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(2500);
    r.clipboardAfter = await readClip();
    r.clipHasJa = typeof r.clipboardAfter === 'string' && r.clipboardAfter.includes('日本語');
    r.clipHasAbc = typeof r.clipboardAfter === 'string' && r.clipboardAfter.includes('abc');
    return r;
  } catch (e) {
    r.error = String(e).split('\n')[0].slice(0, 200);
    return r;
  } finally {
    try { await ctx.close(); } catch { /* */ }
  }
}

/**
 * #1360 右クリックのメニューと日本語入力。腕(`ctx-*`):
 *
 * | 腕 | 手 |
 * |---|---|
 * | `ctx-menu`     | 全部選ぶ → 右クリック → **鍵を普通に押す**(`PKC3_CTX_KEY`、既定 `y` = 日本語のメニューの「コピー(Y)」) |
 * | `ctx-ime-key`  | 同じ手順で、鍵を **日本語入力オンの押し方**(keydown 229 + 変換中の「ｙ」)で届ける |
 * | `ctx-kbd` / `ctx-kbd-ime` | `ctx-menu` / `ctx-ime-key` と同じだが、**Shift+F10 で開く**(版面を押さない。焦点は Qt の入力用 <input> に残る) |
 * | `ctx-ime-comp` | 全部選んで**変換中**(「に」)にしたまま右クリックする。メニューが出るか / 変換が文書を置き換えるか |
 *
 * 見るもの: `menuOpened`(右クリックの前後で版面が丸ごと入れ替わったか)/ `keyConsumedByMenu`(鍵の後に版面が変わり、
 * かつ文書の字が残っているか)/ `copied`(外のクリップボードが種から文書の字に替わったか = 「コピー」が実行された)/
 * `docIntact`(最後に Ctrl+A → Ctrl+C で外へ読んだ文書の字が元のままか。⚠ 「ｙ」に置き換わっていたら false)。
 * ⚠ 日本語入力は CDP の `Input.imeSetComposition` で再現する(焦点が編集可能要素に無いと何も起きない = 実機と同じ条件)。
 */
async function ctxArm({ arm, n, r, page, ctx, box, step, shot, framesOf, swapped, readClip, deep }) {
  const full = { x: 0, y: 0, width: 1280, height: 800 };
  const key = process.env.PKC3_CTX_KEY ?? 'y';
  const FULLWIDTH = { y: 'ｙ', c: 'ｃ', t: 'ｔ' };
  const cdp = await ctx.newCDPSession(page);
  const imeKey = async () => {
    // Mac の日本語入力オンで 1 鍵押したときの形: keydown は keyCode 229(Process)、字は変換中として入る
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: 229 });
    await cdp.send('Input.imeSetComposition', { text: FULLWIDTH[key] ?? key, selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
  };
  const seed = `SEED-${arm}-${n}`;
  await page.evaluate(`navigator.clipboard.writeText(${JSON.stringify(seed)})`).catch(() => {});
  await page.evaluate('globalThis.__ime.length = 0');
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(800);
  step('全部選んだ', { deep: await deep() });
  if (arm === 'ctx-ime-comp') {
    await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
    await page.waitForTimeout(800);
    step('変換中(に)', { deep: await deep() });
  }
  const f0 = await framesOf(full);
  // `ctx-kbd*` はキーボード(Shift+F10)で開く = 版面を押さないので、焦点は Qt の入力用 <input> に残ったまま
  if (arm.startsWith('ctx-kbd')) await page.keyboard.press('Shift+F10');
  else await page.mouse.click(box.x + box.w * 0.3, box.y + box.h * 0.31, { button: 'right' });
  await page.waitForTimeout(2000);
  const f1 = await framesOf(full);
  r.menuOpened = swapped(f0, f1);
  step('右クリックした', { deep: await deep() });
  await shot('5-contextmenu');
  // Qt の窓(DOM の `.qt-window`)の一覧。ポップアップ(メニュー)が窓として足されるか・どう見分けられるか
  r.windowsOutline = await page.evaluate(`(() => {
    const out = [];
    const walk = (node) => { for (const el of node.querySelectorAll('*')) {
      if (el.classList && el.classList.contains('qt-window')) {
        const r = el.getBoundingClientRect();
        out.push({ cls: el.className, display: getComputedStyle(el).display, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          canvases: el.querySelectorAll('canvas').length, attrs: [...el.attributes].map((a) => a.name + '=' + a.value).slice(0, 6),
          // 窓の外側(qt-decorated-window)の素性。枠なし(メニュー等)と枠あり(本体・ダイアログ)で違うか
          deco: el.parentElement ? { cls: el.parentElement.className, id: el.parentElement.id, style: (el.parentElement.getAttribute('style') || '').slice(0, 200),
            children: [...el.parentElement.children].map((c) => c.className || c.tagName).slice(0, 6), host: (el.parentElement.parentElement || {}).className || null } : null });
      }
      if (el.shadowRoot) walk(el.shadowRoot); } };
    walk(document);
    return out;
  })()`);
  r.imeEventsAfterRightClick = await page.evaluate('globalThis.__ime.slice(0, 40)');
  if (arm !== 'ctx-ime-comp') {
    if (arm === 'ctx-ime-key' || arm === 'ctx-kbd-ime') await imeKey();
    else await page.keyboard.press(key);
    await page.waitForTimeout(2500);
    const f2 = await framesOf(full);
    r.keyChangedScreen = swapped(f1, f2);
    step(`鍵 ${key} を押した`, { deep: await deep() });
    await shot('6-after-key');
    r.clipboardAfterKey = await readClip();
    r.copied = typeof r.clipboardAfterKey === 'string' && r.clipboardAfterKey !== seed && !r.clipboardAfterKey.startsWith('ERR') && r.clipboardAfterKey !== 'HUNG';
    r.imeEventsAfterKey = await page.evaluate('globalThis.__ime.slice(0, 40)');
    if (r.copied) {
      // メニューが閉じた後も、字が普通に打てるか(IME 用 <input> の焦点を壊していないか)。選択を畳んでから 1 字
      await page.keyboard.press('ArrowRight');
      await page.keyboard.type('q', { delay: 100 });
      await page.waitForTimeout(1200);
    }
  }
  // 後始末と、文書の字が無傷かの検算(メニューを閉じ、変換中なら確定させず捨て、Ctrl+A → Ctrl+C で外へ読む)
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.evaluate(`navigator.clipboard.writeText(${JSON.stringify(seed + '-2')})`).catch(() => {});
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(800);
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(2500);
  r.docText = await readClip();
  r.docIntact = typeof r.docText === 'string' && r.docText.includes('abc') && !r.docText.startsWith('SEED-');
  if (r.copied) r.typingAfterMenu = typeof r.docText === 'string' && r.docText.includes('q');
  await shot('7-final');
  return r;
}

for (let n = 1; n <= ROUNDS; n += 1) {
  for (const arm of ARMS) {
    wd.mark(`${arm}-${n}`);
    const x = await oneRound(arm, n);
    result.rounds.push(x);
    await flush();
  }
}
wd.disarm();
await flush();
if (!OUT) console.log(JSON.stringify(result, null, 1));
server.close();
process.exit(0);
