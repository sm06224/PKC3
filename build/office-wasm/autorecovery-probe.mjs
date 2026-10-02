/**
 * 🔴 **LibreOffice 自身の自動回復(AutoRecovery)が、この wasm で生きているか**(#1228 段 0)。
 *
 * 製品は 1 行も変えない ── **自分の複製の設定を `localStorage` の退避口へ置く**だけで、
 * `host.html` の `seedWindowSize` が「保存済みプロファイルを土台に書き戻す」実経路
 * (`loadSavedProfile` → `registrymodifications.xcu`)をそのまま踏む。
 *
 * ## 測るもの(依頼文 1〜5)
 *  1. timer が回るか   … `/instdir/user/**` への書き込みの有無 + `RecoveryList` の出現
 *  2. backup の置き場   … FS を丸ごと走査して**起動後に増えた file**を全部出す
 *  3. 形式              … 増えた file の先頭 4 byte(zip か)と zip の中の `mimetype` / 一覧
 *  4. main thread の塞ぎ … 窓の中の 20ms 刻みの heartbeat の**途切れ**(+ longtask)を
 *                          FS の出来事の時刻と並べる(`PROXY_TO_PTHREAD=0` = LO の main は窓の main)
 *  5. 最小間隔          … `TimeIntervall` を変えて、最初の書き込みまでの経過時間を採る
 *
 * ⚠ 設定の名前は **2 系統**ある(同梱の `main.xcd` から読んだ):
 *   - `/org.openoffice.Office.Recovery/AutoSave` の `Enabled` / `TimeIntervall`(**生きている**側)
 *   - `/org.openoffice.Office.Common/Save/Document` の `AutoSave` / `AutoSaveTimeIntervall`
 *     (スキーマに **「Not used anymore」**と書いてある側 = 対照群 `PKC3_AR_MODE=legacy`)
 *
 * ⚠ 文書は**自作の fixture**だけ(`seed.odt` / `seed.docx`)。画像は撮らず、版面の
 *   sha256 の先頭だけ採る(`save-existing-probe.mjs` と同じ作法)。
 *
 * 使い方:
 *   node build/office-wasm/autorecovery-probe.mjs <pages 形式の pack> <文書> <出力.json> [待つ秒]
 *   PKC3_AR_MODE=recovery|legacy|none   既定 recovery(none = 設定を足さない = 既定値の観測)
 *   PKC3_AR_INTERVAL=<分>                既定 1
 *   PKC3_AR_TYPE=1|0                    既定 1(文字を打って「変更あり」にする。0 = 打たない対照群)
 *   PKC3_AR_REVISIT=1                   待った後に**読み直して**、退避された設定で何が起きるか見る
 *   PKC3_AR_PORT=<port>                 既定 47954
 *   PKC3_AR_KEEP=<dir>                  増えた file の実物を落とす先(自作 fixture のみ)
 *   PKC3_CHROMIUM / PKC3_PUBLIC
 */
import { createServer } from 'node:http';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { armWatchdog } from './probe-watchdog.mjs';

const PACK = resolve(process.argv[2]);
const DOC = resolve(process.argv[3]);
const OUT = process.argv[4] ?? '';
const WAIT_SEC = Number(process.argv[5] ?? 240);
const PUBLIC = resolve(process.env.PKC3_PUBLIC ?? 'public');
const MODE = process.env.PKC3_AR_MODE ?? 'recovery';
const INTERVAL = Number(process.env.PKC3_AR_INTERVAL ?? 1);
const TYPE = process.env.PKC3_AR_TYPE !== '0';
const REVISIT = process.env.PKC3_AR_REVISIT === '1';
/** 🔴 隣の穴 2 つの再現(自動回復とは別の主題)。stopband = 停止の帯の「読み込み直す」/ replace = 別の添付を開く放送 */
const SCENARIO = process.env.PKC3_AR_SCENARIO ?? '';
/** 🔒 撮影は env の門の下(自作 fixture のときだけ渡す。出すのは sha256 の先頭だけ)。 */
const SHOOT = process.env.PKC3_FRAMES === '1';
const PORT = Number(process.env.PKC3_AR_PORT ?? 47954);
const KEEP = process.env.PKC3_AR_KEEP ?? '';
const EXE = process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.metadata': 'application/json', '.gz': 'application/gzip',
  '.ttf': 'font/ttf', '.data': 'application/octet-stream',
};

