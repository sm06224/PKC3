/**
 * 🔴 **JS → LO の `XStorable.storeToURL` で、保存前の控え(影)を wasm の FS へ書けるか**(#1228 段 1')。
 *
 * 製品は 1 行も変えない。窓は `public/office/host.html` をそのまま使い、**自作の fixture** だけを開く。
 * 段 0(`autorecovery-probe.mjs`)の作法を引き継ぐ ── 一式の配り方 / 文書の渡し方 / heartbeat / 見張り。
 *
 * ## 測るもの(依頼文 1〜6)
 *  1. 書けるか      … `/work/shadow/<名前>` へ書かれたか。FS から読み戻して大きさ・先頭 4 byte・zip の中身
 *  2. 形式          … `.odt`(native)/ `.docx`(非 ODF)。`FilterName` を渡す / 渡さない / 別の形式を渡す
 *  3. 塞ぎ時間      … 呼びの前後の `performance.now()` と、窓の 20ms 刻みの heartbeat の途切れ
 *  4. 副作用        … `isModified` / 取り消し / 焦点・caret / 窓の題名(UNO の `XTitle` と `getLocation`)
 *  5. 連打          … 同じ path へ N 回(既定 10 回・2 秒おき)
 *  6. 対照群        … 何も呼ばない(`control`)/ `isModified()` だけ 30 回 / 何もしない区間の heartbeat
 *
 * ## 腕(arm)
 *  - `control` … 影を書かない。「打つ → X を打つ → 取り消す」を**同じ順番**で通した基線
 *  - `asis`    … **製品の窓のまま**で `storeToURL` を呼ぶ
 *  - `patched` … ⚠ **probe の中だけで** wasm の import `fd_sync` を「何もせず 0 を返す普通の関数」に
 *                差し替えてから呼ぶ(`WebAssembly.instantiateStreaming` を包む)。製品の file は触らない。
 *                理由は `asis` の結果(`fd_sync` が JSPI の suspend 側 import で、LO の main ループの外から
 *                呼ぶ同期呼びでは suspend できず `SuspendError`)── 差し替えが「何を変えるか」を見るための腕。
 *
 * ⚠ 結果の解釈は書かない(JSON に値を出すだけ)。対照群が届かない回(`unoOk` が無い / 文書が組まれない)は
 *   `verdict: '判定不能'` を付ける。
 *
 * 使い方:
 *   node build/office-wasm/shadow-store-probe.mjs <pages 形式の pack> <出力.json>
 *   PKC3_SS_CASES=small-odt:asis,large-docx:patched   既定は全部(4 文書 × control/asis/patched)
 *   PKC3_SS_REPEAT=10                                 連打の回数(既定 10)
 *   PKC3_SS_SETTLE=12                                 窓が立ってから測り始めるまでの秒(既定 12)
 *   PKC3_SS_PORT=<port>                               既定 48152
 *   PKC3_SS_FIXDIR=<dir>                              fixture の置き場(既定は tmp。終わったら消す)
 *   PKC3_SS_KEEP=<dir>                                影の実物(初回の 1 件 + asis の取り残し)を落とす先(自作 fixture のみ)。
 *                                                     native `soffice --convert-to txt` で「文書として開けるか」を外から見る用
 *   PKC3_CHROMIUM / PKC3_PUBLIC
 *
 * ⚠ fixture は **native `soffice --convert-to`** で作る(`.fodt` を本 probe が組み、`.odt` / `.docx` へ変換)。
 *   repo に bytes は置かない。`soffice` が無ければ `verdict: '判定不能'` で終わる。
 */
