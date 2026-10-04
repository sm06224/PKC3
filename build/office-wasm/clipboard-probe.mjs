/**
 * **Office(LO wasm)の中でコピーしたとき、外のクリップボードがどうなるか**を測る probe(#121 の「測る」)。
 *
 * 既知(2026-10-04 時点)は「LO の中で `Ctrl+C` → 外を読むと**空**(2/2)/ 外で置いた物は
 * 何もしなければ維持される(対照群 2/2)」だけで、n=2・1 つの箱・字 1 種だった。
 * ここは**どの出し方 × どの中身**で空になるかを、各 n=3 で割る:
 *
 * | 腕 | 外で種を置く | LO の中でやること | その後 |
 * |---|---|---|---|
 * | `C`  | ✅ | **何もしない**(字を打つだけ。対照群) | 外を読む |
 * | `C2` | ✅ | 右クリックしてメニューを開き `Escape` で閉じる(**コピーしない**。B2 の対照群) | 外を読む |
 * | `B0` | ✅ | **何も選ばずに** `Ctrl+C`(依頼文の腕に無い追加の対照) | 外を読む |
 * | `B1` | ✅ | 字を全部選んで **`Ctrl+C`** | 外を読む |
 * | `B2` | ✅ | 字を全部選んで **右クリック → メニューの「コピー」を押す** | 外を読む |
 * | `B2k` | ✅ | 同じ右クリック → メニューを**近道キー `y`**(`コピー(Y)`)で選ぶ(B2 の別の出し方) | 外を読む |
 * | `B3` | ✅ | **画像**を `Shift+→` で選んで(段落先頭の 1 文字として)`Ctrl+C` | 外を読む |
 * | `B3c` | ✅ | **画像を左クリックで選んで**(枠の取っ手が出る)`Ctrl+C`(B3 の別の選び方。押す) | 外を読む |
 * | `B4` | ✅ | **表**を選んで `Ctrl+C` | 外を読む |
 *
 * ## 何を読むか(読みは書かない ── 数と字だけ出す)
 *
 * - `after.text` / `after.types` … 頁の `navigator.clipboard.readText()` / `read()` が返した物
 * - `emptied` … `readText()` が空文字だったか(**空 = 種が消えた**)
 * - `afterOtherPage` … 同じ origin の**別の頁**(空の頁)を前面に出して読み直した値
 * - `hostWrites` … LO の worker が host へ送った **書き込みの依頼**(`BroadcastChannel`
 *   `pkc3-clipboard` を横から聞く)と、host が実際に呼んだ `navigator.clipboard.write` の
 *   **成否**(頁の `write` を包んで採る)。⚠ これは製品コードを変えずに採る**傍受**である
 *
 * ## 判定不能の規則(回す**前**に書いてある。結果の後から緩めない)
 *
 * 次のどれかなら、その回は**数に入れない**(`verdict: 判定不能(…)`):
 *   ① 文書が開かなかった ② 外へ種を置けなかった / 置いた直後に読み戻せなかった
 *   ③ **字を打っても版面が変わらなかった**(入力が LO に届いていない。SKILL §4 の対照群)
 *   ④ 選ぶ腕(B1〜B4)で、**選択が版面に出なかった**(Ctrl+C の前に版面が変わらない)
 *   ⑤ `B2` / `B2k` / `C2` で**メニューが開かなかった**(窓の数が増えない ── 続く鍵は字として入る)
 *   ⑥ **コピーの前に** `memory access out of bounds` が出た(修飾キーの経路が死ぬ。SKILL §14)
 *   ⑦ 版面が固まった / 回の締切を超えた
 * 判定不能の回は数に入れず、**判定できた回が n 回になるまで回し足す**(上限は +2 回。足りなければ表の `valid` が n 未満になる)。
 *
 * ## 押すことについて(SKILL §14)
 *
 * 版面を**クリック**すると、LO が落ちる(`memory access out of bounds` / `unreachable`)回がある
 * (SKILL §14 は 2026-08-30 の実測で 10 回中 5 回)。だから**押さずに済む腕は押さない**
 * (開いた直後の caret は本文の先頭に在る ── 字は押さずに打てる / `B0` `B1` `B3` `B4` はキーだけで選ぶ)。
 * 押す腕は `C2` / `B2`(右クリック + メニューの項目)/ `B3c`(画像を左クリック)で、
 * `C2` が「押しただけでコピーしない」群である。⚠ 落ちた回は `faults` に時刻を出す
 * (コピーの**後**に落ちた回は、外の値には影響しないので判定不能にしない ── `faultsAtRead` で見分ける)。
 *
 * ## 使い方
 *
 *   python3 build/office-wasm/make-clipboard-fixtures.py /tmp/fx          # 自作の .odt 3 つ
 *   node build/office-wasm/make-pages-bundle.mjs <LO 展開先> /tmp/pack    # SKILL §1〜§3
 *   node build/office-wasm/clipboard-probe.mjs /tmp/pack /tmp/fx out.json [回数=3]
 *
 *   PKC3_ARMS=C,B1,B2   腕を絞る(既定は全部)
 *   PKC3_N_START=<n>    回の番号の開始(既定 1)。判定不能の回を埋め合わせるとき、前と番号を被せない
  PKC3_DIST=<dir>     `office/host.html` を配る場所(既定 `public` ── host.html は静的なので build 不要)
 *   PKC3_SHOTDIR=<dir>  各段の版面を PNG で残す。⚠ **自作の fixture を開いたときだけ**渡すこと
 *                       (機密資料の取り扱い 6 ── 渡さなければ撮れない形)
 *   PKC3_CTX_X / PKC3_CTX_Y   右クリックする比(既定 0.27 / 0.31 = text.odt の 1 行目の字の上)
 *
 * ⚠ 1 回ごとに Chromium を起こし直す(前の回の状態を持ち越さない)。
 */