/** ⚠ 配る側が COOP/COEP を付ける(付け忘れると `crossOriginIsolated` が false で動かない)。 */
const server = await new Promise((ok) => {
  const s = createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0];
    const head = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    };
    const f = p.startsWith('/office-pack/')
      ? join(PACK, p.slice('/office-pack/'.length))
      : join(PUBLIC, p);
    readFile(f)
      .then((b) => {
        res.writeHead(200, { ...head, 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream' });
        res.end(b);
      })
      .catch((e) => { res.writeHead(404, head); res.end(String(e)); });
  });
  s.listen(PORT, '127.0.0.1', () => ok(s));
});
const base = `http://127.0.0.1:${PORT}`;

const NAME = basename(DOC);
const raw = await readFile(DOC);
const b64 = raw.toString('base64');
const result = {
  mode: MODE, interval: INTERVAL, type: TYPE, revisit: REVISIT, waitSec: WAIT_SEC,
  docExt: extname(NAME), docBytes: raw.byteLength, steps: [], console: [],
};
const safeLine = (s) => (/[^\x20-\x7e]/.test(s) ? null : s.slice(0, 200));

const PROFILE = `${tmpdir()}/pkc3-ar-${process.pid}`;
const browser = await chromium.launchPersistentContext(PROFILE, {
  headless: true, viewport: { width: 1280, height: 900 },
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  executablePath: EXE,
});
const page = await browser.newPage();
const wd = armWatchdog({
  result, out: OUT, limitSec: Number(process.env.PKC3_HARD_LIMIT_SEC ?? WAIT_SEC + 900),
  browser: () => browser,
});
page.on('console', (m) => {
  const t = safeLine(`[${m.type()}] ${m.text()}`);
  if (t && result.console.length < 60) result.console.push(t);
});
page.on('pageerror', (e) => {
  result.pageErrors = result.pageErrors ?? [];
  if (result.pageErrors.length < 10) result.pageErrors.push(String(e).slice(0, 200));
});

/**
 * 🔴 **設定の注入**。`host.html` の `loadSavedProfile` が読む退避口(`pkc3-office-profile`)へ
 * xcu を置く。⚠ 製品の経路をそのまま使う(host.html の複製は作らない)。
 */
function seedXcu() {
  if (MODE === 'none') return '';
  const head = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<oor:items xmlns:oor="http://openoffice.org/2001/registry"'
    + ' xmlns:xs="http://www.w3.org/2001/XMLSchema"'
    + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">';
  let items;
  if (MODE === 'legacy') {
    items = '<item oor:path="/org.openoffice.Office.Common/Save/Document">'
      + '<prop oor:name="AutoSave" oor:op="fuse"><value>true</value></prop>'
      + `<prop oor:name="AutoSaveTimeIntervall" oor:op="fuse"><value>${INTERVAL}</value></prop></item>`;
  } else {
    items = '<item oor:path="/org.openoffice.Office.Recovery/AutoSave">'
      + '<prop oor:name="Enabled" oor:op="fuse"><value>true</value></prop>'
      + `<prop oor:name="TimeIntervall" oor:op="fuse"><value>${INTERVAL}</value></prop></item>`;
  }
  return `${head}${items}</oor:items>`;
}
const SEED = seedXcu();

