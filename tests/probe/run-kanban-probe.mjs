/**
 * P3-6 DoD probe: 15,000 件(うち 1,500 件がチェックリストを持つ)で
 * kanban / calendar を駆動。
 *   1. 面が出るまで(同期)と、**札が立つまで**(worker の走査を含む)を**別々に**
 *   2. チェックの実クリック → 書換 → 札が列を移る往復時間と、他の札のノード同一性
 *   3. calendar 初回描画時間
 * 前提: vite --port 45731 起動済み。persistent profile(実 OPFS)。値は向きの参考。
 *
 * 🔴 **札の出所が変わった**(2026-08-19、#277 段②-b)。
 * 札は「`todo` アーキタイプのノート」ではなく**本文のチェック項目**になり、
 * 集めるのは **storage worker** である ── だから
 * ⚠ fixture の本文に `- [ ]` が無いと盤面は 0 枚になり
 *   (`sidebar-probe.html` が 10 件に 1 件それを書く)、
 * ⚠ 「初回描画」は**同期では終わらない**(往復を含む量を別の名前で出す)。
 *
 * 🔴 **切替は押さずに dispatch する**(2026-08-17、#221 の巻き添えで判明)。
 *
 * ⚠ 直すまでこの probe は `q('[data-pkc-view="kanban"]').click()` が **null** で
 * 落ちていた。#59(2026-08-04)で kanban / calendar は**封印**され、切替ボタンは
 * 出ないのが正しかったからである。⚠ **13 晩 1 度も走っていなかった**ので
 * 気づかなかった(手前の probe が落ちると後続 step が skip される作りだった)。
 *
 * 🔑 **封印は 2026-08-19 に解けたが、ここは変えない** ── 解いた形は
 * **組み込みタイル**であって帯の切替ではないので、帯のボタンは**今も無いのが正しい**
 * (`bandHasNoBoard` がその tripwire。導線そのものは
 * `tests/smoke/kanban.smoke.spec.ts` が実クリックで見る)。
 */
import { chromium } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { waitForRows } from './browse-face.mjs';

const PORT = Number(process.env.PKC3_BENCH_PORT ?? 45731);
const PROFILE_DIR =
  process.env.PKC3_PROFILE_DIR ?? join(tmpdir(), 'pkc3-bench-profile');
// ⚠ `??` ではなく `||` ── **空文字を素通りさせない**(CI が path を取れなかった回に
//    「どのブラウザで測ったか分からないまま緑」になるのを止める)
const executablePath = process.env.PKC3_CHROMIUM || '/opt/pw-browsers/chromium';

