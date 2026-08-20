import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 🔴 **カレンダー(封印の解除)**(#276。user 指示 2026-08-19
 * 「かつて無くしたカレンダーとカンバンはここで生きてきます / 発想を変え、
 * frontmatter でのカレンダー情報付与…で復活させるのです」)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * ① **導線が実際に効くか** ── アプリの一覧のタイルを**実クリック**して面が開くか
 *    (封印は「導線を畳んだ」ものなので、戻ったことは導線でしか確かめられない)
 * ② **面が本当に見えているか** ── `hidden` の付け替えと CSS の噛み合いは
 *    happy-dom では読めない(`toBeVisible` は実レイアウトを見る)
 * ③ **セルに面積が在るか** ── 日の地を押す導線なので、潰れていると狙えない
 */
test('🔴 アプリの一覧からカレンダーを開き、日を押すと予定が入る (#276)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ノートを 1 件作る(作った直後は選ばれている)
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ① 🔴 **アプリの一覧に居て、押すと開く**(封印が解けている)
  await clickReal(page, '[data-pkc-browse="launcher"]');
  const tile = page.locator('[data-pkc-action="open-tile"][data-pkc-tile="builtin:calendar"]');
  await expect(tile, 'アプリの一覧にカレンダーが出ていない').toBeVisible();
  await tile.click();

  // ② 🔴 面が見えている(本文の面は畳まれている)
  await expect(page.locator('[data-pkc-view-pane="calendar"]')).toBeVisible();
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeHidden();

  /**
   * ③ 🔴 **日を押すと、選んでいるノートに日付が入る。**
   * ⚠ 日付は**画面から読む**(実行月に依存する値を test 側で組まない ──
   *   月替わりの日に落ちる test を作らない)。
   */
  const month = await page
    .locator('[data-pkc-field="calendar-month"]')
    .getAttribute('data-pkc-month');
  expect(month, '月が出ていない').toMatch(/^\d{4}-\d{2}$/);
  const key = `${month}-15`;
  const cell = page.locator(`[data-pkc-date="${key}"]`);
  const box = await cell.boundingBox();
  expect(box, '日のセルが描かれていない').not.toBeNull();
  expect(box!.height, 'セルに面積が無い(押せない)').toBeGreaterThan(8);

  /**
   * ⚠ 狙うのは**日の数字**(user が実際に見て押す所)。
   * 🔑 座標で「地」を狙わない ── ノートが入るとセルが伸びるので、**同じ座標が
   *   2 回目には行の上に来る**(1 稿目でそう外した。製品ではなく叩き方の問題)。
   */
  const day = cell.locator('[data-pkc-field="day-number"]');
  await day.click();
  await expect(
    cell.locator('[data-pkc-entry]'),
    '押した日にノートが出ない(日付が入っていない)',
  ).toHaveCount(1);

  /** ④ 🔴 **同じ日をもう一度押すと外れる**(付けた本人が外せない導線を作らない)。 */
  await day.click();
  await expect(cell.locator('[data-pkc-entry]'), '同じ日を押しても外れない').toHaveCount(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **カレンダーを開いたまま、別のノートを選べる**(2026-08-20。user 指示
 * 「カレンダーを利用するための導線が不足している」)。
 *
 * ⚠ 直す前は**閉ループ**だった ── ① カレンダーは「ノートを先に選んでから日を押す」
 *   設計 ② 開く道はアプリタブのタイルだけで、そこにノートの一覧は無い
 *   ③ 一覧へ行こうとタブを押すと**カレンダーごと閉じる**。つまり
 *   「カレンダーが開いていて、かつノート一覧が見えている」状態が**存在し得なかった**。
 * ⚠ 既存の smoke はこの穴を**踏まない** ── 直前に作ったノートが自動で選ばれているので、
 *   選ぶ導線が 1 度も要らない(CLAUDE.md §1「緑のまま欠けている」型)。
 *   だからここは **2 件目のノートを選び直す**という、実際に詰まる筋をなぞる。
 */
test('🔴 カレンダーを開いたまま一覧へ行き、別のノートに日付を付けられる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // 2 件作る ── 2 件目が選ばれた状態で終わる
  for (const t of ['あ', 'い']) {
    await createEntry(page, 'text');
    const title = page.locator('[data-pkc-field="editor-title"]');
    if (await title.count()) await title.fill(t);
    await clickReal(page, '[data-pkc-action="commit-edit"]');
  }

  await clickReal(page, '[data-pkc-browse="launcher"]');
  await clickReal(page, '[data-pkc-action="open-tile"][data-pkc-tile="builtin:calendar"]');
  await expect(page.locator('[data-pkc-view-pane="calendar"]')).toBeVisible();

  /**
   * 🔴 **ここが直した所** ── 一覧タブへ移っても、カレンダーは開いたまま。
   * ⚠ 観測点は「面が見えていること」にする(state ではなく画面)── 畳まれると
   *   `hidden` が付くので、`toBeVisible` が確定的に落ちる。
   */
  await clickReal(page, '[data-pkc-browse="list"]');
  await expect(
    page.locator('[data-pkc-view-pane="calendar"]'),
    '一覧タブへ移ったらカレンダーが閉じた(閉ループに戻っている)',
  ).toBeVisible();

  // 左の一覧から 1 件目を選び直す ── 面は開いたまま
  const first = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').first();
  await first.click();
  await expect(
    page.locator('[data-pkc-view-pane="calendar"]'),
    'ノートを選んだらカレンダーが閉じた',
  ).toBeVisible();

  // その状態で日を押すと、選び直したノートに日付が入る
  const month = await page
    .locator('[data-pkc-field="calendar-month"]')
    .getAttribute('data-pkc-month');
  const cell = page.locator(`[data-pkc-date="${month}-15"]`);
  await cell.locator('[data-pkc-field="day-number"]').click();
  await expect(
    cell.locator('[data-pkc-entry]'),
    '選び直したノートに日付が入っていない',
  ).toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **面の破れを実レイアウトで確かめる**(2026-08-20)。
 *
 * ⚠ ここは **unit では原理的に届かない層**だけを見る ── どれも「DOM に在るか」では
 *   なく「**実際に何 px どこに置かれたか**」である。直す前の実測(1440×900):
 *   曜日の列が **40.6px×6 + 696.1px×1**(予定のある列だけ伸びる)/
 *   表の高さが器の **30.6%**(626px の器に 191.5px)。
 */
test('🔴 曜日の列が等幅で、月が面の高さを使う', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  /**
   * ⚠ **長い題名のノートを 1 件入れてから測る** ── 空の月では `auto` でも
   *   等幅に見えるので、**入れずに測ると直す前でも緑になる**(§1 の空振り)。
   */
  await createEntry(page, 'text');
  const title = page.locator('[data-pkc-field="editor-title"]');
  if (await title.count()) await title.fill('とても長い題名のノートで列を押し広げる試験用の見出し');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-browse="launcher"]');
  await clickReal(page, '[data-pkc-action="open-tile"][data-pkc-tile="builtin:calendar"]');
  const month = await page
    .locator('[data-pkc-field="calendar-month"]')
    .getAttribute('data-pkc-month');
  await page.locator(`[data-pkc-date="${month}-15"] [data-pkc-field="day-number"]`).click();
  // ⚠ 空振り防止 ── 予定が本当にセルへ入ったか(入っていなければ列は広がらない)
  await expect(
    page.locator(`[data-pkc-date="${month}-15"] [data-pkc-entry]`),
    '前提が崩れている(予定が入っていない)',
  ).toHaveCount(1);

  const cols = await page
    .locator('[data-pkc-region="calendar-grid"] thead th')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  expect(cols.length, '曜日が 7 列でない').toBe(7);
  expect(
    Math.max(...cols) - Math.min(...cols),
    `曜日の列が等幅でない: ${cols.map((c) => c.toFixed(1)).join(' / ')}`,
  ).toBeLessThanOrEqual(1);

  const paneH = (await page.locator('[data-pkc-view-pane="calendar"]').boundingBox())!.height;
  const tableH = (await page.locator('[data-pkc-region="calendar-grid"]').boundingBox())!.height;
  expect(
    tableH / paneH,
    `月が面の高さを使っていない(器 ${paneH.toFixed(0)}px に対し表 ${tableH.toFixed(0)}px)`,
  ).toBeGreaterThan(0.7);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
