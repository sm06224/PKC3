/**
 * LibreOffice wasm の**日本語組版**を確かめる(#88、2026-08-10)。
 *
 * 🔴 「表示できた」と「**組版が正しい**」は別である(§3.11 の残件)。
 * §3.11 で証明したのは「豆腐にならない」ことだけ ── 縦書き・ルビ・禁則・圏点・
 * 縦中横が正しいかは 1 つも見ていない。user 指示「**日本語は絶対**」に照らすと、
 * そこを見ないまま「日本語は出ました」と言い続けるのは主張の水増しである。
 *
 * ## 何を 1 つ主張するか
 *
 * **「日本語の組版機能が版面に効いているか」** ── 速度も常駐も主張しない
 * (それは `steady-probe.mjs` の仕事)。1 script = 1 主張。
 *
 * ## 🔴 判定は目で見る(自動判定を作らない)
 *
 * 組版の正しさは canvas の中に在り、DOM からは 1 文字も読めない。
 * ⚠ ここで「それらしい自動判定」をでっち上げると、**通っても何も保証しない検査**に
 *   なる(CLAUDE.md「検査の『主張そのもの』が間違っていることがある」)。
 * したがってこの probe が機械で保証するのは **2 つだけ**:
 *   ① 版面が実際に描かれたこと(shadow root を越えた canvas)
 *   ② 題材が**素通りしていない**こと ── 縦書き・ルビ・禁則の各 fixture を
 *      **1 面ずつ別々に**描き、面ごとに画素が違うことを確かめる
 *      (全部同じ絵なら、その指定は 1 つも効いていない)
 * 正しさそのものの判定は **screenshot を人が見る**。probe の役割は
 * 「見るに足る材料を、取りこぼしなく揃える」ことである。
 *
 * 使い方: node ja-typography-probe.mjs <配信ディレクトリ> [--fonts <TTF のディレクトリ>]
 */
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, extname, resolve, basename } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(process.argv[2] ?? '.');
const fontsIdx = process.argv.indexOf('--fonts');
const FONT_DIR = fontsIdx > 0 ? resolve(process.argv[fontsIdx + 1]) : '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.metadata': 'application/json',
  '.data': 'application/octet-stream',
};

const NS = `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
 xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"`;

