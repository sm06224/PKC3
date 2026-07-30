/**
 * 多重タブ writer リースの probe:
 *   tab1 が即取得 + opfs-sahpool init → tab2 は immediate=false で待機 →
 *   tab1 close で tab2 が昇格し、opfs-sahpool で init できることを確認する。
 * 前提: vite が --port 45731 で起動していること(同一 origin = 同一 lock scope)。
 */
import { chromium } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = Number(process.env.PKC3_BENCH_PORT ?? 45731);
const PROFILE_DIR = '/home/user/PKC3/.lease-profile';
const executablePath = process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium';
const URL_ = `http://localhost:${PORT}/tests/probe/lease-probe.html`;

rmSync(PROFILE_DIR, { recursive: true, force: true });
mkdirSync(PROFILE_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE_DIR, { executablePath });
const steps = {};
try {
  const tab1 = await context.newPage();
  await tab1.goto(URL_);
  await tab1.waitForFunction(() => window.__LEASE__);
  steps.tab1Acquire = await tab1.evaluate(() => window.__LEASE__.tryAcquire());
  steps.tab1Init = await tab1.evaluate(() => window.__LEASE__.initStore());

  const tab2 = await context.newPage();
  await tab2.goto(URL_);
  await tab2.waitForFunction(() => window.__LEASE__);
  steps.tab2Acquire = await tab2.evaluate(() => window.__LEASE__.tryAcquire());

  // tab1 を閉じる → lock 自動解放 + worker 終了で SAH も解放される
  await tab1.close();
  steps.tab2Held = await tab2.evaluate(() => window.__LEASE__.waitHeld());
  await new Promise((r) => setTimeout(r, 500)); // SAH 解放の settle 待ち
  steps.tab2Init = await tab2.evaluate(() => window.__LEASE__.initStore());
  await tab2.evaluate(() => window.__LEASE__.closeAll());

  const ok =
    steps.tab1Acquire.immediate === true &&
    steps.tab1Init.vfs === 'opfs-sahpool' &&
    steps.tab2Acquire.immediate === false &&
    steps.tab2Acquire.state === 'waiting' &&
    steps.tab2Held.state === 'held' &&
    steps.tab2Init.vfs === 'opfs-sahpool';
  console.log(JSON.stringify({ ok, steps }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  await context.close();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
}
