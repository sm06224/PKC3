/**
 * P3-6 DoD probe: 15,000 件(うち 1,500 件が**日付つきのチェックリスト**を持つ)で
 * 左の列の「予定」タブを駆動。
 *   1. タブが出るまで(同期)と、**札が立つまで**(worker の走査を含む)を**別々に**
 *   2. チェックの実クリック → 書換 → 札が消えるまでの往復時間と、他の札のノード同一性
 *   3. 月を送ったときの組み直し時間
 * 前提: vite --port 45731 起動済み。persistent profile(実 OPFS)。値は向きの参考。
 *
 * 🔴 **面が引っ越した**(2026-08-23、#292 段⑤)。カレンダー / やることの板は
 * **中央の面をやめ、左の列の「予定」タブ**になった ── だから
 * ⚠ 駆動は `SET_VIEW_MODE` ではなく **`__APP__.setBrowse('schedule')`** である
 *   (中央の面ではないので `viewMode` は 1 ミリも動かない ── それ自体が主張の 1 つ)。
 *
 * 🔴 **札の出所**(2026-08-19、#277 段②-b)。札は「`todo` アーキタイプのノート」
 * ではなく**本文のチェック項目**で、集めるのは **storage worker** である ── だから
 * ⚠ fixture の本文に `- [ ] … @2026-08-25` が無いと 0 枚になり
 *   (`sidebar-probe.html` が 10 件に 1 件それを書く)、
 * ⚠ 「初回描画」は**同期では終わらない**(往復を含む量を別の名前で出す)。
 *
 * 🔴 **切替は押さずに配線を呼ぶ**(2026-08-17、#221 の巻き添えで判明)。
 * ⚠ ここが見ているのは**量**であって導線ではない ── 導線が実際に効くかは
 *   `tests/smoke/schedule.smoke.spec.ts` が実クリックで見る。
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
    const until = async (pred) => {
      for (let i = 0; i < 200; i++) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    };

    /**
     * 0. 前提 ── **切替は上の帯にも中央にも無い**(#292 段⑤)。
     *
     * ⚠ 予定は**探し方のタブ**なので、`[data-pkc-view="…"]`(中央の面の切替)には
     *   出ないのが正しい。
     * ⚠ **不在の検査は、観測点が死んでも真になる** ── だから
     *   「中央の面の切替が生きていること」を同時に見る(positive control)。
     */
    const viewButtonsAlive = q('[data-pkc-view="settings"]') !== null;
    const bandHasNoBoard =
      viewButtonsAlive &&
      q('[data-pkc-view="kanban"]') === null &&
      q('[data-pkc-view="calendar"]') === null;
    // ⚠ 器は boot から常駐している(`browse.ts` がタブぶんまとめて作る)ので、
    //    「在ること」は切替の証拠にならない ── `hidden` の遷移で見る
    const paneOf = () => q('[data-pkc-browse-pane="schedule"]');
    const scheduleWasHidden = paneOf()?.hidden !== false;
    const viewModeBefore = window.__APP__.dispatcher.getState().viewMode;

    /**
     * 1. 🔴 **2 つの量を分けて測る**(#277 段②-b で札の出所が変わった)。
     *
     * ⚠ 直す前の `kanbanFirstRenderMs` は「dispatch が返るまで」= **同期の描画**
     *   だけを測っていた。いまは札を **storage worker が集める**ので、
     *   同じ名前で出すと**worker の往復を測っていないのに「初回描画」と名乗る**
     *   (CLAUDE.md §4「計器の名前が、計器の見ている範囲より広い」)。
     * 🔑 だから 2 つ出す:
     *   - `paneShownMs` … タブが出るまで(同期。小さな月と器だけ)
     *   - `cardsReadyMs` … **札が 1 枚立つまで**(worker の走査を含む)
     */
    let t0 = performance.now();
    window.__APP__.setBrowse('schedule');
    const paneShownMs = +(performance.now() - t0).toFixed(1);
    const scheduleShown = paneOf()?.hidden === false;
    const cardsCame = await until(
      () => q('[data-pkc-region="schedule-cards"] [data-pkc-entry]') !== null,
    );
    const cardsReadyMs = +(performance.now() - t0).toFixed(1);
    /**
     * 🔴 **本文を占有していない**(#292 段⑤ の主張そのもの)。
     * ⚠ 予定を開いても `viewMode` は動かない ── 動いたら、引っ越しの理由が消える。
     */
    const centerUntouched =
      window.__APP__.dispatcher.getState().viewMode === viewModeBefore &&
      q('[data-pkc-view-pane="detail"]')?.hidden === false;

    const groups = [...document.querySelectorAll('[data-pkc-region="schedule-group"]')];
    /**
     * 🔴 **落ちるときは名前で落ちる**(2026-08-17 の変異試験で判明)。
     * 直す前は器が無いと `null.click()` の `TypeError` で死んでいた ──
     * 赤の理由が「カードが 1 枚も立っていない」なのか「観測点が変わった」なのか
     * **run を開いても読めない**。CLAUDE.md「落ちたとき原因が名前で分かるか」。
     */
    if (groups.length === 0)
      return { error: '予定の束が 1 つも無い ── 面が描かれていないか、観測点が変わった', scheduleShown };
    /** ⚠ どの日に散ったか(束が潰れたときに「何日ぶんか」が読めるように出す)。 */
    const groupDates = groups.map((g) => g.getAttribute('data-pkc-drop-date'));
    if (!cardsCame)
      return { error: '札が 1 枚も立たない ── 走査が返っていないか、本文に日付つきの項目が無い', scheduleShown };
    const host = groups[0].querySelector('[data-pkc-region="schedule-cards"]');
    if (!host)
      return { error: '束の中に札の器が無い ── 観測点が変わった', scheduleShown };
    const cardCount = document.querySelectorAll(
      '[data-pkc-region="schedule-cards"] [data-pkc-entry]',
    ).length;

    /**
     * 2. トグル往復。⚠ **押すのは本物の checkbox**(`data-pkc-task-line`)。
     * 🔑 済んだ予定は既定で畳まれるので、**押した札が消える**のが正しい遷移である
     *   (旧カンバンの「列を移る」に当たる)。
     */
    const others = [...host.children].slice(1, 50); // 同一性照合サンプル
    const first = host.children[0];
    const toggle = first?.querySelector('[data-pkc-action="toggle-task"]');
    if (!toggle)
      return { error: '先頭の札に印が無い ── ノートの予定だけが並んでいるか、観測点が変わった', cardCount, scheduleShown };
    const lid = first.getAttribute('data-pkc-entry');
    const line = toggle.getAttribute('data-pkc-task-line');
    t0 = performance.now();
    toggle.click();
    const moved = await until(
      () =>
        document.querySelector(
          `[data-pkc-region="schedule-cards"] [data-pkc-entry="${lid}"] [data-pkc-task-line="${line}"]`,
        ) === null,
    );
    const toggleRoundtripMs = +(performance.now() - t0).toFixed(1);
    /**
     * 🔴 **器は毎回引き直す**(sidebar / editor で `listSameNode` を足したのと同じ理由。
     * 2026-08-17 のレビュー ⚠-9 =「1 巡目の修正は 2 巡目の対象」)。掴んだままの
     * `host` の子を数えると、束ごと差し替えられたとき**外れた古い器**を見て
     * 「他のカードは無傷」という嘘の緑になる。
     */
    const hostNow = document.querySelector('[data-pkc-region="schedule-cards"]');
    const hostSameNode = hostNow === host;
    const othersIntact =
      hostNow !== null && others.every((el, i) => [...hostNow.children].slice(0, 49)[i] === el);
    /** 🔑 押した札の**本文が実際に変わった**か(見た目だけ動いていないか)。 */
    const scan = window.__APP__.dispatcher.getState().taskScan;
    const toggledDone =
      scan?.cards.find((c) => c.lid === lid && String(c.line) === line)?.done === true;

    // 3. 月送り(小さな月の組み直し)
    const next = [...document.querySelectorAll('[data-pkc-action="schedule-nav"]')].find(
      (b) => b.getAttribute('data-pkc-nav-step') === '1',
    );
    if (!next)
      return { error: '月送りの口が無い ── 観測点が変わった', cardCount, scheduleShown };
    t0 = performance.now();
    next.click();
    const monthNavMs = +(performance.now() - t0).toFixed(1);
    const gridReady = q('[data-pkc-field="schedule-grid"]') !== null;

    return {
      bandHasNoBoard,
      viewButtonsAlive,
      centerUntouched,
      hostSameNode,
      scheduleWasHidden,
      scheduleShown,
      paneShownMs,
      cardsReadyMs,
      cardCount,
      groupCount: groups.length,
      groupDates,
      /** ⚠ 上限で切ったか(切っていたら `cardCount` は「全部」ではない)。 */
      truncated: scan?.truncated ?? null,
      scannedNotes: scan?.scannedNotes ?? null,
      totalNotes: scan?.totalNotes ?? null,
      moved,
      toggleRoundtripMs,
      othersIntact,
      toggledDone,
      monthNavMs,
      gridReady,
      storageVfs: window.__APP__.storageVfs,
    };
  });

  const ok =
    !result.error &&
    result.bandHasNoBoard &&
    result.centerUntouched &&
    result.scheduleWasHidden &&
    result.scheduleShown &&
    result.cardCount > 0 &&
    // 🔴 **束が 1 つへ潰れていないこと**(fixture の次元を test 自身が見張る)。
    //    ⚠ fixture は 4 日ぶんに散らしてある(25 / 26 / 27 / 28)── 2026-08-23 に
    //      「3 日に散らした」つもりで 2 日にしか散っていない fixture を書いたので、
    //      ここで数を見る(CLAUDE.md「ゼロ件の次元は測っていない次元」)
    result.groupCount >= 3 &&
    result.moved &&
    result.othersIntact &&
    result.hostSameNode &&
    result.toggledDone &&
    result.gridReady &&
    result.storageVfs === 'opfs-sahpool';
  console.log(JSON.stringify({ ok, result }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  await context.close();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
}
