/**
 * 「自分のパソコンで動かす」一式(#532 段 B)。**純粋な層** ── ここは
 * 「何を・どんな名前で・どんな中身で zip に入れるか」だけを決める。
 * 取りに行くのも落とすのも adapter 側の仕事である。
 *
 * > user 指示 2026-08-28「**ローカルでホストする仕組みと一緒にインストーラーを
 * > PKC3 自身で配布できるように組み込みアプリに動線を追加しましょう**」
 *
 * 設計の根拠は `docs/development/self-host-design-2026-08.md`。要点は 3 つ:
 *
 * 1. 🔑 **要るのはただの静的ファイルサーバ**。分離(COOP/COEP)は Service Worker
 *    自身が被せるので(`sw-source.ts`、GitHub Pages がヘッダを設定できないため)、
 *    サーバ側に細工は 1 つも要らない。
 * 2. 🔑 **配る中身は `dist/` そのまま**。`sw.js` は根に在り、登録も相対
 *    (`./sw.js`)なので、document root に置くだけで scope ごと成立する。
 * 3. 🔴 **origin を固定する。空きポートを自動で探してはいけない。**
 *    `http://localhost:8787` と `http://localhost:8788` は**別の場所**で、
 *    OPFS も IndexedDB も origin に紐づく ── 番号が変わると
 *    **前に書いたノートが 1 件も見えなくなる**。埋まっていたら**止めて理由を出す**。
 */
import { precacheEntryPath } from './precache-list';

/**
 * 🔴 **住所は固定**(上の 3)。⚠ ここを変えると、**既に一式を使っている人の
 * ノートが全部見えなくなる** ── 変えてよいのは「まだ誰も使っていない」と
 * 言い切れるときだけである。
 *
 * ⚠ 8080 / 8000 / 3000 は他の道具がよく使う ── 塞がっていると
 * 「止めて理由を出す」が毎回出て動線として成立しないので、**当たりにくい番号**を選ぶ。
 */
export const SELFHOST_PORT = 8787;

/** user に見せる住所。⚠ スクリプトが開く先と**同じ字**でなければならない。 */
export const SELFHOST_ORIGIN = `http://localhost:${SELFHOST_PORT}`;

/** zip の中の一番上のディレクトリ(展開しても散らからないように 1 枚被せる)。 */
export const SELFHOST_ROOT = 'pkc3-selfhost';

/** 配る物を入れる場所。⚠ **ここが document root になる**。 */
export const SELFHOST_SITE = 'site';

/** 一式の版(中身が変わったら上げる)。⚠ はじめに.txt に出す。 */
export const SELFHOST_LAYOUT = 1;

/** zip の名前。⚠ 日付を入れる ── 古い一式と混ざったとき、どちらが新しいか分かる。 */
export function selfhostZipName(stamp: string): string {
  return `pkc3-selfhost-${stamp}.zip`;
}

/** dist の相対 path → zip の中の名前。 */
export function siteEntryName(ref: string): string {
  return `${SELFHOST_ROOT}/${SELFHOST_SITE}/${precacheEntryPath(ref)}`;
}

/**
 * 🔴 **precache に載らないが、配るのに要る file**(2026-09-09、実地の probe で判明)。
 *
 * ⚠ 直す前は「配る物の一覧 = precache の一覧」で組んでいたが、**それは違う** ──
 *   `sw.js` は**自分を precache しない**(`dist-inspect.mjs` の `want` が
 *   `p !== 'sw.js'` で外している)ので、一覧に**現れない**。
 * 🔴 帰結は重い:落とした一式に Service Worker が入らず、
 *   ①**オフラインで開かない** ②**分離(COOP/COEP)が生まれない** ──
 *   ②は「セルフホストする理由」そのものである(`file://` では Office が使えない、
 *   だからローカルに立てる)。⚠ しかも症状は**console の 404 が 1 行**だけで、
 *   画面はふつうに起動して見える(いちばん気づけない形)。
 * 🔑 **この一覧が漏れていないことは、検品が保証している** ── `dist-inspect.mjs` は
 *   「precache に載っていない生成物がある」で落ちるので、**配る物のうち
 *   precache に載らないのは `sw.js` ただ 1 つ**である(そこを外した唯一の例外)。
 */
export const REQUIRED_EXTRA_FILES: readonly string[] = ['sw.js'];

