/**
 * P3-2 DoD probe: 15,000 件 seed 済み DB で実アプリを boot し、
 * 選択(実クリック)→ 編集開始 → 入力 → 確定 を通して
 * **サイドバー行の DOM ノードが 1 つも作り直されない**ことを assert する。
 * 前提: vite --port 45731 起動済み。persistent profile(実 OPFS)。
 */
import { chromium } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';

const PORT = Number(process.env.PKC3_BENCH_PORT ?? 45731);
const PROFILE_DIR = '/home/user/PKC3/.bench-profile';
const executablePath = process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium';

rmSync(PROFILE_DIR, { recursive: true, force: true });
mkdirSync(PROFILE_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE_DIR, { executablePath });
try {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://localhost:${PORT}/tests/probe/sidebar-probe.html`);
  await page.waitForFunction(() => window.__APP__, null, { timeout: 120_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-pkc-entry]').length >= 15000,
    null,
    { timeout: 60_000 },
  );

  const steps = await page.evaluate(async () => {
    const t0 = window.__BOOT_T0__;
    const bootToRowsMs = Math.round(performance.now() - t0);
    const rows = Array.from(document.querySelectorAll('[data-pkc-entry]'));
    // 行ノードの同一性を後で照合するため WeakSet ではなく直接参照で保持
    window.__ROWS_BEFORE__ = rows;
    return { rowCount: rows.length, bootToRowsMs };
  });

  // 実クリックで選択(binder 経路を通す)
  await page.click('[data-pkc-entry="e42"]');
  await page.waitForFunction(
    () => window.__APP__.dispatcher.getState().openBody?.lid === 'e42',
    null,
    { timeout: 10_000 },
  );

  const result = await page.evaluate(async () => {
    const d = window.__APP__.dispatcher;
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# entry 42\n\n編集後の本文' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await new Promise((r) => setTimeout(r, 300)); // persist 完了待ち
    const after = Array.from(document.querySelectorAll('[data-pkc-entry]'));
    const before = window.__ROWS_BEFORE__;
    let identical = after.length === before.length;
    if (identical) {
      for (let i = 0; i < after.length; i++) {
        if (after[i] !== before[i]) {
          identical = false;
          break;
        }
      }
    }
    const state = d.getState();
    return {
      rowsIdenticalThroughEditCycle: identical,
      selectedMarked:
        document.querySelector('[data-pkc-entry="e42"]')?.hasAttribute('data-pkc-selected') ?? false,
      committedBaseline: state.openBody?.baseline?.includes('編集後') ?? false,
      phase: state.phase,
    };
  });

  const ok =
    steps.rowCount === 15000 &&
    result.rowsIdenticalThroughEditCycle &&
    result.selectedMarked &&
    result.committedBaseline &&
    result.phase === 'ready';
  console.log(JSON.stringify({ ok, steps, result }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  await context.close();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
}
