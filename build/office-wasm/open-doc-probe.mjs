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
/**
 * 🔴 **例外は「行ごと」に濾す**(2026-08-24)。
 *
 * ⚠ 直す前は `safeLine(String(e))` を 1 回掛けていたので、**例外の文言に
 *   非 ASCII が 1 文字でも混ざると全部捨てて `'error'` だけが残った** ──
 *   自分のハーネスの誤りを、自分で直せない形である(実際 1 回転溶かした)。
 * 🔑 規律(**非 ASCII の行は丸ごと捨てる**)はそのままに、**行単位**で当てる ──
 *   Playwright の例外は 1 行目が ASCII の要約で、本文が混じるのは call log の側である。
 */
const safeErr = (e) => {
  for (const line of String(e).split('\n')) {
    const t = safeLine(line.trim());
    if (t !== null && t !== '') return t;
  }
  return 'error';
};

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
 * 🔴 **スレッドの内訳を読む**(#199 の「次の一手 ①」)。⚠ **既定では何もしない。**
 * ⚠ `PKC3_IME` とは別の口である ── あちらは版面を押して打つので、
 *   「詰まっている最中」を見たいこちらと**混ぜてはいけない**。
 */
const PTHREAD = process.env.PKC3_PTHREAD === '1';
/**
 * 🔴 **全 worker の stack を 1 枚撮る**(#199 の「次の一手 ②」)。⚠ 既定では何もしない。
 * ⚠ `PKC3_PTHREAD` の内訳が**死んだ観測点**だったので足した(下の実装を参照)。
 */
const STACKS = process.env.PKC3_STACKS === '1';
/**
 * 🔴 **打鍵が「その場で版面に出るか」を測るか**(#154 段①)。⚠ 既定は測らない。
 *
 * 実機レポート #7(2/2): Impress は**打っている間、画面が更新されない** ──
 * `Escape` を押してメニューを開いた瞬間に、打った字がいっぺんに現れる。
 * ⚠ issue が「Impress 固有」と書いた自信度は **60%**(同一の腕で Writer と
 * 比べていない)ので、まず**対照群を揃える**のがこの門の仕事である。
 * ⚠ `PKC3_IME` とは**同時に使わない**(どちらも版面を押して打つので混ざる)。
 */
const REDRAW = process.env.PKC3_REDRAW === '1';
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
/**
 * 🔴 **計装の出口を MEMFS から読む**(#156 段③、`patch-lo-ime-trace.py` と対)。
 *
 * ⚠ LO 側の文脈から DOM を触れないので、計装は **libc だけ**で
 *   `/tmp/pkc3-ime.log` へ追記している ── ここはその file を読むだけ。
 * 🔑 返り値で 3 つを見分ける:
 *     `null`   = 計装の入っていない一式(= この焼きでは測っていない)
 *     `[]`     = 計装は在るが **1 行も出ていない**(呼ばれていない)
 *     `[...]`  = 出た行
 * ⚠ ここは template literal なので**逆引用符を書かない**。
 */
const IME_TRACE = `(() => {
  try {
    const lo = globalThis.__lo;
    if (!lo || !lo.FS) return null;
    const raw = lo.FS.readFile('/tmp/pkc3-ime.log', { encoding: 'utf8' });
    // ⚠ **ここで '\\n' と書いてはいけない** ── この原文は template literal の中に
    //   在るので、escape は**組み立てる側で解決されて実改行になる**
    //   (= 開いた ' が閉じないまま改行 = SyntaxError)。2026-08-24 に踏んだ。
    return String(raw).split(String.fromCharCode(10)).filter((l) => l.length > 0);
  } catch (e) {
    // ⚠ **大文字小文字を潰してから見る**(2026-08-24 に踏んだ)── 実際に飛ぶのは
    //    ErrnoError: No such file or directory で、小文字の 'no such file' とは一致しない。
    //    🔑 ここを外すと「計装が入っていない(null)」が「読もうとして落ちた(ERR)」に化け、
    //    **対照群の意味が逆に読める**(実際 #199 の対照群で 1 度読み違えた)。
    //    ⚠⚠ この注釈に**逆引用符を書かない** ── ここは template literal の中である。
    const msg = String(e).toLowerCase();
    return msg.indexOf('enoent') >= 0 || msg.indexOf('no such file') >= 0
      ? null
      : ['ERR ' + String(e).slice(0, 80)];
  }
})()`;
/**
 * 版面(いちばん大きい canvas)の位置。⚠ Qt 6 の canvas は **shadow root の中**なので
 * 潜って拾う(`host.html` が「1 日溶かした罠」と書いている当のもの)。
 * ⚠ **2 つの門で同じものを使う** ── 別々に書くと、片方だけ直す事故が起きる。
 * ⚠ ここは template literal なので**逆引用符も escape も書かない**(下の検査を参照)。
 */
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
/**
 * 🔴 **詰まっている最中のスレッドの内訳**(#199 の「次の一手 ①」、2026-08-24)。
 *
 * ⚠ **`PKC3_PTHREAD=1` を渡した回だけ読む** ── 既定の使い方を変えない。
 * 🔴 **未 export の名前は「読んだ瞬間に abort する getter」である**(この file の頭)。
 *   だから値を取る前に **`getOwnPropertyDescriptor` で見る** ── 記述子を見るのは
 *   getter を発火させない。⚠ `lo.PThread` と素で書いた瞬間、計装の入っていない
 *   一式では **LO ごと死ぬ**(調査で実際に踏み、5 秒ごとの観測が 5 秒ごとに対象を殺した)。
 * ⚠ 触るのは **`runningWorkers` / `unusedWorkers` の列挙だけ**
 *   (`patch-lo-memory.py` が出しているのはそこまで)。
 * 🔑 返り値で 3 つを見分ける:
 *     `null`   = この一式は `PThread` を出していない(= 測っていない)
 *     `{...}`  = 読めた
 *     `{err}`  = 読もうとして落ちた(**空と混ぜない**)
 */
const PTHREADS = `(() => {
  try {
    const lo = globalThis.__lo;
    if (!lo) return null;
    const d = Object.getOwnPropertyDescriptor(lo, 'PThread');
    // ⚠ 記述子が getter なら**触らない**(発火させると abort する)
    if (!d || d.get !== undefined || d.value === undefined || d.value === null) return null;
    const P = d.value;
    const names = (v) => {
      if (!v) return null;
      const arr = Array.isArray(v) ? v : (typeof v.values === 'function' ? Array.from(v.values()) : null);
      if (arr === null) return null;
      return arr.map((w) => {
        try { return typeof w.name === 'string' && w.name.length > 0 ? w.name : '(名前なし)'; }
        catch (e) { return '(読めない)'; }
      });
    };
    const run = names(P.runningWorkers);
    const idle = names(P.unusedWorkers);
    const ed = Object.getOwnPropertyDescriptor(lo, 'ENV');
    const env = !ed || ed.get !== undefined || !ed.value ? null : {
      VCL_NO_THREAD_SCALE: ed.value.VCL_NO_THREAD_SCALE ?? null,
      VCL_NO_THREAD_IMPORT: ed.value.VCL_NO_THREAD_IMPORT ?? null,
      MAX_CONCURRENCY: ed.value.MAX_CONCURRENCY ?? null,
    };
    return {
      running: run === null ? null : run.length,
      unused: idle === null ? null : idle.length,
      runningNames: run,
      unusedNames: idle,
      env,
    };
  } catch (e) {
    return { err: String(e).slice(0, 120) };
  }
})()`;

/**
 * 🔴 **渡す原文を、走らせる前に構文として検める**(2026-08-24 に踏んだ)。
 *
 * ⚠ `IME_TRACE` は**書いた日から一度も成立していなかった** ── 原文の中に
 *   `'\n'` と書いたが、これらは template literal の中に在るので**組み立てる側で
 *   実改行に解決され**、開いた `'` が閉じないまま改行していた。
 * ⚠ 症状は「IME ブロックが 1 つのエラーで畳まれる」だけで、**どの一手で落ちたかが
 *   出ない** ── 押す・打つ・`Ctrl+A` の対照群は 1 度も走っていなかったのに、
 *   出力は「測ったが取れなかった」と見分けが付かなかった。
 * 🔑 だから**名前を付けて先に落とす** ── 原文が壊れているのか、相手の頁で
 *   取れなかったのかを、出力だけで区別できるようにする。
 */
/**
 * 🔴 **idle 錠の待ちの計装を読む**(#199。`patch-lo-idles-trace.py` が書く)。
 *
 * 🔑 3 行の意味:
 *   `idles:wait a=<IsUseSystemEventLoop> b=<IsMainThread>` ── ⚠ **前提を実測で出す**
 *   `idles:woke` ── 出なければ、そこで永久に止まっている
 *   `execute:set` ── 0 件なら、メインスレッドが `Application::Execute()` のループに未到達
 * ⚠ **ここで '\n' と書いてはいけない**(組み立て側で実改行に解決される。2026-08-24 に踏んだ)。
 */
const IDLES_TRACE = `(() => {
  try {
    const lo = globalThis.__lo;
    if (!lo || !lo.FS) return null;
    const raw = lo.FS.readFile('/tmp/pkc3-idles.log', { encoding: 'utf8' });
    return String(raw).split(String.fromCharCode(10)).filter((l) => l.length > 0);
  } catch (e) {
    // ⚠ **大文字小文字を潰してから見る**(2026-08-24 に踏んだ)── 実際に飛ぶのは
    //    ErrnoError: No such file or directory で、小文字の 'no such file' とは一致しない。
    //    🔑 ここを外すと「計装が入っていない(null)」が「読もうとして落ちた(ERR)」に化け、
    //    **対照群の意味が逆に読める**(実際 #199 の対照群で 1 度読み違えた)。
    //    ⚠⚠ この注釈に**逆引用符を書かない** ── ここは template literal の中である。
    const msg = String(e).toLowerCase();
    return msg.indexOf('enoent') >= 0 || msg.indexOf('no such file') >= 0
      ? null
      : ['ERR ' + String(e).slice(0, 80)];
  }
})()`;

for (const [name, src] of Object.entries({ IME_DEEP, IME_TRACE, CANVAS_BOX, PTHREADS, IDLES_TRACE })) {
  try {
    new Function(`return ${src}`);
  } catch (e) {
    throw new Error(`evaluate の原文 ${name} が構文として成立していない`, { cause: e });
  }
}
const docBytes = NO_DOC ? 0 : (await readFile(DOC)).length;
const result = { doc: { bytes: docBytes }, events: [], console: [], imeConsole: [], samples: [] };
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
  if (t === null) return;
  // 🔴 **計装の行は別の箱へ採る**(#156 段③)。⚠ 下の一般の箱は 60 行で打ち切る
  //    ので、起動時の洪水に**押し出される** ── 「出ていない」と「採らなかった」が
  //    見分けられなくなる(CLAUDE.md §4「観測点が別の物に満たされる」の器版)。
  //    🔑 本命は MEMFS の log(`result.ime.trace`)で、こちらはその控えである。
  if (t.includes('PKC3-IME') && result.imeConsole.length < 200) result.imeConsole.push(t);
  if (result.console.length < 60) result.console.push(t);
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
    /**
     * 🔴 **詰まっている最中に読む**(#199)。⚠ 開いた後ではなく**各サンプル**で採る ──
     *   開かない文書が相手なので、「開いた」を待つと**一度も読めない**。
     * ⚠ メインスレッドが応答しない回は `alive` が偽なので、そこでは読まない
     *   (読もうとしても `evaluate` が返らない)。
     */
    let threads;
    if (PTHREAD && alive) {
      try {
        threads = await Promise.race([
          page.evaluate(PTHREADS),
          new Promise((_, rej) => setTimeout(() => rej(new Error('unresponsive')), 4000)),
        ]);
      } catch {
        threads = { err: 'unresponsive' };
      }
    }
    result.samples.push({
      atSec: Math.round((Date.now() - t0) / 1000),
      alive,
      canvas,
      title,
      msg,
      ...(threads === undefined ? {} : { threads }),
    });
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
  const canvasBox = () => page.evaluate(CANVAS_BOX);

  /**
   * 🔴 **版面の絵を「集合」で採る**(CLAUDE.md §4、2026-08-13 の教訓)。
   *
   * ⚠ **1 枚ずつ比べない** ── 点滅するカーソルだけで「変わった」になる。
   * 間隔をあけて数枚採り、**集合ごと入れ替わったときだけ**「変わった」と言う。
   * ⚠ 撮れない回は `null` を返す(空配列にしない ── 空だと `every` が真になって
   * 「変わった」と誤読する)。
   */
  const framesOf = async (clip, n = 5) => {
    const set = new Set();
    for (let i = 0; i < n; i += 1) {
      const png = IME || REDRAW ? await page.screenshot({ clip }) : null;
      if (png === null) return null;
      set.add(createHash('sha256').update(png).digest('hex').slice(0, 16));
      await page.waitForTimeout(400);
    }
    return [...set];
  };
  /** 2 つの集合が**丸ごと**入れ替わったか(片方でも採れていなければ `null`)。 */
  const swapped = (a, b) => (a === null || b === null ? null : b.every((h) => !a.includes(h)));

  if (IME && result.opened) {
    try {
      const box = await canvasBox();
      result.ime = { clicked: false, before: await page.evaluate(IME_DEEP) };
      /**
       * 🔴 **どの一手で何行出たかを分ける**(#156 段③)。
       *
       * ⚠ log に印を書き込めない(JS から MEMFS へ追記する口を増やすと、
       *   計装の出口が 2 か所になる ── CLAUDE.md §7)。
       * 🔑 代わりに**節目ごとに行数を採る** ── 差が「その一手で出た行」である。
       *   これが無いと、起動中に出た行と押した後に出た行が混ざって読めない。
       */
      const traceLen = async () => {
        const t = await page.evaluate(IME_TRACE);
        return Array.isArray(t) ? t.length : null;
      };
      result.ime.marks = { opened: await traceLen() };
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
        const frames = (n = 5) => framesOf(clip, n);
        await page.mouse.click(box.x + box.w * 0.4, box.y + box.h * 0.35);
        result.ime.clicked = true;
        await page.waitForTimeout(3000);
        result.ime.marks.clicked = await traceLen();
        const beforeFrames = await frames();
        await page.keyboard.type('a', { delay: 120 });
        await page.waitForTimeout(3000);
        result.ime.marks.typed = await traceLen();
        const afterFrames = await frames();
        /**
         * 🔴 **キャレットが「本文」に入ったかを分ける**(#156 段③ の前段、2026-08-23)。
         *
         * ⚠ 上の `landed`(版面が変わった)は **「打鍵が届いた」までしか言えない** ──
         *   工具帯の強調でも版面は変わる。ところが `accept0` を読むには
         *   **本文にキャレットが在ること**が前提である(VCL は「ここは文字を入れる
         *   場所だ」と言うときだけ `SetInputContext` を呼ぶ)。
         * 🔑 **LO 自身の近道で分ける** ── `Ctrl+A`(すべて選択)は
         *   **本文にキャレットが在るときだけ**版面を大きく変える(選択の色が乗る)。
         *   ⚠ これも集合で採る(点滅するカーソルで誤判定しない)。
         * ⚠ **これが偽なら `accept0` は読めない** ── 健全なビルドでも
         *   キャレットが無ければ `accept0` を返す(#156 本文の「まだ言えないこと」)。
         */
        await page.keyboard.press('Control+a');
        await page.waitForTimeout(2500);
        result.ime.marks.selectedAll = await traceLen();
        const selFrames = await frames();
        result.ime.caretInBody = swapped(afterFrames, selFrames);
        result.ime.landed = swapped(beforeFrames, afterFrames);
        result.ime.frames = { before: beforeFrames?.length ?? null, after: afterFrames?.length ?? null };
      }
      result.ime.after = await page.evaluate(IME_DEEP);
      // 🔑 最後にまとめて読む(console の取りこぼしに左右されない本命の出口)
      result.ime.trace = await page.evaluate(IME_TRACE);
    } catch (e) {
      result.ime = { err: safeErr(e) };
    }
  }

  /**
   * 🔴 **打鍵が「その場で」版面に出るか**(#154 段①)。
   *
   * 実機は「打っている間は何も変わらず、`Escape` を押した瞬間に**いっぺんに**現れる」。
   * 🔑 だから 2 つを別々に測る ── **打った直後**に変わったか(`landedWhileTyping`)と、
   * **`Escape` の後**に変わったか(`revealedAfterEscape`)。
   *
   * | 読み方 | `landedWhileTyping` | `revealedAfterEscape` |
   * |---|---|---|
   * | 健全(その場で出る) | `true` | 何でもよい |
   * | 🔴 #154 の症状 | **`false`** | **`true`** |
   * | 打鍵が届いていない | `false` | `false` ← ⚠ **判定不能**(以降は読めない) |
   *
   * ⚠ **3 行目が要る。** これを分けないと「届いていない」を「描いていない」と読む
   * (2026-08-13 に、対照群を置かずに存在しない結論を書きかけたのと同じ型)。
   * ⚠ 入れ物だけ違う対(`.odt` / `.odp`)を**同じ腕で**回して初めて
   * 「Impress 固有」が言える ── 片方だけ回して結論を書かない。
   */
  if (REDRAW && result.opened) {
    try {
      const box = await canvasBox();
      result.redraw = { clicked: false };
      if (box) {
        const clip = { x: box.x, y: box.y, width: box.w, height: box.h };
        // ⚠ 版面の**中ほど**を押す(端は枠や定規に当たる)
        await page.mouse.click(box.x + box.w * 0.4, box.y + box.h * 0.35);
        result.redraw.clicked = true;
        await page.waitForTimeout(3000);
        const before = await framesOf(clip);
        // ⚠ 1 文字では足りない ── 見えていても気づけない。**目に見える量**を打つ
        await page.keyboard.type('HELLO 12345', { delay: 120 });
        await page.waitForTimeout(3000);
        const typed = await framesOf(clip);
        // 🔑 実機で「いっぺんに現れた」引き金と**同じ一手**(Escape)を打つ
        await page.keyboard.press('Escape');
        await page.waitForTimeout(2500);
        const escaped = await framesOf(clip);
        /**
         * 🔴 **陰の対照群 ── 何も打たない間は変わらないこと。**
         *
         * ⚠ これが無いと「変わった」が何も言っていない ── 版面が放っておいても
         * 変わるなら(点滅・再描画・時計)、上の 2 つは**時間が経った証拠**でしかない
         * (CLAUDE.md §4「観測点が放っておいても変わるなら、変化は届いた証拠にならない」)。
         * ⚠ `idleChanged` が `true` の回は、**この probe の結果を 1 つも読まない**。
         */
        await page.waitForTimeout(2500);
        const idle = await framesOf(clip);
        result.redraw.landedWhileTyping = swapped(before, typed);
        result.redraw.revealedAfterEscape = swapped(typed, escaped);
        result.redraw.idleChanged = swapped(escaped, idle);
        result.redraw.frames = {
          before: before?.length ?? null,
          typed: typed?.length ?? null,
          escaped: escaped?.length ?? null,
          idle: idle?.length ?? null,
        };
      }
    } catch (e) {
      result.redraw = { err: safeErr(e) };
    }
  }
  /**
   * 🔴 **詰まっている相手を「名前で」言う ── 全 worker の stack を 1 枚撮る**
   * (#199 の「次の一手 ②」、2026-08-24)。
   *
   * ⚠ **`PKC3_STACKS=1` を渡した回だけ**。既定の使い方を変えない。
   * 🔑 ここが要るのは、①(`PThread` の内訳)が**死んだ観測点**だったからである ──
   *   詰まった回と開いた回で **`running:2 / unused:14` が完全に同じ**だった
   *   (2026-08-24 実測。対照群つき)。数では言えないので、**中身**を見る。
   * ⚠ 名前が読めるのは `profiling_funcs: true` で焼いた一式だけ ── 素の一式では
   *   `$funcNNNN` になる。**それでも「止まっているか / どこに居るか」は分かる**ので、
   *   まず機構が通ることを確かめる。
   * 🔑 返り値で 3 つを見分ける:
   *     `{ workers: 0 }`      = worker が 1 つも見えない(機構が通っていない)
   *     `{ err: ... }`        = 撮ろうとして落ちた
   *     `{ frames: [...] }`   = 撮れた
   * ⚠ **1 本ずつ時限を切る** ── futex で寝ている worker は `Debugger.pause` に
   *   応じないことがある。応じない 1 本のために全部を失わない。
   */
  if (STACKS) {
    /**
     * ⚠ **Playwright は worker に CDP を張れない**(2026-08-24 実測:
     *   `browser.newCDPSession(worker)` は `expected Page or Frame` で断る)。
     * 🔑 だから **target 越しに送る** ── 頁の session から `Target.attachToTarget`
     *   して `sessionId` を貰い、`Target.sendMessageToTarget` で包んで渡す
     *   (返事は `Target.receivedMessageFromTarget` で戻る)。
     * ⚠ この 2 つは deprecated なので、**無ければ無いと書く**(黙って 0 件にしない)。
     */
    const shot = { workers: page.workers().length, stacks: [] };
    try {
      const cdp = await browser.newCDPSession(page);
      const waiters = new Map();
      let seq = 0;
      cdp.on('Target.receivedMessageFromTarget', (e) => {
        let msg;
        try { msg = JSON.parse(e.message); } catch { return; }
        const key = `${e.sessionId}:${msg.id}`;
        const w = waiters.get(key);
        if (w) { waiters.delete(key); w(msg); }
        if (msg.method === 'Debugger.paused') {
          const p = waiters.get(`${e.sessionId}:paused`);
          if (p) { waiters.delete(`${e.sessionId}:paused`); p(msg.params); }
        }
      });
      const call = (sessionId, method, params = {}) => {
        seq += 1;
        const id = seq;
        const done = new Promise((ok) => waiters.set(`${sessionId}:${id}`, ok));
        return cdp
          .send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
          .then(() => Promise.race([done, new Promise((ok) => setTimeout(() => ok(null), 4000))]));
      };
      const { targetInfos } = await cdp.send('Target.getTargets');
      const workers = targetInfos.filter((t) => t.type === 'worker' || t.type === 'shared_worker');
      shot.targets = workers.length;
      for (const [i, t] of workers.entries()) {
        const one = { i, type: t.type };
        try {
          const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: false });
          one.attached = true;
          await call(sessionId, 'Debugger.enable');
          const paused = new Promise((ok) => waiters.set(`${sessionId}:paused`, ok));
          await call(sessionId, 'Debugger.pause');
          const ev = await Promise.race([paused, new Promise((ok) => setTimeout(() => ok(null), 4000))]);
          // ⚠ **応じなかった回は `null`**(空配列にしない ── 「寝ている」と「枠が無い」は別)
          one.frames =
            ev === null
              ? null
              : (ev.callFrames ?? []).slice(0, 20).map((f) => ({
                  fn: String(f.functionName ?? '').slice(0, 80),
                  url: String(f.url ?? '').slice(-40),
                }));
          await call(sessionId, 'Debugger.resume');
          await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        } catch (e) {
          one.err = safeErr(e);
        }
        shot.stacks.push(one);
      }
      await cdp.detach().catch(() => {});
    } catch (e) {
      shot.err = safeErr(e);
    }
    result.stacks = shot;
  }

  // 🔑 **計装はまとめて最後に読む**(出口を 1 つにする ── 2026-08-10 の教訓)。
  //    ⚠ `null`(この焼きに計装が無い)と `[]`(在るが 1 行も出ていない)を混ぜない。
  result.idlesTrace = await page.evaluate(IDLES_TRACE).catch((e) => ({ err: String(e).slice(0, 80) }));

  if (SHOT) {
    try { await page.screenshot({ path: SHOT }); } catch { /* 固まっていたら撮れない */ }
  }
} catch (e) {
  result.error = safeErr(e);
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
