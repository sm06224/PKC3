// Office(LO wasm)の固まり・停止を割る probe の共通部(#1408 / #1402)。
// 一式を同一 origin で配り、IDB に入れ、文書を渡して開き、観測の道具(h)を返す。使い方は README.md。
import { createServer } from 'node:http';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { connectAll } from './alldump.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json', '.metadata': 'application/json', '.gz': 'application/gzip', '.ttf': 'font/ttf', '.data': 'application/octet-stream' };

export function serve(PACK, DIST = join(REPO, 'public')) {
  return new Promise((ok) => {
    const s = createServer((req, res) => {
      const p = (req.url ?? '/').split('?')[0];
      const head = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' };
      if (p === '/__reader.html') { res.writeHead(200, { ...head, 'Content-Type': MIME['.html'] }); res.end('<!doctype html><title>reader</title><p>reader'); return; }
      const f = p.startsWith('/office-pack/') ? join(PACK, p.slice('/office-pack/'.length)) : join(DIST, p);
      readFile(f).then((b) => { res.writeHead(200, { ...head, 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream' }); res.end(b); })
        .catch(() => { res.writeHead(404, head); res.end(); });
    });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
}
export const safeLine = (s) => (/[^\x20-\x7e]/.test(s) ? null : s.slice(0, 200));
export const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);
export const COUNT_QT_WINDOWS = `(() => { let n = 0; const walk = (node) => { for (const el of node.querySelectorAll('*')) { if (el.classList && el.classList.contains('qt-window')) n += 1; if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return n; })()`;
export const QT_WINDOWS = `(() => { const out = []; const walk = (node) => { for (const el of node.querySelectorAll('*')) { if (el.classList && el.classList.contains('qt-window')) { const r = el.getBoundingClientRect(); out.push({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), title: (el.textContent || '').trim().slice(0, 60) }); } if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return out; })()`;
export const CANVAS_BOX = `(() => { let best = null; const walk = (n) => { for (const el of n.querySelectorAll('*')) { if (el.tagName === 'CANVAS' && el.width > 0) { const r = el.getBoundingClientRect(); if (!best || r.width > best.w) best = { x: r.x, y: r.y, w: r.width, h: r.height }; } if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return best; })()`;

/** 1 回ぶんの窓を起こして文書を開く。返す物: { row, page, ctx, h(helpers), close() } */
export async function openOffice({ base, FX, docName, tag, shotdir, viewport = { width: 1280, height: 800 } }) {
  const START = docName === '__start__';
  const docB64 = START ? '' : (await readFile(join(FX, docName))).toString('base64');
  const row = { doc: docName, steps: [], faults: [], console: [], trace: [] };
  const profile = `${tmpdir()}/pkc3-sp-${process.pid}-${tag}`;
  const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport, args: ['--no-sandbox', '--disable-dev-shm-usage', ...(process.env.PKC3_STACKDUMP === 'all' ? ['--remote-debugging-port=0'] : [])], executablePath: process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium' });
  const t0 = Date.now();
  const step = (name, extra = {}) => row.steps.push({ at: Date.now() - t0, name, ...extra });
  const page = await ctx.newPage();
  await page.addInitScript('Error.stackTraceLimit = 200;');
  // PKC3_STACKDUMP=1: debugger は run の最初に有効にしておく(固まった page では Debugger.enable が処理されない ── 2026-10-07 実測。
  // pause だけが割り込みで届く)。⚠ 有効化で wasm の実行が遅くなる可能性があるので、opened.atMs を対照と比べること
  let cdpDbg = null;
  if (process.env.PKC3_STACKDUMP) { try { cdpDbg = await ctx.newCDPSession(page); await cdpDbg.send('Debugger.enable'); row.debuggerEnabled = true; } catch (e) { row.debuggerEnabled = String(e).slice(0, 120); cdpDbg = null; } }
  // PKC3_STACKDUMP=all: pthread(= dedicated worker)にも raw CDP で attach して Debugger を先に有効にする(alldump.mjs)
  let cdpAll = null;
  const dlog = (line) => { if (process.env.CONSOLE_LOG) { try { appendFileSync(process.env.CONSOLE_LOG, `[+${Date.now() - t0}ms][STACKDUMP] ${line}\n`); } catch { /* 観測の書き込みで本体を止めない */ } } };
  if (process.env.PKC3_STACKDUMP === 'all') { try { cdpAll = await connectAll(profile, dlog); row.allAttached = true; } catch (e) { row.allAttached = String(e).slice(0, 120); cdpAll = null; } }
  // PKC3_JSBEAT=<ms>: renderer の JS イベントループが生きているかの鼓動(#1408 ── wasm のスピンなら止まる / Qt のタイマーだけ止まるなら続く)
  if (process.env.PKC3_JSBEAT) await page.addInitScript((ms) => { let n = 0; setInterval(() => { n += 1; console.error(`PKC3-JSBEAT #${n} t=${Date.now()} top=${globalThis === globalThis.top ? 1 : 0}`); }, ms); }, Number(process.env.PKC3_JSBEAT));
  try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write']); } catch (e) { row.permissionErr = String(e).slice(0, 80); }
  page.on('console', (m) => {
    const raw = m.text();
    if (process.env.CONSOLE_LOG) { try { const kept0 = raw.split('\n').filter((l) => !/[^\x20-\x7e]/.test(l)); appendFileSync(process.env.CONSOLE_LOG, `[+${Date.now() - t0}ms][${m.type()}] ` + kept0.join('\n') + '\n'); } catch { /* 観測の書き込みで本体を止めない */ } }
    const t = safeLine(`[${m.type()}] ${raw}`);
    if (/PKC3-(CLIP|MENU|UEV|POPUPSYNC|SCHED|TASKGONE)/.test(raw)) {
      // 非 ASCII の行は捨てる(自作 fixture でも作法を守る)。改行入りの stack は行ごと
      const kept = raw.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '' && !/[^\x20-\x7e]/.test(l));
      if (kept.length) { row.trace.push(`[+${Date.now() - t0}ms]` + kept.join('\n').slice(0, 1500)); if (row.trace.length > 3000) row.trace.shift(); }
    }
    if (t !== null && row.console.length < 60) row.console.push(`[+${Date.now() - t0}ms]${t}`);
  });
  page.on('pageerror', (e) => {
    if (process.env.CONSOLE_LOG) { try { appendFileSync(process.env.CONSOLE_LOG, `[+${Date.now() - t0}ms][PAGEERROR] ` + String((e && e.stack) || e).split('\n').filter((l) => !/[^\x20-\x7e]/.test(l)).join('\n') + '\n'); } catch { /* 観測の書き込みで本体を止めない */ } }
    const t = safeLine(`[pageerror] ${String(e)}`);
    if (t !== null && row.console.length < 60) row.console.push(`[+${Date.now() - t0}ms]${t}`);
    if (/memory access out of bounds/.test(String(e)) && process.env.PKC3_STACKDUMP === 'all') { setTimeout(() => { stackdumpRef?.('pageerror OOB'); }, 50); }
    if (/memory access out of bounds|RuntimeError|Aborted\(/.test(String(e))) row.faults.push({ at: Date.now() - t0, text: (safeLine(String(e).split('\n')[0]) ?? 'error'), stack: String((e && e.stack) || '').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !/[^\x20-\x7e]/.test(l)).map((l) => l.slice(0, 200)).join('\n').slice(0, 3000) });
  });
  const alive = () => Promise.race([page.evaluate('1').then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 8000))]);
  // PKC3_STACKDUMP=1: page が応答しないとき CDP の Debugger.pause で main の呼び出し stack を取る(#1408 C1 の判別。
  // wasm が spin していても V8 の interrupt は届くはず ── 届かなければ 'STACKDUMP timeout' と出る)
  let dumped = 0; let stackdumpRef = null;
  const stackdump = async (why) => {
    if (!process.env.PKC3_STACKDUMP || dumped >= 4) return null; dumped += 1;
    const log = (line) => { if (process.env.CONSOLE_LOG) { try { appendFileSync(process.env.CONSOLE_LOG, `[+${Date.now() - t0}ms][STACKDUMP] ${line}\n`); } catch { /* 観測の書き込みで本体を止めない */ } } };
    try {
      const cdp = cdpDbg; if (!cdp) { log(`PKC3-STACKDUMP ${why}: no debugger session`); return null; }
      const paused = new Promise((r) => cdp.once('Debugger.paused', r));
      await cdp.send('Debugger.pause');
      const ev = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 15000))]);
      if (!ev) { log(`PKC3-STACKDUMP ${why}: timeout (no Debugger.paused in 15s)`); return null; }
      const frames = (ev.callFrames ?? []).map((f, i) => `#${i} ${f.functionName || '?'} @${(f.url || '').split('/').pop().slice(0, 40)}:${f.location?.lineNumber ?? '?'}:${f.location?.columnNumber ?? '?'}`);
      log(`PKC3-STACKDUMP ${why}: reason=${ev.reason} frames=${frames.length}`);
      for (const fr of frames.slice(0, 60)) log(fr);
      await cdp.send('Debugger.resume').catch(() => {});
      if (cdpAll) { try { const lines = await cdpAll.dumpAll(why); log(`PKC3-STACKDUMP-ALL ${why}: sessions=${cdpAll.sessions.size}`); for (const l of lines) log(l); } catch (e) { log(`PKC3-STACKDUMP-ALL ${why}: error ${String(e).slice(0, 120)}`); } }
      return frames;
    } catch (e) { log(`PKC3-STACKDUMP ${why}: error ${String(e).slice(0, 160)}`); return null; }
  };
  const shot = async (label) => { if (!shotdir) return; await mkdir(shotdir, { recursive: true }); try { await page.screenshot({ path: join(shotdir, `${tag}-${label}.png`) }); } catch { /* 観測の書き込みで本体を止めない */ } };
  const canvasBox = () => page.evaluate(CANVAS_BOX);
  let clipBox = null;
  /** 版面の PNG byte 数と hash 集合(点滅 caret を集合に収める)。 */
  const frames = async (k = 4) => {
    const set = new Set(); const sizes = [];
    const clip = clipBox ? { x: clipBox.x, y: clipBox.y, width: clipBox.w, height: clipBox.h } : undefined;
    for (let i = 0; i < k; i += 1) {
      const png = await Promise.race([page.screenshot(clip ? { clip } : {}), new Promise((r) => setTimeout(() => r(null), 20000))]);
      if (png === null) return null;
      set.add(sha(png)); sizes.push(png.length);
      await page.waitForTimeout(400);
    }
    return { hashes: [...set], bytes: sizes };
  };
  const swapped = (a, b) => (a === null || b === null ? null : b.hashes.every((h) => !a.hashes.includes(h)));
  const status = () => page.evaluate("(document.getElementById('status') || {}).textContent ?? null").catch(() => null);
  const bandText = () => page.evaluate("(() => { const m = document.getElementById('msg'); return m && !m.hidden ? m.textContent.slice(0,120) : null; })()").catch(() => null);
  try {
    step('一式を IDB へ');
    await page.goto(`${base}/office/host.html`, { waitUntil: 'domcontentloaded' });
    row.staged = await page.evaluate(async () => {
      const { fetch, indexedDB } = globalThis;
      const grab = async (path) => { const r = await fetch(path); if (!r.ok) throw new Error(`${path} HTTP ${r.status}`); return r; };
      const m = await (await grab('/office-pack/pack.json')).json();
      const names = [...m.files, ...m.fonts];
      const db = await new Promise((res, rej) => { const r = indexedDB.open('pkc3-office-pack', 1); r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('files')) r.result.createObjectStore('files'); if (!r.result.objectStoreNames.contains('meta')) r.result.createObjectStore('meta'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const put = (s, k, v) => new Promise((res, rej) => { const t = db.transaction(s, 'readwrite'); t.objectStore(s).put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
      let bytes = 0;
      for (const nm of names) { const b = new globalThis.Blob([await (await grab(`/office-pack/${nm}`)).arrayBuffer()]); bytes += b.size; await put('files', nm, b); }
      await put('meta', 'pack', { version: m.version, installedAt: Date.now(), source: 'url', totalBytes: bytes, files: names.map((nm) => ({ name: nm })) });
      return { count: names.length, version: m.version, crossOriginIsolated: globalThis.crossOriginIsolated };
    });
    await page.addInitScript(({ doc, name }) => {
      const ch = new globalThis.BroadcastChannel('pkc3-office');
      ch.onmessage = (ev) => {
        const d = ev.data; if (!d || !d.pkc3Office) return;
        if (d.pkc3Office === 'ready-for-document') {
          const raw = globalThis.atob(doc); const u8 = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i += 1) u8[i] = raw.charCodeAt(i);
          ch.postMessage({ pkc3Office: 'document', payload: { name, bytes: u8 } });
        }
        if (d.pkc3Office === 'closed' || d.pkc3Office === 'shadow-failed') (globalThis.__bc ??= []).push(d.pkc3Office);
      };
      (globalThis.__bcall ??= []);
      const ch2 = new globalThis.BroadcastChannel('pkc3-office');
      ch2.onmessage = (ev) => { const d = ev.data; if (d && d.pkc3Office && d.pkc3Office !== 'alive') globalThis.__bcall.push(d.pkc3Office); };
    }, { doc: docB64, name: docName });
    step('文書を渡して開く');
    await page.goto(START ? `${base}/office/host.html` : `${base}/office/host.html?await-doc=1&name=${encodeURIComponent(docName)}`, { waitUntil: 'commit' });
    if (START) {
      // Start Center が出るまで待つ(版面の canvas が出て、落ち着くまで)
      for (let i = 0; i < 40; i += 1) { await page.waitForTimeout(3000); const b = await Promise.race([page.evaluate(CANVAS_BOX), new Promise((r) => setTimeout(() => r(null), 4000))]).catch(() => null); if (b) { row.canvas = b; break; } }
      await page.waitForTimeout(8000);
      await page.bringToFront();
      await shot('0-start');
      // Impress プレゼンテーション(Start Center の左の列)を押す
      await page.mouse.click(185, 469);
      await page.waitForTimeout(15000);
      row.opened = { atMs: Date.now() - t0, startCenter: true };
    }
    let opened = START ? row.opened : null;
    let unresp = 0;
    for (let i = 0; i < 40 && opened === null; i += 1) {
      await page.waitForTimeout(3000);
      try {
        const r = await Promise.race([
          page.evaluate((NAME) => {
            const titles = [];
            const wt = (node) => { for (const el of node.querySelectorAll('*')) { if (el.shadowRoot) wt(el.shadowRoot); else if (el.children.length === 0) titles.push(el.textContent ?? ''); } };
            const screen = document.getElementById('screen'); if (screen) wt(screen);
            const all = titles.join(' ');
            return { docOpen: all.includes(NAME), loTitle: /LibreOffice/i.test(all) };
          }, docName),
          new Promise((_, rej) => setTimeout(() => rej(new Error('unresponsive')), 4000)),
        ]);
        unresp = 0;
        if (r.docOpen && r.loTitle) opened = { atMs: Date.now() - t0 };
      } catch { unresp += 1; if (unresp === 3) await stackdump('load-wait unresponsive x3'); }
      if (row.faults.length) break;
    }
    row.opened = opened;
    if (opened === null) { row.undecidable = '文書が開かなかった'; return { row, page, ctx, h: null, close: async () => { await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]); await rm(profile, { recursive: true, force: true }).catch(() => {}); } }; }
    await page.bringToFront();
    await page.waitForTimeout(3000);
    step('開いた');
    const box = await canvasBox(); row.canvas = box; clipBox = box;
    await shot('1-opened');
  } catch (e) { row.error = String(e).slice(0, 200); row.undecidable = `例外: ${row.error}`; }
  stackdumpRef = stackdump;
  const h = { alive, stackdump, shot, canvasBox, frames, swapped, status, bandText, step, t0, get box() { return clipBox; } };
  return { row, page, ctx, h, close: async () => { await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]); await rm(profile, { recursive: true, force: true }).catch(() => {}); } };
}
