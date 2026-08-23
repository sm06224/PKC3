/**
 * **PKC から Office へ文書を渡して「開けるか」を測る** probe(#199 / #156)。
 *
 * `host.html?await-doc=1` の実経路(BroadcastChannel `pkc3-office` で bytes を渡す)を
 * そのまま踏み、次の 3 つだけを見る:
 *   ① host の放送(ready-for-document / painted)
 *   ② **開けたか** ── Qt の器の中の題名に「渡した名前」と `LibreOffice` が**両方**出たか
 *   ③ メインスレッドの応答(`evaluate` が返るか = 「固まる」そのもの)
 *
 * ⚠ **`painted` を「開けた」と読まない** ── canvas が 1 枚出ただけで、Start Center でも出る。
 * ⚠ **題名を document 全体から拾わない** ── host 自身が上の帯に file 名を出しているので、
 *   拾うと LO が 1 画素も描く前に「開けた」と言う(2026-08-15 に実際に踏んだ)。
 * ⚠ `document.title` は**この面では動かない**(常に host の題名)── 観測点として死んでいる。
 * ⚠ `locked`(LO の `.~lock` file)も**死んだ観測点**(2026-08-15 実測)── 開けた文書でも
 *   出ないので、これで「開いた」を判定してはいけない。生きているのは**窓の題名**だけである。
 * 🔴 **`Module` の未 export のシンボルを読むと LO が死ぬ。** emscripten は未 export の名前に
 *   `abort()` する getter を仕込むので、`lo.PThread` を**読んだ瞬間**に
 *   `Aborted('PThread' was not exported…)` → `RuntimeError: unreachable` で runtime ごと落ちる
 *   (調査で実際に踏み、5 秒ごとの観測が 5 秒ごとに対象を殺していた)。
 *   ⚠ 触ってよいのは `FS` / `HEAPU8` / `calledRun`。**素性の分からない名前は
 *   `Object.getOwnPropertyDescriptor` で見る**(getter を発火させない)。
 *
 * 使い方:
 *   node build/office-wasm/open-doc-probe.mjs <pack ディレクトリ> <文書|none> [出力.json] [秒]
 *   PKC3_SHOT=/path/shot.png  を付けると最後に 1 枚撮る
 *
 * ⚠ `dist/` を配るので **先に `npm run build`** すること。
 */

import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, extname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const PACK = resolve(process.argv[2]);
const DOC = process.argv[3] === 'none' ? '' : resolve(process.argv[3]);
const OUT = process.argv[4] ?? '';
const LIMIT_SEC = Number(process.argv[5] ?? 180);
const DIST = resolve(process.env.PKC3_DIST ?? 'dist');
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
      const f = p.startsWith('/office-pack/')
        ? join(PACK, p.slice('/office-pack/'.length))
        : join(DIST, p);
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
const safeLine = (s) => (/[^\x20-\x7e]/.test(s) ? null : s.slice(0, 140));

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
// `none` = 文書を渡さない(Start Center)。⚠ 対照群 ── 「起動そのもの」と
// 「文書を渡した起動」のどちらが壊れているかは、これが無いと分けられない。
const NO_DOC = process.argv[3] === 'none';
const b64 = NO_DOC ? '' : (await readFile(DOC)).toString('base64');
// ⚠ 名前は**実ファイルのもの**を渡す ── 1 巡目は全部 `doc.docx` 固定で渡しており、
//   平文の対照群まで docx として読ませていた(対照群が対照群になっていなかった)。
const NAME = NO_DOC ? '' : basename(DOC);
const SHOT = process.env.PKC3_SHOT ?? '';
/** 🔴 開いた状態で IME の門を読むか(#156 段②)。⚠ 既定は読まない。 */
const IME = process.env.PKC3_IME === '1';
/**
 * 編集可能要素と、パッチが書く診断(`obj1-win1-panel1-accept0` の形)。
 * ⚠ 読み方は `ime-probe.mjs` と**同じ 1 つ**にする(2 か所で別々に決めない)。
 * ⚠ ここは template literal なので**逆引用符を書かない**。
 */