/** 窓の中の道具(heartbeat / longtask / FS の出来事)。⚠ `__lo` は起動後にしか無い。 */
const INIT = ({ seed, doc, name, once }) => {
  const W = globalThis;
  if (seed) {
    try { W.localStorage.setItem('pkc3-office-profile', seed); } catch { /* 触れない */ }
  }
  W.__hb = { gaps: [], long: [], last: performance.now(), ticks: 0, max: 0 };
  setInterval(() => {
    const t = performance.now();
    const g = t - W.__hb.last;
    W.__hb.last = t; W.__hb.ticks += 1;
    if (g > W.__hb.max) W.__hb.max = g;
    if (g > 120 && W.__hb.gaps.length < 800) {
      W.__hb.gaps.push({ at: Math.round(performance.timeOrigin + t), gap: Math.round(g) });
    }
  }, 20);
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (W.__hb.long.length < 800) {
          W.__hb.long.push({ at: Math.round(performance.timeOrigin + e.startTime), dur: Math.round(e.duration) });
        }
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* longtask が無い */ }
  const ch = new W.BroadcastChannel('pkc3-office');
  W.__saved = [];
  ch.onmessage = (ev) => {
    const d = ev.data;
    if (!d || !d.pkc3Office) return;
    if (d.pkc3Office === 'saved') W.__saved.push({ key: d.payload.key, size: d.payload.size });
    if (d.pkc3Office !== 'ready-for-document' || !doc) return;
    // 🔴 本体(`OfficeWindow.sendDocument`)は文書を 1 度送ると手放す = 2 度目の「ちょうだい」には答えない
    try {
      const n = Number(W.sessionStorage.getItem('__readyN') || '0') + 1;
      W.sessionStorage.setItem('__readyN', String(n));
      if (once && W.sessionStorage.getItem('__answered')) return;
      W.sessionStorage.setItem('__answered', '1');
    } catch { /* 触れない */ }
    const rawDoc = W.atob(doc);
    const u8 = new Uint8Array(rawDoc.length);
    for (let i = 0; i < rawDoc.length; i += 1) u8[i] = rawDoc.charCodeAt(i);
    ch.postMessage({ pkc3Office: 'document', payload: { name, bytes: u8, token: 'lid-PROBE' } });
  };
};

/** FS を走査する(`/proc` `/dev` は除く)。⚠ 20〜27ms かかる ── 毎秒は回さない。 */
const WALK = `(() => {
  const lo = window.__lo; if (!lo || !lo.FS) return null;
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 12) return;
    let names; try { names = lo.FS.readdir(dir); } catch (e) { return; }
    for (const n of names) {
      if (n === '.' || n === '..') continue;
      const full = (dir === '/' ? '' : dir) + '/' + n;
      if (full === '/proc' || full === '/dev') continue;
      let st; try { st = lo.FS.stat(full); } catch (e) { continue; }
      if (lo.FS.isDir(st.mode)) { out.push({ p: full + '/', d: 1 }); walk(full, depth + 1); }
      else out.push({ p: full, size: st.size, m: +st.mtime });
    }
  };
  walk('/', 0);
  return out;
})()`;

/** FS の出来事を時刻つきで貯める(非 polling)。⚠ `/instdir/share` `/instdir/program` は読むだけなので除く。 */
const HOOK = `(() => {
  const lo = window.__lo; if (!lo || !lo.FS || window.__fsEv) return !!window.__fsEv;
  const FS = lo.FS; const ev = window.__fsEv = [];
  const skip = (p) => typeof p !== 'string'
    || p.indexOf('/instdir/share/') === 0 || p.indexOf('/instdir/program/') === 0
    || p.indexOf('/proc') === 0 || p.indexOf('/dev') === 0;
  const push = (k, p, p2, extra) => {
    if (skip(p) || ev.length > 1500) return;
    ev.push(Object.assign({ t: Date.now(), k: k, p: p, p2: p2 }, extra || {}));
  };
  const wrap = (name, f) => { const o = FS[name]; FS[name] = function () { try { f.apply(this, arguments); } catch (e) {} return o.apply(this, arguments); }; };
  const oc = FS.close;
  FS.close = function (s) {
    const r = oc.apply(this, arguments);
    try { push('close', s && s.path, undefined, { size: s && s.node && s.node.usedBytes }); } catch (e) {}
    return r;
  };
  wrap('open', (p, fl) => push('open', typeof p === 'string' ? p : (p && p.path), undefined, { fl: fl }));
  wrap('rename', (a, b) => push('rename', a, b));
  wrap('unlink', (p) => push('unlink', p));
  wrap('mkdir', (p) => push('mkdir', p));
  wrap('rmdir', (p) => push('rmdir', p));
  return true;
})()`;

/** 増えた file の実物を読む(自作 fixture のみ)。8MB まで。 */
const READ_FILE = (p) => `(() => {
  const lo = window.__lo; try {
    const u8 = lo.FS.readFile(${JSON.stringify(p)});
    if (u8.length > 8 * 1024 * 1024) return { big: u8.length };
    let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return { b64: btoa(s), n: u8.length };
  } catch (e) { return { err: String(e).slice(0, 100) }; }
})()`;

