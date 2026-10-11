/* global Blob, WebSocket, navigator, AudioContext */
/**
 * 🔴 動画の切り出し(#683 段②b。設計 doc §9.1c)の実測 probe。再実行できる形で置く。
 *
 * 測るもの(実物の `cutVideo` / `scanVideo` を、本物の Worker の中で回す):
 *   1. 1080p / 4K の作り直し(押した所ぴったり)の所要時間・同時に生きる VideoFrame の最大数(復号器の出力を数え、
 *      `VideoFrame.prototype.close` を数える ── 製品の `reencodeHead` の stats とは別の観測)・JS heap・ブラウザ全体の RSS
 *   2. 音と映像のずれ(白い点滅と 1kHz のビープを同じ時計で採り、元と切り出し後の差を見る)
 *   3. ビットレートの式(元の実測 × 1.2、下限 = 画素数 × 0.8)の画質(出力 vs 元の同じフレームの PSNR / SSIM)と大きさ。
 *      符号化器の `configure` に倍率を掛けて、式の ×0.5 / ×1 / ×2 を同条件で突き合わせる(1080p のみ)
 *
 * 使い方: `node scripts/probes/video-trim-measure.mjs [--reps 3] [--seconds 16] [--wc-seconds 12] [--out file.json] [--only 360,1080,4k(接頭辞のコンマ区切り)] [--bisect none|mr|audio|quality|sync|mrsync] [--lean(1080p@x1 の作り直しだけ。元の音と映像のずれ・画質は採らない)] [--mr-opts JSON]`
 *   `PKC3_CHROMIUM` でブラウザを差し替える(既定 `/opt/pw-browsers/chromium` = フル版)。
 * ⚠ 箱を静かにして回す(他の重い仕事と同時に回さない)。⚠ 合成の絵なので、実画面の録画の代表ではない。
 */
import { chromium } from '@playwright/test';
import { build } from 'vite';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pageFns from './video-trim-measure-page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const REPS = Number(arg('reps', '3'));
const SECONDS = Number(arg('seconds', '16'));
const OUT = arg('out', '');
const ONLY = arg('only', '');
const PAIRS = [2, 6, 10, 14].filter((p) => p < SECONDS - 1);
const PORT = Number(arg('port', '47693'));
const MR_OPTS = JSON.parse(arg('mr-opts', '{"videoKeyFrameIntervalDuration":4000}'));
const BISECT = arg('bisect', '');
const LEAN = argv.includes('--lean');
const WC_SECONDS = Number(arg('wc-seconds', '12'));

async function bundle() {
  const entry = path.join(here, 'video-trim-measure-entry.mjs');
  const res = await build({
    configFile: false,
    root: repo,
    logLevel: 'error',
    resolve: {
      alias: {
        '@core': path.join(repo, 'src/core'),
        '@features': path.join(repo, 'src/features'),
        '@adapter': path.join(repo, 'src/adapter'),
        '@runtime': path.join(repo, 'src/runtime'),
      },
    },
    build: {
      write: false,
      minify: false,
      lib: { entry, name: 'VC', formats: ['iife'], fileName: 'vc' },
    },
  });
  const outs = Array.isArray(res) ? res : [res];
  const chunk = outs[0].output.find((o) => o.type === 'chunk');
  return chunk.code;
}

/** /proc/stat の合計 jiffies と steal / idle。 */
function cpuStat() {
  const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const total = f.slice(0, 8).reduce((a, b) => a + b, 0);
  return { total, idle: f[3] + f[4], steal: f[7] };
}

