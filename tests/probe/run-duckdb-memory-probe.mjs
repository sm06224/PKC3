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
import { profileMemoryMb, findBrowserPid } from '../helpers/proc-memory.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const ROUNDS = Number(args.rounds ?? 3);
const WORK = '/tmp/claude-0/duckdb-mem-probe';
/**
 * 🔴 **port は OS に選ばせる**（既定 0）。
 * ⚠ 固定にしていた頃、**前の走りが握ったまま**だと
 *   `EADDRINUSE` で落ちた ── しかも直すには名前でプロセスを探すことになり、
 *   その grep は**自分の命令行にも当たる**（CLAUDE.md §6）。
 * 🔑 0 にすればこの経路が**構造から消える**。
 */
const PORT = Number(args.port ?? 0);

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
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const port = server.address().port;

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
// ⚠ 404 は requestfailed には来ない ── **どの URL が無いのか**を出さないと、
//   「404」だけが残って次に読む人が同じ所で止まる。
page.on('response', (r) => {
  if (r.status() >= 400) console.error('  [http]', r.status(), r.url());
});
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => globalThis.__pkcDuck !== undefined, null, { timeout: 60_000 });

if (findBrowserPid(profile) === null) {
  console.error('🔴 ブラウザの pid が引けない ── 計器が死んでいる(結果は読まない)');
  await browser.close();
  server.close();
  process.exit(1);
}
/**
 * 🔑 **profile で選ぶ**(木で辿らない)── Chromium の描画プロセスは zygote 経由で
 * 親が付け替わるので、木では取りこぼす(実測で 200MB が **−2.2MB** に見えた)。
 */
const mem = () => profileMemoryMb(profile);
const settle = async (ms = 2500) => {
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  await new Promise((r) => setTimeout(r, ms));
};

/**
 * 🔴 **対照群①:計器が動くことを先に見る**(CLAUDE.md §4)。
 *
 * ⚠ これが無いと「DuckDB は軽かった」と「計器が見ていない」を**区別できない** ──
 * 1 回目の走りで実際に **+0.2MB** が出て、どちらか読めなかった。
 * 🔑 200MB を確保して**触る**(触らないと確保されただけで常駐に出ない)。
 */
await settle();
const ctlBefore = mem();
console.log(`[診断] profile を握るプロセス ${ctlBefore.procs} 個 / Pss ${ctlBefore.pssMb}MB`);
await page.evaluate(() => {
  const N = 200 * 1024 * 1024;
  const b = new Uint8Array(N);
  for (let i = 0; i < N; i += 4096) b[i] = 1;
  globalThis.__ballast = b;
});
await settle();
const ctlAwake = mem();
await page.evaluate(() => {
  delete globalThis.__ballast;
});
await settle(4000);
const ctlFreed = mem();
const ctlRise = +(ctlAwake.pssMb - ctlBefore.pssMb).toFixed(1);
console.log(`\n[対照群] 200MB を確保して触る → +${ctlRise}MB / 捨てると ${+(ctlAwake.pssMb - ctlFreed.pssMb).toFixed(1)}MB 返る`);
if (ctlRise < 100) {
  console.error(`🔴 計器が動いていない ── 200MB 確保して +${ctlRise}MB しか出ない。以降の数字は読まない`);
  await browser.close();
  server.close();
  process.exit(1);
}

const rows = [];
for (let i = 1; i <= ROUNDS; i += 1) {
  await settle();
  const before = mem();

  await page.evaluate(async () => {
    const { openDuckDb, DuckDbLease } = globalThis.__pkcDuck;
    globalThis.__lease = new DuckDbLease({
      open: () => openDuckDb({ wasmUrl: '/duckdb/duckdb-eh.wasm', workerUrl: '/duckdb/duckdb-browser-eh.worker.js' }),
      idleMs: 60_000,
    });
    // 🔴 **設計 doc と同じ仕事に揃える**(+182.5MB は 10 万行の集計で測った値)。
    //   ⚠ `select 42` はデータを 1 行も読まないので、比べる相手になっていなかった。
    globalThis.__answer = await globalThis.__lease.run(
      'select k % 100 as g, count(*) as c, sum(k) as s from range(100000) t(k) group by 1 order by 1 limit 3',
    );
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
if (!last.answer.includes('"c"')) {
  console.error('🔴 集計が返っていない ── 起こせていないので、上の数字は判定に使えない');
  process.exit(1);
}
console.log(`\n🔑 起こすと +${last.起こした差}MB / 畳むと ${last.畳んで返った}MB 返り、${last.返らなかった}MB 残る`);