import { createServer } from 'node:http';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, extname, resolve } from 'node:path';
import { tmpdir, loadavg } from 'node:os';
import { Buffer } from 'node:buffer';
import { deflateSync, crc32, inflateRawSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { armWatchdog } from './probe-watchdog.mjs';

const PACK = resolve(process.argv[2] ?? '');
const OUT = process.argv[3] ?? '';
const PUBLIC = resolve(process.env.PKC3_PUBLIC ?? 'public');
const PORT = Number(process.env.PKC3_SS_PORT ?? 48152);
const REPEAT = Number(process.env.PKC3_SS_REPEAT ?? 10);
const SETTLE = Number(process.env.PKC3_SS_SETTLE ?? 12);
const EXE = process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium';
const KEEP = process.env.PKC3_SS_KEEP ?? '';
const FIXDIR = process.env.PKC3_SS_FIXDIR ?? `${tmpdir()}/pkc3-ss-fx-${process.pid}`;

const FIXTURES = ['small-odt', 'small-docx', 'large-odt', 'large-docx'];
const ARMS = ['control', 'asis', 'patched'];
const WANT = (process.env.PKC3_SS_CASES ?? '')
  ? process.env.PKC3_SS_CASES.split(',').map((s) => s.split(':'))
  : FIXTURES.flatMap((f) => ARMS.map((a) => [f, a]));

const result = { probe: 'shadow-store-probe', repeat: REPEAT, settleSec: SETTLE, cases: [], console: [] };
const wd = armWatchdog({
  result, out: OUT, limitSec: Number(process.env.PKC3_HARD_LIMIT_SEC ?? 3 * 3600),
  browser: () => currentBrowser,
});
let currentBrowser = null;
const round = (n, k = 100) => Math.round(n * k) / k;

// ───────────────────────── fixture(自作・native soffice で変換) ─────────────────────────

/** 決定的な疑似乱数(画像の中身。毎回同じ bytes にする)。 */
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
}
/** 160x160 RGB の雑音 PNG(圧縮されにくい = ほぼ 77KB)。 */
function noisePng(w, h) {
  const rnd = prng(1228);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x += 1) raw[y * (w * 3 + 1) + 1 + x] = rnd();
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const FODT_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"'
  + ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"'
  + ' xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"'
  + ' xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"'
  + ' xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"'
  + ' office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">'
  + '<office:body><office:text>';
const FODT_TAIL = '</office:text></office:body></office:document>';
function fodtSmall() {
  return `${FODT_HEAD}<text:p>shadow seed one</text:p><text:p>shadow seed two</text:p><text:p>shadow seed three</text:p>${FODT_TAIL}`;
}
/** 段落 200 個・表 1 つ(5 列 × 6 行)・画像 1 枚。 */
function fodtLarge() {
  let b = FODT_HEAD;
  for (let i = 0; i < 100; i += 1) {
    b += `<text:p>paragraph ${i} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore</text:p>`;
  }
  b += '<table:table table:name="T1"><table:table-column table:number-columns-repeated="5"/>';
  for (let r = 0; r < 6; r += 1) {
    b += '<table:table-row>';
    for (let c = 0; c < 5; c += 1) {
      b += `<table:table-cell office:value-type="string"><text:p>r${r}c${c}</text:p></table:table-cell>`;
    }
    b += '</table:table-row>';
  }
  b += '</table:table>';
  b += '<text:p>image paragraph '
    + '<draw:frame draw:name="img1" text:anchor-type="as-char" svg:width="4cm" svg:height="4cm">'
    + `<draw:image><office:binary-data>${noisePng(160, 160).toString('base64')}</office:binary-data></draw:image>`
    + '</draw:frame></text:p>';
  for (let i = 100; i < 200; i += 1) {
    b += `<text:p>paragraph ${i} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore</text:p>`;
  }
  return b + FODT_TAIL;
}
async function makeFixtures() {
  await mkdir(FIXDIR, { recursive: true });
  const out = {};
  const prof = `file://${FIXDIR}/prof`;
  for (const [size, xml] of [['small', fodtSmall()], ['large', fodtLarge()]]) {
    await writeFile(join(FIXDIR, `${size}.fodt`), xml);
    for (const [ext, filter] of [['odt', 'odt'], ['docx', 'docx']]) {
      execFileSync('soffice', [`-env:UserInstallation=${prof}`, '--headless', '--convert-to', filter, '--outdir', FIXDIR,
        join(FIXDIR, `${size}.fodt`)], { stdio: 'ignore', timeout: 180000 });
      // `size.docx` / `size.odt` ── 同じ stem の別拡張子なので上書きされない
      const buf = await readFile(join(FIXDIR, `${size}.${ext}`));
      out[`${size}-${ext}`] = { path: join(FIXDIR, `${size}.${ext}`), bytes: buf.byteLength, name: `seed.${ext}` };
    }
  }
  return out;
}

// ───────────────────────── zip の読み(node 側。FS から読み戻した bytes を分類する) ─────────────────────────

