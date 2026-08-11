/**
 * 焼いた LibreOffice(wasm / Qt6)を**手元のブラウザで触れる**ようにする(#88、2026-08-10)。
 *
 * user「もう動く? dev で触れる? 見たほうが早いわ」への答え ──
 * ⚠ **`npm run dev` では触れない。** この段階では `src/` に何も入っていないので、
 *   PKC3 本体からは 1 行も繋がっていない。動くのは焼いた成果物単体である。
 *
 * ⚠ **GitHub Pages にも置けない**(2 つ理由がある):
 *   ① `soffice.wasm` が 156MB で、GitHub の 100MB/file 制限を超えるので git に入らない
 *   ② Pages は COOP/COEP ヘッダを付けられない ── SharedArrayBuffer が使えず、
 *      LO の `-pthread` が動かない(service worker で被せる手はあるが ① が残る)
 * したがって「手元で serve する」が唯一の触り方である。
 *
 * 使い方:
 *   bash build/office-wasm/fetch-and-run.sh --serve      # 取得もまとめて
 *   node build/office-wasm/serve-local.mjs /tmp/lo-wasm  # 既に取得済みなら
 *
 * できること:
 *   - 何も選ばずに待てば Start Center が出る
 *   - **手元の Office ファイル(.docx / .xlsx / .pptx / .odt …)を選んで開ける**
 *   - BIZ UD(ゴシック / P ゴシック / 明朝)を自動で流し込むので日本語が豆腐にならない
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, extname, resolve, basename } from 'node:path';

const DIR = resolve(process.argv[2] ?? '/tmp/lo-wasm');
const portArg = process.argv.indexOf('--port');
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.PKC3_LO_PORT ?? 8088);
const FONT_DIR = join(DIR, 'inject');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.metadata': 'application/json',
  '.ttf': 'font/ttf',
  '.data': 'application/octet-stream',
};

for (const f of ['soffice.js', 'soffice.wasm', 'soffice.data', 'soffice.data.js.metadata', 'qtloader.js']) {
  if (!existsSync(join(DIR, f))) {
    console.error(`ERROR: ${join(DIR, f)} が無い。先に取得する:\n`
      + '  bash build/office-wasm/fetch-and-run.sh --serve');
    process.exit(1);
  }
}
const fonts = existsSync(FONT_DIR)
  ? readdirSync(FONT_DIR).filter((f) => f.toLowerCase().endsWith('.ttf'))
  : [];

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>LibreOffice wasm (PKC3 #88)</title>
<style>
  :root { color-scheme: light dark; }
  html,body { padding:0; margin:0; height:100%; overflow:hidden;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  #bar { position:fixed; inset:0 0 auto 0; height:40px; display:flex; gap:12px;
    align-items:center; padding:0 12px; background:#1b1b1b; color:#eee; font-size:13px; z-index:10; }
  #bar b { font-weight:600; }
  #bar .sp { flex:1 }
  #status { opacity:.75; font-variant-numeric: tabular-nums; }
  #screen { position:fixed; inset:40px 0 0 0; }
  #intro { position:fixed; inset:40px 0 0 0; display:grid; place-content:center;
    text-align:center; gap:14px; padding:24px; }
  #intro p { margin:0; opacity:.8; line-height:1.7 }
  button, label.btn { background:#2d6cdf; color:#fff; border:0; border-radius:6px;
    padding:8px 14px; font-size:13px; cursor:pointer; }
  label.btn input { display:none }
</style></head><body>
<div id="bar">
  <b>LibreOffice wasm</b><span>Qt6 / JSPI</span>
  <span class="sp"></span>
  <span id="status">起動していません</span>
</div>
<div id="intro">
  <p><b>手元の Office ファイルを開いて試せます。</b><br>
  .docx / .xlsx / .pptx / .odt / .ods / .odp / .doc / .xls / .ppt など</p>
  <div>
    <label class="btn">ファイルを選ぶ<input id="pick" type="file"></label>
    <button id="blank">何も開かずに起動(Start Center)</button>
  </div>
  <p style="font-size:12px">初回は wasm 156MB + データ 84MB の読み込みとコンパイルで
  <b>十数秒〜1 分</b>かかります(2 回目以降はブラウザのキャッシュが効きます)。<br>
  日本語フォント(BIZ UD)は起動時に自動で流し込みます。</p>
</div>
<div id="screen" hidden></div>
<script>
const FONTS = ${JSON.stringify(fonts)};
const statusEl = document.querySelector('#status');
const setStatus = (s) => { statusEl.textContent = s; };
let started = false;

async function boot(file) {
  if (started) return;
  started = true;
  document.querySelector('#intro').remove();
  const screen = document.querySelector('#screen');
  screen.hidden = false;
  setStatus('読み込み中…');
  try {
    const fontBytes = [];
    for (const n of FONTS)
      fontBytes.push([n, new Uint8Array(await (await fetch('/inject/' + n)).arrayBuffer())]);
    const docBytes = file ? new Uint8Array(await file.arrayBuffer()) : null;

    // 🔑 main は自分で呼ぶ ── qtloader は noInitialRun を尊重して callMain を飛ばすので、
    //    runtime が完全に立ち上がったあとに FS へフォントと文書を置ける
    //    (preRun 経路では /instdir がまだ見えず ENOENT で落ちる)
    const inst = window.__lo = await qtLoad({
      noInitialRun: true,
      qt: {
        onLoaded: () => setStatus('LibreOffice を起動中…'),
        onExit: (d) => setStatus('終了: ' + JSON.stringify(d)),
        entryFunction: window.soffice_entry,
        containerElements: [screen],
      },
    });
    const FS = inst.FS;
    for (const [n, b] of fontBytes) FS.writeFile('/instdir/share/fonts/truetype/' + n, b);
    const args = [];
    if (docBytes) {
      try { FS.mkdir('/work'); } catch (e) { /* 既に在る */ }
      // ⚠ 題名はそのまま使う(日本語のファイル名も通る)
      const path = '/work/' + file.name.replace(/[/\\\\]/g, '_');
      FS.writeFile(path, docBytes);
      args.push(path);
    }
    setStatus(docBytes ? '文書を開いています…' : '起動しています…');
    // ⚠ 版面が出たら表示を確定させる。callMain は event loop に入ったまま
    //    戻らないことがあるので、**戻り値ではなく画面**を待つ。
    //    ⚠ Qt 6 の canvas は **shadow root の中**に在るので querySelectorAll では
    //      永遠に 0 枚(#88 §3.11 で 1 日溶かした罠)── 境界を越えて探す。
    //    ⚠ ここは PAGE(template literal)の中なので、バッククォートを書かない。
    const deep = (root) => {
      const out = [];
      const walk = (n) => {
        for (const el of n.querySelectorAll('*')) {
          if (el.tagName === 'CANVAS') out.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      if (root) walk(root);
      return out;
    };
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (deep(screen).some((c) => c.width > 0)) {
        clearInterval(tick);
        setStatus((file ? '表示中: ' + file.name : '起動しました')
          + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒)');
      }
    }, 300);
    inst.callMain(args);
  } catch (e) {
    console.error(e);
    setStatus('起動に失敗: ' + String(e && e.message || e).slice(0, 120));
  }
}

