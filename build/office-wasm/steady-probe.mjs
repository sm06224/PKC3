/**
 * LibreOffice wasm の **定常**を測る(#88、2026-08-10)。
 *
 * 🔴 不可侵指示(user 2026-07-27)「**boot 直後とか測ってない?意味ないからね、ソレ**」──
 * `boot-probe.mjs` が出す +636MB は **Start Center を出しただけ**の値であって、
 * 「継続使用でどうなるか」を 1 文字も語っていない。この probe はその穴を埋める。
 *
 * ## 何を 1 つ主張するか
 *
 * **「編集を続けたときに、常駐メモリと応答がどう推移するか」** ── これだけ。
 * ビルドの可否も起動の可否も主張しない(それは `boot-probe.mjs` の仕事)。
 * 🔑 1 script = 1 主張(user 指示 2026-08-10「回すものの粒度」)。
 *
 * ## 対照群
 *
 * ⚠ 「何もしない」ではなく「**測りたい操作以外を全部同じにしたもの**」(計測規律)。
 * したがって対照群は *空ページ* ではなく **同じ LibreOffice を同じ時間だけ開いたまま
 * 放置したもの**(`idle`)である ── これと `edit` の差だけが「編集の代金」。
 * ブラウザ自体の常駐は、両方の arm で同条件の空ページから引く。
 *
 * ## 🔴 空振り対策(これが無いと idle を 2 回測って「編集は軽い」と言ってしまう)
 *
 * キー入力が Qt に届いていなければ、`edit` は `idle` と同じものになる。
 * **届いたことを独立に確かめる**:
 *   ① 打鍵の前後で screenshot の bytes が変わること(変わらなければ NOT-APPLIED として落とす)
 *   ② Event Timing API が `keydown` を 1 件以上観測していること
 * ⚠ ①だけでは足りない(カーソル点滅でも bytes は変わる)。②だけでも足りない
 *   (event は届いたがアプリが無視した可能性が残る)。**両方**を要求する。
 *
 * ## 観測点
 *
 * - **常駐**: proc の status に在る VmRSS 合計を、この起動だけの `user-data-dir` で絞る
 *   (⚠ ここに proc のワイルドカード表記を書くと、その 2 文字がブロックコメントを閉じる)
 *   (`boot-probe.mjs` と同じ理由 ── 同じ箱の他の chrome を巻き込まない)
 * - **応答**: Event Timing API(`PerformanceObserver({type:'event'})`)の
 *   `duration` = 入力から次の描画までの実測。⚠ long task だけでは「入力が待たされたか」は
 *   分からないので両方録る
 *
 * 使い方:
 *   node steady-probe.mjs <配信ディレクトリ> [出力 JSON] [--fonts <TTF のディレクトリ>]
 *   PKC3_STEADY_MS=300000 で 1 arm あたりの時間を変える(既定 5 分)
 */
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, extname, resolve, basename } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(process.argv[2] ?? '.');
const OUT = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
const fontsIdx = process.argv.indexOf('--fonts');
const FONT_DIR = fontsIdx > 0 ? resolve(process.argv[fontsIdx + 1]) : '';
const ARM_MS = Number(process.env.PKC3_STEADY_MS ?? 300_000);
const SAMPLE_MS = 15_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.metadata': 'application/json',
  '.data': 'application/octet-stream',
};

/**
 * 🔴 **日本語の「入力」は測れない**(2026-08-10 に判明)。Playwright の
 * `keyboard.type()` も `keyboard.insertText()` も **非 ASCII が Qt に届かない** ──
 * 5 分回した本文が `Steady` だけ・言語欄が English (USA) になっていた。
 * 保存側は健全である(`bytes 38287 / ascii 82 / cjk 0` で切り分け済み)。
 * ⚠ 空振り検査①②(画面が変わった / key イベントが在る)は **ASCII だけでも通る**ので、
 *   「日本語で測った」と誤って言えてしまう。だから③(保存物に日本語が在る)を足した。
 *
 * 🔑 そこで、測る日本語の次元を**入力から組版へ**振り替える ── #88 の裁定は
 * 「**閲覧優先**で実装」なので、効くのは打鍵ではなく**日本語 20 ページを送ったときの
 * 組版・整形・描画**である。fixture を長い日本語本文にして、スクロールで回す。
 * ⚠ 日本語入力の応答は**未検証のまま残る**(Qt の IME 経路が要る)。測っていない次元を
 *   「軽かった」と言わないこと。
 */
