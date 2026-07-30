/**
 * PKC3 計器 1: 編集セッション腕(継続使用)+ 保存の実書込量。
 *
 * PKC2 計測規律(perf-measurement)の継承:
 * - **persistent profile 必須**: ephemeral/incognito は storage がメモリバックで
 *   実 I/O を踏まない(PKC2 2026-07-22 計測バグ)。launchPersistentContext を使う
 * - **固定ポート**(既定 45731): ランダムポートは origin が毎回変わり「毎回初回起動」になる
 * - **対照群**: --arm=nosave は body 生成まで同一で保存 request だけ発行しない(Y 腕)。
 *   差し引きの値は「向き」のみ信頼し倍率は書かない
 * - **ゼロ件次元の明記**: 本計器の fixture は revisions / relations / assets が 0 件。
 *   その次元は「測っていない」──主張しない
 * - 実書込は /proc/diskstats(sectors written × 512)。コンテナではホスト装置全体の
 *   値なので、同時に走る他プロセスのノイズを含む ── 絶対値でなく腕間比較に使う
 *
 * 使い方: vite を --port 45731 で起動してから
 *   node tests/bench/run-edit-session.mjs --entries=5000 --edits=100 --arm=save
 */
import { chromium } from '@playwright/test';
import { readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const ENTRIES = Number(args.entries ?? 5000);
const EDITS = Number(args.edits ?? 100);
const INTERVAL_MS = Number(args.interval ?? 50);
const ARM = args.arm === 'nosave' ? 'nosave' : 'save';
const BATCH = Number(args.batch ?? 0);
const REVS = Number(args.revs ?? 0);
const JOURNAL = args.journal ?? 'delete';
const PORT = Number(args.port ?? 45731);
const PROFILE_DIR = args.profile ?? '/home/user/PKC3/.bench-profile';
const executablePath = process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium';

function sectorsWritten() {
  // 物理装置のみ(loop/ram を除外)。field[9] = sectors written
  let total = 0;
  for (const line of readFileSync('/proc/diskstats', 'utf8').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const dev = f[2];
    if (/^(loop|ram|zram)/.test(dev)) continue;
    if (/\d+p?\d+$/.test(dev)) continue; // partition は親 device と二重計上になるので除外
    total += Number(f[9]);
  }
  return total;
}
const mb = (sectors) => +((sectors * 512) / (1024 * 1024)).toFixed(1);

function rssOfProfileMb() {
  // profile dir を cmdline に含むプロセス群(chromium tree)の RSS 合計
  let total = 0;
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmd.includes(PROFILE_DIR)) continue;
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/VmRSS:\s+(\d+) kB/);
      if (m) total += Number(m[1]);
    } catch {
      /* races with process exit are expected */
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
  await page.goto(`http://localhost:${PORT}/tests/bench/edit-session.html`);
  await page.waitForFunction(() => window.__BENCH__);

  const init = await page.evaluate(
    ({ name, journal }) => window.__BENCH__.init(name, journal),
    { name: 'pkc3-bench', journal: JOURNAL },
  );

  const seedW0 = sectorsWritten();
  const seed = await page.evaluate(
    ({ n, batch }) => window.__BENCH__.seed(n, batch),
    { n: ENTRIES, batch: BATCH },
  );
  const seedW1 = sectorsWritten();

  const metas = await page.evaluate(() => window.__BENCH__.metas());

  // revisions 次元(--revs=K で entry あたり K 件を投入し、常駐ゼロ設計を検証)
  let revisions = null;
  if (REVS > 0) {
    const rw0 = sectorsWritten();
    const rssBefore = rssOfProfileMb();
    const seedRevs = await page.evaluate(
      ({ n, per, batch }) => window.__BENCH__.seedRevisions(n, per, batch),
      { n: ENTRIES, per: REVS, batch: Math.max(BATCH, 200) },
    );
    const rw1 = sectorsWritten();
    const stats = await page.evaluate(
      (sid) => window.__BENCH__.revisionStats(sid),
      'r-0-0',
    );
    const rssAfter = rssOfProfileMb();
    revisions = {
      seed: { ...seedRevs, diskWriteMB: mb(rw1 - rw0) },
      stats,
      rssBeforeMB: rssBefore,
      rssAfterStatsMB: rssAfter,
    };
  }

  // 編集セッション腕: RSS を 500ms ごとにサンプルしつつ k 編集
  const rssSeries = [];
  const sampler = setInterval(() => rssSeries.push(rssOfProfileMb()), 500);
  const sesW0 = sectorsWritten();
  const session = await page.evaluate(
    ({ k, n, interval, save }) => window.__BENCH__.editSession(k, n, interval, save),
    { k: EDITS, n: ENTRIES, interval: INTERVAL_MS, save: ARM === 'save' },
  );
  const sesW1 = sectorsWritten();
  clearInterval(sampler);

  await page.evaluate(() => window.__BENCH__.close());

  const sortedRss = [...rssSeries].sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        arm: ARM,
        config: { batch: BATCH, journalRequested: JOURNAL },
        fixture: {
          entries: ENTRIES,
          edits: EDITS,
          intervalMs: INTERVAL_MS,
          revsPerEntry: REVS,
          zeroDims: [...(REVS === 0 ? ['revisions'] : []), 'relations', 'assets'], // 測っていない次元
        },
        init,
        seed: { ...seed, diskWriteMB: mb(seedW1 - seedW0) },
        metas,
        revisions,
        session: { ...session, diskWriteMB: mb(sesW1 - sesW0) },
        rssMB: {
          samples: rssSeries.length,
          median: sortedRss[Math.floor(sortedRss.length / 2)] ?? null,
          max: sortedRss[sortedRss.length - 1] ?? null,
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