function zipInfo(buf, needle = null) {
  const info = { size: buf.length, magic: buf.subarray(0, 4).toString('hex') };
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '<?xml') {
    info.kind = 'flat-xml'; info.head = buf.subarray(0, 60).toString('latin1');
    if (needle) info.bodyHasTyped = buf.toString('utf8').includes(needle);
    return info;
  }
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) { info.kind = 'not-zip'; return info; }
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) { info.kind = 'zip-truncated'; info.zipComplete = false; return info; }
  info.zipComplete = true;
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  const entries = [];
  let mimetype = null; let hasContentTypes = false;
  for (let i = 0; i < n; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) { info.cdBroken = true; break; }
    const method = buf.readUInt16LE(p + 10);
    const csz = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28); const el = buf.readUInt16LE(p + 30); const cl = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    names.push(name);
    entries.push({ name, method, csz, lho });
    if (name === '[Content_Types].xml') hasContentTypes = true;
    if (name === 'mimetype') {
      const lnl = buf.readUInt16LE(lho + 26); const lel = buf.readUInt16LE(lho + 28);
      const data = buf.subarray(lho + 30 + lnl + lel, lho + 30 + lnl + lel + csz);
      mimetype = (method === 0 ? data : inflateRawSync(data)).toString('latin1');
    }
    p += 46 + nl + el + cl;
  }
  if (needle) {
    // 本文の部品(ODF = content.xml / OOXML = word/document.xml)に、打った字が入っているか
    const part = entries.find((e) => e.name === 'content.xml' || e.name === 'word/document.xml');
    if (part) {
      const lnl = buf.readUInt16LE(part.lho + 26); const lel = buf.readUInt16LE(part.lho + 28);
      const data = buf.subarray(part.lho + 30 + lnl + lel, part.lho + 30 + lnl + lel + part.csz);
      try {
        const xml = (part.method === 0 ? data : inflateRawSync(data)).toString('utf8');
        info.bodyPart = part.name; info.bodyHasTyped = xml.includes(needle);
      } catch (e) { info.bodyPart = part.name; info.bodyReadErr = String(e).slice(0, 60); }
    }
  }
  info.entries = n; info.names = names.slice(0, 14);
  info.mimetype = mimetype;
  info.kind = mimetype ? `odf(${mimetype})` : hasContentTypes ? 'ooxml' : 'zip-other';
  return info;
}

// ───────────────────────── 窓の中の道具 ─────────────────────────

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
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store',
    };
    const f = p.startsWith('/office-pack/') ? join(PACK, p.slice('/office-pack/'.length)) : join(PUBLIC, p);
    readFile(f)
      .then((b) => { res.writeHead(200, { ...head, 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream' }); res.end(b); })
      .catch((e) => { res.writeHead(404, head); res.end(String(e)); });
  });
  s.listen(PORT, '127.0.0.1', () => ok(s));
});
const base = `http://127.0.0.1:${PORT}`;

/**
 * wasm の import `fd_sync` を、**probe の中だけで**「何もせず 0 を返す普通の関数」へ差し替える。
 * ⚠ `host.html` の `WebAssembly.instantiateStreaming(response, imports)` に渡る `imports` を包む
 *   (製品の file は触らない)。⚠ 差し替えが当たったかは `__fsyncPatched` に書く(当たらなければ腕の意味が無い)。
 */
const PATCH_FSYNC = () => {
  const W = globalThis.WebAssembly;
  const orig = W.instantiateStreaming;
  W.instantiateStreaming = function (src, imports) {
    const hit = [];
    try {
      for (const k of ['env', 'wasi_snapshot_preview1']) {
        const o = imports && imports[k];
        if (o && o.fd_sync) { o.fd_sync = () => 0; hit.push(k); }
      }
    } catch { /* 差し替えられない */ }
    globalThis.__fsyncPatched = hit.join(',') || 'NOT-PATCHED';
    return orig.apply(this, arguments);
  };
};

/** 窓の中の道具(heartbeat / longtask / 文書の受け渡し / 保存の放送)。⚠ `__lo` は起動後にしか無い。 */
const INIT = ({ doc, name }) => {
  const W = globalThis;
  W.__hb = { gaps: [], long: [], last: performance.now(), ticks: 0, max: 0 };
  setInterval(() => {
    const t = performance.now();
    const g = t - W.__hb.last;
    W.__hb.last = t; W.__hb.ticks += 1;
    if (g > W.__hb.max) W.__hb.max = g;
    if (g > 120 && W.__hb.gaps.length < 800) W.__hb.gaps.push({ at: Math.round(t), gap: Math.round(g) });
  }, 20);
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (W.__hb.long.length < 800) W.__hb.long.push({ at: Math.round(e.startTime), dur: Math.round(e.duration) });
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* longtask が無い */ }
  const ch = new W.BroadcastChannel('pkc3-office');
  W.__saved = [];
  ch.onmessage = (ev) => {
    const d = ev.data;
    if (!d || !d.pkc3Office) return;
    if (d.pkc3Office === 'saved') W.__saved.push({ key: d.payload.key, size: d.payload.size });
    if (d.pkc3Office !== 'ready-for-document') return;
    const rawDoc = W.atob(doc);
    const u8 = new Uint8Array(rawDoc.length);
    for (let i = 0; i < rawDoc.length; i += 1) u8[i] = rawDoc.charCodeAt(i);
    ch.postMessage({ pkc3Office: 'document', payload: { name, bytes: u8, token: 'lid-PROBE' } });
  };
};