/** 面ごとに違う組版指定を当てる ── 同じ絵になったら、その指定は効いていない。 */
const CASES = [
  {
    key: 'yoko-kinsoku',
    title: '横書き + 禁則',
    // わざと行末に閉じ括弧・句読点が来る幅に追い込む
    styles: `<style:style style:name="P" style:family="paragraph">
     <style:text-properties style:language-asian="ja" style:country-asian="JP"
       style:font-name-asian="BIZ UDMincho" fo:font-size="16pt" style:font-size-asian="16pt"/>
    </style:style>`,
    page: '',
    body: Array.from({ length: 24 }, (_, i) =>
      `<text:p text:style-name="P">${i + 1}. 禁則処理の確認である。句読点、や「かぎ括弧」や『二重括弧』`
      + `や(丸括弧)が行頭・行末で正しく処理されるか。長音ー・促音っ・小書きゃゅょも同様に見る。</text:p>`).join(''),
  },
  {
    key: 'tate',
    title: '縦書き',
    styles: `<style:style style:name="P" style:family="paragraph">
     <style:text-properties style:language-asian="ja" style:country-asian="JP"
       style:font-name-asian="BIZ UDMincho" fo:font-size="16pt" style:font-size-asian="16pt"/>
    </style:style>`,
    // 版面ごと縦組みにする(page layout の writing-mode)
    page: 'style:writing-mode="tb-rl"',
    body: Array.from({ length: 12 }, (_, i) =>
      `<text:p text:style-name="P">${i + 1}. 縦書きの確認である。行は右から左へ進む。`
      + `句読点、や「かぎ括弧」の向き、長音ー、そして算用数字 2026 年の扱いを見る。</text:p>`).join(''),
  },
  {
    key: 'ruby-kenten',
    title: 'ルビ + 圏点 + 縦中横',
    styles: `<style:style style:name="P" style:family="paragraph">
     <style:text-properties style:language-asian="ja" style:country-asian="JP"
       style:font-name-asian="BIZ UDMincho" fo:font-size="18pt" style:font-size-asian="18pt"/>
    </style:style>
    <style:style style:name="R" style:family="ruby">
     <style:ruby-properties style:ruby-align="distribute-letter" style:ruby-position="above"/>
    </style:style>
    <style:style style:name="RT" style:family="text">
     <style:text-properties fo:font-size="9pt" style:font-size-asian="9pt"/>
    </style:style>
    <style:style style:name="KT" style:family="text">
     <style:text-properties style:text-emphasize="dot above"/>
    </style:style>`,
    page: '',
    body: `<text:p text:style-name="P">ルビ: `
      + `<text:ruby text:style-name="R"><text:ruby-base>吾輩</text:ruby-base>`
      + `<text:ruby-text text:style-name="RT">わがはい</text:ruby-text></text:ruby>は`
      + `<text:ruby text:style-name="R"><text:ruby-base>猫</text:ruby-base>`
      + `<text:ruby-text text:style-name="RT">ねこ</text:ruby-text></text:ruby>である。</text:p>`
      + `<text:p text:style-name="P">圏点: これは<text:span text:style-name="KT">とても大事</text:span>な行である。</text:p>`
      + `<text:p text:style-name="P">熟語ルビ: `
      + `<text:ruby text:style-name="R"><text:ruby-base>東京特許許可局</text:ruby-base>`
      + `<text:ruby-text text:style-name="RT">とうきょうとっきょきょかきょく</text:ruby-text></text:ruby>。</text:p>`
      + `<text:p text:style-name="P">記号と約物: ①②③ ㈱ ℡ ／ 〜 … ‥ 〈〉《》【】〔〕。</text:p>`
      + `<text:p text:style-name="P">半角ｶﾅ / 全角ＡＢＣ１２３ / 混植 abc 123 と日本語。</text:p>`,
  },
];

const fodt = (c) => `<?xml version="1.0" encoding="UTF-8"?>
<office:document ${NS} office:version="1.3"
 office:mimetype="application/vnd.oasis.opendocument.text">
 <office:automatic-styles>
  ${c.styles}
  <style:page-layout style:name="PL">
   <style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm"
     fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"
     ${c.page}/>
  </style:page-layout>
 </office:automatic-styles>
 <office:master-styles>
  <style:master-page style:name="Standard" style:page-layout-name="PL"/>
 </office:master-styles>
 <office:body><office:text>${c.body}</office:text></office:body>
</office:document>`;

const DEEP_CANVAS_FN = `(root) => {
  const out = [];
  const walk = (node) => {
    for (const el of node.querySelectorAll('*')) {
      if (el.tagName === 'CANVAS') out.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  if (root) walk(root);
  return out;
}`;

const HARNESS = (fontNames) => `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>ja typography</title><style>html,body{padding:0;margin:0;overflow:hidden;height:100%}
#screen{width:100%;height:100%}</style></head><body onload="init()">
<figure id="qtspinner"><div id="qtstatus"></div></figure><div id="screen"></div>
<script>
async function init(){
  const spinner=document.querySelector('#qtspinner'), screen=document.querySelector('#screen');
  const show=(ui)=>{[spinner,screen].forEach(e=>e.style.display='none'); ui.style.display='block';};
  const key = new URLSearchParams(location.search).get('case');
  const doc = new Uint8Array(await (await fetch('/__case/'+key)).arrayBuffer());
  const fonts = [];
  for (const n of ${JSON.stringify(fontNames)})
    fonts.push([n, new Uint8Array(await (await fetch('/__font/'+n)).arrayBuffer())]);
  try {
    show(spinner);
    // 🔑 main は自分で呼ぶ(preRun では /instdir がまだ見えない)
    const inst = globalThis.__lo = await qtLoad({ noInitialRun: true,
      qt:{ onLoaded:()=>show(screen), entryFunction: globalThis.soffice_entry,
           containerElements:[screen] } });
    const FS = inst.FS;
    try { FS.mkdir('/work'); } catch(e) {}
    FS.writeFile('/work/case.fodt', doc);
    for (const [n,b] of fonts) FS.writeFile('/instdir/share/fonts/truetype/'+n, b);
    inst.callMain(['/work/case.fodt']);
  } catch(e) { console.error(e); globalThis.__bootError = String(e && e.stack || e).slice(0,400); }
}
</script><script src="soffice.js"></script><script src="qtloader.js"></script></body></html>`;

