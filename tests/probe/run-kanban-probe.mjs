/**
 * P3-6 DoD probe: 15,000 件(うち todo 1,500)で kanban / calendar を駆動。
 *   1. kanban 初回描画時間(切替 → 列にカードが立つまで)
 *   2. トグル実クリック → store 書込 → カード移動の往復時間と、他カードのノード同一性
 *   3. calendar 初回描画時間
 * 前提: vite --port 45731 起動済み。persistent profile(実 OPFS)。値は向きの参考。
 *
 * 🔴 **切替は押さずに dispatch する**(2026-08-17、#221 の巻き添えで判明)。
 *
 * ⚠ 直すまでこの probe は `q('[data-pkc-view="kanban"]').click()` が **null** で
 * 落ちていた。#59(2026-08-04)で kanban / calendar は**封印**され
 * (`src/features/sealed.ts`「導線は畳む・描画と state は生かす」)、
 * 切替ボタンは**出ないのが正しい**からである。⚠ **13 晩 1 度も走っていなかった**
 * ので気づかなかった(手前の probe が落ちると後続 step が skip される作りだった)。
 *
 * 🔑 だから「押す」のではなく `SET_VIEW_MODE` を投げて、**生きている側**
 * (描画器・state)を測る ── `tests/adapter/kanban-calendar-view.test.ts` と同じ判断。
 * 🔑 そのうえで **`sealedOk` を逆向きの tripwire** にする ── 封印が解けて
 * ボタンが戻ったら probe が落ち、「実クリックへ戻せ」と教える。
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
    (list) => document.querySelectorAll(`${list} [data-pkc-entry]`).length >= 15000,
    '[data-pkc-region="entry-list"]',
    { timeout: 60_000 },
  );

  const result = await page.evaluate(async () => {
    const q = (sel) => document.querySelector(sel);
    const pane = (v) => q(`[data-pkc-view-pane="${v}"]`);
    const until = async (pred) => {
      for (let i = 0; i < 200; i++) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    };

    // 0. 前提 ── 封印中は切替ボタンが**無い**のが正しい(逆向きの tripwire)
    const sealedOk =
      q('[data-pkc-view="kanban"]') === null && q('[data-pkc-view="calendar"]') === null;
    // ⚠ 器は boot から常駐している(`center.ts` が 7 枚まとめて作る)ので、
    //    「在ること」は切替の証拠にならない ── `hidden` の遷移で見る
    const kanbanWasHidden = pane('kanban')?.hidden === true;

    // 1. kanban 初回描画(dispatch は同期 ── 前後の壁時計で測る)
    let t0 = performance.now();
    window.__APP__.dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'kanban' });
    const kanbanFirstRenderMs = +(performance.now() - t0).toFixed(1);
    const kanbanShown = pane('kanban')?.hidden === false;
    const openCol = q('[data-pkc-kanban-status="open"] [data-pkc-region="kanban-cards"]');
    const doneCol = q('[data-pkc-kanban-status="done"] [data-pkc-region="kanban-cards"]');
    /**
     * 🔴 **落ちるときは名前で落ちる**(2026-08-17 の変異試験で判明)。
     * 直す前は列やトグルが無いと `null.click()` の `TypeError` で死んでいた ──
     * 赤の理由が「カードが 1 枚も立っていない」なのか「観測点が変わった」なのか
     * **run を開いても読めない**。CLAUDE.md「落ちたとき原因が名前で分かるか」。
     */
    if (!openCol || !doneCol)
      return { error: 'kanban の列が無い ── 面が描かれていないか、観測点が変わった', kanbanShown };
    const cardCount = openCol.children.length + doneCol.children.length;

    // 2. トグル往復(e0 は todo: i%10===0)
    const others = [...openCol.children].slice(1, 50); // 同一性照合サンプル
    const toggle = q('[data-pkc-entry="e0"] [data-pkc-action="toggle-todo"]');
    if (!toggle)
      return { error: 'e0 のトグルが無い ── カードが立っていない', cardCount, kanbanShown };
    t0 = performance.now();
    toggle.click();
    const moved = await until(() =>
      q('[data-pkc-kanban-status="done"] [data-pkc-entry="e0"]') !== null,
    );
    const toggleRoundtripMs = +(performance.now() - t0).toFixed(1);
    const othersIntact = others.every((el, i) => [...openCol.children].slice(0, 49)[i] === el);
    const state = window.__APP__.dispatcher.getState();

    // 3. calendar 初回描画
    t0 = performance.now();
    window.__APP__.dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'calendar' });
    const calendarFirstRenderMs = +(performance.now() - t0).toFixed(1);
    const calendarShown = pane('calendar')?.hidden === false;
    const gridReady = q('[data-pkc-region="calendar-grid"]') !== null;

    return {
      sealedOk,
      kanbanWasHidden,
      kanbanShown,
      kanbanFirstRenderMs,
      cardCount,
      moved,
      toggleRoundtripMs,
      othersIntact,
      toggledStatus: state.entryMetas.get('e0')?.status,
      calendarFirstRenderMs,
      calendarShown,
      gridReady,
      storageVfs: window.__APP__.storageVfs,
    };
  });

  const ok =
    !result.error &&
    result.sealedOk &&
    result.kanbanWasHidden &&
    result.kanbanShown &&
    result.cardCount === 1500 &&
    result.moved &&
    result.othersIntact &&
    result.toggledStatus === 'done' &&
    result.calendarShown &&
    result.gridReady &&
    result.storageVfs === 'opfs-sahpool';
  console.log(JSON.stringify({ ok, result }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  await context.close();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
}