/** 起動後に 1 度だけ入れる UNO の道具。`window.__ss` へ置く(⚠ 返り値は JSON にできる物だけ)。 */
const HELPERS = `(async () => {
  const lo = window.__lo;
  await lo.uno_init;
  const S = lo.uno.com.sun.star;
  const del = (o) => { try { if (o && typeof o.delete === 'function') o.delete(); } catch (e) {} };
  const ctx = lo.getUnoComponentContext();
  const any = ctx.getValueByName('/singletons/com.sun.star.frame.theDesktop');
  const desktop = S.frame.XDesktop.query(any.get());
  const comps = desktop.getComponents();
  const en = comps.createEnumeration();
  let doc = null; let mod = null;
  while (en.hasMoreElements()) {
    const a = en.nextElement(); const el = a.get(); del(a);
    const m = S.util.XModifiable.query(el);
    if (m && !doc) { doc = el; mod = m; } else { del(m); del(el); }
  }
  if (!doc) return { ok: false, why: 'no-doc' };
  const st = S.frame.XStorable.query(doc);
  const PS = lo['uno_Type_com$sun$star$beans$PropertyState'];
  const Seq = lo['uno_Sequence_com$sun$star$beans$PropertyValue'];
  const FS = lo.FS;
  const errText = (e) => {
    const r = { err: String(e && e.name ? e.name + ': ' + e.message : e).slice(0, 220), type: typeof e };
    try { r.stackHead = String(e && e.stack || '').split('\\n').slice(0, 5).map((s) => s.trim().slice(0, 90)).join(' | '); } catch (x) {}
    return r;
  };
  const mk = (props) => {
    const s = new Seq(props.length, lo.uno_Sequence.FromSize);
    const anys = [];
    props.forEach((kv, i) => {
      const a = new lo.uno_Any(typeof kv[1] === 'boolean' ? lo.uno_Type.Boolean() : lo.uno_Type.String(), kv[1]);
      anys.push(a);
      s.set(i, { Name: kv[0], Handle: 0, Value: a, State: PS.DIRECT_VALUE });
    });
    return { s, anys };
  };
  const readText = () => {
    try {
      const td = S.text.XTextDocument.query(doc);
      const x = td.getText();
      const tr = S.text.XTextRange.query(x);
      const s = tr.getString();
      del(tr); del(x); del(td);
      const idx = s.indexOf('SHADOWTYPED');
      return { len: s.length, idx: idx, around: idx >= 0 ? s.substr(idx, 20) : null, head: s.substr(0, 24) };
    } catch (e) { return { err: errText(e).err }; }
  };
  const readUndo = () => {
    try {
      const sup = S.document.XUndoManagerSupplier.query(doc);
      const um = sup.getUndoManager();
      const r = { possible: um.isUndoPossible(), redo: um.isRedoPossible() };
      if (r.possible) r.title = um.getCurrentUndoActionTitle();
      del(um); del(sup);
      return r;
    } catch (e) { return { err: errText(e).err }; }
  };
  const readTitle = () => {
    const r = {};
    try { const t = S.frame.XTitle.query(doc); r.title = t.getTitle(); del(t); } catch (e) { r.titleErr = errText(e).err; }
    try { r.location = st.getLocation(); } catch (e) { r.locErr = errText(e).err; }
    try { const m = S.frame.XModel.query(doc); r.url = m.getURL(); del(m); } catch (e) { r.urlErr = errText(e).err; }
    return r;
  };
  const deepActive = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a ? (a.tagName + '#' + (a.id || '') + '.' + String(a.className || '').slice(0, 40)) : null;
  };
  window.__ss = {
    state() {
      const o = {};
      try { o.mod = mod.isModified(); } catch (e) { o.mod = 'ERR ' + errText(e).err; }
      o.text = readText(); o.undo = readUndo(); o.names = readTitle();
      o.focus = deepActive(); o.docHasFocus = document.hasFocus();
      return o;
    },
    modTimes(n) {
      const ms = [];
      for (let i = 0; i < n; i += 1) { const t0 = performance.now(); mod.isModified(); ms.push(Math.round((performance.now() - t0) * 1000) / 1000); }
      return ms;
    },
    store(url, props) {
      const t0 = performance.now();
      let r = { ok: false }; let made = null;
      try { made = mk(props); st.storeToURL(url, made.s); r.ok = true; } catch (e) { r = Object.assign({ ok: false }, errText(e)); }
      r.ms = Math.round((performance.now() - t0) * 100) / 100;
      if (made) { del(made.s); made.anys.forEach(del); }
      return r;
    },
    mkdir(p) { try { FS.mkdir(p); return 'mkdir'; } catch (e) { return String(e.message || e).slice(0, 60); } },
    ls(dir) {
      try { return FS.readdir(dir).filter((n) => n !== '.' && n !== '..').map((n) => ({ n: n, size: FS.stat(dir + '/' + n).size })); }
      catch (e) { return { err: String(e.message || e).slice(0, 60) }; }
    },
    read(p, withBytes) {
      try {
        const u8 = FS.readFile(p);
        if (!withBytes || u8.length > 8 * 1024 * 1024) return { size: u8.length };
        let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        return { size: u8.length, b64: btoa(s) };
      } catch (e) { return { missing: true, why: String(e.message || e).slice(0, 60) }; }
    },
    unlink(p) { try { FS.unlink(p); return true; } catch (e) { return false; } },
    mountSync(p) {
      try { const n = FS.lookupPath(p).node; return { type: n.mount.type && n.mount.type.constructor && n.mount.type.constructor.name, hasSyncfs: !!(n.mount.type && n.mount.type.syncfs), mountpoint: n.mount.mountpoint }; }
      catch (e) { return { err: String(e.message || e).slice(0, 60) }; }
    },
  };
  return { ok: true };
})()`;

