/**
 * 🔴 **DuckDB は「畳んだら返る」か**(#682 段①b。user 裁定 2026-09-15「常駐させない」)。
 *
 * ## 何を測るか
 *
 * 「**起こす → 打つ → 畳む**」を通し、各段で**プロセス木の Pss** を採る。
 * ⚠ `performance.memory` では測れない ── あれはメインの realm の JS heap だけで、
 * **worker の中の wasm を 1 バイトも数えない**(DuckDB の常駐はまさにそこに在る)。
 *
 * ## ⚠ この probe が測っていないこと(先に書く)
 *
 * - **配った通りの経路ではない** ── アプリの UI からではなく、probe 用に焼いた
 *   小さな束から `openDuckDb` を呼ぶ。⚠ 測っているのは**wasm と worker の常駐**であって、
 *   「画面から押したときの体感」ではない
 * - 1 回しか打たない(大きい集計での挙動は別)
 *
 * ## 使い方
 *
 *   node tests/probe/run-duckdb-memory-probe.mjs [--rounds=3]
 *
 * ⚠ 先に `npm run build`(`dist/duckdb/` が要る)。
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { treeMemoryMb, findBrowserPid } from '../helpers/proc-memory.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const ROUNDS = Number(args.rounds ?? 3);
const WORK = '/tmp/claude-0/duckdb-mem-probe';
const PORT = Number(args.port ?? 45777);

if (!existsSync('dist/duckdb/duckdb-eh.wasm')) {
  console.error('🔴 dist/duckdb/ が無い ── 先に `npm run build` を回してください');
  process.exit(1);
}

// ── ① probe 用の束を焼く(上流は bare import を持つので、素の browser では読めない)
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
writeFileSync(
  'tests/zz-duckdb-mem-entry.mjs',
  `import { openDuckDb } from '../src/adapter/platform/duckdb/duckdb-open';
import { DuckDbLease } from '../src/adapter/platform/duckdb/duckdb-lease';
globalThis.__pkcDuck = { openDuckDb, DuckDbLease };
`,
);
writeFileSync(
  `${WORK}/vite.mjs`,
  `export default {
  root: '${process.cwd()}',
  logLevel: 'warn',
  build: {
    outDir: '${WORK}/site',
    emptyOutDir: true,
    rollupOptions: { input: '${process.cwd()}/tests/zz-duckdb-mem-entry.mjs', output: { entryFileNames: 'probe.js' } },
  },
};`,
);
execFileSync('npx', ['vite', 'build', '--config', `${WORK}/vite.mjs`], { stdio: 'inherit' });
rmSync('tests/zz-duckdb-mem-entry.mjs', { force: true });
cpSync('dist/duckdb', `${WORK}/site/duckdb`, { recursive: true });
writeFileSync(
  `${WORK}/site/index.html`,
  '<!doctype html><meta charset="utf-8"><title>duckdb mem probe</title><script type="module" src="/probe.js"></script>',
);

// ── ② 同一オリジンで配る(⚠ 外へは 1 バイトも出さない)
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html' };
const server = createServer((req, res) => {
  const p = join(`${WORK}/site`, decodeURIComponent((req.url ?? '/').split('?')[0]));
  const f = p.endsWith('/') ? join(p, 'index.html') : p;
  if (!existsSync(f)) {
    res.writeHead(404).end('no');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(PORT, r));

const profile = `${WORK}/profile`;
/**
 * ⚠ **同梱のブラウザを名指す** ── playwright の版が上がると
 * 既定の探し先（`chromium_headless_shell-<版>`）が実在しなくなり、
 * 「落とせ」と言って止まる（この箱は外へ取りに行けない）。
 * 🔑 解き方は smoke の config と同じ（`tests/smoke/playwright.config.ts`）。
 */
const bundled = process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium';
const launch = existsSync(bundled) ? { executablePath: bundled } : {};
const browser = await chromium.launchPersistentContext(profile, { headless: true, ...launch });
const page = await browser.newPage();
// ⚠ 読めなかった理由を拾う ── 無いと「timeout」だけが残る
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [browser]', m.text());
});
page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
page.on('requestfailed', (r) => console.error('  [failed]', r.url(), r.failure()?.errorText));
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForFunction(() => globalThis.__pkcDuck !== undefined, null, { timeout: 60_000 });

const root = findBrowserPid(profile);
if (root === null) {
  console.error('🔴 ブラウザの pid が引けない ── 計器が死んでいる(結果は読まない)');
  await browser.close();
  server.close();
  process.exit(1);
}
const mem = () => treeMemoryMb(root);
const settle = async (ms = 2500) => {
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  await new Promise((r) => setTimeout(r, ms));
};

const rows = [];
for (let i = 1; i <= ROUNDS; i += 1) {
  await settle();
  const before = mem();

  await page.evaluate(async () => {
    const { openDuckDb, DuckDbLease } = globalThis.__pkcDuck;
    globalThis.__lease = new DuckDbLease({
      open: () => openDuckDb({ wasmUrl: 'duckdb/duckdb-eh.wasm', workerUrl: 'duckdb/duckdb-browser-eh.worker.js' }),
      idleMs: 60_000,
    });
    globalThis.__answer = await globalThis.__lease.run('select 42 as n');
  });
  const answer = await page.evaluate(() => globalThis.__answer);
  await settle();
  const awake = mem();

  await page.evaluate(() => globalThis.__lease.release());
  await settle(4000);
  const folded = mem();

  rows.push({
    round: i,
    answer: JSON.stringify(answer),
    beforeMb: before.pssMb,
    awakeMb: awake.pssMb,
    foldedMb: folded.pssMb,
    起こした差: +(awake.pssMb - before.pssMb).toFixed(1),
    畳んで返った: +(awake.pssMb - folded.pssMb).toFixed(1),
    返らなかった: +(folded.pssMb - before.pssMb).toFixed(1),
  });
}

await browser.close();
server.close();

console.log('\n=== DuckDB は畳んだら返るか(Pss / MB)===');
console.table(rows);
const last = rows[rows.length - 1];
// ⚠ 空振り防止 ── 答えが返っていない回の数字は読まない
if (!last.answer.includes('42')) {
  console.error('🔴 select 42 が返っていない ── 起こせていないので、上の数字は判定に使えない');
  process.exit(1);
}
console.log(`\n🔑 起こすと +${last.起こした差}MB / 畳むと ${last.畳んで返った}MB 返り、${last.返らなかった}MB 残る`);