const JA_PARA = [
  '定常計測用の本文です。編集セッションを継続したときの常駐メモリと操作の応答を測ります。',
  '吾輩は猫である。名前はまだ無い。どこで生れたか頓と見当がつかぬ。',
  '春はあけぼの。やうやう白くなりゆく山際、少し明かりて、紫だちたる雲の細くたなびきたる。',
  '東京都渋谷区・株式会社・令和七年八月十日。半角ｶﾅ ／ 全角ＡＢＣ ／ 記号 ①②③ ㈱ ℡。',
  '禁則処理の確認、句読点は行頭に来ない。括弧「かぎ」『二重』(丸) も同様である。',
];
/** 日本語主体の flat ODF。⚠ CJK が 0 文字だと「日本語での定常」を測っていない。 */
const DOC_BODY = Array.from({ length: 400 }, (_, i) =>
  `  <text:p text:style-name="P">${i + 1}. ${JA_PARA[i % JA_PARA.length]}</text:p>`).join('\n');
const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
 office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
 <office:automatic-styles>
  <style:style style:name="P" style:family="paragraph">
   <style:text-properties style:language-asian="ja" style:country-asian="JP"
     fo:font-size="12pt" style:font-size-asian="12pt"/>
  </style:style>
 </office:automatic-styles>
 <office:body><office:text>
${DOC_BODY}
 </office:text></office:body>