const paintedJs = `(() => {
  const walk=(n)=>{for(const e of n.querySelectorAll('*')){if(e.tagName==='CANVAS'&&e.width>0)return true;if(e.shadowRoot&&walk(e.shadowRoot))return true;}return false;};
  return walk(document.getElementById('screen')||document.body);
})()`;
const canvasJs = `(() => {
  const walk=(n)=>{for(const e of n.querySelectorAll('*')){if(e.tagName==='CANVAS'){const r=e.getBoundingClientRect();if(r.width>100)return {x:r.x,y:r.y,w:r.width,h:r.height};}if(e.shadowRoot){const f=walk(e.shadowRoot);if(f)return f;}}return null;};
  return walk(document.getElementById('screen')||document.body);
})()`;

async function stagePack() {
  return page.evaluate(async () => {
    const m = await (await globalThis.fetch('/office-pack/pack.json')).json();
    const names = [...m.files, ...m.fonts];
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('pkc3-office-pack', 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains('files')) r.result.createObjectStore('files');
        if (!r.result.objectStoreNames.contains('meta')) r.result.createObjectStore('meta');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const put = (s, k, v) => new Promise((res, rej) => {
      const t = db.transaction(s, 'readwrite');
      t.objectStore(s).put(v, k);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
    let bytes = 0;
    for (const n of names) {
      const b = await (await globalThis.fetch(`/office-pack/${n}`)).blob();
      bytes += b.size; await put('files', n, b);
    }
    await put('meta', 'pack', { version: m.version, installedAt: Date.now(), source: 'url',
      totalBytes: bytes, files: names.map((n) => ({ name: n })) });
    return { count: names.length, version: m.version };
  });
}

async function waitPainted(limitSec) {
  const t0 = Date.now();
  for (;;) {
    const ok = await page.evaluate(paintedJs).catch(() => false);
    if (ok) return (Date.now() - t0) / 1000;
    if ((Date.now() - t0) / 1000 > limitSec) throw new Error('版面が出ない');
    await page.waitForTimeout(1500);
  }
}

/**
 * 🔴 **隣の穴 2 つ**(#1228 段 0 の調べもの 6)。⚠ 自動回復とは別の主題 ── ここは**再現の有無**だけを採る。
 *
 * ① stopband: 停止の帯の「読み込み直す」は `location.reload()` で、URL に `?await-doc=1` が残る。
 *    本体は文書を 1 度しか送らない(上の INIT の once)ので、2 度目の「ちょうだい」は誰も答えず、
 *    窓は 15 秒待って Start Center になる**はず**。
 * ② replace: 窓が開いているときに別の添付を「Office で開く」と、本体は `reload-request` を放送し、
 *    窓は `location.replace` する。LO の中の未保存を見ない**はず**(`beforeunload` は保存の受け渡し中だけ)。
 *    ⚠ 本体の代役は同一 origin の別 tab(放送は同じ封筒)。本体の UI は通していない。
 */
async function runScenario({ framesSet }) {
  const sc = { which: SCENARIO, events: [] };
  result.scenario = sc;
  const loInfo = `(() => { const lo = window.__lo; let work = null; try { work = lo.FS.readdir('/work').filter((n) => n !== '.' && n !== '..').length; } catch (e) {}
    return { docPath: window.__loDocPath ? 'set' : null, work: work, readyN: Number(sessionStorage.getItem('__readyN') || '0'),
      status: document.getElementById('status') && document.getElementById('status').textContent, nav: performance.getEntriesByType('navigation')[0].name.replace(/name=[^&]*/, 'name=…') }; })()`;
  sc.before = await page.evaluate(loInfo);
  page.on('dialog', async (d) => { sc.events.push({ k: 'dialog', type: d.type() }); await d.dismiss().catch(() => {}); });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) sc.events.push({ k: 'navigated', at: Date.now() }); });

  if (SCENARIO === 'stopband') {
    // 停止の帯を出す(既存 smoke と同じ作法: wasm 由来の例外を投げる)
    await page.evaluate(() => window.dispatchEvent(new globalThis.ErrorEvent('error', { message: 'RuntimeError: function signature mismatch' })));
    await page.waitForTimeout(500);
    sc.band = await page.evaluate(`(() => ({ status: document.getElementById('status').textContent, buttons: [...document.querySelectorAll('#msg button')].map((b) => b.textContent) }))()`);
    const t0 = Date.now();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'commit', timeout: 30000 }),
      page.locator('#msg button', { hasText: '読み込み直す' }).click(),
    ]);
    sc.url = page.url().replace(/name=[^&]*/, 'name=…');
    // 15 秒 + 起動の余裕。⚠ 起動途中の evaluate は落ちうるので catch
    sc.painted = await waitPainted(240).catch((e) => String(e));
    await page.waitForTimeout(25000);
    sc.after = await page.evaluate(loInfo).catch((e) => ({ err: String(e).slice(0, 100) }));
    sc.afterSec = Math.round((Date.now() - t0) / 1000);
    sc.verdict = sc.after && sc.after.docPath === null ? '再現: 文書が渡らず Start Center(__loDocPath 無し)' : '再現せず(文書が渡った)';
  } else if (SCENARIO === 'save') {
    // 🔴 **対照群**: 明示の Ctrl+S。⚠ 「timer が回らない」を言うには、**同じ観測点が保存なら鳴る**ことを先に見る
    //   (hook が FS の出来事を拾えること / heartbeat が保存の塞ぎを拾えること)。
    const before = await framesSet();
    await page.keyboard.type('save-control', { delay: 120 });
    await page.waitForTimeout(3000);
    const after = await framesSet();
    sc.typed = { landed: SHOOT ? after.every((h) => !before.includes(h)) : null };
    await page.evaluate(HOOK);
    sc.pressedAt = Date.now();
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(15000);
    sc.savedBroadcast = await page.evaluate('window.__saved || []');
    sc.verdict = 'Ctrl+S 後の FS の出来事と heartbeat は下の fsEvents / hb';
  } else if (SCENARIO === 'replace') {
    // 「変更あり」にする(押さずに打つ)。届いたかは版面の絵で見る
    const before = await framesSet();
    await page.keyboard.type('unsaved-edit', { delay: 120 });
    await page.waitForTimeout(3000);
    const after = await framesSet();
    sc.typed = { landed: SHOOT ? after.every((h) => !before.includes(h)) : null };
    const stat = `(() => { try { const s = window.__lo.FS.stat(window.__loDocPath); return { size: s.size, m: +s.mtime }; } catch (e) { return null; } })()`;
    sc.docStatBefore = await page.evaluate(stat);
    sc.savedBefore = await page.evaluate('window.__saved || []');
    // 本体の代役(同一 origin の別 tab)
    const main = await browser.newPage();
    await main.goto(`${base}/office-pack/pack.json`);
    const t0 = Date.now();
    await main.evaluate(({ doc, name }) => {
      const ch = new BroadcastChannel('pkc3-office');
      globalThis.__mainCh = ch;
      ch.onmessage = (ev) => {
        const d = ev.data;
        if (!d || d.pkc3Office !== 'ready-for-document') return;
        const raw = globalThis.atob(doc); const u8 = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) u8[i] = raw.charCodeAt(i);
        ch.postMessage({ pkc3Office: 'document', payload: { name, bytes: u8, token: 'lid-OTHER' } });
      };
      // `OfficeWindow.open()` が窓の開いているときに放送する 2 通と同じ封筒
      ch.postMessage({ pkc3Office: 'focus-request', payload: {} });
      ch.postMessage({ pkc3Office: 'reload-request', payload: { name, awaitDoc: true } });
    }, { doc: b64, name: 'other-' + NAME });
    // 窓が作り直されるのを待つ
    await page.waitForNavigation({ waitUntil: 'commit', timeout: 30000 }).catch((e) => { sc.navError = String(e).slice(0, 100); });
    sc.navigatedAfterMs = Date.now() - t0;
    sc.painted = await waitPainted(240).catch((e) => String(e));
    await page.waitForTimeout(20000);
    sc.after = await page.evaluate(loInfo).catch((e) => ({ err: String(e).slice(0, 100) }));
    sc.savedBroadcast = await page.evaluate('window.__saved || []').catch(() => null);
    sc.verdict = (sc.events.some((e) => e.k === 'dialog') ? '確認が出た(未保存を守っている)' : '再現: 確認なしで作り直された(dialog 0 件)')
      + ' / 保存の放送 ' + JSON.stringify(sc.savedBroadcast);
    await main.close().catch(() => {});
  }
  sc.fsEvents = ((await page.evaluate('window.__fsEv || []').catch(() => [])) ?? []).filter((e) => !e.p.endsWith('registrymodifications.xcu'));
  sc.hb = await page.evaluate('({ max: Math.round(window.__hb.max), gaps: window.__hb.gaps, long: window.__hb.long })').catch(() => null);
}

