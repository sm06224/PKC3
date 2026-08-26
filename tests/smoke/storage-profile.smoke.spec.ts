import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp, useSplitEditor } from './helpers';

/**
 * 🔴 **何が容量を食っているか**(#415)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * 1. **本物の worker が数える**(unit は fake を差している ── 実際に
 *    sqlite を引いて数字が返るのは、ここでしか見られない)
 * 2. **行を押すと本当にそのノートへ飛ぶ**(面をまたぐ)
 * 3. 設定の面から**辿り着ける**(畳まれていない / 隠れていない)
 */
test('🔴 調べると重い順に並び、押すとそのノートへ飛ぶ (#415)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // ⚠ `addInitScript` なので **`gotoApp` より前**に呼ぶ
  await useSplitEditor(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('容量を見るノート');
  /**
   * ⚠ **本文を書く。** 添付も本文も 0 のノートは**一覧に出さない**のが正しい
   *   振る舞い(0 B の行を並べない)なので、題名だけだと行が 1 本も出ない
   *   ── 最初これで落ちた。
   */
  await page.locator('[data-pkc-field="editor-body"]').fill('これは容量を数えるための本文です。');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const run = page.locator('[data-pkc-field="storage-profile-run"]');
  await expect(run, '設定の面に出ていない(畳まれている?)').toBeVisible();

  await clickReal(page, '[data-pkc-field="storage-profile-run"]');

  /**
   * ① 🔴 **本物の worker が答える** ── 合計の行が出るまで待つ。
   * ⚠ 「調べています…」のまま止まらないことも、ここで同時に見ている。
   */
  const summary = page.locator('[data-pkc-field="storage-profile-summary"]');
  await expect(summary).toBeVisible();
  await expect
    .poll(async () => (await summary.textContent()) ?? '', {
      message: 'worker が答えていない(「調べています…」のまま)',
    })
    .toContain('数え方が違います');

  // ② 本文を持つノートが 1 件在るので、行が出る
  const rows = page.locator('[data-pkc-field="storage-profile-list"] button');
  await expect(rows.first(), '重い順の行が 1 つも出ていない').toBeVisible();
  await expect(rows.first()).toContainText('容量を見るノート');

  // ③ 🔴 **押すとそのノートへ飛ぶ**(見えても辿り着けない、を作らない)
  await rows.first().click();
  await expect(
    page.locator('[data-pkc-field="detail-title"]'),
    '押しても、そのノートが開かない',
  ).toContainText('容量を見るノート');

  expect(errors, `page error: ${errors.join(' / ')}`).toHaveLength(0);
});