/** この probe が起こした Chromium の各 process の CPU 時間(jiffies)。種類は `--type=`。 */
function procCpu() {
  const m = new Map();
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const exe = fs.readlinkSync('/proc/' + pid + '/exe');
      if (!exe.includes('/opt/pw-browsers/')) continue;
      const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const rest = st.slice(st.lastIndexOf(')') + 2).split(' ');
      const cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
      const type = (cmd.match(/--type=([a-z-]+)/) ?? [null, 'browser'])[1];
      m.set(pid, { type, ticks: Number(rest[11]) + Number(rest[12]) });
    } catch {
      /* 消えた process */
    }
  }
  return m;
}
function procCpuDelta(a, b) {
  const by = {};
  for (const [pid, v] of b) {
    const d = v.ticks - (a.get(pid)?.ticks ?? 0);
    by[v.type] = (by[v.type] ?? 0) + d;
  }
  return by;
}

/** ブラウザ全体(この probe が起こした Chromium)の RSS 合計(MB)。 */
function browserRssMb() {
  let sum = 0;
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const exe = fs.readlinkSync('/proc/' + pid + '/exe');
      if (!exe.includes('/opt/pw-browsers/')) continue;
      const st = fs.readFileSync('/proc/' + pid + '/statm', 'utf8').split(' ');
      sum += (Number(st[1]) * 4096) / 1048576;
    } catch {
      /* 消えた process */
    }
  }
  return sum;
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length === 0 ? NaN : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r1 = (n) => Math.round(n * 10) / 10;

const WORKER_BODY = String.raw`
const base = VC.nativeCodecApi();
let timerWakes = 0;
const realSetTimeout = self.setTimeout.bind(self);
self.setTimeout = (fn, ms, ...a) => (ms === 250 ? realSetTimeout(() => { timerWakes += 1; fn(...a); }, ms) : realSetTimeout(fn, ms, ...a));
let created = 0;
let closed = 0;
let peak = 0;
const seen = new WeakSet();
const origClose = VideoFrame.prototype.close;
VideoFrame.prototype.close = function () {
  if (!seen.has(this)) { seen.add(this); closed += 1; }
  return origClose.call(this);
};
const mem = () => (performance.memory ? performance.memory.usedJSHeapSize : null);
function wrapApi(factor, acc) {
  return {
    createEncoder(init) {
      const e = base.createEncoder({
        output: (c) => { acc.encBytes += c.data.length; acc.encChunks += 1; if (c.type === 'key') acc.encKeys += 1; init.output(c); },
        error: init.error,
      });
      const cfg = e.configure.bind(e);
      e.configure = (c) => { acc.formulaBitrate = c.bitrate; acc.usedBitrate = Math.round(c.bitrate * factor); acc.framerate = c.framerate; cfg({ ...c, bitrate: acc.usedBitrate }); };
      return e;
    },
    createDecoder(init) {
      return base.createDecoder({
        output: (f) => { created += 1; if (created - closed > peak) peak = created - closed; init.output(f); },
        error: init.error,
      });
    },
    makeProbeFrame(w, h) { const f = base.makeProbeFrame(w, h); created += 1; return f; },
  };
}
self.onmessage = async (ev) => {
  const { op, blob, startMs, endMs, factor } = ev.data;
  try {
    if (op === 'env') { self.postMessage({ ok: true, codec: base !== null, hasGc: typeof gc === 'function', hasMem: mem() !== null }); return; }
    created = 0; closed = 0; peak = 0; timerWakes = 0;
    const acc = { encBytes: 0, encChunks: 0, encKeys: 0, formulaBitrate: 0, usedBitrate: 0, framerate: 0 };
    const api = wrapApi(factor || 1, acc);
    const t00 = performance.now();
    const sc = await VC.scanVideo({ blob, startMs, endMs }, api);
    const scanMs = performance.now() - t00;
    if (!sc.ok) throw new Error('scan refused: ' + sc.reason);
    const spec = VC.precisePlanSpec(sc.scan, startMs, endMs);
    const params = VC.preciseEncodeParams(sc.scan);
    const video = sc.scan.blocks.filter((b) => b.track === sc.scan.videoTrack);
    let srcBytes = 0;
    for (const b of video) srcBytes += b.dataEnd - b.dataStart;
    const info = {
      width: sc.scan.width, height: sc.scan.height, frameGapMs: sc.scan.frameGapMs, keyMs: sc.scan.keyMs, videoFrames: video.length,
      sourceEndMs: sc.scan.sourceEndMs, srcVideoBytes: srcBytes, params, precise: sc.precise,
      emit: spec ? spec.emit.length : null, decode: spec ? spec.decode.length : null, tailFromMs: spec ? spec.tailFromMs : null, reencode: spec ? spec.reencode : null,
      headSrcBytes: spec ? spec.emit.reduce((s, b) => s + (b.dataEnd - b.dataStart), 0) : null,
    };
    if (op === 'scan') { self.postMessage({ ok: true, info }); return; }
    if (typeof gc === 'function') gc();
    const h0 = mem();
    let hp = h0;
    const iv = setInterval(() => { const m = mem(); if (m !== null && m > hp) hp = m; }, 40);
    const created0 = created, closed0 = closed;
    const t0 = performance.now();
    const r = await VC.cutVideo({ blob, scan: sc.scan, startMs, endMs, mode: 'precise' }, api);
    const wallMs = performance.now() - t0;
    clearInterval(iv);
    const h1raw = mem();
    if (typeof gc === 'function') gc();
    const h1 = mem();
    if (!r.ok) { self.postMessage({ ok: false, reason: r.reason || ('preciseFailed env=' + r.environmentBroken), info }); return; }
    self.postMessage({
      ok: true, info, scanMs, wallMs, timerWakes, created: created - created0, closed: closed - closed0, live: created - closed, peakLive: peak,
      heap: { before: h0, peak: hp, afterRaw: h1raw, afterGc: h1 }, acc,
      result: { blob: r.blob, size: r.blob.size, durationMs: r.durationMs, reencoded: r.reencoded, precise: r.precise, snapBackMs: r.snapBackMs, keptVideo: r.keptVideo, keptAudio: r.keptAudio },
    });
  } catch (e) {
    self.postMessage({ ok: false, reason: String(e && e.stack || e) });
  }
};
`;