import { createServer } from 'node:http';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { armWatchdog } from './probe-watchdog.mjs';

const PACK = resolve(process.argv[2] ?? '');
const FX = resolve(process.argv[3] ?? '');
const OUT = process.argv[4] ?? '';
const ROUNDS = Number(process.argv[5] ?? 3);
const DIST = resolve(process.env.PKC3_DIST ?? 'public');
const SHOTDIR = process.env.PKC3_SHOTDIR ?? '';
const CTX_X = Number(process.env.PKC3_CTX_X ?? '0.27');
const CTX_Y = Number(process.env.PKC3_CTX_Y ?? '0.31');
const ROUND_SEC = Number(process.env.PKC3_ROUND_SEC ?? 240);
/** 判定不能の回の埋め合わせに回し足すとき、種の名前が前と被らないよう開始番号を変える。 */
const N_START = Number(process.env.PKC3_N_START ?? 1);
const ALL_ARMS = ['C', 'B0', 'B1', 'C2', 'B2', 'B2k', 'B3', 'B3c', 'B4'];
const ARMS = (process.env.PKC3_ARMS ?? ALL_ARMS.join(',')).split(',').filter((a) => ALL_ARMS.includes(a));
/** 腕 → 開く文書。`C` / `B1` / `B2` / `C2` は字だけ、`B3` は画像、`B4` は表。 */
const DOC_OF = { C: 'text.odt', B0: 'text.odt', B1: 'text.odt', C2: 'text.odt', B2: 'text.odt', B2k: 'text.odt', B3: 'image.odt', B3c: 'image.odt', B4: 'table.odt' };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
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
    const s = createServer((req, res) => {
      const p = (req.url ?? '/').split('?')[0];
      const head = {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-store',
      };
      // 🔑 「別の頁から読む」用の空の頁(LO を起こさない)。⚠ host の頁と同じ origin
      if (p === '/__reader.html') {
        res.writeHead(200, { ...head, 'Content-Type': MIME['.html'] });
        res.end('<!doctype html><title>reader</title><p>reader');
        return;
      }
      const f = p.startsWith('/office-pack/') ? join(PACK, p.slice('/office-pack/'.length)) : join(DIST, p);
      readFile(f)
        .then((b) => {
          res.writeHead(200, { ...head, 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream' });
          res.end(b);
        })
        .catch(() => {
          res.writeHead(404, head);
          res.end();
        });
    });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
}

/** 制御文字や非 ASCII の混入で JSON を汚さない(console は外の文字列である)。 */
const safeLine = (s) => (/[^\x20-\x7e]/.test(s) ? null : s.slice(0, 160));
const safeErr = (e) => {
  for (const line of String(e).split('\n')) {
    const t = safeLine(line.trim());
    if (t !== null && t !== '') return t;
  }
  return 'error';
};

/** ⚠ `qt-window` は shadow root の中にも生えるので、**潜って**数える。 */
const COUNT_QT_WINDOWS = `(() => {
  let n = 0;
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      if (el.classList && el.classList.contains('qt-window')) n += 1;
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return n;
})()`;

/** 版面(いちばん大きい canvas)の位置。⚠ Qt 6 の canvas は shadow root の中。 */
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

/** qt-window(メニュー・ダイアログ)の矩形を全部。右クリックのメニューを探すのに使う。 */
const QT_WINDOW_RECTS = `(() => {
  const out = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      if (el.classList && el.classList.contains('qt-window')) {
        const r = el.getBoundingClientRect();
        out.push({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return out;
})()`;

/**
 * 🔴 **傍受**(製品コードは変えない)。頁が開く**前**に差す。
 *
 * ① `pkc3-clipboard` の放送を**横から聞く** ── LO の worker が host へ送る「書いてくれ」の依頼
 *    (`clip: 'write'`)と「読んでくれ」の依頼(`clip: 'read'`)を数える。型と大きさだけ採る。
 * ② 頁の `navigator.clipboard.write` / `writeText` を**包む** ── host が実際に呼んだ回数と成否
 *    (`ok` / `err`)。⚠ 包むのは呼び出しの前後を採るだけで、引数も返り値も変えない。
 * ⚠ 受け取った中身は**型・大きさ・先頭 60 字**だけ残す(自作 fixture の字なので出してよい)。
 */
const SPY = `(() => {
  const W = globalThis;
  W.__clip = { bc: [], writes: [], texts: [] };
  const t0 = Date.now();
  const dec = (buf) => { try { return new TextDecoder().decode(buf).slice(0, 60); } catch (e) { return null; } };
  try {
    const ch = new BroadcastChannel('pkc3-clipboard');
    ch.addEventListener('message', (ev) => {
      const d = ev.data;
      if (!d || d.reply || !d.clip) return;
      W.__clip.bc.push({
        dt: Date.now() - t0,
        clip: d.clip,
        kind: d.kind ?? null,
        parts: Array.isArray(d.parts)
          ? d.parts.map((p) => ({
              type: p.type,
              bytes: p.buf ? p.buf.byteLength : null,
              head: /^text\\//.test(p.type) && p.buf ? dec(p.buf) : null,
            }))
          : null,
      });
    });
  } catch (e) { W.__clip.bcErr = String(e).slice(0, 80); }
  const cb = navigator.clipboard;
  if (!cb) { W.__clip.noClipboard = true; return; }
  const ow = cb.write.bind(cb);
  cb.write = async (items) => {
    const rec = { dt: Date.now() - t0, kind: 'write', items: [] };
    W.__clip.writes.push(rec);
    try {
      for (const it of items || []) {
        const one = { types: Array.from(it.types || []), sizes: {} };
        for (const t of one.types) {
          try { const b = await it.getType(t); one.sizes[t] = b.size; } catch (e) { one.sizes[t] = 'ERR'; }
        }
        rec.items.push(one);
      }
    } catch (e) { rec.spyErr = String(e).slice(0, 80); }
    try {
      const r = await ow(items);
      rec.ok = true;
      return r;
    } catch (e) {
      rec.err = (e && e.name ? e.name : 'Error') + ':' + String(e && e.message ? e.message : e).slice(0, 100);
      throw e;
    }
  };
  const ot = cb.writeText.bind(cb);
  cb.writeText = async (s) => {
    const rec = { dt: Date.now() - t0, kind: 'writeText', len: String(s).length, head: String(s).slice(0, 60) };
    W.__clip.writes.push(rec);
    try { const r = await ot(s); rec.ok = true; return r; }
    catch (e) { rec.err = (e && e.name ? e.name : 'Error') + ':' + String(e && e.message ? e.message : e).slice(0, 100); throw e; }
  };
})()`;

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const result = {
  how: {
    harness: 'build/office-wasm/clipboard-probe.mjs',
    rounds: ROUNDS,
    arms: ARMS,
    read: 'page.evaluate(navigator.clipboard.readText() / read()) ── Office の host 頁そのもの(外のブラウザ側)',
    seed: 'page.evaluate(navigator.clipboard.writeText("OUTSIDE-<腕>-<n>"))',
    permissions: ['clipboard-read', 'clipboard-write'],
    keys: {
      type: "keyboard.type('Q', delay 120) → BackSpace(caret を先頭へ戻す)",
      B0: 'Control+c(選択なし。caret は先頭)',
      B1: 'Control+a → Control+c',
      B2: `Control+a → mouse.click(button=right, canvas の比 ${CTX_X}/${CTX_Y}) → メニュー(開いた窓)の上端から 40px 下の「コピー(Y)」を mouse.click(left)`,
      B2k: `同じ右クリック → keyboard.press('y')(コピー(Y))`,
      C2: `mouse.click(button=right, canvas の比 ${CTX_X}/${CTX_Y}) → Escape`,
      B3: 'Shift+ArrowRight(先頭の段落の画像 1 枚を選ぶ)→ Control+c',
      B3c: 'mouse.click(left, canvas の比 0.30/0.40 = 画像の上)→ Control+c',
      B4: 'Control+a ×2(セル → 表)→ Control+c',
    },
    doc: DOC_OF,
    dist: DIST,
    pack: PACK,
    chromium: process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium',
  },
  rounds: [],
};
let current = null;
const wd = armWatchdog({ result, out: OUT, limitSec: ARMS.length * ROUNDS * ROUND_SEC + 300, browser: () => current });

const flush = async () => {
  const text = JSON.stringify(result, null, 1);
  if (OUT) await writeFile(OUT, text);
};

/** 1 回(= 1 腕 × 1 回)。⚠ 戻り値は表の 1 行。 */
async function oneRound(arm, n) {
  const docName = DOC_OF[arm];
  const docB64 = (await readFile(join(FX, docName))).toString('base64');
  const seed = `OUTSIDE-${arm}-${n}`;
  const row = { arm, n, doc: docName, seed, steps: [], faults: [], console: [] };
  const profile = `${tmpdir()}/pkc3-clip-${process.pid}-${arm}-${n}`;
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium',
  });
  current = ctx;
  const t0 = Date.now();
  const step = (name, extra = {}) => row.steps.push({ at: Date.now() - t0, name, ...extra });
  const page = await ctx.newPage();
  try {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  } catch (e) {
    row.permissionErr = safeErr(e);
  }
  page.on('console', (m) => {
    const t = safeLine(`[${m.type()}] ${m.text()}`);
    if (t !== null && row.console.length < 40) row.console.push(`[+${Date.now() - t0}ms]${t}`);
  });
  page.on('pageerror', (e) => {
    const t = safeLine(`[pageerror] ${String(e)}`);
    if (t !== null && row.console.length < 40) row.console.push(`[+${Date.now() - t0}ms]${t}`);
    if (/memory access out of bounds|RuntimeError|Aborted\(/.test(String(e))) {
      row.faults.push({ at: Date.now() - t0, text: safeErr(e) });
    }
  });
  page.on('requestfailed', (r) => {
    const t = safeLine(`[requestfailed] ${r.url().replace(base, '')} ${r.failure()?.errorText ?? ''}`);
    if (t !== null && row.console.length < 40) row.console.push(`[+${Date.now() - t0}ms]${t}`);
  });
  const alive = () =>
    Promise.race([
      page.evaluate('1').then(() => true, () => false),
      new Promise((r) => setTimeout(() => r(false), 8000)),
    ]);
  const lastStep = () => (row.steps.length ? row.steps[row.steps.length - 1].name : 'start');
  /** 判定不能の理由を 1 つ立てる(最初の 1 つだけ残す)。 */
  const undecidable = (why) => {
    row.undecidable = row.undecidable ?? why;
  };
  const shot = async (label) => {
    if (!SHOTDIR) return;
    await mkdir(SHOTDIR, { recursive: true });
    try {
      await page.screenshot({ path: join(SHOTDIR, `${arm}-${n}-${label}.png`) });
    } catch {
      /* 固まっていたら撮れない */
    }
  };
  const canvasBox = () => page.evaluate(CANVAS_BOX);
  /** 版面を「集合」で採る(点滅する caret だけで「変わった」にしない。CLAUDE.md §4)。 */
  const framesOf = async (clip, k = 4) => {
    const set = new Set();
    for (let i = 0; i < k; i += 1) {
      const png = await Promise.race([
        page.screenshot({ clip }),
        new Promise((r) => setTimeout(() => r(null), 20000)),
      ]);
      if (png === null) return null;
      set.add(createHash('sha256').update(png).digest('hex').slice(0, 16));
      await page.waitForTimeout(400);
    }
    return [...set];
  };
  const swapped = (a, b) => (a === null || b === null ? null : b.every((h) => !a.includes(h)));
  /** 外のクリップボードを読む(頁の中で締切を張る)。 */
  const readOutside = (pg = page) =>
    Promise.race([
      pg.evaluate(`(async () => {
        const late = new Promise((r) => setTimeout(() => r({ hung: 'in-page' }), 15000));
        const go = (async () => {
          const o = { focus: document.hasFocus() };
          try { o.text = await navigator.clipboard.readText(); } catch (e) { o.textErr = String(e && e.name || e).slice(0, 60); }
          try {
            const items = await navigator.clipboard.read();
            o.types = items.map((it) => Array.from(it.types));
          } catch (e) { o.readErr = String(e && e.name || e).slice(0, 60); }
          return o;
        })();
        return await Promise.race([go, late]);
      })()`),
      new Promise((r) => setTimeout(() => r({ hung: 'node' }), 25000)),
    ]).catch((e) => ({ err: safeErr(e) }));
  const seedOutside = () =>
    Promise.race([
      page.evaluate(`(async () => {
        const late = new Promise((r) => setTimeout(() => r({ hung: 'in-page' }), 15000));
        const w = navigator.clipboard.writeText(${JSON.stringify(seed)}).then(() => ({ ok: true }), (e) => ({ err: String(e && e.name || e).slice(0, 60) }));
        return await Promise.race([w, late]);
      })()`),
      new Promise((r) => setTimeout(() => r({ hung: 'node' }), 25000)),
    ]).catch((e) => ({ err: safeErr(e) }));

  try {
    step('一式を IDB へ');
    await page.goto(`${base}/office/host.html`, { waitUntil: 'domcontentloaded' });
    row.staged = await page.evaluate(async () => {
      const { fetch, indexedDB } = globalThis;
      const grab = async (path) => {
        const r = await fetch(path);
        if (!r.ok) throw new Error(`${path} が取れない(HTTP ${r.status})`);
        return r;
      };
      const m = await (await grab('/office-pack/pack.json')).json();
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
      const put = (s, k, v) =>
        new Promise((res, rej) => {
          const t = db.transaction(s, 'readwrite');
          t.objectStore(s).put(v, k);
          t.oncomplete = () => res();
          t.onerror = () => rej(t.error);
        });
      let bytes = 0;
      for (const nm of names) {
        // ⚠ `Response.blob()` ではなく `arrayBuffer()` → `new Blob`。ディスクの空きが少ない箱
        //   (実測: 空き 2.2GB)では大きい `blob()` が `net::ERR_FAILED` で落ちる(`arrayBuffer()` は通る)
        const b = new globalThis.Blob([await (await grab(`/office-pack/${nm}`)).arrayBuffer()]);
        bytes += b.size;
        await put('files', nm, b);
      }
      await put('meta', 'pack', {
        version: m.version,
        installedAt: Date.now(),
        source: 'url',
        totalBytes: bytes,
        files: names.map((nm) => ({ name: nm })),
      });
      return { count: names.length, version: m.version, crossOriginIsolated: globalThis.crossOriginIsolated };
    });

    // 文書の送り手 + 傍受(頁が開く前に差す)
    await page.addInitScript(SPY);
    await page.addInitScript(({ doc, name }) => {
      const ch = new globalThis.BroadcastChannel('pkc3-office');
      ch.onmessage = (ev) => {
        const d = ev.data;
        if (!d || !d.pkc3Office) return;
        if (d.pkc3Office === 'ready-for-document') {
          const raw = globalThis.atob(doc);
          const u8 = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i += 1) u8[i] = raw.charCodeAt(i);
          ch.postMessage({ pkc3Office: 'document', payload: { name, bytes: u8 } });
        }
      };
    }, { doc: docB64, name: docName });

    step('文書を渡して開く');
    await page.goto(`${base}/office/host.html?await-doc=1&name=${encodeURIComponent(docName)}`, { waitUntil: 'commit' });
    // 開いた = Qt の器の中の題名に「渡した名前」と LibreOffice が両方出た(host の帯は数えない)
    let opened = null;
    for (let i = 0; i < 40 && opened === null; i += 1) {
      await page.waitForTimeout(3000);
      try {
        const r = await Promise.race([
          page.evaluate((NAME) => {
            const titles = [];
            const wt = (node) => {
              for (const el of node.querySelectorAll('*')) {
                if (el.shadowRoot) wt(el.shadowRoot);
                else if (el.children.length === 0) titles.push(el.textContent ?? '');
              }
            };
            const screen = document.getElementById('screen');
            if (screen) wt(screen);
            const all = titles.join(' ');
            return { docOpen: all.includes(NAME), loTitle: /LibreOffice/i.test(all) };
          }, docName),
          new Promise((_, rej) => setTimeout(() => rej(new Error('unresponsive')), 4000)),
        ]);
        if (r.docOpen && r.loTitle) opened = { atMs: Date.now() - t0 };
      } catch {
        /* 次の回で */
      }
      if (row.faults.length) break;
    }
    row.opened = opened;
    if (opened === null) {
      undecidable('文書が開かなかった');
      return row;
    }
    await page.bringToFront();
    await page.waitForTimeout(3000);
    step('開いた', { crossOriginIsolated: row.staged.crossOriginIsolated });
    await shot('1-opened');
    if (!(await alive())) {
      undecidable('版面が固まった(開いた直後)');
      return row;
    }
    const box = await canvasBox();
    row.canvas = box;
    if (!box) {
      undecidable('canvas が見つからない');
      return row;
    }
    const clip = { x: box.x, y: box.y, width: box.w, height: box.h };

    // ① 外へ種を置く → 読み戻す(置けたか)
    step('種を置く');
    row.seedWrite = await seedOutside();
    const back = await readOutside();
    row.seedBack = { text: back.text ?? null, focus: back.focus ?? null, err: back.textErr ?? back.hung ?? back.err ?? null };
    if (row.seedWrite.ok !== true || back.text !== seed) {
      undecidable(`外へ種を置けなかった(write=${JSON.stringify(row.seedWrite)} / 読み戻し=${JSON.stringify(row.seedBack)})`);
      return row;
    }

    // ② 対照 ── 字を打って版面が変わったか(入力が LO に届いているか)。押さない
    step('打鍵の対照');
    const f0 = await framesOf(clip);
    await page.keyboard.type('Q', { delay: 120 });
    await page.waitForTimeout(1500);
    const f1 = await framesOf(clip);
    row.typedArrived = swapped(f0, f1);
    await page.keyboard.press('Backspace'); // caret を先頭へ戻す(以降の選び方が先頭前提)
    await page.waitForTimeout(800);
    await shot('2-typed');
    if (row.typedArrived !== true) {
      undecidable('字を打っても版面が変わらなかった(入力が LO に届いていない)');
      return row;
    }
    if (!(await alive())) {
      undecidable('版面が固まった(打鍵の後)');
      return row;
    }

    // ③ コピーの直前の外の値
    row.before = (await readOutside()).text ?? null;
    row.hostWritesBefore = await page.evaluate('globalThis.__clip.writes.length');

    // ④ 腕ごとの手
    const ctxClick = async () => {
      const before = await page.evaluate(COUNT_QT_WINDOWS);
      const x = box.x + box.w * CTX_X;
      const y = box.y + box.h * CTX_Y;
      row.pressed = { x: Math.round(x), y: Math.round(y), button: 'right' };
      await page.mouse.click(x, y, { button: 'right' });
      await page.waitForTimeout(2500);
      const opened = await page.evaluate(COUNT_QT_WINDOWS);
      row.menu = { before, opened, rects: await page.evaluate(QT_WINDOW_RECTS) };
      await shot('4-menu');
      return opened > before;
    };
    let selected = null;
    step(`腕 ${arm}`);
    if (arm === 'C') {
      await page.waitForTimeout(2500);
    } else if (arm === 'B0') {
      await page.keyboard.press('Control+c');
      row.copyKey = 'Control+c';
    } else if (arm === 'B1') {
      const a = await framesOf(clip);
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(1000);
      selected = swapped(a, await framesOf(clip));
      await shot('3-selected');
      row.selectedOnScreen = selected;
      if (selected === true) {
        await page.keyboard.press('Control+c');
        row.copyKey = 'Control+c';
      }
    } else if (arm === 'B3') {
      const a = await framesOf(clip);
      await page.keyboard.press('Shift+ArrowRight');
      await page.waitForTimeout(1000);
      selected = swapped(a, await framesOf(clip));
      await shot('3-selected');
      row.selectedOnScreen = selected;
      if (selected === true) {
        await page.keyboard.press('Control+c');
        row.copyKey = 'Control+c';
      }
    } else if (arm === 'B3c') {
      const a = await framesOf(clip);
      const x = box.x + box.w * 0.3;
      const y = box.y + box.h * 0.4;
      row.pressed = { x: Math.round(x), y: Math.round(y), button: 'left' };
      await page.mouse.click(x, y);
      await page.waitForTimeout(1500);
      selected = swapped(a, await framesOf(clip));
      await shot('3-selected');
      row.selectedOnScreen = selected;
      if (selected === true) {
        await page.keyboard.press('Control+c');
        row.copyKey = 'Control+c';
      }
    } else if (arm === 'B4') {
      const a = await framesOf(clip);
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(600);
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(1000);
      selected = swapped(a, await framesOf(clip));
      await shot('3-selected');
      row.selectedOnScreen = selected;
      if (selected === true) {
        await page.keyboard.press('Control+c');
        row.copyKey = 'Control+c';
      }
    } else if (arm === 'C2') {
      const menuOpen = await ctxClick();
      row.menuOpened = menuOpen;
      if (menuOpen) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1500);
      }
    } else if (arm === 'B2' || arm === 'B2k') {
      const a = await framesOf(clip);
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(1000);
      selected = swapped(a, await framesOf(clip));
      row.selectedOnScreen = selected;
      await shot('3-selected');
      if (selected === true) {
        const menuOpen = await ctxClick();
        row.menuOpened = menuOpen;
        if (menuOpen) {
          if (arm === 'B2k') {
            // 近道キーは日本語 UI の綴り(`コピー(Y)`。`切り取り(C)` と取り違えない)
            row.copyKey = 'menu:y';
            await page.keyboard.press('y');
            await page.waitForTimeout(1000);
            row.menuWindowsAfterClick = await page.evaluate(COUNT_QT_WINDOWS);
          } else {
            // 開いた窓(canvas ではない qt-window)の上端から 40px 下 = 「コピー」の行(版面で確認した値)
            const m = row.menu.rects.filter((r) => !(r.w === Math.round(box.w) && r.h === Math.round(box.h))).pop();
            const cx = m.x + 60;
            const cy = m.y + 40;
            row.copyClick = { x: cx, y: cy, menu: m };
            row.copyKey = 'menu:click';
            await page.mouse.click(cx, cy);
            await page.waitForTimeout(1000);
            row.menuWindowsAfterClick = await page.evaluate(COUNT_QT_WINDOWS);
          }
        }
      }
    }
    await page.waitForTimeout(3000);
    await shot('5-after');

    // ⑤ コピーの後の外
    step('外を読む');
    const faultBeforeCopy = row.faults.length > 0;
    if (!(await alive())) {
      undecidable('版面が固まった(コピーの後)');
    }
    const after = await readOutside();
    row.after = { text: after.text ?? null, types: after.types ?? null, focus: after.focus ?? null, errs: [after.textErr, after.readErr, after.hung, after.err].filter(Boolean) };
    row.emptied = after.text === '' ? true : after.text === undefined ? null : false;
    row.faultsAtRead = row.faults.length;
    /**
     * 🔑 **別の頁からも読む**(同じ origin の空の頁を前面に出して `readText()`)。
     * ⚠ 「外」は host の頁(書いた側)とは限らない ── PKC 本体のタブは別の頁である。
     *   書いた頁と読む頁が同じだと、頁の中の状態で満たされうるので、**読む頁を変えた値**も採る。
     */
    try {
      const other = await ctx.newPage();
      await other.goto(`${base}/__reader.html`, { waitUntil: 'domcontentloaded' });
      await other.bringToFront();
      const o = await readOutside(other);
      row.afterOtherPage = { text: o.text ?? null, types: o.types ?? null, focus: o.focus ?? null, errs: [o.textErr, o.readErr, o.hung, o.err].filter(Boolean) };
      await other.close();
      await page.bringToFront();
    } catch (e) {
      row.afterOtherPage = { err: safeErr(e) };
    }
    const clipLog = await page.evaluate('globalThis.__clip');
    // host の窓の下の行(`setStatus` の出し先)。コピーが外へ届かなかったとき user に見える唯一の面(#121)
    row.hostStatus = await page.evaluate("(document.getElementById('status') || {}).textContent ?? null");
    row.hostWrites = {
      bc: clipLog.bc,
      calls: clipLog.writes.slice(row.hostWritesBefore),
      callsTotal: clipLog.writes.length,
    };

    // ⑤' 参考の観測 ── LO の**中**へ貼ってみる(コピーが LO の中で効いたかの傍証。外の判定とは別)。
    //    ⚠ 外を読み終えた後にやる(貼る操作が外の値を変えるので)。選んだ腕だけ。
    if (selected === true) {
      step('LO の中へ貼る');
      const g0 = await framesOf(clip);
      const bcBefore = (await page.evaluate('globalThis.__clip.bc.length'));
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(500);
      await page.keyboard.press('Control+End');
      await page.waitForTimeout(500);
      const g1 = await framesOf(clip);
      await page.keyboard.press('Control+v');
      await page.waitForTimeout(2500);
      const g2 = await framesOf(clip);
      const bcAfter = await page.evaluate('globalThis.__clip.bc.slice(' + bcBefore + ')');
      row.loPaste = { changed: swapped(g1, g2), bcDuringPaste: bcAfter.map((m) => ({ clip: m.clip, kind: m.kind })) };
      void g0;
      await shot('6-lopaste');
    }

    // ⑥ 判定不能の規則(⑥ コピーの前の fault / ④ 選択が出ない / ⑤ メニューが開かない)
    if (faultBeforeCopy) undecidable('コピーの前後で memory access out of bounds が出た(修飾キーの経路が死ぬ。SKILL §14)');
    if (['B1', 'B3', 'B3c', 'B4', 'B2', 'B2k'].includes(arm) && selected !== true) undecidable('選択が版面に出なかった');
    if (['B2', 'B2k', 'C2'].includes(arm) && row.menuOpened !== true) undecidable('右クリックのメニューが開かなかった(窓の数が増えない)');
    return row;
  } catch (e) {
    row.error = safeErr(e);
    undecidable(`例外(${lastStep()}): ${row.error}`);
    return row;
  } finally {
    await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
    current = null;
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

try {
  wd.mark('ラウンド');
  for (const arm of ARMS) {
    // 判定不能の回は数に入れないので、判定できた回が ROUNDS になるまで回し足す(上限は +2 回)
    let valid = 0;
    for (let n = N_START; valid < ROUNDS && n < N_START + ROUNDS + 2; n += 1) {
      wd.mark(`${arm}-${n}`);
      // 回の締切(固まった evaluate は例外を投げないので、外から競走させる)
      // 🔴 **締切の timer は回が終わったら必ず止める** ── 止めないと 240 秒後に**次の回の browser を
      //    閉じる**(1 稿目で踏んだ: C2 以降の 18 回が `Target page … has been closed` になった)
      let deadline = null;
      const r = await Promise.race([
        oneRound(arm, n),
        new Promise((res) => {
          deadline = setTimeout(() => {
            if (current) current.close().catch(() => {});
            res({ arm, n, undecidable: `回の締切(${ROUND_SEC} 秒)を超えた`, timedOut: true });
          }, ROUND_SEC * 1000);
        }),
      ]);
      clearTimeout(deadline);
      r.verdict = r.undecidable
        ? `判定不能(${r.undecidable})`
        : r.emptied === true
          ? '外が空になった'
          : r.emptied === false
            ? `外は空ではない(text=${JSON.stringify(r.after?.text)})`
            : '読めなかった';
      if (!r.undecidable) valid += 1;
      result.rounds.push(r);
      await flush();
      process.stderr.write(`${arm}-${n}: ${r.verdict}\n`);
    }
  }
  /** 腕 × 回の表。判定不能は数に入れない。 */
  result.table = ARMS.map((arm) => {
    const rs = result.rounds.filter((r) => r.arm === arm);
    const valid = rs.filter((r) => !r.undecidable);
    return {
      arm,
      rounds: rs.length,
      valid: valid.length,
      undecidable: rs.length - valid.length,
      emptied: valid.filter((r) => r.emptied === true).length,
      keptSeed: valid.filter((r) => r.emptied === false && r.after?.text === r.seed).length,
      replacedByLo: valid.filter((r) => r.emptied === false && r.after?.text !== r.seed).length,
      otherPageEmptied: valid.filter((r) => r.afterOtherPage?.text === '').length,
    };
  });
} catch (e) {
  result.error = safeErr(e);
} finally {
  wd.disarm();
  await flush();
  if (!OUT) console.log(JSON.stringify(result, null, 1));
  server.close();
  process.exit(0);
}
