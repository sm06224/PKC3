/**
 * 🔴 **PKC から渡した文書を Ctrl+S で上書き保存できるか**(#205 / cowork レポート #13)。
 *
 * cowork 実機(2026-08-16)の報告:
 * - 添付を Office で開いて **Ctrl+S → 4/4 失敗**(「一般的な I/O エラー」)
 * - 一方、Office の中で**新規に作った文書**を `/home/web_user` へ保存 → **3/3 成功**
 *
 * ⚠ 生きた仮説が 2 つある。**どちらかを潰すまで原因を書かない**:
 *   (A) **書式**(docx の書き出しが通らない)
 *   (B) **こちらの FS hook**(#205 で `FS.close` / `FS.rename` を包んだ)が壊した
 *
 * 🔑 (B) は**自分が入れた退行**なので先に潰す ── だからこの probe は
 * **同じ一式・同じ文書・同じ操作**で、`armSaveWatch` の有無だけを変えて 2 回走る。
 * ⚠ 対照群は「古いビルド」ではなく「**この dist の hook だけ無効**」にする
 * (古いビルドを持ち出すと差が 2 つ以上になる ── 2026-08-16 に 1 度踏んだ)。
 *
 * ## 観測点(⚠ 「保存できた」を title で見ない ── 死んだ観測点である)
 *
 * 1. **`/work/<名前>` の size と mtime が動いたか**(FS を直接読む ── いちばん硬い)
 * 2. **窓が 1 枚増えたか**(エラーのダイアログ)。⚠ 数は相殺しうるので**題名も**採る
 * 3. **対照群として「効くはずの一手」を先に打つ** ── ただの文字入力。
 *    これが届いていない回は、Ctrl+S の判定は**全部無意味**である
 *
 * 🔴 **その「効くはずの一手」自体に、生きた観測点が要る**(2026-08-16、初稿で踏んだ)。
 * 初稿は文字を打った後も **`FS.stat` しか見ていなかった** ── 打っても file は書かれない
 * ので、**当たっても当たらなくても同じ結果**になる。両群が同一に見えたが、それは
 * 「差が無い」ではなく「**何も actuate していない**」だった(§4 の死んだ観測点)。
 *
 * 🔑 版面の**絵**を数枚ずつ採り、**集合ごと入れ替わったか**で見る ──
 * 点滅するカーソルが在るので 1 枚比べでは必ず「変わった」になる(2026-08-13 の教訓)。
 * 逆に**起動直後の集合が 1 種類しか無い**なら、カーソルが立っていない = 版面に
 * 入力位置が無い、と分かる(これも読める信号である)。
 *
 * 使い方:
 *   node build/office-wasm/save-existing-probe.mjs <pages 形式の pack> <文書> [出力.json] [秒]
 *   PKC3_NO_HOOK=1 を付けると **保存の見張りを積まない**(対照群)
 */
import { createServer } from 'node:http';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, extname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { chromium } from '@playwright/test';

