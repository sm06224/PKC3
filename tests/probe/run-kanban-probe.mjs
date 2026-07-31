/**
 * P3-6 DoD probe: 15,000 件(うち todo 1,500)で kanban / calendar を実 UI 経路で駆動。
 *   1. kanban 初回描画時間(view 切替クリック → 列にカードが立つまで)
 *   2. トグル実クリック → store 書込 → カード移動の往復時間と、他カードのノード同一性
 *   3. calendar 初回描画時間
 * 前提: vite --port 45731 起動済み。persistent profile(実 OPFS)。値は向きの参考。
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

  const result = await page.evaluate(async () => {
    const q = (sel) => document.querySelector(sel);
    const until = async (pred) => {
      for (let i = 0; i < 200; i++) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    };

    // 1. kanban 初回描画(同期 render なので click 前後の壁時計)
    let t0 = performance.now();
    q('[data-pkc-view="kanban"]').click();
    const kanbanFirstRenderMs = +(performance.now() - t0).toFixed(1);
    const openCol = q('[data-pkc-kanban-status="open"] [data-pkc-region="kanban-cards"]');
    const cardCount = openCol.children.length +
      q('[data-pkc-kanban-status="done"] [data-pkc-region="kanban-cards"]').children.length;

    // 2. トグル往復(e0 は todo: i%10===0)
    const others = [...openCol.children].slice(1, 50); // 同一性照合サンプル
    t0 = performance.now();
    q('[data-pkc-entry="e0"] [data-pkc-action="toggle-todo"]').click();
    const moved = await until(() =>
      q('[data-pkc-kanban-status="done"] [data-pkc-entry="e0"]') !== null,
    );
    const toggleRoundtripMs = +(performance.now() - t0).toFixed(1);
    const othersIntact = others.every((el, i) => [...openCol.children].slice(0, 49)[i] === el);
    const state = window.__APP__.dispatcher.getState();

    // 3. calendar 初回描画
    t0 = performance.now();
    q('[data-pkc-view="calendar"]').click();
    const calendarFirstRenderMs = +(performance.now() - t0).toFixed(1);
    const gridReady = q('[data-pkc-region="calendar-grid"]') !== null;

    return {
      kanbanFirstRenderMs,
      cardCount,
      moved,
      toggleRoundtripMs,
      othersIntact,
      toggledStatus: state.entryMetas.get('e0')?.status,
      calendarFirstRenderMs,
      gridReady,
      storageVfs: window.__APP__.storageVfs,
    };
  });

  const ok =
    result.cardCount === 1500 &&
    result.moved &&
    result.othersIntact &&
    result.toggledStatus === 'done' &&
    result.gridReady &&
    result.storageVfs === 'opfs-sahpool';
  console.log(JSON.stringify({ ok, result }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  await context.close();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
}
