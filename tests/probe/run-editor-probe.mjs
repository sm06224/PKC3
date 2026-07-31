/**
 * P3-5 probe: 15,000 件 DB + 実アプリで editor を実 UI 経路(クリック / input
 * イベント)で駆動し、以下を確認する。
 *   1. 打鍵(input → UPDATE_OPEN_BODY dispatch)の同期コスト p50/p95
 *      ── 小 body と 200KB body の両方(value 読取は O(body) なので次元を潰さない)
 *   2. 打鍵中に textarea ノードが作り直されない(編集中ガードの実ブラウザ確認)
 *   3. 保存クリック → view 再描画 → サイドバー行ノード同一性の維持
 * 前提: vite --port 45731 起動済み。persistent profile(実 OPFS)。
 * 計測規律: 値は向きの参考(p50/p95/max ms)。IME composition は未模擬(未計測次元)。
 */
import { chromium } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = Number(process.env.PKC3_BENCH_PORT ?? 45731);
const PROFILE_DIR =
  process.env.PKC3_PROFILE_DIR ?? join(tmpdir(), 'pkc3-bench-profile');
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

  await page.evaluate(() => {
    window.__ROWS_BEFORE__ = Array.from(document.querySelectorAll('[data-pkc-entry]'));
  });

  // 実クリックで選択 → 編集開始(binder 経路)
  await page.click('[data-pkc-entry="e42"]');
  await page.waitForFunction(
    () => window.__APP__.dispatcher.getState().openBody?.lid === 'e42',
    null,
    { timeout: 10_000 },
  );
  await page.click('[data-pkc-action="start-edit"]');

  // 打鍵計測本体(小 body → 200KB body の 2 段)
  const result = await page.evaluate(async () => {
    const d = window.__APP__.dispatcher;
    const ta0 = document.querySelector('[data-pkc-field="editor-body"]');
    if (!ta0) return { error: 'textarea not found' };

    // withDispatch=false が対照群: value append(DOM 書込)だけを行う。
    // 差分の向きが「input handler(value 読取 + reduce + listener 群)」の寄与
    const typeBatch = (ta, n, withDispatch) => {
      const durs = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        ta.value += 'あ';
        if (withDispatch)
          ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
        durs.push(performance.now() - t0);
      }
      durs.sort((a, b) => a - b);
      const pick = (q) => durs[Math.min(durs.length - 1, Math.floor(durs.length * q))];
      return {
        n,
        p50: +pick(0.5).toFixed(3),
        p95: +pick(0.95).toFixed(3),
        max: +durs[durs.length - 1].toFixed(3),
      };
    };

    const small = typeBatch(ta0, 300, true);
    const sameNodeAfterSmall = document.querySelector('[data-pkc-field="editor-body"]') === ta0;
    const stateSyncedSmall = d.getState().openBody.body.length === ta0.value.length;

    // 200KB body 次元(value 読取が O(body) ── ゼロ次元を作らない)
    ta0.value = 'x'.repeat(200_000);
    ta0.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const largeControl = typeBatch(ta0, 300, false); // 対照: append のみ
    const large = typeBatch(ta0, 300, true);
    const sameNodeAfterLarge = document.querySelector('[data-pkc-field="editor-body"]') === ta0;

    return {
      small,
      large,
      largeControl,
      sameNodeAfterSmall,
      sameNodeAfterLarge,
      stateSyncedSmall,
    };
  });

  // 保存(実クリック)→ view 復帰 → サイドバー行同一性
  const t0 = Date.now();
  await page.click('[data-pkc-action="commit-edit"]');
  await page.waitForFunction(
    () => document.querySelector('[data-pkc-field="detail-body"]') !== null,
    null,
    { timeout: 10_000 },
  );
  const commitToViewMs = Date.now() - t0;

  const post = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 300)); // persist 完了待ち
    const after = Array.from(document.querySelectorAll('[data-pkc-entry]'));
    const before = window.__ROWS_BEFORE__;
    let identical = after.length === before.length;
    if (identical) {
      for (let i = 0; i < after.length; i++) {
        if (after[i] !== before[i]) { identical = false; break; }
      }
    }
    const s = window.__APP__.dispatcher.getState();
    return {
      rowsIdenticalThroughEditCycle: identical,
      persistedAck: s.openBody?.persisted === s.openBody?.body,
      phase: s.phase,
      storageVfs: window.__APP__.storageVfs,
    };
  });

  const ok =
    !result.error &&
    result.sameNodeAfterSmall &&
    result.sameNodeAfterLarge &&
    result.stateSyncedSmall &&
    post.rowsIdenticalThroughEditCycle &&
    post.persistedAck &&
    post.phase === 'ready' &&
    post.storageVfs === 'opfs-sahpool';
  console.log(JSON.stringify({ ok, typing: result, commitToViewMs, post }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  await context.close();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
}
