/**
 * PKC3 計器 2: assets 次元 ── IDB Blob storage の RSS ±0 検証(設計 doc §4.2)。
 * PKC2 実測(base64 200MB 読出 +293MB 常駐 vs Blob ±0)の PKC3 側の再確認。
 * persistent profile / 固定ポート / diskstats は計器 1 と同じ規律。
 *
 * 使い方: vite --port 45731 起動後に
 *   node tests/bench/run-asset-blob.mjs --count=60 --size=5 --reads=20
 */
import { chromium } from '@playwright/test';
import { readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const COUNT = Number(args.count ?? 60);
const SIZE_MB = Number(args.size ?? 5);
const READS = Number(args.reads ?? 20);
const PORT = Number(args.port ?? 45731);
const PROFILE_DIR = args.profile ?? '/home/user/PKC3/.bench-profile';
const executablePath = process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium';

function sectorsWritten() {
  let total = 0;
  for (const line of readFileSync('/proc/diskstats', 'utf8').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const dev = f[2];
    if (/^(loop|ram|zram)/.test(dev)) continue;
    if (/\d+p?\d+$/.test(dev)) continue;
    total += Number(f[9]);
  }
  return total;
}
const mb = (sectors) => +((sectors * 512) / (1024 * 1024)).toFixed(1);

function rssOfProfileMb() {
  let total = 0;
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmd.includes(PROFILE_DIR)) continue;
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/VmRSS:\s+(\d+) kB/);
      if (m) total += Number(m[1]);
    } catch {
      /* process exit race */
    }
  }
  return +(total / 1024).toFixed(1);
}

rmSync(PROFILE_DIR, { recursive: true, force: true });
mkdirSync(PROFILE_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE_DIR, { executablePath });
try {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://localhost:${PORT}/tests/bench/asset-blob.html`);
  await page.waitForFunction(() => window.__ASSETS__);

  const init = await page.evaluate(() => window.__ASSETS__.init());
  const rssBase = rssOfProfileMb();

  const w0 = sectorsWritten();
  const seed = await page.evaluate(
    ({ c, s }) => window.__ASSETS__.seed(c, s),
    { c: COUNT, s: SIZE_MB },
  );
  const w1 = sectorsWritten();
  const rssAfterSeed = rssOfProfileMb();

  // GC を挟んで定常へ寄せる(数値は向きのみで解釈)
  await new Promise((r) => setTimeout(r, 2000));
  const rssSettled = rssOfProfileMb();

  const reads = await page.evaluate(
    ({ k, c }) => window.__ASSETS__.readLoop(k, c),
    { k: READS, c: COUNT },
  );
  const rssAfterReads = rssOfProfileMb();
  const metas = await page.evaluate(() => window.__ASSETS__.metas());
  await page.evaluate(() => window.__ASSETS__.closeAll());

  console.log(
    JSON.stringify(
      {
        fixture: { count: COUNT, sizeMB: SIZE_MB, logicalMB: COUNT * SIZE_MB, reads: READS },
        init: { vfs: init.vfs, journalMode: init.journalMode },
        seed: { ...seed, diskWriteMB: mb(w1 - w0) },
        reads,
        metas,
        rssMB: {
          base: rssBase,
          afterSeed: rssAfterSeed,
          settled: rssSettled,
          afterReads: rssAfterReads,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
}
