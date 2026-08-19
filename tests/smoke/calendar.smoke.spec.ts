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
