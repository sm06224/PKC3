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
import { readFile, writeFile } from 'node:fs/promises';
import { join, extname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
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
const b64 = (await readFile(DOC)).toString('base64');
const result = { hook: !NO_HOOK, doc: NAME, steps: [], console: [] };
const safeLine = (s) => (/[^\x20-\x7e]/.test(s) ? null : s.slice(0, 160));

const browser = await chromium.launchPersistentContext(`${tmpdir()}/pkc3-save-${process.pid}`, {
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
   * 版面の絵を **n 枚**採り、**別々の見た目が何種類あったか**を返す。
   * ⚠ 1 枚ずつ比べない ── 点滅するカーソルだけで「変わった」になる(2026-08-13)。
   */
  const clip = { x: canvas.x, y: canvas.y, width: canvas.w, height: canvas.h };
  const frames = async (n = 5) => {
    const set = new Set();
    for (let i = 0; i < n; i += 1) {
      const png = await page.screenshot({ clip });
      set.add(createHash('sha256').update(png).digest('hex').slice(0, 16));
      await page.waitForTimeout(400);
    }
    return [...set];
  };

  const snap = async (at) => ({
    at, stat: await page.evaluate(STAT), windows: await page.evaluate(WINDOWS),
    saved: await page.evaluate('globalThis.__saved || []'),
  });
  result.steps.push(await snap('起動直後'));

  // 🔴 **対照群の一手** ── これが届いていない回は以降が無意味。
  //    ⚠ 「届いた」は **file** ではなく**版面の絵の集合**で見る(打っても file は書かれない)
  await page.mouse.click(canvas.x + canvas.w * 0.4, canvas.y + canvas.h * 0.35);
  await page.waitForTimeout(2500);
  const before = await frames();
  await page.keyboard.type('probe', { delay: 120 });
  await page.waitForTimeout(4000);
  const afterType = await frames();
  // ⚠ **集合ごと入れ替わった**ときだけ「届いた」と言う(重なりが 1 つでもあれば怪しい)
  const turned = (a, b) => b.every((h) => !a.includes(h));
  result.actuators = [{
    how: '文字入力', caretBlinks: before.length > 1,
    landed: turned(before, afterType), before, after: afterType,
  }];
  result.steps.push(await snap('文字を打った'));

  // ⚠ 文字が届かないなら、**別の一手**を試す ── 全選択 + 太字(属性だけ動かす)。
  //    2026-08-14 の実機では Cmd+A / Cmd+B が効いていたので、鍵盤の近道は届きうる
  let last = afterType;
  if (!result.actuators[0].landed) {
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(1500);
    await page.keyboard.press('Control+b');
    await page.waitForTimeout(4000);
    const afterBold = await frames();
    result.actuators.push({
      how: '全選択+太字', landed: turned(afterType, afterBold),
      before: afterType, after: afterBold,
    });
    last = afterBold;
    result.steps.push(await snap('全選択+太字'));
  }
  result.actuated = result.actuators.some((a) => a.landed);

  // 本命: Ctrl+S(既存 path への上書き ── ダイアログは出ないはず)
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(12000);
  result.steps.push(await snap('Ctrl+S の 12 秒後'));
  result.afterSaveFrames = await frames();
  // ⚠ 版面が動いたか(書式を訊く小窓が出ると絵が変わる)。窓一覧と突き合わせる
  result.saveChangedScreen = turned(last, result.afterSaveFrames);
  await page.waitForTimeout(13000);
  result.steps.push(await snap('Ctrl+S の 27 秒後'));
} catch (e) {
  result.error = String(e).slice(0, 300);
}

await browser.close().catch(() => {});
server.close();
const text = JSON.stringify(result, null, 1);
if (OUT) await writeFile(OUT, text);
console.log(text);
