/**
 * 🔴 #772 段②-0「入れて測る」── 文字起こし部品の standalone probe(製品コードは 1 行も触らない)。
 *
 * 何を測るか(1 回の走りで 1 つの組み合わせ):
 *   読み込み秒(部品の import / モデルの取得 + wasm のコンパイル + session 生成)/
 *   常駐メモリ(Chromium の **プロセス木の Pss**。`tests/helpers/proc-memory.mjs`)/
 *   N 秒の音を字にする秒(2 回続けて ── 1 回目は warm-up を含む)/
 *   SharedArrayBuffer(COI)と wasm SIMD の有無。
 *
 * 前提(⚠ repo には入れない。数十〜数百 MB):
 *   --transformers <dir>  `@huggingface/transformers` の dist(`transformers.web.js` が在る所)
 *   --ort <dir>           `onnxruntime-web` の dist(`ort.webgpu.bundle.min.mjs` と `ort-wasm-*` が在る所)
 *   --models <dir>        `Xenova/whisper-<size>/` を含む所(sts-whisper-* の `package/models`)
 *   --wav <file>          16kHz mono PCM16 の WAV
 *   ⚠ ort の版は transformers の package.json が名指しする版(dev 版)と**揃える**。
 *
 * 使い方の例:
 *   node tests/probe/asr-probe.mjs --transformers … --ort … --models … --wav speech-60s.wav \
 *        --model base --coi on --threads 2 --variant asyncify --port 47871
 *   日本語の実音声なら `--lang japanese`(出力の text1 を**人が読んで**当たり具合を見る)。
 *   WAV は `ffmpeg -i in.m4a -ar 16000 -ac 1 -c:a pcm_s16le out.wav` で作る。
 *
 * ⚠ 観測の約束:
 *   - 配信は **loopback の小さな http サーバー**(`vite preview` ではない)。だから読み込み秒に
 *     **回線の時間は入らない**(disk → 取得 → wasm compile → session 生成だけ)。
 *   - **毎回まっさらな profile**(Cache Storage / HTTP cache が空 = 初回)。
 *   - 推論は **module Worker の中**(重い処理はワーカー ── CLAUDE.md)。メインは待つだけ。
 *   - 音は合成(ffmpeg の flite)。⚠ **日本語の当たり具合は、この probe では測れない**。
 */
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { URLSearchParams } from 'node:url';
import { chromium } from '@playwright/test';
import { profileMemoryMb } from '../helpers/proc-memory.mjs';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const opt = {
  transformers: arg('transformers'),
  ort: arg('ort'),
  models: arg('models'),
  wav: arg('wav'),
  model: arg('model', 'base'), // tiny | base | small
  coi: arg('coi', 'on') === 'on',
  threads: Number(arg('threads', '0')), // 0 = ort の既定に任せる
  variant: arg('variant', 'asyncify'), // asyncify | plain
  port: Number(arg('port', '47871')),
  timeoutSec: Number(arg('timeout', '900')),
  label: arg('label', ''),
  lang: arg('lang', 'english'), // whisper の language 名(日本語の実音声なら japanese)
};
for (const k of ['transformers', 'ort', 'models', 'wav']) {
  if (!opt[k] || !existsSync(opt[k])) {
    console.error(`--${k} が無い / 実在しない: ${opt[k]}`);
    process.exit(2);
  }
}
if (opt.port < 47871 || opt.port > 47873) {
  console.error('port は 47871〜47873');
  process.exit(2);
}