const IME_DEEP = `(() => {
  const inputs = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      const t = el.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || el.isContentEditable) {
        const r = el.getBoundingClientRect();
        inputs.push({ tag: t, id: el.id || null, w: Math.round(r.width), h: Math.round(r.height),
          focused: el === document.activeElement,
          inputmode: el.getAttribute('inputmode'),
          ime: el.getAttribute('data-pkc-ime') });
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const ae = document.activeElement;
  return { inputs, active: ae ? (ae.tagName + (ae.id ? '#' + ae.id : '')) : null };
})()`;
const docBytes = NO_DOC ? 0 : (await readFile(DOC)).length;
const result = { doc: { bytes: docBytes }, events: [], console: [], samples: [] };
const profile = `${tmpdir()}/pkc3-open-doc-${process.pid}`;
const browser = await chromium.launchPersistentContext(profile, {
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  executablePath: '/opt/pw-browsers/chromium',
});
const page = await browser.newPage();
page.on('console', (m) => {
  const t = safeLine(`[${m.type()}] ${m.text()}`);
  if (t && result.console.length < 60) result.console.push(t);
});
page.on('pageerror', (e) => {
  const t = safeLine(`[pageerror] ${String(e)}`);
  if (t) result.console.push(t);
});
page.on('crash', () => result.console.push('[crash] page crashed'));