rmSync(PROFILE_DIR, { recursive: true, force: true });
mkdirSync(PROFILE_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE_DIR, { executablePath });
try {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://localhost:${PORT}/tests/probe/sidebar-probe.html`);
  await page.waitForFunction(() => window.__APP__, null, { timeout: 120_000 });
  // 🔴 面を名指ししない(#265)── 既定のタブが入れ替わると hidden 側を見る
  await waitForRows(page, 15000);

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

    /**
     * 0. 前提 ── **切替は上の帯に無い**(#277 段②-b で封印を解いた後も同じ)。
     *
     * ⚠ 解いた形は**組み込みタイル**であって帯の切替ではないので、
     *   `[data-pkc-view="kanban"]` は**今も無いのが正しい**。
     * ⚠ **不在の検査は、観測点が死んでも真になる** ── だから
     *   「封印外の view が在ること」を同時に見る(positive control)。
     */
    const viewButtonsAlive = q('[data-pkc-view="settings"]') !== null;
    const bandHasNoBoard =
      viewButtonsAlive &&
      q('[data-pkc-view="kanban"]') === null &&
      q('[data-pkc-view="calendar"]') === null;
    // ⚠ 器は boot から常駐している(`center.ts` が 7 枚まとめて作る)ので、
    //    「在ること」は切替の証拠にならない ── `hidden` の遷移で見る
    const kanbanWasHidden = pane('kanban')?.hidden === true;

    /**
     * 1. 🔴 **2 つの量を分けて測る**(#277 段②-b で札の出所が変わった)。
     *
     * ⚠ 直す前の `kanbanFirstRenderMs` は「dispatch が返るまで」= **同期の描画**
     *   だけを測っていた。いまは札を **storage worker が集める**ので、
     *   同じ名前で出すと**worker の往復を測っていないのに「初回描画」と名乗る**
     *   (CLAUDE.md §4「計器の名前が、計器の見ている範囲より広い」)。
     * 🔑 だから 2 つ出す:
     *   - `paneShownMs` … 面が出るまで(同期。器と列だけ)
     *   - `cardsReadyMs` … **札が 1 枚立つまで**(worker の走査を含む)
     */
    let t0 = performance.now();
    window.__APP__.dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'kanban' });
    const paneShownMs = +(performance.now() - t0).toFixed(1);
    const kanbanShown = pane('kanban')?.hidden === false;
    const cardsCame = await until(
      () => q('[data-pkc-region="kanban-cards"] [data-pkc-entry]') !== null,
    );
    const cardsReadyMs = +(performance.now() - t0).toFixed(1);
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
    if (!cardsCame)
      return { error: '札が 1 枚も立たない ── 走査が返っていないか、本文に項目が無い', kanbanShown };
    const cardCount = openCol.children.length + doneCol.children.length;

    /**
     * 2. トグル往復。⚠ **押すのは本物の checkbox**(`data-pkc-task-line`)。
     * 🔑 狙うのは `e0`(fixture は 10 件に 1 件チェックリストを持つ)の**先頭の項目**。
     */
    const others = [...openCol.children].slice(1, 50); // 同一性照合サンプル
    const firstCard = openCol.querySelector('[data-pkc-entry="e0"]');
    const toggle = firstCard?.querySelector('[data-pkc-action="toggle-task"]');
    if (!toggle)
      return { error: 'e0 の札が無い ── 走査の順が変わったか、項目が拾えていない', cardCount, kanbanShown };
    const line = toggle.getAttribute('data-pkc-task-line');
    t0 = performance.now();
    toggle.click();
    const moved = await until(
      () =>
        q(
          `[data-pkc-kanban-status="done"] [data-pkc-entry="e0"] [data-pkc-task-line="${line}"]`,
        ) !== null,
    );
    const toggleRoundtripMs = +(performance.now() - t0).toFixed(1);
    /**
     * 🔴 **器は毎回引き直す**(sidebar / editor で `listSameNode` を足したのと同じ理由。
     * 2026-08-17 のレビュー ⚠-9 =「1 巡目の修正は 2 巡目の対象」)。掴んだままの
     * `openCol` の子を数えると、列ごと差し替えられたとき**外れた古い列**を見て
     * 「他のカードは無傷」という嘘の緑になる。
     */
    const openColNow = q('[data-pkc-kanban-status="open"] [data-pkc-region="kanban-cards"]');
    const colSameNode = openColNow === openCol;
    const othersIntact =
      openColNow !== null &&
      others.every((el, i) => [...openColNow.children].slice(0, 49)[i] === el);
    /** 🔑 押した札の**本文が実際に変わった**か(見た目だけ動いていないか)。 */
    const scan = window.__APP__.dispatcher.getState().taskScan;
    const toggledDone =
      scan?.cards.find((c) => c.lid === 'e0' && String(c.line) === line)?.done === true;

    // 3. calendar 初回描画
    t0 = performance.now();
    window.__APP__.dispatcher.dispatch({ type: 'SET_VIEW_MODE', mode: 'calendar' });
    const calendarFirstRenderMs = +(performance.now() - t0).toFixed(1);
    const calendarShown = pane('calendar')?.hidden === false;
    const gridReady = q('[data-pkc-region="calendar-grid"]') !== null;

    return {
      bandHasNoBoard,
      viewButtonsAlive,
      colSameNode,
      kanbanWasHidden,
      kanbanShown,
      paneShownMs,
      cardsReadyMs,
      cardCount,
      /** ⚠ 上限で切ったか(切っていたら `cardCount` は「全部」ではない)。 */
      truncated: scan?.truncated ?? null,
      scannedNotes: scan?.scannedNotes ?? null,
      totalNotes: scan?.totalNotes ?? null,
      moved,
      toggleRoundtripMs,
      othersIntact,
      toggledDone,
      calendarFirstRenderMs,
      calendarShown,
      gridReady,
      storageVfs: window.__APP__.storageVfs,
    };
  });

  const ok =
    !result.error &&
    result.bandHasNoBoard &&
    result.kanbanWasHidden &&
    result.kanbanShown &&
    result.cardCount > 0 &&
    result.moved &&
    result.othersIntact &&
    result.colSameNode &&
    result.toggledDone &&
    result.calendarShown &&
    result.gridReady &&
    result.storageVfs === 'opfs-sahpool';
  console.log(JSON.stringify({ ok, result }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  await context.close();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
}