const PAGE = `<!doctype html><meta charset=utf-8><title>asr probe</title>
<script type="module">
const q = new URLSearchParams(location.search);
window.__phase = 'boot';
const out = { env: {
  crossOriginIsolated, sab: typeof SharedArrayBuffer !== 'undefined',
  hardwareConcurrency: navigator.hardwareConcurrency, webgpu: !!navigator.gpu,
  // wasm SIMD(v128.const 付きの最小 module を validate する)
  simd: WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11])),
}};
function parseWav(buf) {
  const dv = new DataView(buf);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(p), dv.getUint8(p+1), dv.getUint8(p+2), dv.getUint8(p+3));
    const size = dv.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = { ch: dv.getUint16(p+10, true), rate: dv.getUint32(p+12, true), bits: dv.getUint16(p+22, true) };
    if (id === 'data') { data = [p + 8, size]; break; }
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.bits !== 16 || fmt.ch !== 1 || fmt.rate !== 16000) throw new Error('wav は 16kHz mono PCM16 のみ: ' + JSON.stringify(fmt));
  const n = data[1] >> 1, f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = dv.getInt16(data[0] + i * 2, true) / 32768;
  return f;
}
try {
  const wav = parseWav(await (await fetch('/audio.wav')).arrayBuffer());
  out.audioSec = wav.length / 16000;
  const w = new Worker('/worker.mjs?' + q.toString(), { type: 'module' });
  const result = await new Promise((resolve, reject) => {
    w.onmessage = (e) => {
      if (e.data.phase) window.__phase = e.data.phase;
      if (e.data.done) resolve(e.data);
    };
    w.onerror = (e) => reject(new Error('worker error: ' + e.message));
    w.postMessage({ wav }, [wav.buffer]); // transfer(ゼロコピー)
  });
  out.worker = result;
  window.__phase = 'terminating';
  w.terminate();
  window.__phase = 'terminated';
} catch (e) {
  out.error = String(e && e.stack || e);
}
window.__RESULT__ = out;
</script>`;

const WORKER = `
const q = new URLSearchParams(self.location.search);
const t = {}, r = {};
const say = (phase) => self.postMessage({ phase });
self.onmessage = async (e) => {
  try {
    const wav = e.data.wav;
    say('import');
    let t0 = performance.now();
    const T = await import('/lib/transformers.web.js');
    t.importMs = performance.now() - t0;
    const { pipeline, env } = T;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = '/models/';
    env.useBrowserCache = false;
    const v = q.get('variant');
    const suffix = v === 'plain' ? '' : '.asyncify';
    env.backends.onnx.wasm.wasmPaths = {
      mjs: '/ort/ort-wasm-simd-threaded' + suffix + '.mjs',
      wasm: '/ort/ort-wasm-simd-threaded' + suffix + '.wasm',
    };
    const th = Number(q.get('threads'));
    if (th > 0) env.backends.onnx.wasm.numThreads = th;
    r.numThreadsRequested = th || null;
    say('load');
    t0 = performance.now();
    const asr = await pipeline('automatic-speech-recognition', 'Xenova/whisper-' + q.get('model'), { device: 'wasm', dtype: 'q8' });
    t.loadMs = performance.now() - t0;
    r.numThreadsEffective = env.backends.onnx.wasm.numThreads;
    say('loaded');
    r.runs = [];
    for (let i = 0; i < 2; i++) {
      say('run' + (i + 1));
      t0 = performance.now();
      const o = await asr(wav, { chunk_length_s: 30, stride_length_s: 5, language: q.get('lang'), task: 'transcribe', return_timestamps: false });
      r.runs.push({ ms: performance.now() - t0, text: o.text });
      say('ran' + (i + 1));
    }
    say('dispose');
    await asr.dispose();
    say('disposed');
    self.postMessage({ done: true, t, r });
  } catch (err) {
    self.postMessage({ done: true, t, r, error: String(err && err.stack || err) });
  }
};
`;

const rewriteTransformers = (src) =>
  src
    .replace('from "onnxruntime-web/webgpu"', 'from "/ort/ort.webgpu.bundle.min.mjs"')
    .replace('from "onnxruntime-common"', 'from "/ort/ort.webgpu.bundle.min.mjs"');

function serve() {
  const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body, type = 'text/plain') => {
      const h = { 'content-type': type, 'cache-control': 'no-store' };
      if (opt.coi) {
        h['cross-origin-opener-policy'] = 'same-origin';
        h['cross-origin-embedder-policy'] = 'require-corp';
        h['cross-origin-resource-policy'] = 'same-origin';
      }
      res.writeHead(code, h);
      res.end(body);
    };
    const file = (root, rel) => {
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(path.resolve(root) + path.sep) || !existsSync(abs) || !statSync(abs).isFile()) return send(404, 'not found');
      send(200, readFileSync(abs), mime[path.extname(abs)] ?? 'application/octet-stream');
    };
    if (u.pathname === '/') return send(200, PAGE, 'text/html');
    if (u.pathname === '/worker.mjs') return send(200, WORKER, 'text/javascript');
    if (u.pathname === '/audio.wav') return send(200, readFileSync(opt.wav), 'audio/wav');
    if (u.pathname === '/lib/transformers.web.js')
      return send(200, rewriteTransformers(readFileSync(path.join(opt.transformers, 'transformers.web.js'), 'utf8')), 'text/javascript');
    if (u.pathname.startsWith('/ort/')) return file(opt.ort, u.pathname.slice(5));
    if (u.pathname.startsWith('/models/')) return file(opt.models, decodeURIComponent(u.pathname.slice(8)));
    send(404, 'not found');
  });
  return new Promise((ok) => server.listen(opt.port, '127.0.0.1', () => ok(server)));
}

