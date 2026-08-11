/**
 * ヘッダを**何も足さない**静的 server(#111)。
 *
 * 🔴 **これが無いと、分離の検査は必ず空振りする。** smoke の既定 server は
 * `vite preview` で、COOP/COEP を**自分で返す** ── その上で
 * `crossOriginIsolated` を見ても、通るのは preview のおかげであって
 * service worker が働いた証拠にはならない(CLAUDE.md「空振りを直したら
 * 今度は何に救われていないかを問う」)。
 *
 * 🔑 だから **GitHub Pages と同じ条件**を立てる ── 静的 file を返すだけで、
 * COOP も COEP も返さない。ここで分離が成立したなら、それは SW が被せたからである。
 *
 * ⚠ **SPA fallback を書かない。** 本番(Pages)にも無いので、足すと
 * 「本番に無い救い」で test が通ってしまう。
 */
import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../dist', import.meta.url));
const PORT = Number(process.env.PKC3_PLAIN_PORT ?? 45733);

/**
 * 🔴 **起動を壊す古い SW を配れるようにする**(#115)。
 *
 * 2026-08-11 に、起動を壊す SW を出荷して**自己永続化する障害**を作った ──
 * 直した版を配っても旧 SW が active のままなので起動せず、交代を促す案内は
 * 起動しないと出ない。回復の機構(`boot-recovery.ts`)を**実際に働かせて**
 * 確かめるには、その「壊れた active」を作れなければならない。
 *
 * `/__control/stale-sw/on` で壊れた SW を、`/off` で本物を配る。
 */
let staleSw = false;

/**
 * 本物の `sw.js` から「worker にも COEP を被せる」だけを外した版を作る。
 *
 * ⚠ **当たったことを確かめる**(CLAUDE.md「当たらなかった変異と生き延びた変異を
 * 区別する」)── 置換が空振りすると、この fixture は**ただの本物**になり、
 * 回復の test が「壊れていないものから回復した」と嘘の合格を出す。
 */
function brokenSw() {
  const real = readFileSync(join(ROOT, 'sw.js'), 'utf-8');
  const from = "req.mode === 'navigate' || WORKER_DESTS.indexOf(req.destination) !== -1";
  if (!real.includes(from)) {
    throw new Error(`stale-sw fixture: 置換対象が sw.js に無い(実装が変わった): ${from}`);
  }
  // ⚠ BUILD も変える ── 同じ版だと本物が「新しい版」として install されない
  return real
    .replace(from, "req.mode === 'navigate'")
    .replace(/const BUILD = "([^"]+)"/, 'const BUILD = "$1-stale"');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

createServer((req, res) => {
  // ⚠ `..` で dist の外へ出させない
  const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(
    /^(\.\.[/\\])+/,
    '',
  );

  // 壊れた SW の on/off(#115 の回復を実際に働かせるための口)
  if (rel === 'sw.js' || rel === '/sw.js') {
    const body = staleSw ? brokenSw() : readFileSync(join(ROOT, 'sw.js'), 'utf-8');
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
    return;
  }
  if (rel.startsWith('__control/stale-sw/') || rel.startsWith('/__control/stale-sw/')) {
    staleSw = rel.endsWith('/on');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(staleSw ? 'stale' : 'real');
    return;
  }
  let path = join(ROOT, rel);
  try {
    if (statSync(path).isDirectory()) path = join(path, 'index.html');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  try {
    statSync(path);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    // ⚠ 意図的に **cache させない** ── 読み直しで古い sw.js を掴むと、
    //    何を見ているのか分からなくなる
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(res);
}).listen(PORT, () => {
  process.stdout.write(`plain server on ${PORT}\n`);
});