/**
 * 在れば入れる(無くても一式は成立する)。
 *
 * ⚠ `portable-template.html`(持ち歩ける 1 枚の雛形)は **`npm run build` の産物ではなく**、
 *   配る workflow が後から置く(#400 段④)── だから**在る配信と無い配信がある**。
 * 🔑 だから**取れたら入れる**。⚠ 入れないと、落とした一式で
 *   「持ち歩ける HTML 1 枚」を押したとき **404 で断られる**。
 */
export const OPTIONAL_EXTRA_FILES: readonly string[] = ['portable-template.html'];

/**
 * 配る物の一覧 → zip に入れる site の中身(重複を畳み、並びを固定する)。
 *
 * ⚠ **空を通さない** ── 0 件の一式を配ると、user は「zip を開いても何も無い」
 * という、いちばん理由の分からない壊れ方に当たる。
 * ⚠ 並びを固定するのは、同じ入力から**同じ zip** が出るようにするため
 * (違う zip が出ると「取り違えたのか、変わったのか」が読めない)。
 */
export function planSiteFiles(precache: readonly string[]): readonly string[] {
  const listed = precache.map(precacheEntryPath);
  if (listed.length === 0) throw new Error('配る物が 1 つも無い一式は組めません');
  return [...new Set([...listed, ...REQUIRED_EXTRA_FILES])].sort();
}

/**
 * python3 / node のどちらでも同じことをする静的サーバ、の python 版。
 *
 * ⚠ **`--bind 127.0.0.1`**(既定の全インタフェースではない)── 同じ LAN の
 * 別の端末から読めてしまうのを止める。⚠ しかも LAN の住所は secure context では
 * ないので、仮に届いても **SW も OPFS も動かない**(= 壊れた PKC が見える)。
 */
export const SERVE_PY = [
  '# PKC3 self-host (#532). ただの静的サーバ ── 分離は Service Worker が被せる。',
  'import http.server, functools, os, socketserver, sys',
  '',
  'PORT = ' + String(SELFHOST_PORT),
  "ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '" + SELFHOST_SITE + "')",
  '',
  'class H(http.server.SimpleHTTPRequestHandler):',
  '    extensions_map = {',
  "        **http.server.SimpleHTTPRequestHandler.extensions_map,",
  "        '.wasm': 'application/wasm',",
  "        '.webmanifest': 'application/manifest+json',",
  "        '.mjs': 'text/javascript',",
  '    }',
  '    def end_headers(self):',
  '        # 読み直しで古い sw.js を掴ませない',
  "        self.send_header('Cache-Control', 'no-cache')",
  '        super().end_headers()',
  '    def log_message(self, *a):',
  '        pass',
  '',
  'socketserver.TCPServer.allow_reuse_address = True',
  'try:',
  "    with socketserver.TCPServer(('127.0.0.1', PORT), functools.partial(H, directory=ROOT)) as httpd:",
  "        print('PKC3 を " + SELFHOST_ORIGIN + " で開いてください(この窓を閉じると止まります)')",
  '        httpd.serve_forever()',
  'except OSError as e:',
  "    print('起動できません: ' + str(e))",
  "    print('ポート " +
    String(SELFHOST_PORT) +
    " が使われています。先に使っている物を止めてから、もう一度やり直してください。')",
  "    print('⚠ ほかの番号に変えると、前に書いたノートが見えなくなります(住所が変わるため)。')",
  '    sys.exit(1)',
  '',
].join('\n');

/** 同じことをする node 版(python3 が無い端末のため)。 */
export const SERVE_MJS = [
  '// PKC3 self-host (#532). ただの静的サーバ ── 分離は Service Worker が被せる。',
  "import { createServer } from 'node:http';",
  "import { createReadStream, statSync } from 'node:fs';",
  "import { join, normalize, extname, dirname } from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  '',
  'const PORT = ' + String(SELFHOST_PORT) + ';',
  "const ROOT = join(dirname(fileURLToPath(import.meta.url)), '" + SELFHOST_SITE + "');",
  'const TYPES = {',
  "  '.html': 'text/html; charset=utf-8',",
  "  '.js': 'text/javascript; charset=utf-8',",
  "  '.mjs': 'text/javascript; charset=utf-8',",
  "  '.css': 'text/css; charset=utf-8',",
  "  '.json': 'application/json; charset=utf-8',",
  "  '.webmanifest': 'application/manifest+json; charset=utf-8',",
  "  '.svg': 'image/svg+xml',",
  "  '.wasm': 'application/wasm',",
  "  '.png': 'image/png',",
  "  '.woff2': 'font/woff2',",
  '};',
  '',
  'const server = createServer((req, res) => {',
  "  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);",
  "  const rel = normalize(p).replace(/^(\\.\\.[/\\\\])+/, '');",
  '  let file = join(ROOT, rel);',
  '  try {',
  "    if (statSync(file).isDirectory()) file = join(file, 'index.html');",
  '    statSync(file);',
  '  } catch {',
  "    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });",
  "    res.end('not found');",
  '    return;',
  '  }',
  '  res.writeHead(200, {',
  "    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',",
  "    'cache-control': 'no-cache',",
  '  });',
  '  createReadStream(file).pipe(res);',
  '});',
  '',
  "server.on('error', (e) => {",
  "  console.log('起動できません: ' + e.message);",
  "  console.log('ポート ' + PORT + ' が使われています。先に使っている物を止めてから、もう一度やり直してください。');",
  "  console.log('⚠ ほかの番号に変えると、前に書いたノートが見えなくなります(住所が変わるため)。');",
  '  process.exit(1);',
  '});',
  "server.listen(PORT, '127.0.0.1', () => {",
  "  console.log('PKC3 を " + SELFHOST_ORIGIN + " で開いてください(この窓を閉じると止まります)');",
  '});',
  '',
].join('\n');