const paintedJs = `(() => {
  const walk=(n)=>{for(const e of n.querySelectorAll('*')){if(e.tagName==='CANVAS'&&e.width>0)return true;if(e.shadowRoot&&walk(e.shadowRoot))return true;}return false;};
  return walk(document.getElementById('screen')||document.body);
})()`;

async function waitPainted(page, limitSec) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(paintedJs).catch(() => false)) return round((Date.now() - t0) / 1000, 10);
    if ((Date.now() - t0) / 1000 > limitSec) throw new Error('版面が出ない');
    await page.waitForTimeout(1500);
  }
}
async function stagePack(page) {
  return page.evaluate(async () => {
    const m = await (await globalThis.fetch('/office-pack/pack.json')).json();
    const names = [...m.files, ...m.fonts];
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('pkc3-office-pack', 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains('files')) r.result.createObjectStore('files');
        if (!r.result.objectStoreNames.contains('meta')) r.result.createObjectStore('meta');
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const put = (s, k, v) => new Promise((res, rej) => {
      const t = db.transaction(s, 'readwrite'); t.objectStore(s).put(v, k);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
    let bytes = 0;
    for (const n of names) { const b = await (await globalThis.fetch(`/office-pack/${n}`)).blob(); bytes += b.size; await put('files', n, b); }
    await put('meta', 'pack', { version: m.version, installedAt: Date.now(), source: 'url', totalBytes: bytes, files: names.map((n) => ({ name: n })) });
    return { count: names.length, version: m.version, build: m.build ?? null };
  });
}

// ───────────────────────── 1 case ─────────────────────────

/** 影の実物を落とす(`PKC3_SS_KEEP` のときだけ。自作 fixture の bytes のみ)。 */
async function keep(name, b64) {
  await mkdir(KEEP, { recursive: true });
  await writeFile(join(KEEP, name), Buffer.from(b64, 'base64'));
}

const SHADOW_DIR = '/work/shadow';
const FILTER = { odt: 'writer8', docx: 'MS Word 2007 XML' };

async function runCase(fx, fixName, arm) {
  const ext = fixName.endsWith('docx') ? 'docx' : 'odt';
  const c = { fixture: fixName, arm, docBytes: fx.bytes, docName: fx.name, loadavgStart: loadavg().map((x) => round(x, 10)) };
  const t00 = Date.now();
  const raw = await readFile(fx.path);
  const profile = `${tmpdir()}/pkc3-ss-${process.pid}-${fixName}-${arm}`;
  const browser = await chromium.launchPersistentContext(profile, {
    headless: true, viewport: { width: 1280, height: 900 }, args: ['--no-sandbox', '--disable-dev-shm-usage'], executablePath: EXE,
  });
  currentBrowser = browser;
  const page = await browser.newPage();
  c.console = []; c.pageErrors = [];
  page.on('console', (m) => {
    const t = `[${m.type()}] ${m.text()}`;
    if (!/[^\x20-\x7e]/.test(t) && c.console.length < 25 && /error|abort|unreachable|out of bounds|Suspend|invalid/i.test(t)) c.console.push(t.slice(0, 200));
  });
  page.on('pageerror', (e) => { if (c.pageErrors.length < 10) c.pageErrors.push(String(e).slice(0, 200)); });
  const ev = (js) => page.evaluate(js);
  const typeText = async (s) => { await page.keyboard.type(s, { delay: 60 }); await page.waitForTimeout(1500); };
  /** 呼びの窓の heartbeat の最大の途切れ(呼びの後 0.5 秒待って読む)。 */
  const hbWindow = async (fn) => {
    await ev('window.__hb.max = 0');
    const r = await fn();
    await page.waitForTimeout(500);
    return { r, hbMaxGapMs: await ev('Math.round(window.__hb.max)') };
  };
  try {
    wd.mark(`${fixName}:${arm} 起動`);
    await page.goto(`${base}/office/host.html`, { waitUntil: 'domcontentloaded' });
    c.coi = await ev('crossOriginIsolated');
    c.staged = await stagePack(page);
    if (arm === 'patched') await page.addInitScript(PATCH_FSYNC);
    await page.addInitScript(INIT, { doc: raw.toString('base64'), name: fx.name });
    await page.goto(`${base}/office/host.html?await-doc=1&name=${encodeURIComponent(fx.name)}`, { waitUntil: 'commit' });
    wd.mark(`${fixName}:${arm} 版面待ち`);
    c.paintedAfterSec = await waitPainted(page, 300);
    await page.waitForTimeout(SETTLE * 1000);
    c.fsyncPatched = await ev('globalThis.__fsyncPatched ?? null');
    const h = await ev(HELPERS).catch((e) => ({ ok: false, why: String(e).slice(0, 200) }));
    c.helpers = h;
    if (!h.ok) { c.verdict = '判定不能'; c.verdictWhy = `UNO の道具が立たない: ${h.why}`; return c; }
    // 文書が組まれるのを待つ(本文が読めるまで)
    let st0 = null;
    for (let i = 0; i < 40; i += 1) {
      st0 = await ev('window.__ss.state()');
      if (st0.text && st0.text.len > 0) break;
      await page.waitForTimeout(1500);
    }
    c.loaded = st0;
    if (!st0.text || !(st0.text.len > 0)) { c.verdict = '判定不能'; c.verdictWhy = '文書の本文が読めない(開けていない)'; return c; }
    c.mount = { work: await ev(`window.__ss.mountSync('/work')`), tmp: await ev(`window.__ss.mountSync('/tmp')`) };

    // ── 対照群 ──
    wd.mark(`${fixName}:${arm} 対照群`);
    c.idle = [];
    for (let i = 0; i < 3; i += 1) {
      await ev('window.__hb.max = 0');
      await page.waitForTimeout(2000);
      c.idle.push(await ev('Math.round(window.__hb.max)'));
    }
    const ms = await ev('window.__ss.modTimes(30)');
    const sorted = [...ms].sort((a, b) => a - b);
    c.isModifiedOnly = { n: ms.length, min: sorted[0], median: sorted[15], max: sorted[sorted.length - 1] };
    c.unoOk = typeof (await ev('window.__ss.state().mod')) === 'number';
    // 穴②(#1259)の `anyModified`(Desktop の全文書を列挙して `isModified` を聞く)と同じ道の所要時間
    const am = await ev(`(async () => { const ms = []; let last = null;
      for (let i = 0; i < 30; i += 1) { const t0 = performance.now(); last = await window.PKC3OfficeUnsaved.anyModified(window.__lo); ms.push(Math.round((performance.now() - t0) * 1000) / 1000); }
      return { ms, last }; })()`).catch((e) => ({ err: String(e).slice(0, 100) }));
    if (am.ms) {
      const so = [...am.ms].sort((a, b) => a - b);
      c.anyModified = { n: so.length, min: so[0], median: so[15], max: so[so.length - 1], last: am.last };
    } else c.anyModified = am;

    // ── 打って「変更あり」にする ──
    wd.mark(`${fixName}:${arm} 打つ`);
    c.s0 = await ev('window.__ss.state()');   // 打つ前
    await typeText('SHADOWTYPED');
    c.s1 = await ev('window.__ss.state()');   // 打った後(影を書く前)
    c.typedLanded = c.s1.mod === 1 && c.s1.text.idx >= 0;
    if (!c.typedLanded) { c.verdict = '判定不能'; c.verdictWhy = '打った字が届いていない(isModified が 1 でない / 本文に無い)'; return c; }
    await ev(`window.__ss.mkdir('/work/shadow')`);

    if (arm !== 'control') {
      wd.mark(`${fixName}:${arm} 影を書く`);
      const url = `file://${SHADOW_DIR}/shadow.${ext}`;
      const props = [['FilterName', FILTER[ext]]];
      c.first = [];
      const nFirst = arm === 'asis' ? 3 : 1;
      for (let i = 0; i < nFirst; i += 1) {
        const w = await hbWindow(() => ev(`window.__ss.store(${JSON.stringify(url)}, ${JSON.stringify(props)})`));
        const rec = { ...w.r, hbMaxGapMs: w.hbMaxGapMs, after: await ev('window.__ss.state()') };
        const f = await ev(`window.__ss.read(${JSON.stringify(`${SHADOW_DIR}/shadow.${ext}`)}, true)`);
        rec.shadow = f.missing ? { missing: true, why: f.why } : { ...zipInfo(Buffer.from(f.b64 ?? '', 'base64'), 'SHADOWTYPED'), size: f.size };
        if (KEEP && f.b64 && i === 0) await keep(`${fixName}-${arm}-first.${ext}`, f.b64);
        c.first.push(rec);
        await page.waitForTimeout(2000);
      }
      c.dirAfterFirst = await ev(`window.__ss.ls('${SHADOW_DIR}')`);
      // asis: 残った temp(lu*.tmp)の中身
      c.tmpLeft = [];
      for (const e of Array.isArray(c.dirAfterFirst) ? c.dirAfterFirst : []) {
        if (e.n === `shadow.${ext}`) continue;
        const f = await ev(`window.__ss.read('${SHADOW_DIR}/${e.n}', true)`);
        c.tmpLeft.push({ n: e.n, ...(f.b64 ? zipInfo(Buffer.from(f.b64, 'base64'), 'SHADOWTYPED') : { size: f.size }) });
        if (KEEP && f.b64 && c.tmpLeft.length === 1) await keep(`${fixName}-${arm}-tmp.${ext}`, f.b64);
      }
    }

    // 影の後で X を打つ(caret / 焦点が動いていなければ SHADOWTYPED の直後に入る)→ 取り消す
    await typeText('X');
    c.s2 = await ev('window.__ss.state()');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(1500);
    c.s3 = await ev('window.__ss.state()');

    if (arm === 'patched') {
      // ── 形式の変種(同じ「変更あり」の文書へ)──
      if ((await ev('window.__ss.state().mod')) !== 1) await typeText('M');
      c.variants = [];
      const other = ext === 'odt' ? 'docx' : 'odt';
      const defs = [
        { label: `${ext}/FilterName なし`, file: `v-nofilter.${ext}`, props: [] },
        { label: `${ext} 文書へ ${other} の filter`, file: `v-other.${other}`, props: [['FilterName', FILTER[other]]] },
        { label: `${ext} 文書へ flat XML`, file: 'v-flat.fodt', props: [['FilterName', 'OpenDocument Text Flat XML']] },
      ];
      for (const d of defs) {
        const w = await hbWindow(() => ev(`window.__ss.store('file://${SHADOW_DIR}/${d.file}', ${JSON.stringify(d.props)})`));
        const f = await ev(`window.__ss.read('${SHADOW_DIR}/${d.file}', true)`);
        c.variants.push({
          label: d.label, filter: d.props.length ? d.props[0][1] : null, ...w.r, hbMaxGapMs: w.hbMaxGapMs,
          shadow: f.missing ? { missing: true, why: f.why } : { ...zipInfo(Buffer.from(f.b64 ?? '', 'base64')), size: f.size },
          mod: await ev('window.__ss.state().mod'),
        });
        await page.waitForTimeout(1000);
      }
      // ── 連打(同じ path へ。2 秒おき)──
      wd.mark(`${fixName}:${arm} 連打`);
      c.repeat = [];
      const url = `file://${SHADOW_DIR}/rep.${ext}`;
      for (let i = 0; i < REPEAT; i += 1) {
        await page.waitForTimeout(2000);
        const ticksBefore = await ev('window.__hb.ticks');
        const w = await hbWindow(() => ev(`window.__ss.store(${JSON.stringify(url)}, [['FilterName', ${JSON.stringify(FILTER[ext])}]])`));
        const f = await ev(`window.__ss.read('${SHADOW_DIR}/rep.${ext}', false)`);
        await page.waitForTimeout(500);
        const alive = await ev(`({ ticks: window.__hb.ticks, mod: window.__ss.state().mod, painted: ${paintedJs} })`);
        c.repeat.push({ i, ok: w.r.ok, err: w.r.err ?? null, ms: w.r.ms, hbMaxGapMs: w.hbMaxGapMs, size: f.size ?? null, mod: alive.mod, painted: alive.painted, ticksAdvanced: alive.ticks > ticksBefore });
      }
      c.dirEnd = await ev(`window.__ss.ls('${SHADOW_DIR}')`);
    }

    if (arm === 'patched') {
      c.workEnd = await ev(`window.__ss.ls('/work')`);
      c.tmpEnd = await ev(`window.__ss.ls('/tmp')`);
    }
    if (arm !== 'control' && ext === 'odt') {
      // 影を書いた後(asis では失敗の後)でも、LO の普通の保存(Ctrl+S)が通るか
      wd.mark(`${fixName}:${arm} 健全性`);
      await ev('window.__saved.length = 0');
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(15000);
      c.afterStoreCtrlS = { saved: await ev('window.__saved'), state: await ev('window.__ss.state()') };
    }
    c.hb = await ev('({ max: Math.round(window.__hb.max), ticks: window.__hb.ticks, gaps: window.__hb.gaps.length, long: window.__hb.long.length })');
    c.verdict = c.unoOk ? '測れた' : '判定不能';
  } catch (e) {
    c.error = String(e).slice(0, 400);
    c.verdict = '判定不能';
  } finally {
    c.elapsedSec = Math.round((Date.now() - t00) / 1000);
    c.loadavgEnd = loadavg().map((x) => round(x, 10));
    await browser.close().catch(() => {});
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    currentBrowser = null;
  }
  return c;
}

// ───────────────────────── 本体 ─────────────────────────

try {
  wd.mark('fixture');
  let fixtures;
  try {
    fixtures = await makeFixtures();
  } catch (e) {
    result.verdict = '判定不能';
    result.verdictWhy = `fixture を作れない(native soffice): ${String(e).slice(0, 200)}`;
    fixtures = null;
  }
  if (fixtures) {
    result.fixtures = Object.fromEntries(Object.entries(fixtures).map(([k, v]) => [k, v.bytes]));
    result.browser = EXE;
    for (const [fixName, arm] of WANT) {
      const fx = fixtures[fixName];
      if (!fx) { result.cases.push({ fixture: fixName, arm, verdict: '判定不能', verdictWhy: '未知の fixture' }); continue; }
      // ⚠ LO wasm は起動直後の打鍵で稀に落ちる(`RuntimeError: … signature mismatch`)。影を書く前の話なので、
      //   「打った字が届かなかった」回だけ**作り直して**最大 3 回まで測り直す(落ちた回は `attempts` に残す)。
      const attempts = [];
      let c = await runCase(fx, fixName, arm);
      while (c.verdict === '判定不能' && attempts.length < 2 && /打った字が届いていない/.test(c.verdictWhy ?? '')) {
        attempts.push({ verdictWhy: c.verdictWhy, pageErrors: c.pageErrors, loaded: c.loaded?.text?.len ?? null });
        c = await runCase(fx, fixName, arm);
      }
      c.attempts = attempts;
      result.cases.push(c);
      process.stderr.write(`[${fixName}:${arm}] ${c.verdict} ${c.elapsedSec}s\n`);
      if (OUT) await writeFile(OUT, JSON.stringify(result, null, 1));
    }
  }
} catch (e) {
  result.error = String(e).slice(0, 400);
}

server.close();
await rm(FIXDIR, { recursive: true, force: true }).catch(() => {});
wd.disarm();
const text = JSON.stringify(result, null, 1);
if (OUT) await writeFile(OUT, text);
console.log(text.slice(0, 4000));