try {
  wd.mark('起動');
  await page.goto(`${base}/office/host.html`, { waitUntil: 'domcontentloaded' });
  result.coi = await page.evaluate('crossOriginIsolated');
  result.staged = await stagePack();

  await page.addInitScript(INIT, { seed: SEED, doc: b64, name: NAME, once: SCENARIO !== '' });
  const loadAt = Date.now();
  await page.goto(`${base}/office/host.html?await-doc=1&name=${encodeURIComponent(NAME)}`,
    { waitUntil: 'commit' });
  wd.mark('版面待ち');
  result.paintedAfterSec = await waitPainted(240);
  // LO が文書を組むのを待つ
  await page.waitForTimeout(20000);
  result.profileSeeded = await page.evaluate(
    `(localStorage.getItem('pkc3-office-profile')||'').includes('TimeIntervall') || (localStorage.getItem('pkc3-office-profile')||'').includes('AutoSaveTimeIntervall')`);
  result.hook = await page.evaluate(HOOK);
  const baseline = await page.evaluate(WALK);
  result.baselineFiles = baseline ? baseline.length : null;
  const baseSet = new Map((baseline ?? []).map((e) => [e.p, e]));
  // 起動時の xcu(注入が届いたか)
  result.xcuAtBoot = await page.evaluate(`(() => { try { const t = window.__lo.FS.readFile('/instdir/user/registrymodifications.xcu', {encoding:'utf8'}); const m = t.match(/(TimeIntervall|AutoSaveTimeIntervall)[^<]*<value>[^<]*/g); return { len: t.length, autosave: m }; } catch (e) { return { err: String(e).slice(0,80) }; } })()`);

  const canvas = await page.evaluate(canvasJs);
  const frameHash = async () => {
    if (!canvas || !SHOOT) return null;
    const png = SHOOT ? await page.screenshot({ clip: { x: canvas.x, y: canvas.y, width: canvas.w, height: canvas.h } }) : null;
    return createHash('sha256').update(png).digest('hex').slice(0, 12);
  };
  const framesSet = async (n = 4) => {
    const s = new Set();
    for (let i = 0; i < n; i += 1) { s.add(await frameHash()); await page.waitForTimeout(400); }
    return [...s];
  };

  let typedAt = null;
  if (SCENARIO) { await runScenario({ framesSet }); }
  else {
  if (TYPE) {
    // ⚠ **押さずに打つ**(版面の click は 2 回に 1 回 LO を落とす = office-oracle §14)
    const before = await framesSet();
    typedAt = Date.now();
    await page.keyboard.type('autorecovery', { delay: 120 });
    await page.waitForTimeout(3000);
    const after = await framesSet();
    result.typed = { at: typedAt, landed: SHOOT ? after.every((h) => !before.includes(h)) : null, before, after };
  }
  result.timeline = { loadAt, hookAt: Date.now(), typedAt };

  // 観測の本体: WAIT_SEC のあいだ、15 秒ごとに「新しい file」を数える(走査は軽いが毎秒は回さない)
  wd.mark('観測');
  const t0 = Date.now();
  const seen = new Map();
  let firstNewAt = null;
  const downloaded = [];
  while ((Date.now() - t0) / 1000 < WAIT_SEC) {
    await page.waitForTimeout(15000);
    const now = await page.evaluate(WALK).catch(() => null);
    if (!now) { result.walkLost = true; break; }
    for (const e of now) {
      const b = baseSet.get(e.p);
      if (e.d) { if (!b && !seen.has(e.p)) seen.set(e.p, { p: e.p, dir: true, firstAt: Date.now() }); continue; }
      if (!b || b.size !== e.size || b.m !== e.m) {
        const key = e.p + '#' + e.size + '#' + e.m;
        if (!seen.has(key)) {
          seen.set(key, { p: e.p, size: e.size, mtime: e.m, firstSeenAt: Date.now(), isNew: !b });
          if (firstNewAt === null && !e.p.startsWith('/tmp/') && !e.p.endsWith('/registrymodifications.xcu')) firstNewAt = Date.now();
          // ⚠ 自作 fixture のみ落とす。ODF / Office の本体らしい物と backup 配下だけ
          if (e.size > 0 && e.size <= 8 * 1024 * 1024
              && (/backup|recover|\.(odt|docx|ods|xlsx|bak|tmp)$/i.test(e.p)) && downloaded.length < 12) {
            const r = await page.evaluate(READ_FILE(e.p)).catch(() => null);
            if (r && r.b64) {
              const buf = Buffer.from(r.b64, 'base64');
              downloaded.push({ p: e.p, n: buf.length, magic: buf.subarray(0, 4).toString('hex'), at: Date.now() });
              if (KEEP) {
                await mkdir(KEEP, { recursive: true });
                await writeFile(join(KEEP, `${downloaded.length}-${basename(e.p).replace(/[^\w.-]/g, '_')}`), buf);
              }
            }
          }
        }
      }
    }
    result.steps.push({ at: Math.round((Date.now() - t0) / 1000), changed: seen.size, firstNewAt });
  }
  result.changed = [...seen.values()];
  result.downloaded = downloaded;
  result.firstNewAfterSec = firstNewAt === null ? null : Math.round((firstNewAt - loadAt) / 100) / 10;
  result.firstNewAfterTypeSec = firstNewAt === null || typedAt === null ? null : Math.round((firstNewAt - typedAt) / 100) / 10;

  // 結果の本命(まとめて最後に読む)
  result.fsEvents = await page.evaluate('window.__fsEv || null');
  result.hb = await page.evaluate('({ max: Math.round(window.__hb.max), ticks: window.__hb.ticks, gaps: window.__hb.gaps, long: window.__hb.long })');
  result.xcuAtEnd = await page.evaluate(`(() => { try { const t = window.__lo.FS.readFile('/instdir/user/registrymodifications.xcu', {encoding:'utf8'});
    return { len: t.length, recoveryList: /RecoveryList/.test(t), crashed: (t.match(/Crashed[^<]*<value>[^<]*/)||[])[0] || null, sessionData: (t.match(/SessionData[^<]*<value>[^<]*/)||[])[0] || null,
      recoveryExcerpt: (t.match(/<item oor:path="\\/org.openoffice.Office.Recovery[^]*?<\\/item>/g)||[]).slice(0, 6).map((s) => s.slice(0, 600)) }; } catch (e) { return { err: String(e).slice(0,80) }; } })()`);
  result.savedBroadcast = await page.evaluate('window.__saved || []');
  result.profileInLocalStorage = await page.evaluate(`(() => { const t = localStorage.getItem('pkc3-office-profile') || ''; return { len: t.length, recoveryList: /RecoveryList/.test(t), crashed: (t.match(/Crashed[^<]*<value>[^<]*/)||[])[0] || null }; })()`);
  result.status = await page.evaluate(`document.getElementById('status') && document.getElementById('status').textContent`);

  if (REVISIT) {
    wd.mark('読み直し');
    // 30 秒の退避を待ってから(退避が起きていなければ pagehide の分に任せる)
    await page.waitForTimeout(32000);
    result.profileBeforeReload = await page.evaluate(`(() => { const t = localStorage.getItem('pkc3-office-profile') || ''; return { len: t.length, recoveryList: /RecoveryList/.test(t), crashed: (t.match(/Crashed[^<]*<value>[^<]*/)||[])[0] || null }; })()`);
    await page.reload({ waitUntil: 'commit' });
    result.revisitPaintedAfterSec = await waitPainted(240).catch((e) => String(e));
    await page.waitForTimeout(30000);
    const w = await page.evaluate(`(() => { const out = []; const walk = (n) => { for (const el of n.querySelectorAll('*')) { if (el.classList && el.classList.contains('qt-window')) { const t = el.querySelector('.title-bar .window-name, .title'); out.push((t && t.textContent || '').length); } if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return out; })()`).catch(() => null);
    result.revisit = { windowTitleLengths: w, status: await page.evaluate(`document.getElementById('status') && document.getElementById('status').textContent`).catch(() => null) };
    // 回復の窓が出たか: 版面の絵が文書の絵と違う(撮るのは自作 fixture のみ)
    result.revisitFrame = await frameHash().catch(() => null);
    result.revisitFiles = (await page.evaluate(WALK).catch(() => []) ?? []).filter((e) => /backup|recover/i.test(e.p)).slice(0, 20);
  }
  }
} catch (e) {
  result.error = String(e).slice(0, 400);
}

await browser.close().catch(() => {});
server.close();
await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
wd.disarm();
const text = JSON.stringify(result, null, 1);
if (OUT) await writeFile(OUT, text);
console.log(text.slice(0, 6000));