/** ページの中: Worker を 1 つ起こして 1 件回し、結果(Blob は window.__out に保存)を返す。 */
async function runInWorker(workerSrc, key, srcKey, msg) {
  const url = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
  const w = new Worker(url);
  const res = await new Promise((resolve, reject) => {
    w.onmessage = (e) => resolve(e.data);
    w.onerror = (e) => reject(new Error('worker error: ' + e.message));
    w.postMessage({ ...msg, blob: window.__src[srcKey] });
  });
  // 🔑 後始末(gc)の後の heap を CDP で採るため、少し生かしておく
  await new Promise((r) => setTimeout(r, 2000));
  w.terminate();
  URL.revokeObjectURL(url);
  if (res.result && res.result.blob) {
    window.__out = window.__out || {};
    window.__out[key] = res.result.blob;
    res.result = { ...res.result, blob: undefined };
  }
  return res;
}


/** ブラウザ全体への素の CDP(Worker の heap を採るため。playwright の CDPSession は Worker に繋げない)。 */
async function connectBrowserCdp(port) {
  const info = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id !== undefined && waiting.has(d.id)) {
      const w = waiting.get(d.id);
      waiting.delete(d.id);
      if (d.error) w.rej(new Error(d.error.message));
      else w.res(d.result);
    }
  };
  // 🔑 終わった Worker の session へ送ると返事が来ない(await が永久に残る)── 2 秒で諦める
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      id += 1;
      waiting.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => rej(new Error('cdp timeout')), 2000);
    });
  return { send, close: () => ws.close() };
}