const bundled = process.env.PKC3_CHROMIUM || '/opt/pw-browsers/chromium';
const profile = mkdtempSync(path.join(tmpdir(), 'asr-probe-'));
const server = await serve();
const t00 = Date.now();
const samples = []; // { t, phase, pssMb, rssMb }
let browser;
try {
  browser = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(existsSync(bundled) ? { executablePath: bundled } : {}),
  });
  const page = browser.pages()[0] ?? (await browser.newPage());
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  // ⚠ 比べる基準は「何も載せていない 1 ページ」── ブラウザを起こしただけの値ではない
  await page.goto('about:blank');
  await new Promise((r) => setTimeout(r, 1500));
  const base = profileMemoryMb(profile);
  samples.push({ t: 0, phase: 'blank-page', ...base });
  const qs = new URLSearchParams({ model: opt.model, threads: String(opt.threads), variant: opt.variant, lang: opt.lang });
  await page.goto(`http://127.0.0.1:${opt.port}/?${qs}`);
  let result = null;
  while (Date.now() - t00 < opt.timeoutSec * 1000) {
    const st = await page.evaluate(() => ({ phase: window.__phase, res: window.__RESULT__ ?? null }));
    const m = profileMemoryMb(profile);
    samples.push({ t: Date.now() - t00, phase: st.phase, ...m });
    if (st.res) {
      result = st.res;
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  // ワーカー終了後(terminate 済み)の常駐を 3 秒おいて採る
  await new Promise((r) => setTimeout(r, 3000));
  const after = profileMemoryMb(profile);
  samples.push({ t: Date.now() - t00, phase: 'after-terminate+3s', ...after });
  await new Promise((r) => setTimeout(r, 7000));
  const after10 = profileMemoryMb(profile);
  samples.push({ t: Date.now() - t00, phase: 'after-terminate+10s', ...after10 });

  const peakOf = (pred) => Math.max(0, ...samples.filter(pred).map((s) => s.pssMb));
  const lastOf = (phase) => [...samples].reverse().find((s) => s.phase === phase)?.pssMb ?? null;
  const summary = {
    label: opt.label || `${opt.model}/${opt.variant}/coi-${opt.coi ? 'on' : 'off'}/th-${opt.threads || 'default'}`,
    opts: { model: opt.model, coi: opt.coi, threads: opt.threads, variant: opt.variant, lang: opt.lang, wav: path.basename(opt.wav) },
    timedOut: result === null,
    env: result?.env ?? null,
    audioSec: result?.audioSec ?? null,
    importMs: result?.worker?.t?.importMs != null ? Math.round(result.worker.t.importMs) : null,
    loadMs: result?.worker?.t?.loadMs != null ? Math.round(result.worker.t.loadMs) : null,
    numThreads: result?.worker?.r ? { requested: result.worker.r.numThreadsRequested, effective: result.worker.r.numThreadsEffective } : null,
    runMs: result?.worker?.r?.runs?.map((r) => Math.round(r.ms)) ?? null,
    text1: result?.worker?.r?.runs?.[0]?.text ?? null,
    error: result?.error ?? result?.worker?.error ?? null,
    pssMb: {
      blankPage: base.pssMb,
      // 読み込み直後(run1 の最初のサンプル)/ 読み込み中の最大 / 推論中の最大
      atLoaded: samples.find((s) => s.phase === 'run1')?.pssMb ?? null,
      peakDuringLoad: peakOf((s) => s.phase === 'load' || s.phase === 'import'),
      peakDuringRun: peakOf((s) => s.phase === 'run1' || s.phase === 'run2'),
      // 推論が済んだ後・worker を terminate した後(+3 秒 / +10 秒)
      lastRunSample: lastOf('run2') ?? lastOf('ran2'),
      afterTerminate3s: after.pssMb,
      afterTerminate10s: after10.pssMb,
    },
    procsAtPeak: Math.max(...samples.map((s) => s.procs)),
    wallSec: +((Date.now() - t00) / 1000).toFixed(1),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.timedOut || summary.error) process.exitCode = 1;
} finally {
  await browser?.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