document.querySelector('#pick').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) boot(f);
});
document.querySelector('#blank').addEventListener('click', () => boot(null));
// 画面のどこへ落としても開ける
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) boot(f);
});
</script>
<script src="soffice.js"></script><script src="qtloader.js"></script>
</body></html>`;

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  // ⚠ COOP/COEP は必須(SharedArrayBuffer = LO の -pthread に要る)
  const head = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  };
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { ...head, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  // ディレクトリ外へ出られないようにする
  const target = resolve(join(DIR, path));
  if (!target.startsWith(DIR)) { res.writeHead(403, head); res.end(); return; }
  const type = MIME[extname(path)] ?? 'application/octet-stream';
  // 🔑 **圧縮を効かせる。** 同じ名前の `.gz` が在って client が gzip を受け付けるなら、
  //    それをそのまま `Content-Encoding: gzip` で返す(解凍はブラウザがやる)。
  //    ⚠ 実測: soffice.wasm 148.9MB → 50.6MB(2.94x)/ soffice.data 83.6MB → 26.4MB(3.17x)。
  //    ⚠ `Vary: Accept-Encoding` を必ず付ける ── 付けないと途中の cache が
  //      gzip 版を非対応 client へ配る。
  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  const gz = `${target}.gz`;
  if (acceptsGzip && existsSync(gz)) {
    readFile(gz).then((buf) => {
      res.writeHead(200, { ...head, 'Content-Type': type, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      res.end(buf);
    }).catch(() => { res.writeHead(500, head); res.end(); });
    return;
  }
  readFile(target)
    .then((buf) => {
      res.writeHead(200, { ...head, 'Content-Type': type, Vary: 'Accept-Encoding' });
      res.end(buf);
    })
    .catch(() => { res.writeHead(path === '/favicon.ico' ? 204 : 404, head); res.end(); });
});

server.listen(PORT, '127.0.0.1', () => {
  const mb = (p) => Math.round(readFileSync(p).length / 1048576);
  console.log('');
  console.log('  LibreOffice wasm をローカルで配信します');
  console.log('  ────────────────────────────────────────');
  console.log(`  ブラウザで開く:  http://127.0.0.1:${PORT}/`);
  console.log(`  配信元:          ${DIR}`);
  console.log(`  wasm ${mb(join(DIR, 'soffice.wasm'))}MB / data ${mb(join(DIR, 'soffice.data'))}MB`);
  console.log(`  日本語フォント:  ${fonts.length ? fonts.map((f) => basename(f)).join(', ') : '**無し(日本語は豆腐になります)**'}`);
  console.log('');
  console.log('  手元の Office ファイルを選ぶか、画面へドロップすると開きます。');
  console.log('  止めるときは Ctrl-C。');
  console.log('');
});