/** 走っている Worker(blob: の dedicated worker)の JS heap を 80ms ごとに採る。`stop()` で止まり、採った列を返す。 */
function startWorkerHeapSampler(cdpb) {
  let stopped = false;
  const samples = [];
  let sessionId = null;
  const loop = (async () => {
    while (!stopped) {
      try {
        if (sessionId === null) {
          const { targetInfos } = await cdpb.send('Target.getTargets');
          const t = targetInfos.find((x) => x.type === 'worker' && x.url.startsWith('blob:'));
          if (t) sessionId = (await cdpb.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
        } else {
          const r = await cdpb.send('Runtime.getHeapUsage', {}, sessionId);
          samples.push(r.usedSize);
        }
      } catch {
        /* worker が終わった */
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  })();
  return async () => {
    stopped = true;
    await loop;
    return samples;
  };
}

async function main() {
  const t0 = Date.now();
  const bundleCode = await bundle();
  const workerSrc = bundleCode + '\n' + WORKER_BODY;
  const server = http.createServer((q, s) => {
    s.setHeader('content-type', 'text/html');
    s.end('<html><body></body></html>');
  });
  await new Promise((r) => server.listen(PORT, r));
  const exe = process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--autoplay-policy=no-user-gesture-required', '--js-flags=--expose-gc', '--remote-debugging-port=' + (PORT + 1)],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
  await page.goto('http://localhost:' + PORT + '/');
  const cdp = await page.context().newCDPSession(page);
  const cdpb = await connectBrowserCdp(PORT + 1);
  await page.evaluate('window.__p = {' + Object.entries(pageFns).map(([k, f]) => k + ':' + f.toString()).join(',') + '}');
  const out = { browser: await browser.version(), exe, reps: REPS, seconds: SECONDS, wcSeconds: WC_SECONDS, pairs: PAIRS, startedAt: new Date().toISOString(), runs: [], sources: {}, sync: [], quality: [] };

  // 本物の Worker の中で WebCodecs が使えるか(使えなければ 判定不能)
  const runW = (key, srcKey, msg) =>
    page.evaluate(
      async ({ workerSrc, key, srcKey, msg, fn }) => {
        const f = new Function('return ' + fn)();
        return f(workerSrc, key, srcKey, msg);
      },
      { workerSrc, key, srcKey, msg, fn: runInWorker.toString() },
    );
  const env = await page.evaluate(async ({ workerSrc }) => {
    const url = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
    const w = new Worker(url);
    const r = await new Promise((res) => {
      w.onmessage = (e) => res(e.data);
      w.postMessage({ op: 'env' });
    });
    w.terminate();
    return { ...r, ua: navigator.userAgent, cores: navigator.hardwareConcurrency };
  }, { workerSrc });
  out.env = env;
  console.log('env', JSON.stringify(env));
  if (!env.codec) {
    console.log('判定不能: Worker に WebCodecs(VP8)が無い');
    await browser.close();
    server.close();
    return;
  }

  const SOURCES = [
    // 音と映像のずれ用。⚠ MediaRecorder は 1080p を実時間で 4〜18fps、4K を 5fps ほどしか録れない(この箱)ので、
    //   点滅を 30fps で拾える 360p で録る(ずれは画の大きさに依らない container の時刻の話)
    { name: '360p-mr', kind: 'mr', w: 640, h: 360 },
    { name: '1080p-30', kind: 'wc', w: 1920, h: 1080, fps: 30, bitrate: 4_000_000 },
    { name: '4K-30', kind: 'wc', w: 3840, h: 2160, fps: 30, bitrate: 16_000_000 },
  ].filter((r) => !ONLY || ONLY.toLowerCase().split(',').some((o) => r.name.toLowerCase().startsWith(o)));
  for (const r of SOURCES) {
    const g =
      r.kind === 'mr'
        ? await page.evaluate(({ k, w, h, s, p, o }) => window.__p.genSource(k, w, h, s, p, o), { k: r.name, w: r.w, h: r.h, s: SECONDS, p: PAIRS, o: MR_OPTS })
        : await page.evaluate(({ k, w, h, s, fps, kc, br }) => window.__p.genSourceWc(k, w, h, s, fps, kc, br), { k: r.name, w: r.w, h: r.h, s: WC_SECONDS, fps: r.fps, kc: 4, br: r.bitrate });
    out.sources[r.name] = { ...g };
    console.log('source', r.name, JSON.stringify(g));
    if (g.error) throw new Error(g.error);
    // 切る範囲: 2 つ目のキーフレーム + 300ms(作り直しが長くなる所)。終わりは録画の終わりの手前
    const s = await runW(r.name, r.name, { op: 'scan', startMs: 0, endMs: (SECONDS + 10) * 1000 });
    if (!s.ok) throw new Error('scan: ' + s.reason);
    const ks = s.info.keyMs;
    r.startMs = (ks[1] ?? 2000) + 300;
    r.endMs = Math.min(s.info.sourceEndMs - 500, ((r.kind === 'mr' ? SECONDS : WC_SECONDS) - 1) * 1000);
    out.sources[r.name].scan = { keyMs: ks, frameGapMs: s.info.frameGapMs, videoFrames: s.info.videoFrames, srcVideoBytes: s.info.srcVideoBytes, params: s.info.params, startMs: r.startMs, endMs: r.endMs, sourceEndMs: s.info.sourceEndMs };
    console.log(r.name, 'keys', ks.map((k) => Math.round(k)).join(','), 'start', r.startMs, 'end', r.endMs, 'fps~', r1(1000 / s.info.frameGapMs), 'frames', s.info.videoFrames);
  }

  // 切り分け(--bisect X): 同じ page で「何かをした前後」の作り直しの所要時間を比べる(X = mr | audio | quality | sync)
  if (BISECT) {
    const r = SOURCES.find((x) => x.kind === 'wc');
    const timeRun = async (label, i) => {
      const key = 'bis' + i;
      const pc0 = procCpu();
      const res = await runW(key, r.name, { op: 'cut', startMs: r.startMs, endMs: r.endMs, factor: 1 });
      const d = procCpuDelta(pc0, procCpu());
      console.log('bisect', BISECT, label, 'wall(ms)', Math.round(res.wallMs), 'renderer CPU(s)', d.renderer / 100);
      out.runs.push({ label, wallMs: Math.round(res.wallMs), rendererCpuSec: d.renderer / 100 });
    };
    for (let i = 0; i < 2; i += 1) await timeRun('前', i);
    if (BISECT === 'mr') await page.evaluate(({ o }) => window.__p.genSource('b-mr', 640, 360, 8, [2, 6], o), { o: MR_OPTS });
    if (BISECT === 'mrsync') {
      await page.evaluate(({ o }) => window.__p.genSource('b-mr', 640, 360, 8, [2, 6], o), { o: MR_OPTS });
      for (let i = 0; i < 3; i += 1) await page.evaluate(() => window.__p.measureSync('b-mr', 'src', 1));
    }
    if (BISECT === 'audio') {
      await page.evaluate(async () => {
        const ac = new AudioContext();
        await ac.resume();
        const o = ac.createOscillator();
        o.connect(ac.destination);
        o.start();
        await new Promise((res) => setTimeout(res, 3000));
        o.stop();
        await ac.close();
      });
    }
    if (BISECT === 'quality' || BISECT === 'sync') {
      // 作り直した出力(音なし)を再生する。出力は window.__out['bis1']
      if (BISECT === 'quality') await page.evaluate(({ k, sk, st }) => window.__p.measureQuality(k, sk, st, [0, 1], 0.5), { k: 'bis1', sk: r.name, st: r.startMs });
      else await page.evaluate(({ k }) => window.__p.measureSync(k, 'out', 1), { k: 'bis1' });
    }
    for (let i = 2; i < 7; i += 1) await timeRun('後', i);
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    cdpb.close();
    await browser.close();
    server.close();
    return;
  }

  // 元の音と映像のずれ(基準)
  out.srcSync = {};
  for (const r of LEAN ? [] : SOURCES.filter((x) => x.kind === 'mr')) {
    out.srcSync[r.name] = [];
    for (let i = 0; i < REPS; i += 1) {
      const m = await page.evaluate(({ k }) => window.__p.measureSync(k, 'src', 1), { k: r.name });
      out.srcSync[r.name].push(m);
      console.log('srcSync', r.name, i, 'flashes', m.flashes.length, 'beeps', m.beeps.length, 'frames', m.frames);
    }
  }

  const has = (n) => SOURCES.some((r) => r.name === n);
  const CONFIGS = [
    { src: '1080p-30', f: 1 },
    { src: '4K-30', f: 1 },
    { src: '360p-mr', f: 1 },
    { src: '1080p-30', f: 0.5 },
    { src: '1080p-30', f: 2 },
  ].filter((c) => has(c.src) && (!LEAN || (c.f === 1 && c.src === '1080p-30')));
  const heapUsed = async () => (await cdp.send('Runtime.getHeapUsage')).usedSize;
  for (let rep = 0; rep < REPS; rep += 1) {
    // 並び順は rep ごとに回す(同じ設定がいつも同じ位置にならない)
    const order = CONFIGS.map((_, i) => CONFIGS[(i + rep * 3) % CONFIGS.length]);
    for (const c of order) {
      const r = SOURCES.find((x) => x.name === c.src);
      const key = c.src + '@' + c.f + '#' + rep;
      await new Promise((rs) => setTimeout(rs, 1500)); // 前の run の後始末を待つ(RSS の起点を揃える)
      const rssBefore = browserRssMb();
      const heapBefore = await heapUsed();
      let rssPeak = rssBefore;
      const iv = setInterval(() => {
        rssPeak = Math.max(rssPeak, browserRssMb());
      }, 150);
      const cpu0 = cpuStat();
      const pc0 = procCpu();
      const stopSampler = startWorkerHeapSampler(cdpb);
      const res = await runW(key, r.name, { op: 'cut', startMs: r.startMs, endMs: r.endMs, factor: c.f });
      clearInterval(iv);
      const cpu1 = cpuStat();
      const pcDelta = procCpuDelta(pc0, procCpu());
      const heapSamples = await stopSampler();
      await new Promise((rs) => setTimeout(rs, 1500));
      const rssAfter = browserRssMb();
      const heapAfter = await heapUsed();
      const row = { rep, src: c.src, factor: c.f, ok: res.ok, reason: res.reason, rssBeforeMb: r1(rssBefore), rssPeakMb: r1(rssPeak), rssAfterMb: r1(rssAfter), mainHeapBefore: heapBefore, mainHeapAfter: heapAfter };
      if (res.ok) {
        const head = res.acc.encBytes;
        Object.assign(row, {
          wallMs: Math.round(res.wallMs),
          timerWakes: res.timerWakes,
          cpuTicksByProc: pcDelta,
          cpuBusyPct: Math.round((1 - (cpu1.idle - cpu0.idle) / (cpu1.total - cpu0.total)) * 1000) / 10,
          cpuStealPct: Math.round(((cpu1.steal - cpu0.steal) / (cpu1.total - cpu0.total)) * 1000) / 10,
          scanMs: Math.round(res.scanMs),
          frames: res.acc.encChunks,
          decodeFrames: res.info.decode,
          msPerFrame: r1(res.wallMs / Math.max(1, res.acc.encChunks)),
          created: res.created,
          closed: res.closed,
          live: res.live,
          peakLive: res.peakLive,
          workerHeapMb: heapSamples.length === 0 ? null : { first: r1(heapSamples[0] / 1048576), peak: r1(Math.max(...heapSamples) / 1048576), last: r1(heapSamples[heapSamples.length - 1] / 1048576), n: heapSamples.length },
          formulaBitrate: res.acc.formulaBitrate,
          usedBitrate: res.acc.usedBitrate,
          framerate: res.acc.framerate,
          srcVideoBitrate: Math.round((res.info.srcVideoBytes * 8 * 1000) / (res.info.videoFrames * res.info.frameGapMs)),
          headEncBytes: head,
          headSrcBytes: res.info.headSrcBytes,
          headSizeRatio: Math.round((head / res.info.headSrcBytes) * 1000) / 1000,
          outSize: res.result.size,
          durationMs: res.result.durationMs,
          encKeys: res.acc.encKeys,
          tailFromMs: res.info.tailFromMs,
        });
      }
      out.runs.push(row);
      console.log('run', JSON.stringify(row));
      if (!res.ok || LEAN) continue;
      const tailRel = res.info.tailFromMs === null ? null : (res.info.tailFromMs - r.startMs) / 1000;
      // 画質(同じ番号のフレームを元と突き合わせる)。継ぎ目(tailRel)の前後 2 枚ずつ
      const targets = (tailRel === null ? [0, 1, 3] : [0, 1, tailRel - 0.2, tailRel - 0.05, tailRel, tailRel + 0.05, tailRel + 2])
        .filter((t) => t >= 0)
        .sort((a, b) => a - b);
      const q = await page.evaluate(({ key, srcKey, startMs, targets }) => window.__p.measureQuality(key, srcKey, startMs, targets, 0.5), { key, srcKey: r.name, startMs: r.startMs, targets });
      out.quality.push({ rep, src: c.src, factor: c.f, tailRel, rows: q });
      console.log('quality', c.src, c.f, rep, q.map((x) => (x.missing ? 'missing' : x.target.toFixed(2) + ':' + x.psnr.toFixed(1) + 'dB/' + x.ssim.toFixed(4))).join('  '));
      if (c.f === 1 && r.kind === 'mr') {
        const m = await page.evaluate(({ k }) => window.__p.measureSync(k, 'out', 1), { k: key });
        out.sync.push({ rep, src: c.src, tailRel, startMs: r.startMs, ...m });
        console.log('sync', c.src, rep, 'flashes', m.flashes.length, 'beeps', m.beeps.length);
      }
      await page.evaluate((k) => {
        delete window.__out[k];
      }, key);
    }
  }
  out.elapsedSec = Math.round((Date.now() - t0) / 1000);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  summarize(out);
  cdpb.close();
  await browser.close();
  server.close();
}

function summarize(out) {
  const rng = (a) => `${r1(median(a))} (${r1(Math.min(...a))}〜${r1(Math.max(...a))})`;
  const groups = new Map();
  for (const r of out.runs) {
    const k = r.src + ' x' + r.factor;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  console.log('--- 作り直し(src x倍率)');
  for (const [k, rs] of groups) {
    const ok = rs.filter((r) => r.ok);
    if (ok.length === 0) {
      console.log(k, 'n=0 全部失敗', rs.map((r) => r.reason).join(' | ').slice(0, 300));
      continue;
    }
    console.log(
      k,
      'n=' + ok.length,
      'frames', ok[0].frames, 'decode', ok[0].decodeFrames,
      'wall(ms)', rng(ok.map((r) => r.wallMs)),
      '250msタイマ起床', ok.map((r) => r.timerWakes).join(','),
      'CPU使用率%(箱全体)', ok.map((r) => r.cpuBusyPct).join(','),
      'steal%', ok.map((r) => r.cpuStealPct).join(','),
      'ms/frame', rng(ok.map((r) => r.msPerFrame)),
      'peakLive', rng(ok.map((r) => r.peakLive)),
      'live末', rng(ok.map((r) => r.live)),
      'created/closed', ok.map((r) => r.created + '/' + r.closed).join(','),
      'rssPeak(MB)', rng(ok.map((r) => r.rssPeakMb)),
      'rss前→後', ok.map((r) => r.rssBeforeMb + '→' + r.rssAfterMb).join(','),
      'workerHeap前/peak/後(MB)', ok.map((r) => (r.workerHeapMb ? r.workerHeapMb.first + '/' + r.workerHeapMb.peak + '/' + r.workerHeapMb.last : 'n/a')).join(','),
      'bitrate(式/元)', ok[0].usedBitrate, ok[0].srcVideoBitrate,
      '頭のバイト/元', rng(ok.map((r) => r.headSizeRatio)),
    );
  }
  console.log('--- 画質(出力 vs 元 の同じフレーム。target = 出力の秒。継ぎ目 = 区切りを挟む target)');
  const qg = new Map();
  for (const q of out.quality) {
    const k = q.src + ' x' + q.factor;
    if (!qg.has(k)) qg.set(k, []);
    qg.get(k).push(q);
  }
  for (const [k, qs] of qg) {
    const n = Math.min(...qs.map((q) => q.rows.length));
    const cols = [];
    for (let i = 0; i < n; i += 1) {
      const rows = qs.map((q) => q.rows[i]).filter((x) => x && !x.missing);
      if (rows.length === 0) continue;
      cols.push(`t${rows[0].target.toFixed(2)} ${rng(rows.map((x) => x.psnr))}dB ssim ${median(rows.map((x) => x.ssim)).toFixed(4)} (n=${rows.length})`);
    }
    console.log(k, '|', cols.join(' | '));
  }
  console.log('--- 音と映像のずれ(ビープ − 点滅、ms。出力 − 元 の差が切り出しで増えたずれ)');
  const byPair = new Map();
  for (const sy of out.sync) {
    const srcRuns = (out.srcSync[sy.src] ?? []).filter((m) => m.beeps.length === m.flashes.length && m.beeps.length > 0);
    if (srcRuns.length === 0) {
      console.log(sy.src, 'rep', sy.rep, '判定不能: 元の再生で点滅とビープの数が揃わない');
      continue;
    }
    const n = srcRuns[0].beeps.length;
    const med = (f) => Array.from({ length: n }, (_, i) => median(srcRuns.map((m) => f(m, i))));
    const srcMedia = med((m, i) => m.flashes[i].media);
    const srcOff = med((m, i) => (m.beeps[i] - m.flashes[i].t) * 1000);
    const idx = srcMedia.map((t, i) => i).filter((i) => srcMedia[i] * 1000 >= sy.startMs);
    if (sy.beeps.length !== idx.length || sy.flashes.length !== idx.length) {
      console.log(sy.src, 'rep', sy.rep, '判定不能: 出力の対の数が合わない', 'out beeps', sy.beeps.length, 'flashes', sy.flashes.length, '期待', idx.length);
      continue;
    }
    const tailFrom = sy.tailRel === null ? null : sy.startMs + sy.tailRel * 1000;
    idx.forEach((i, j) => {
      const outOff = (sy.beeps[j] - sy.flashes[j].t) * 1000;
      const where = tailFrom !== null && srcMedia[i] * 1000 >= tailFrom ? '尻(元のバイト)' : '頭(作り直し)';
      const k = '対' + (i + 1) + ' 元の時刻' + r1(srcMedia[i]) + 's ' + where;
      if (!byPair.has(k)) byPair.set(k, { src: [], out: [], delta: [] });
      const e = byPair.get(k);
      e.src.push(...srcRuns.map((m) => (m.beeps[i] - m.flashes[i].t) * 1000));
      e.out.push(outOff);
      e.delta.push(outOff - srcOff[i]);
    });
  }
  for (const [k, e] of byPair) {
    console.log(k, '| 元の差 median', r1(median(e.src)), `(${r1(Math.min(...e.src))}〜${r1(Math.max(...e.src))}, n=${e.src.length})`, '| 出力の差', rng(e.out), 'n=' + e.out.length, '| 増えたずれ(出力−元)', rng(e.delta));
  }
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