try {
  // 一式を IDB へ(PKC が入れる形と同じ)
  await page.goto(`${base}/office/host.html`, { waitUntil: 'domcontentloaded' });
  result.staged = await page.evaluate(async () => {
    const { fetch, indexedDB } = globalThis;
    const m = await (await fetch('/office-pack/pack.json')).json();
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
    for (const n of names) {
      const b = await (await fetch(`/office-pack/${n}`)).blob();
      bytes += b.size;
      await put('files', n, b);
    }
    await put('meta', 'pack', {
      version: m.version,
      installedAt: Date.now(),
      source: 'url',
      totalBytes: bytes,
      files: names.map((n) => ({ name: n })),
    });
    return { count: names.length, version: m.version };
  });

  // 送り手を仕込む(PKC の実経路 = 放送で bytes を渡す)
  await page.addInitScript(({ doc, name }) => {
    const ch = new globalThis.BroadcastChannel('pkc3-office');
    globalThis.__probeEvents = [];
    ch.onmessage = (ev) => {
      const d = ev.data;
      if (!d || !d.pkc3Office) return;
      globalThis.__probeEvents.push({ t: Date.now(), type: d.pkc3Office });
      if (d.pkc3Office === 'ready-for-document') {
        const raw = globalThis.atob(doc);
        const u8 = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) u8[i] = raw.charCodeAt(i);
        ch.postMessage({ pkc3Office: 'document', payload: { name, bytes: u8 } });
      }
    };
  }, { doc: b64, name: NAME });

  const t0 = Date.now();
  await page.goto(NO_DOC ? `${base}/office/host.html` : `${base}/office/host.html?await-doc=1&name=${encodeURIComponent(NAME)}`, { waitUntil: 'commit' });

  let deadStreak = 0;
  for (let i = 0; i * 5 < LIMIT_SEC; i += 1) {
    await page.waitForTimeout(5_000);
    let alive = false;
    let canvas = 0;
    let title = null;
    let msg = null;
    try {
      const r = await Promise.race([
        page.evaluate((NAME_IN_PAGE) => {
          const walk = (n) => {
            let w = 0;
            for (const e of n.querySelectorAll('*')) {
              if (e.tagName === 'CANVAS') w = Math.max(w, e.width);
              if (e.shadowRoot) w = Math.max(w, walk(e.shadowRoot));
            }
            return w;
          };
          const m = document.getElementById('msg');
          /**
           * **判定は面の中でやり、外へは真偽だけ出す。**
           * ⚠ 題名は UI が日本語なので、外で ASCII 濾過すると**丸ごと消える**
           *   (実測: 1 巡目は題名が常に null で「死んだ観測点」だった)。
           */
          /**
           * ⚠ **`textContent` は shadow 境界を越えない。** 1 稿目は `qt-window` の
           *   textContent を見ていたので、題名バーが入れ子の shadow root に在る
           *   この面では**常に空**だった(= 死んだ観測点。自作の対照群を写真で
           *   確かめて気づいた)。葉の要素まで降りて集める。
           */
          /**
           * ⚠ **host 自身の帯を数えない。** 2 稿目は document 全体の葉を集めたので、
           *   host が出している `Office <名前>` に満たされて **5 秒で「開けた」**と
           *   言った(LO はまだ 1 画素も描いていない)── §1 の「代替物に満たされる」。
           * 🔑 見るのは **Qt の器の中だけ**、しかも**名前と LibreOffice の両方**。
           */
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
          /**
           * 🔑 **LO が本当に開いたか**は、LO 自身が作る**ロック file** で分かる
           * (`.~lock.<名前>#`)。⚠ 名前はこちらが付けた `doc.docx` なので中身に触れない。
           * ⚠ 窓の題名は**この面では死んでいる**(実測: 常に長さ 13 で変わらない)。
           */
          let work;
          try {
            work = globalThis.__lo.FS.readdir('/work').filter((n) => n !== '.' && n !== '..');
          } catch {
            work = ['(読めない)'];
          }
          const geom = [];
          const wg = (node) => {
            for (const el of node.querySelectorAll('*')) {
              if (el.classList && el.classList.contains('qt-window')) {
                const r = el.getBoundingClientRect();
                geom.push(`${Math.round(r.width)}x${Math.round(r.height)}`);
              }
              if (el.shadowRoot) wg(el.shadowRoot);
            }
          };
          wg(document);
          return {
            canvas: walk(document),
            docOpen: all.includes(NAME_IN_PAGE),
            loTitle: /LibreOffice/i.test(all),
            titleLen: document.title.length,
            windows: titles.length,
            wrote: !!(globalThis.__loDocPath),
            work,
            geom,
            locked: work.some((n) => n.startsWith('.~lock')),
            msg: m && !m.hidden ? (m.textContent ?? '').slice(0, 100) : null,
            events: globalThis.__probeEvents ?? [],
          };
        }, NAME),
        new Promise((_, rej) => setTimeout(() => rej(new Error('unresponsive')), 4000)),
      ]);
      alive = true;
      canvas = r.canvas;
      title = { docOpen: r.docOpen, loTitle: r.loTitle, windows: r.windows, wrote: r.wrote, locked: r.locked, work: r.work, geom: r.geom };
      msg = r.msg === null ? null : safeLine(r.msg);
      result.events = r.events.map((e) => ({ dt: e.t - t0, type: e.type }));
    } catch {
      alive = false;
    }
    deadStreak = alive ? 0 : deadStreak + 1;
    result.samples.push({ atSec: Math.round((Date.now() - t0) / 1000), alive, canvas, title, msg });
    // 🔑 「開けた」= Qt が窓の題名を差し替えたとき(Writer / Calc / Impress の名が出る)
    // 🔑 「開けた」= 窓の題名に**渡した名前**が出たとき(名前はこちらが付けた `doc.docx`)
    // 🔑 名前だけでは足りない(host の帯に出る)── **Qt の器の中で**両方が揃った時
    if (alive && title && title.docOpen && title.loTitle) {
      result.opened = { atSec: Math.round((Date.now() - t0) / 1000), ...title };
      break;
    }
    if (deadStreak >= 6) {
      result.frozen = { fromSec: result.samples[result.samples.length - 6].atSec };
      break;
    }
  }
  /**
   * 🔴 **開いた状態で IME の門を読む**(#156 の「次にやること ②」、2026-08-23)。
   *
   * ⚠ `ime-probe.mjs` は**文書を開かずに**読むので、そこの `accept0` は
   * 「VCL が `SetInputContext` を呼ぶ理由が無い」だけかもしれず、
   * **パッチの失敗の証拠でも成功の証拠でもない**(#156 本文)。
   * 🔑 ここは**開いたことを確かめてから**読むので、その曖昧さが消える。
   *
   * ⚠ 版面を 1 度**押してから**読む ── VCL が `WA_InputMethodEnabled` を立てるのは
   * 「ここは文字を入れる場所だ」と言うときだけなので、caret が要る。
   * ⚠ **既定では何もしない**(`PKC3_IME=1` を渡した回だけ)── 既存の使い方を変えない。
   */
  if (IME && result.opened) {
    try {
      const box = await page.evaluate(`(() => {
        let best = null;
        const walk = (n) => { for (const el of n.querySelectorAll('*')) {
          if (el.tagName === 'CANVAS' && el.width > 0) {
            const r = el.getBoundingClientRect();
            if (!best || r.width > best.w) best = { x: r.x, y: r.y, w: r.width, h: r.height };
          }
          if (el.shadowRoot) walk(el.shadowRoot); } };
        walk(document);
        return best;
      })()`);
      result.ime = { clicked: false, before: await page.evaluate(IME_DEEP) };
      if (box) {
        /**
         * 🔴 **対照群 ── 打鍵が版面に届いたか**(CLAUDE.md §4、2026-08-13 の教訓)。
         *
         * ⚠ これが無いと `accept0` を読めない ── 合成クリックが caret を置けて
         *   いなければ、健全なビルドでも `accept0` を返す(#156 本文の
         *   「🔴 まだ言えないこと」がそれ)。
         * ⚠ **1 枚ずつ比べない** ── 点滅するカーソルだけで「変わった」になる。
         *   間隔をあけて数枚採り、**集合ごと入れ替わったときだけ**「届いた」と言う。
         * ⚠ 撮れない回は `null` を返す(空配列にしない ── 空だと `every` が
         *   真になって「届いた」と誤読する)。
         */
        const clip = { x: box.x, y: box.y, width: box.w, height: box.h };
        const frames = async (n = 5) => {
          const set = new Set();
          for (let i = 0; i < n; i += 1) {
            const png = IME ? await page.screenshot({ clip }) : null;
            if (png === null) return null;
            set.add(createHash('sha256').update(png).digest('hex').slice(0, 16));
            await page.waitForTimeout(400);
          }
          return [...set];
        };
        await page.mouse.click(box.x + box.w * 0.4, box.y + box.h * 0.35);
        result.ime.clicked = true;
        await page.waitForTimeout(3000);
        const beforeFrames = await frames();
        await page.keyboard.type('a', { delay: 120 });
        await page.waitForTimeout(3000);
        const afterFrames = await frames();
        result.ime.landed =
          beforeFrames === null || afterFrames === null
            ? null
            : afterFrames.every((h) => !beforeFrames.includes(h));
        result.ime.frames = { before: beforeFrames?.length ?? null, after: afterFrames?.length ?? null };
      }
      result.ime.after = await page.evaluate(IME_DEEP);
    } catch (e) {
      result.ime = { err: safeLine(String(e)) ?? 'error' };
    }
  }
  if (SHOT) {
    try { await page.screenshot({ path: SHOT }); } catch { /* 固まっていたら撮れない */ }
  }
} catch (e) {
  result.error = safeLine(String(e)) ?? 'error(非 ASCII のため伏せた)';
} finally {
  const text = JSON.stringify(result, null, 1);
  if (OUT) await writeFile(OUT, text);
  else console.log(text);
  await browser.close();
  server.close();
  /**
   * 🔴 **profile を残さない**(#220 の併走で判明。機密資料の取り扱い 5)。
   * ⚠ 開いた文書の痕跡(cache / IDB / 一時 file)がここに入る ── 兄弟の
   * `save-existing-probe.mjs` は消しているのに、こちらは残していた
   * (「片側を直したら対称の反対側を疑う」の 1 件)。
   */
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
