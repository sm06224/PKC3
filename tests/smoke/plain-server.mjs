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
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../dist', import.meta.url));
const PORT = Number(process.env.PKC3_PLAIN_PORT ?? 45733);

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