function serve(fontFiles) {
  return new Promise((ok) => {
    const s = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      const head = {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-store',
      };
      const send = (type, body) => { res.writeHead(200, { ...head, 'Content-Type': type }); res.end(body); };
      if (path === '/__harness') return send('text/html; charset=utf-8', HARNESS(fontFiles.map((f) => basename(f))));
      if (path.startsWith('/__case/')) {
        const c = CASES.find((x) => x.key === path.slice('/__case/'.length));
        if (!c) { res.writeHead(404, head); return res.end(); }
        return send('application/xml', fodt(c));
      }
      if (path.startsWith('/__font/')) {
        const f = fontFiles.find((x) => basename(x) === path.slice('/__font/'.length));
        if (!f) { res.writeHead(404, head); return res.end(); }
        return send('font/ttf', readFileSync(f));
      }
      readFile(join(ROOT, path))
        .then((buf) => send(MIME[extname(path)] ?? 'application/octet-stream', buf))
        .catch(() => { res.writeHead(path === '/favicon.ico' ? 204 : 404, head); res.end(); });
    });
    s.listen(0, '127.0.0.1', () => ok(s));
  });
}

async function main() {
  const fontFiles = FONT_DIR
    ? readdirSync(FONT_DIR).filter((f) => f.toLowerCase().endsWith('.ttf')).map((f) => join(FONT_DIR, f))
    : [];
  if (fontFiles.length === 0) {
    console.error('ERROR: --fonts を渡していない。CJK 無しでは組版を見る意味が無い(全部豆腐になる)');
    process.exitCode = 1;
    return;
  }
  const server = await serve(fontFiles);
  const base = `http://127.0.0.1:${server.address().port}`;
  const bundled = process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium';
  const results = [];
  const shots = new Map();

  for (const c of CASES) {
    const browser = await chromium.launchPersistentContext(`/tmp/pkc3-jatypo-${c.key}`, {
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      viewport: { width: 1280, height: 900 },
      ...(existsSync(bundled) ? { executablePath: bundled } : {}),
    });
    const page = await browser.newPage();
    await page.goto(`${base}/__harness?case=${c.key}`, { waitUntil: 'commit' });
    const painted = await page.waitForFunction((fn) => {
      for (const cv of eval(fn)(document.querySelector('#screen'))) {
        const r = cv.getBoundingClientRect();
        if (cv.width > 0 && r.width > 0) return true;
      }
      return globalThis.__bootError ? 'error' : false;
    }, DEEP_CANVAS_FN, { timeout: 240_000, polling: 500 })
      .then((h) => h.jsonValue()).catch((e) => `timeout ${String(e).slice(0, 70)}`);
    // 版面が組み上がるまで待つ
    await page.waitForTimeout(15_000);
    const file = join(ROOT, `ja-typo-${c.key}.png`);
    await page.screenshot({ path: file });
    shots.set(c.key, await page.screenshot());
    results.push({ key: c.key, title: c.title, painted, file });
    await browser.close();
  }
  server.close();

  // 🔴 空振り対策 ── **面ごとに絵が違う**ことを確かめる。全部同じなら、
  //    組版指定が 1 つも効いておらず「同じ既定の版面を 3 回撮った」だけである。
  const keys = [...shots.keys()];
  const identical = [];
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      if (Buffer.compare(shots.get(keys[i]), shots.get(keys[j])) === 0) identical.push([keys[i], keys[j]]);
    }
  }
  const ok = results.every((r) => r.painted === true) && identical.length === 0;
  console.log(JSON.stringify({
    ok,
    results,
    identicalPairs: identical,
    // 🔑 これは「描けた」までしか言わない。**正しさは screenshot を人が見る**
    note: 'painted と「面ごとに絵が違う」までが機械の保証。組版の正否は screenshot を目で見て判定する',
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

await main();