const PACK = resolve(process.argv[2]);
const DOC = resolve(process.argv[3]);
const OUT = process.argv[4] ?? '';
const LIMIT_SEC = Number(process.argv[5] ?? 180);
const DIST = resolve(process.env.PKC3_DIST ?? 'dist');
const NO_HOOK = process.env.PKC3_NO_HOOK === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.metadata': 'application/json', '.gz': 'application/gzip',
  '.ttf': 'font/ttf', '.data': 'application/octet-stream',
};

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
      : join(DIST, p);
    readFile(f)
      .then((b) => {
        let body = b;
        // 🔴 **対照群: 見張りを積む 1 行だけを消す**(他は 1 バイトも変えない)
        if (NO_HOOK && p.endsWith('/office/host.html')) {
          const src = b.toString('utf-8');
          const marked = src.replace('armSaveWatch(FS, docToken);', '/* 対照群: 積まない */');
          if (marked === src) throw new Error('対照群の書き換えが当たらなかった');
          body = Buffer.from(marked, 'utf-8');
        }
        res.writeHead(200, { ...head, 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch((e) => {
        res.writeHead(p.endsWith('/office/host.html') && NO_HOOK ? 500 : 404, head);
        res.end(String(e));
      });
  });
  s.listen(0, '127.0.0.1', () => ok(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const NAME = basename(DOC);
const raw = await readFile(DOC);
const b64 = raw.toString('base64');
/**
 * 🔴 **渡された文書の名前を出さない**(CLAUDE.md「機密資料の取り扱い」1)。
 * ⚠ 禁じられるのは本文だけではない ── **題名も「類推させる材料」**である。
 * この probe は user から貰った実文書を引数に取る作りなので、名前を控えると
 * JSON と端末に落ちる。⚠ 観測点として要るのは**形式と大きさ**だけ。
 */
/**
 * 🔴 **`docOpened()` が実物で真になるか**(#199 の昇格判定、2026-08-23)。
 *
 * ⚠ `host.html` の `docOpened()` は「器の中に**渡した名前**と `LibreOffice` が
 *   両方出た」で判定する。⚠ **これが真になるところを一度も観測していない**まま
 *   user に見える文言を決めかけ、smoke を 2 件落とした。
 * 🔑 だから **host 経由**(= 製品と同じ道)で、**開く文書と開かない文書の対**で測る。
 *
 * 観測点は 2 つ:
 *   ① `#status` の字(user が実際に見るもの)
 *   ② `say('doc-open')` の診断(`docOpened()` が真になった証拠)
 *
 * ⚠ **対照群を先頭に置く** ── 開く文書(VML / odt)で真にならないなら、
 *   判定そのものが届いていないので、開かない文書の結果は読めない。
 */
const result = {
  hook: !NO_HOOK, docExt: extname(NAME), docBytes: raw.byteLength,
  steps: [], console: [],
};
const safeLine = (s) => (/[^\x20-\x7e]/.test(s) ? null : s.slice(0, 160));

/** ⚠ **使い終わったら消す**(機密資料の取り扱い 5:profile も痕跡である)。 */
const PROFILE = `${tmpdir()}/pkc3-docopen-${process.pid}`;
const browser = await chromium.launchPersistentContext(PROFILE, {
  headless: true, viewport: { width: 1280, height: 900 },
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  executablePath: '/opt/pw-browsers/chromium',
});
const page = await browser.newPage();
page.on('console', (m) => {
  const t = safeLine(`[${m.type()}] ${m.text()}`);
  if (t && result.console.length < 40) result.console.push(t);
});

/** FS を直接読む ── いちばん硬い観測点(title は死んでいる)。 */
const STAT = `(() => {
  const lo = window.__lo; const p = window.__loDocPath;
  if (!lo || !lo.FS || !p) return null;
  try { const s = lo.FS.stat(p); return { size: s.size, mtimeMs: +s.mtime }; }
  catch (e) { return { err: String(e).slice(0, 80) }; }
})()`;

/** 窓の題名 ── ⚠ **数ではなく個体**で見る(増減が相殺する。2026-08-14 の教訓)。 */
const WINDOWS = `(() => {
  const out = [];
  const walk = (n) => {
    for (const el of n.querySelectorAll('*')) {
      if (el.classList && el.classList.contains('qt-window')) {
        const t = el.querySelector('.title-bar .window-name, .title');
        out.push((t && t.textContent || '').slice(0, 60));
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return out;
})()`;

try {
  await page.goto(`${base}/office/host.html`, { waitUntil: 'domcontentloaded' });
  result.staged = await page.evaluate(async () => {
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

  await page.addInitScript(({ doc, name }) => {
    const ch = new globalThis.BroadcastChannel('pkc3-office');
    globalThis.__saved = [];
    ch.onmessage = (ev) => {
      const d = ev.data;
      if (!d || !d.pkc3Office) return;
      if (d.pkc3Office === 'saved') globalThis.__saved.push(d.payload);
      if (d.pkc3Office !== 'ready-for-document') return;
      const raw = globalThis.atob(doc);
      const u8 = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) u8[i] = raw.charCodeAt(i);
      ch.postMessage({ pkc3Office: 'document', payload: { name, bytes: u8, token: 'lid-PROBE' } });
    };
  }, { doc: b64, name: NAME });

  await page.goto(`${base}/office/host.html?await-doc=1&name=${encodeURIComponent(NAME)}`,
    { waitUntil: 'commit' });

  // 版面が描かれるまで待つ
  const t0 = Date.now();
  for (;;) {
    const painted = await page.evaluate(`(() => {
      const walk=(n)=>{for(const e of n.querySelectorAll('*')){if(e.tagName==='CANVAS'&&e.width>0)return true;if(e.shadowRoot&&walk(e.shadowRoot))return true;}return false;};
      return walk(document.getElementById('screen')||document.body);
    })()`).catch(() => false);
    if (painted) break;
    if ((Date.now() - t0) / 1000 > LIMIT_SEC) throw new Error('版面が出ない');
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(20000);   // LO が文書を組むのを待つ

  const canvas = await page.evaluate(`(() => {
    const walk=(n)=>{for(const e of n.querySelectorAll('*')){if(e.tagName==='CANVAS'){const r=e.getBoundingClientRect();if(r.width>100)return {x:r.x,y:r.y,w:r.width,h:r.height};}if(e.shadowRoot){const f=walk(e.shadowRoot);if(f)return f;}}return null;};
    return walk(document.getElementById('screen')||document.body);
  })()`);
  if (!canvas) throw new Error('版面が見つからない');

  /**
   * 🔴 **題名も名前も外へ出さない**(機密資料の取り扱い 1。2 巡目レビューで判明)。
   *
   * ⚠ 最上位の `doc` を消しただけでは**塞がっていなかった** ── 保存の放送 payload
   * (`{ key, name, size }`)の `name` は**文書名そのもの**であり、`__saved` に丸ごと
   * 積んで JSON と端末へ出していた。⚠ `safeLine`(非 ASCII を捨てる)は **console
   * にしか掛かっておらず**、しかも ASCII の名前は素通りする。
   * 🔑 観測点として要るのは**個体の弁別**だけなので、鍵と大きさ・題名の長さで足りる。
   */
  const snap = async (at) => ({
    at,
    stat: await page.evaluate(STAT),
    windows: (await page.evaluate(WINDOWS)).map((t) => t.length),
    saved: (await page.evaluate('globalThis.__saved || []'))
      .map((s) => ({ key: s.key, size: s.size })),
  });
  result.steps.push(await snap('起動直後'));

  /**
   * 🔴 **この probe は文書に手を触れない**(2026-08-23)。
   * ⚠ 元にした `save-existing-probe.mjs` は打鍵で「一手が届いたか」を見るので
   *   版面の絵を撮っていたが、ここが問うのは **`docOpened()` が真になるか**
   *   だけである ── 打つと文書が変わるうえ、要らない撮影の口が残る。
   * 🔑 **要らない口は塞ぐのではなく、持たない**(機密資料の取り扱い 6)。
   */
  /**
   * 🔑 host の `say()` は **BroadcastChannel `pkc3-office`** へ流れる
   *   (`host.html:103-106`)── 同じ page で購読して積む。
   * ⚠ **購読を張るのは遅い**(既に起動しているので `painted` は取り逃す)が、
   *   知りたいのは `doc-open` が**来るかどうか**なので足りる。
   */
  await page.evaluate(() => {
    globalThis.__says = [];
    const ch = new BroadcastChannel('pkc3-office');
    ch.onmessage = (e) => {
      const d = e.data;
      if (d && typeof d.pkc3Office === 'string') globalThis.__says.push(d.pkc3Office);
    };
  });
  result.status = [];
  for (let i = 0; i < 14; i += 1) {
    result.status.push({
      atSec: Math.round((Date.now() - t0) / 1000),
      text: await page.evaluate(() => document.getElementById('status')?.textContent ?? null),
      says: await page.evaluate(() => [...new Set(globalThis.__says ?? [])].join(',')),
    });
    if (result.status[result.status.length - 1].says.includes('doc-open')) break;
    await page.waitForTimeout(3000);
  }
  /**
   * 🔴 **偽の false と、届いていない false を分ける**(CLAUDE.md §4)。
   * ⚠ `docOpenSeen: false` だけでは「文書が開かなかった」のか
   *   「`docOpened()` が器に届いていない」のか読めない ── 器の字を**そのまま**採る。
   */
  result.screen = await page.evaluate((leaf) => {
    const root = document.getElementById('screen');
    let text = '';
    (function walk(n) {
      const els = n.querySelectorAll('*');
      for (let i = 0; i < els.length; i += 1) {
        const el = els[i];
        text += ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '');
        if (el.children.length === 0) text += ' ' + (el.textContent || '');
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    })(root);
    const flat = text.replace(/\s+/g, ' ').trim();
    return {
      chars: flat.length,
      hasLibreOffice: /LibreOffice/i.test(flat),
      hasLeaf: flat.indexOf(leaf) >= 0,
      leaf,
      sample: flat.slice(0, 600),
    };
  }, NAME.replace(/[/\\]/g, '_'));
  result.docOpenSeen = result.status.some((s) => s.says.includes('doc-open'));
  result.finalStatus = result.status[result.status.length - 1]?.text ?? null;
} catch (e) {
  result.error = String(e).slice(0, 300);
}
const json = JSON.stringify(result, null, 2);
// ⚠ 出力先を渡されたら**必ず書く** ── 渡しても書かない口があると、
//    「file が無い = 落ちた」と読んで 1 回転捨てる(2026-08-23 に実際に捨てた)
if (OUT !== '') await writeFile(OUT, json);
console.log(json);
await browser.close();
/**
 * 🔴 **使い終わったら痕跡ごと廃棄する**(機密資料の取り扱い 5)。
 * ⚠ persistent profile には**開いた文書の残骸**が残る ── 消さないと
 *   `/tmp` に置きっぱなしになる。
 */
await rm(PROFILE, { recursive: true, force: true }).catch(() => {});
process.exitCode = result.error ? 1 : 0;
