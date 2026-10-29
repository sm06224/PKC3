/**
 * 計器: **左の一覧が、本文を打つ重さ・↓ で行を送る重さに足す分**(#1087 台帳④ の残り)。
 *
 * 主張(測る前に 1 行): 「3,000 件の一覧が出ているとき、本文 200 字を打つメインスレッドの時間が、
 * 一覧を隠したときより長い。一覧を画面に見えている行だけにすると、その差が縮む」。
 *
 * 🔑 対照群 = 測りたい操作以外を全部同じにしたもの ── 同じビルド・同じ本文・同じ打鍵で、
 *   `arm=list`(そのまま)と `arm=hidden`(一覧を `display: none`)を **交互に** 回す。
 * ⚠ 指標は CDP `Performance.getMetrics` の差分(TaskDuration / ScriptDuration / LayoutDuration /
 *   RecalcStyleDuration と各回数)。⚠ 画面はソフトウェア描画なので絶対値は実機の GPU と違う ── 向きだけ信頼し、倍率は書かない。
 * ⚠ fixture は 3,000 件 × 本文 1 段落(`left-list-bench.html`)。履歴 0 / 添付 0 / 関連 0 は測っていない次元。
 * 計器の自己検査: 打った字が `row-source` に実際に入った数(`typed`)を出す ── 0 なら計器が死んでいる。
 *
 * 使い方: npx vite --port 48210 --strictPort &
 *         node tests/bench/run-left-list-type.mjs --port=48210 --rounds=3
 */
import { chromium } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const PORT = Number(args.port ?? 48210);
const ROUNDS = Number(args.rounds ?? 3);
const CHARS = Number(args.chars ?? 200);
const KEYS = Number(args.keys ?? 30);
const executablePath = process.env.PKC3_CHROMIUM || '/opt/pw-browsers/chromium';
const PROFILE_DIR = join(tmpdir(), 'pkc3-left-list-bench');

rmSync(PROFILE_DIR, { recursive: true, force: true });
mkdirSync(PROFILE_DIR, { recursive: true });

async function metrics(cdp) {
  const { metrics: m } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(m.map((x) => [x.name, x.value]));
}
const diff = (a, b) => ({
  taskMs: Math.round((b.TaskDuration - a.TaskDuration) * 1000),
  scriptMs: Math.round((b.ScriptDuration - a.ScriptDuration) * 1000),
  layoutMs: Math.round((b.LayoutDuration - a.LayoutDuration) * 1000),
  styleMs: Math.round((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000),
  layouts: b.LayoutCount - a.LayoutCount,
  styles: b.RecalcStyleCount - a.RecalcStyleCount,
});

const ROW = '[data-pkc-region="filer-table"] tbody [data-pkc-entry]';
const context = await chromium.launchPersistentContext(PROFILE_DIR, { executablePath });
try {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://localhost:${PORT}/tests/bench/left-list-bench.html`);
  await page.waitForSelector('[data-pkc-boot="ready"]', { timeout: 180_000 });
  await page.waitForSelector(ROW, { timeout: 60_000 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const rowsMounted = await page.evaluate((sel) => document.querySelectorAll(sel).length, ROW);
  console.log(`[bench] 組まれている行 = ${rowsMounted}`);

  for (let round = 0; round < ROUNDS; round += 1) {
    for (const arm of round % 2 === 0 ? ['list', 'hidden'] : ['hidden', 'list']) {
      await page.reload();
      await page.waitForSelector('[data-pkc-boot="ready"]', { timeout: 180_000 });
      await page.waitForSelector(ROW, { timeout: 60_000 });
      // ── ↓ で行を送る(一覧を見せたまま)
      let nav = null;
      if (arm === 'list') {
        await page.click(ROW);
        await page.waitForTimeout(300);
        const a = await metrics(cdp);
        for (let i = 0; i < KEYS; i += 1) {
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(40);
        }
        const b = await metrics(cdp);
        const d = diff(a, b);
        nav = {
          taskMsPerKey: +(d.taskMs / KEYS).toFixed(1),
          stylesPerKey: +(d.styles / KEYS).toFixed(1),
          layoutsPerKey: +(d.layouts / KEYS).toFixed(1),
        };
      }
      // ── 本文を打つ
      await page.click(ROW);
      await page.waitForSelector('[data-pkc-action="start-edit"]', { timeout: 20_000 });
      await page.click('[data-pkc-action="start-edit"]');
      await page.waitForSelector('[data-pkc-region="editor-live"] h1', { timeout: 30_000 });
      await page.click('[data-pkc-region="editor-live"] h1');
      await page.waitForSelector('[data-pkc-field="row-source"]');
      await page.evaluate(() => {
        const ta = document.querySelector('[data-pkc-field="row-source"]');
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
      if (arm === 'hidden')
        await page.addStyleTag({ content: '[data-pkc-region="filer-table"]{display:none !important}' });
      await page.waitForTimeout(500);
      const a = await metrics(cdp);
      await page.keyboard.type('あ'.repeat(CHARS), { delay: 0 });
      await page.waitForTimeout(200);
      const b = await metrics(cdp);
      const typed = await page.evaluate(
        () => document.querySelector('[data-pkc-field="row-source"]')?.value.length ?? 0,
      );
      console.log(JSON.stringify({ arm, round, typed, ...diff(a, b), nav }));
    }
  }
} finally {
  await context.close();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
}