/**
 * mac / Linux の入口。
 *
 * 🔴 **「在るか」で選ばない ── 実際に走らせた終了コードで選ぶ**(設計 doc §2 ③)。
 * ⚠ macOS の `/usr/bin/python3` は **開発者ツールを入れさせるための殻**、
 *   Windows の `python3` は **Store へ誘導する殻**で、`command -v` は**成功する**。
 *   ここを間違えると「起動しました」と出て**何も起きない**。
 * ⚠ 1 つも無ければ、**何を入れればよいかを画面に出して止まる**(黙って失敗しない)。
 */
export const START_SH = [
  '#!/bin/sh',
  '# PKC3 を自分のパソコンで動かす (#532)',
  'cd "$(dirname "$0")" || exit 1',
  '',
  '# ⚠ 「在るか」ではなく「実際に走るか」で選ぶ(殻が居る)',
  'if python3 -c "" 2>/dev/null; then',
  '  exec python3 serve.py',
  'fi',
  'if python -c "" 2>/dev/null; then',
  '  exec python serve.py',
  'fi',
  'if node -e "" 2>/dev/null; then',
  '  exec node serve.mjs',
  'fi',
  '',
  'echo "PKC3 を動かすのに必要な物が見つかりませんでした。"',
  'echo "次のどちらかを入れてから、もう一度この file をダブルクリックしてください:"',
  'echo "  ・Python 3   https://www.python.org/downloads/"',
  'echo "  ・Node.js    https://nodejs.org/"',
  'echo "(macOS で python3 と打つと案内が出る場合は、まだ入っていません)"',
  'exit 1',
  '',
].join('\n');

/**
 * Windows の入口(`.cmd` を 2 度押しで動く)。
 *
 * ⚠ **実行ポリシーの壁を `.cmd` 側で回避する** ── user に PowerShell の設定を
 * 触らせない(設計 doc §4 段 B)。
 */
export const START_CMD = [
  '@echo off',
  'rem PKC3 を自分のパソコンで動かす (#532)',
  'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"',
  'pause',
  '',
].join('\r\n');

/**
 * Windows の本体。`System.Net.HttpListener` で静的配信する(依存 0)。
 *
 * ⚠ **落ちたら理由を出す。** HttpListener は環境によって
 * 「アクセスが拒否されました」で始まらないことがある ── そのとき
 * **黙って終わらない**(何が起きたのか user に分からなくなる)。
 * ⚠ この箱では Windows を動かせないので、**実機での確認が要る**
 * (`docs/development/self-host-design-2026-08.md` §6)。
 */
