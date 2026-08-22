import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp, useSplitEditor } from './helpers';

/**
 * 🔴 **別の窓の変更と重なったとき、黙って上書きしない**(#178 / #300 段③、2026-08-22)。
 *
 * ## user から見た物語
 *
 * 本文を書いている。⚠ **その隣で、別窓のカレンダーが同じノートに日付を付ける**
 * (#300 段③ で組み込みアプリは既定で別窓になったので、これは特殊な使い方ではない)。
 * そのまま保存すると、日付は上書きされる ── **直す前はそのとき画面に何も出なかった**。
 * user から見えるのは「カレンダーで付けた日付が消えた」だけで、
 * **戻せることを知る道が無い**。
 *
 * ## 🔴 unit では原理的に届かない層だけをここで見る
 *
 * ⚠ これは **2 枚の窓が同じ DB を書く**話である ── happy-dom には
 * BroadcastChannel をまたぐ 2 つの文書も、本体タブの worker も無い。
 * だから ①**放送が本当に届くか** ②**編集中のタブがそれを受けるか**
 * ③**保存したときに理由が出るか** の 3 つを実物で通す。
 *
 * ⚠ 「上書きされた版が履歴に入るか」は**実物の worker**が
 * `tests/adapter/storage-worker.test.ts` で見ている ── ここでは重ねない
 * (同じ主張を 2 か所で見ると、片方を壊しても気づけない)。
 */
test('🔴 別窓が同じノートを書いたら、保存時に理由が出る (#178)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await useSplitEditor(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ノートを 1 件作って保存(作った直後は選ばれている)
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  // 🔑 **窓 2 枚目**をアプリの一覧のタイルから開く(user と同じ手)
  await clickReal(page, '[data-pkc-browse="launcher"]');
  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-tile"][data-pkc-tile="builtin:calendar"]');
  const win = await popup;
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(win.locator('[data-pkc-view-pane="calendar"]')).toBeVisible();
  // ⚠ **前提** ── 読んでいたノートが連れて来られている(#300 段③)。
  //    連れて来られていないと、この窓は日付を付けられないので test が成り立たない
  await expect(
    win.locator('[data-pkc-field="calendar-target"]'),
    '前提が崩れている(別窓にノートが渡っていない)',
  ).toContainText('に日付を付けます');

  // 本体の窓へ戻って、本文の編集を始めて打鍵する
  // ⚠ 左の列は「アプリ」のままでよい ── 中央の面は本文のままである
  await page.bringToFront();
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await page.locator('[data-pkc-field="editor-body"]').fill('# 打鍵中の下書き');

  /**
   * 🔴 **別窓が同じノートに日付を付ける**(= disk が進む)。
   * ⚠ 日付は**画面から読む**(実行月に依存する値を test 側で組まない)。
   */
  const month = await win
    .locator('[data-pkc-field="calendar-month"]')
    .getAttribute('data-pkc-month');
  expect(month, '月が出ていない').toMatch(/^\d{4}-\d{2}$/);
  const cell = win.locator(`[data-pkc-date="${month}-15"]`);
  await cell.locator('[data-pkc-field="day-number"]').click();
  await expect(
    cell.locator('[data-pkc-entry]'),
    '別窓で日付が入っていない(この test の前提が崩れている)',
  ).toHaveCount(1);

  /**
   * 🔴 **本体の窓で保存する** ── 打った字は残り、**理由が出る**。
   * ⚠ 観測点は**状態の行**へ絞る(root 全体で探すと、お知らせのカードの文言に
   *   満たされて常に真になる ── 2026-08-17 に踏んだ型)。
   */
  await page.bringToFront();
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '黙って上書きした(user は日付が消えたとしか見えない)',
  ).toContainText('別の窓の変更と重なりました', { timeout: 15_000 });
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '戻し方が書いていない',
  ).toContainText('履歴');

  // 🔑 打った字は捨てられていない(user の作業を守るのが last-write-wins の理由)
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toContainText('打鍵中の下書き');

  await win.close();
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
