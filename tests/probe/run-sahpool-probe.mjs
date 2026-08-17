/**
 * headless Chromium で sahpool-probe.html を開き、結果 JSON を stdout に出す。
 * 前提: vite dev server が --port 5173 で起動していること。
 * ブラウザは環境同梱の Chromium(PKC3_CHROMIUM で上書き可)。
 */
import { chromium } from '@playwright/test';

// ⚠ `??` ではなく `||` ── **空文字を素通りさせない**(CI が path を取れなかった回に
//    「どのブラウザで測ったか分からないまま緑」になるのを止める)
const executablePath = process.env.PKC3_CHROMIUM || '/opt/pw-browsers/chromium';
const url =
  process.argv[2] ?? 'http://localhost:5173/tests/probe/sahpool-probe.html';

const browser = await chromium.launch({ executablePath });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(url);
  const handle = await page.waitForFunction(() => window.__PROBE_RESULT__, null, {
    timeout: 30_000,
  });
  const result = await handle.jsonValue();
  console.log(JSON.stringify(result, null, 2));
  // ok:false を exit 0 で握りつぶさない ── CI step は exit code しか見ない
  if (!result || result.ok !== true) process.exitCode = 1;
} finally {
  await browser.close();
}