export const START_PS1 = [
  '# PKC3 を自分のパソコンで動かす (#532)',
  '$ErrorActionPreference = "Stop"',
  '$port = ' + String(SELFHOST_PORT),
  '$root = Join-Path $PSScriptRoot "' + SELFHOST_SITE + '"',
  '$types = @{',
  '  ".html" = "text/html; charset=utf-8";',
  '  ".js" = "text/javascript; charset=utf-8";',
  '  ".mjs" = "text/javascript; charset=utf-8";',
  '  ".css" = "text/css; charset=utf-8";',
  '  ".json" = "application/json; charset=utf-8";',
  '  ".webmanifest" = "application/manifest+json; charset=utf-8";',
  '  ".svg" = "image/svg+xml";',
  '  ".wasm" = "application/wasm";',
  '  ".png" = "image/png";',
  '  ".woff2" = "font/woff2"',
  '}',
  '$listener = New-Object System.Net.HttpListener',
  '$listener.Prefixes.Add("http://localhost:$port/")',
  'try {',
  '  $listener.Start()',
  '} catch {',
  '  Write-Host "起動できません: $($_.Exception.Message)"',
  '  Write-Host "ポート $port が使われているか、許可がありません。先に使っている物を止めてから、もう一度やり直してください。"',
  '  Write-Host "⚠ ほかの番号に変えると、前に書いたノートが見えなくなります(住所が変わるため)。"',
  '  exit 1',
  '}',
  'Write-Host "PKC3 を ' + SELFHOST_ORIGIN + ' で開いてください(この窓を閉じると止まります)"',
  'while ($listener.IsListening) {',
  '  $ctx = $listener.GetContext()',
  '  $p = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)',
  '  $file = Join-Path $root ($p.TrimStart("/") -replace "/", [IO.Path]::DirectorySeparatorChar)',
  '  if ((Test-Path $file) -and (Get-Item $file).PSIsContainer) { $file = Join-Path $file "index.html" }',
  '  if (Test-Path $file -PathType Leaf) {',
  '    $ext = [IO.Path]::GetExtension($file).ToLower()',
  '    $ct = $types[$ext]',
  '    if (-not $ct) { $ct = "application/octet-stream" }',
  '    $bytes = [IO.File]::ReadAllBytes($file)',
  '    $ctx.Response.ContentType = $ct',
  '    $ctx.Response.Headers.Add("Cache-Control", "no-cache")',
  '    $ctx.Response.ContentLength64 = $bytes.Length',
  '    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)',
  '  } else {',
  '    $ctx.Response.StatusCode = 404',
  '  }',
  '  $ctx.Response.Close()',
  '}',
  '',
].join('\r\n');

/** 同梱する説明。⚠ **住所が変わるとノートが見えなくなる**ことを必ず書く。 */
export const README_TXT = [
  'PKC3 を自分のパソコンで動かす',
  '============================',
  '',
  '【はじめ方】',
  '  Windows          … start-windows.cmd をダブルクリック',
  '  Mac / Linux      … start-mac-linux.sh をダブルクリック(または端末で sh start-mac-linux.sh)',
  '',
  '  出てきた窓に住所が出ます。ブラウザで開いてください:',
  '    ' + SELFHOST_ORIGIN,
  '',
  '  ⚠ この窓を閉じると止まります。使うあいだは開いたままにしてください。',
  '',
  '【いちばん大事なこと】',
  '  ここに書いたノートは、上の住所にだけ残ります。',
  '  住所(番号)が変わると、前に書いたノートは 1 件も見えなくなります。',
  '  ── 消えたわけではありませんが、別の場所として扱われます。',
  '',
  '  だから、ポート ' +
    String(SELFHOST_PORT) +
    ' が使われているときは、番号を変えずに、',
  '  先に使っている物を止めてください。',
  '',
  '【ほかの端末からは見えません】',
  '  このパソコンの中だけで動きます(127.0.0.1 に限定)。',
  '  同じ Wi-Fi の別の端末からは開けません。',
  '',
  '【入っていないと動かない物】',
  '  Windows          … 追加で要る物はありません',
  '  Mac / Linux      … Python 3 か Node.js のどちらか',
  '',
  '【中身】',
  '  site/            … PKC3 本体(この中を配っています)',
  '  serve.py         … Python で動かすときの本体',
  '  serve.mjs        … Node.js で動かすときの本体',
  '',
  '【古くなったら】',
  '  新しい一式は、PKC3 の中の「自分のパソコンで動かす」からもう一度落とせます。',
  '  ⚠ site/ を入れ替えても、住所が同じならノートはそのまま残ります。',
  '',
  '  一式の形: ' + String(SELFHOST_LAYOUT),
  '',
].join('\r\n');

/** zip に入れる「site 以外」の中身(名前 → 中身)。 */
export function selfhostExtras(): ReadonlyMap<string, string> {
  return new Map([
    [`${SELFHOST_ROOT}/serve.py`, SERVE_PY],
    [`${SELFHOST_ROOT}/serve.mjs`, SERVE_MJS],
    [`${SELFHOST_ROOT}/start-mac-linux.sh`, START_SH],
    [`${SELFHOST_ROOT}/start-windows.cmd`, START_CMD],
    [`${SELFHOST_ROOT}/start.ps1`, START_PS1],
    [`${SELFHOST_ROOT}/はじめに.txt`, README_TXT],
  ]);
}