</office:document>`;

/** shadow root を越えて canvas を数える(Qt 6 の面は shadowRoot の中に在る)。 */
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
<title>steady</title><style>html,body{padding:0;margin:0;overflow:hidden;height:100%}
#screen{width:100%;height:100%}</style></head><body onload="init()">
<figure id="qtspinner"><div id="qtstatus"></div></figure><div id="screen"></div>
<script>
// 🔴 **boot 窓を定常に混ぜない**(不可侵指示「boot 直後とか測ってない?意味ないからね」)。
//    buffered:true は起動中の long task(wasm のコンパイル = 秒オーダー)まで拾うので、
//    **startTime を必ず一緒に持ち**、計測窓の開始時刻で後から切り分ける。
//    ⚠ 合計値だけ持つと切り分けられない ── 捨てられる形で記録してはいけない。
globalThis.__perf = { longTasks: [], events: [], windowStart: null };
new PerformanceObserver((l) => { for (const e of l.getEntries())
  globalThis.__perf.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); })
  .observe({ type: 'longtask', buffered: true });
// ⚠ Event Timing の durationThreshold は仕様下限が 16ms。**16ms 未満の入力は観測されない**
//    ので、出す数字は必ず「16ms 以上の入力のうち」と断る(全入力の p50 ではない)。
new PerformanceObserver((l) => { for (const e of l.getEntries())
  globalThis.__perf.events.push([e.name, Math.round(e.startTime), Math.round(e.duration)]); })
  .observe({ type: 'event', buffered: true, durationThreshold: 16 });
async function init(){
  const spinner=document.querySelector('#qtspinner'), screen=document.querySelector('#screen');
  const show=(ui)=>{[spinner,screen].forEach(e=>e.style.display='none'); ui.style.display='block';};
  const doc = new Uint8Array(await (await fetch('/__doc.fodt')).arrayBuffer());
  const fonts = [];
  for (const n of ${JSON.stringify(fontNames)})
    fonts.push([n, new Uint8Array(await (await fetch('/__font/'+n)).arrayBuffer())]);
  try {
    show(spinner);
    // 🔑 noInitialRun にして main を自分で呼ぶ ── runtime が完全に立ち上がったあとに
    //    FS を触れる(preRun 経路は /instdir がまだ見えず ENOENT で落ちる)
    const inst = globalThis.__lo = await qtLoad({ noInitialRun: true,
      qt:{ onLoaded:()=>show(screen), entryFunction: globalThis.soffice_entry,
           containerElements:[screen] } });
    const FS = inst.FS;
    try { FS.mkdir('/work'); } catch(e) {}
    FS.writeFile('/work/steady.fodt', doc);
    for (const [n,b] of fonts) FS.writeFile('/instdir/share/fonts/truetype/'+n, b);
    globalThis.__fontsInjected = fonts.length;
    inst.callMain(['/work/steady.fodt']);
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
      if (path === '/__blank') return send('text/html; charset=utf-8', '<!doctype html><title>b</title>');
      if (path === '/__harness') return send('text/html; charset=utf-8', HARNESS(fontFiles.map((f) => basename(f))));
      if (path === '/__doc.fodt') return send('application/xml', DOC);
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

function browserRssKb(tag) {
  let total = 0;
  let procs = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let cmd;
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf-8'); } catch { continue; }
    if (!cmd.includes(tag)) continue;
    try {
      const m = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf-8'));
      if (m) { total += Number(m[1]); procs += 1; }
    } catch { /* 消えたプロセスは数えない */ }
  }
  return { rssKb: total, procs };
}

/**
 * 2 枚の PNG の**異なる画素の割合**。screenshot の bytes 比較では
 * 「キャレットが点滅しただけ」と「版面が丸ごと入れ替わった」を区別できない。
 * ⚠ 復号は page 側でやる(この箱に画像ライブラリが無い)。
 */
async function pixelDiffRatio(page, a, b) {
  return page.evaluate(async ([ba, bb]) => {
    const toBmp = async (arr) =>
      globalThis.createImageBitmap(new Blob([new Uint8Array(arr)], { type: 'image/png' }));
    const [ia, ib] = await Promise.all([toBmp(ba), toBmp(bb)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return 1;
    const px = (bmp) => {
      const c = new globalThis.OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, bmp.width, bmp.height).data;
    };
    const pa = px(ia);
    const pb = px(ib);
    let diff = 0;
    for (let i = 0; i < pa.length; i += 4) if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2]) diff += 1;
    return Math.round((diff / (pa.length / 4)) * 1000) / 1000;
  }, [Array.from(a), Array.from(b)]).catch(() => null);
}

const pct = (xs, p) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))] : null);

/**
 * 1 arm を回す。`edit === false` なら同じ時間だけ**開いたまま放置**する(対照群)。
 * ⚠ 2 つの arm は「打鍵するかどうか」以外を**完全に同じ**にする ── 起動も、
 *   文書も、待ち時間も、標本の刻みも同じ。
 */
async function runArm({ base, edit }) {
  const tag = `/tmp/pkc3-steady-${edit ? 'edit' : 'idle'}-${process.pid}`;
  const bundled = process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium';
  const browser = await chromium.launchPersistentContext(tag, {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    viewport: { width: 1280, height: 800 },
    ...(existsSync(bundled) ? { executablePath: bundled } : {}),
  });
  const arm = { arm: edit ? 'edit' : 'idle', samples: [], consoleErrors: [] };
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') arm.consoleErrors.push(m.text().slice(0, 160)); });

  await page.goto(`${base}/__blank`, { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  arm.baselineRssKb = browserRssKb(tag).rssKb;

  await page.goto(`${base}/__harness`, { waitUntil: 'commit' });
  const painted = await page.waitForFunction((fn) => {
    for (const c of eval(fn)(document.querySelector('#screen'))) {
      const r = c.getBoundingClientRect();
      if (c.width > 0 && r.width > 0) return true;
    }
    return globalThis.__bootError ? 'error' : false;
  }, DEEP_CANVAS_FN, { timeout: 300_000, polling: 500 })
    .then((h) => h.jsonValue()).catch((e) => `timeout ${String(e).slice(0, 80)}`);
  arm.painted = painted;
  arm.fontsInjected = await page.evaluate(() => globalThis.__fontsInjected ?? 0).catch(() => null);
  if (painted !== true) { await browser.close(); return arm; }

  // 文書が組み上がるのを待ってから「開いた直後」を測る
  await page.waitForTimeout(15_000);
  arm.afterOpenRssKb = browserRssKb(tag).rssKb;
  const shotBefore = await page.screenshot();

  // 本文のあたりをクリックしてキャレットを置く(canvas は shadow root の中なので座標で押す)
  const box = { x: 500, y: 300 };
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(1000);

  // 計測窓の開始を page 内の時間軸(performance.now)で刻む ── long task / event の
  // startTime と同じ物差しでないと切り分けられない
  await page.evaluate(() => { globalThis.__perf.windowStart = performance.now(); });

  const t0 = Date.now();
  let strokes = 0;
  let nextSample = SAMPLE_MS;
  while (Date.now() - t0 < ARM_MS) {
    if (edit) {
      // 日本語 400 段落を送り続ける = 組版・整形・描画を回し続ける(閲覧優先の定常)
      await page.keyboard.press('PageDown');
      await page.mouse.wheel(0, 600);
      strokes += 1;
      // 打鍵も混ぜる ── 編集の代金も同じ arm で拾う。⚠ ASCII しか届かないので
      //    「日本語入力の応答」は**この数字に含まれていない**
      if (strokes % 4 === 0) await page.keyboard.type('steady ');
      // 端まで行ったら先頭へ戻す(同じ版面を舐め続けないよう、往復させる)
      if (strokes % 40 === 0) await page.keyboard.press('Control+Home');
    }
    await page.waitForTimeout(edit ? 500 : 1000);
    // ⚠ 剰余で刻むと、1 周の長さが変わる arm(打鍵あり)で標本数がずれる ──
    //    「次に取る時刻」を持って、**両 arm で同じ刻み**を保証する
    if (Date.now() - t0 >= nextSample) {
      nextSample += SAMPLE_MS;
      const perf = await page.evaluate(() => {
        const w = globalThis.__perf.windowStart ?? 0;
        const lt = globalThis.__perf.longTasks.filter(([s]) => s >= w);
        return { longTasks: lt.length, longTaskMs: lt.reduce((a, [, d]) => a + d, 0) };
      }).catch(() => null);
      arm.samples.push({ atMs: Date.now() - t0, rssKb: browserRssKb(tag).rssKb, strokes, ...perf });
    }
  }

  arm.strokes = strokes;
  arm.endRssKb = browserRssKb(tag).rssKb;
  const shotAfter = await page.screenshot();

  // 🔴 空振り対策 ③ ── **版面が本当に動いたか**を画素で確かめる。
  //    ⚠ ①(bytes が変わった)はキャレットの点滅でも通る。②(key イベント)は
  //      「押した」ことしか言わない ── **dead click でも通る**。
  //    ⚠ 以前ここは「保存物に日本語が在るか」だったが、fixture 自身が日本語 400 段落に
  //      なった時点で**fixture が検査を満たしてしまう**(救い手が変わっただけ)。
  //      主張が「送って組み直させた」に変わったので、検査も版面の変化に変える。
  arm.pixelDiffRatio = await pixelDiffRatio(page, shotBefore, shotAfter);
  // 打鍵側は ASCII の目印で見る(日本語は届かないので CJK では見られない)
  if (edit) {
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(5000);
    // ⚠ **「届かなかった」と「保存されなかった」を混ぜない。** 目印が 0 件のとき、
    //    file が育っていなければ原因は保存側であって入力側ではない。
    arm.saved = await page.evaluate(() => {
      try {
        const bytes = globalThis.__lo.FS.readFile('/work/steady.fodt');
        // ⚠ ここは page 内で走るが lint は node として読む ── `globalThis.` を付けて
        //    `no-undef` を避ける(この file の他の browser API も同じ書き方)
        const text = new globalThis.TextDecoder().decode(bytes);
        return { bytes: bytes.length, ascii: (text.match(/steady/gi) ?? []).length };
      } catch (e) { return { err: String(e).slice(0, 60) }; }
    }).catch((e) => ({ err: String(e).slice(0, 60) }));
  }
  // 🔴 空振り対策 ①: 画面が変わったか(bytes 比較)
  arm.screenChanged = Buffer.compare(shotBefore, shotAfter) !== 0;
  // 🔴 空振り対策 ②: Event Timing が打鍵を観測したか
  const perf = await page.evaluate(() => globalThis.__perf)
    .catch(() => ({ longTasks: [], events: [], windowStart: 0 }));
  const w = perf.windowStart ?? 0;
  // 🔴 定常窓のみ。boot 窓(w 未満)は別欄に出す ── 捨てずに、混ぜない
  const inWin = perf.longTasks.filter(([s]) => s >= w).map(([, d]) => d);
  const boot = perf.longTasks.filter(([s]) => s < w).map(([, d]) => d);
  const keyDur = perf.events.filter(([n, s]) => n.startsWith('key') && s >= w).map(([, , d]) => d);
  arm.input = {
    // ⚠ 「16ms 以上の入力イベントのうち」の値。16ms 未満は Event Timing の仕様上見えない
    keyEventsOver16ms: keyDur.length,
    keyP50Ms: pct(keyDur, 50),
    keyP95Ms: pct(keyDur, 95),
    keyMaxMs: keyDur.length ? Math.max(...keyDur) : null,
    longTasks: inWin.length,
    longTaskTotalMs: inWin.reduce((a, b) => a + b, 0),
    longTaskP95Ms: pct(inWin, 95),
    longTaskMaxMs: inWin.length ? Math.max(...inWin) : null,
  };
  arm.bootWindow = { longTasks: boot.length, longTaskTotalMs: boot.reduce((a, b) => a + b, 0) };
  await page.screenshot({ path: join(ROOT, `steady-${arm.arm}.png`) });
  await browser.close();
  return arm;
}

async function main() {
  const fontFiles = FONT_DIR
    ? readdirSync(FONT_DIR).filter((f) => f.toLowerCase().endsWith('.ttf')).map((f) => join(FONT_DIR, f))
    : [];
  const server = await serve(fontFiles);
  const base = `http://127.0.0.1:${server.address().port}`;
  // ⚠ `.map(basename)` は index を第 2 引数(suffix)に渡してしまう
  const result = { base, armMs: ARM_MS, fonts: fontFiles.map((f) => basename(f)), arms: [] };
  try {
    for (const edit of [false, true]) result.arms.push(await runArm({ base, edit }));
  } finally {
    server.close();
  }

  const idle = result.arms.find((a) => a.arm === 'idle');
  const ed = result.arms.find((a) => a.arm === 'edit');
  const mb = (kb) => Math.round((kb / 1024) * 10) / 10;
  if (idle?.endRssKb && ed?.endRssKb) {
    result.summary = {
      idleOpenMb: mb(idle.afterOpenRssKb - idle.baselineRssKb),
      idleEndMb: mb(idle.endRssKb - idle.baselineRssKb),
      editOpenMb: mb(ed.afterOpenRssKb - ed.baselineRssKb),
      editEndMb: mb(ed.endRssKb - ed.baselineRssKb),
      // 「編集の代金」= 同じ時間・同じ起動で、打鍵した分だけの差
      editCostMb: mb((ed.endRssKb - ed.baselineRssKb) - (idle.endRssKb - idle.baselineRssKb)),
    };
  }

  // 🔴 空振りなら**成功として出さない** ── idle を 2 回測って「編集は軽い」と言わないため
  // ⚠ ① screenChanged は idle でも true になる(キャレットの点滅)。だから②が要る。
  //    ② keyEvents は idle では 0 でなければならない ── **対照群が汚れていないこと**も検める
  //    ③ 版面が実際に動いたこと(画素の 10% 以上)── ①②は dead click でも通る
  //    ④ ASCII の打鍵が保存物に届いたこと
  const vacuous = ed && (!ed.screenChanged
    || (ed.input?.keyEventsOver16ms ?? 0) === 0
    || !(typeof ed.pixelDiffRatio === 'number' && ed.pixelDiffRatio >= 0.1)
    || !((ed.saved?.ascii ?? 0) > 0));
  const idleDirty = (idle?.input?.keyEventsOver16ms ?? 0) !== 0;
  result.ok = Boolean(idle?.painted === true && ed?.painted === true && !vacuous && !idleDirty);
  if (vacuous) {
    result.notApplied = `操作が届いていない(screenChanged=${ed.screenChanged}, `
      + `keyEventsOver16ms=${ed.input?.keyEventsOver16ms}, pixelDiff=${ed.pixelDiffRatio}, `
      + `savedAscii=${ed.saved?.ascii}) ── この結果は「操作中の定常」を測っていない`;
  }
  if (idleDirty) result.controlDirty = '対照群(idle)で入力イベントが観測された ── 対照群が汚れている';

  const text = JSON.stringify(result, null, 2);
  console.log(text);
  if (OUT) await writeFile(OUT, text);
  if (!result.ok) process.exitCode = 1;
}

await main();
