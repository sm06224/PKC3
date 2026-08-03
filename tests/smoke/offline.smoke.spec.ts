import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal } from './helpers';

/**
 * P7 段④: オフラインで**中身が読める**(設計 doc §3)。
 *
 * 🔴 **「SW が登録された」で止めない**。登録されていても cache が空なら白紙になる
 * ── register の成否は「オフラインで使える」を 1 ミリも保証しない。
 * ここでは実際に **`setOffline(true)` → reload → entry が読める**まで見る。
 */
test('🔴 オフラインで再読込しても、作ったノートが読める', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ノートを 1 つ作る(オフライン後に「中身が読める」の観測点になる)
  await clickReal(page, '[data-pkc-action="create-entry"][data-pkc-archetype="text"]');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.click();
  await page.keyboard.type('# オフラインで読む\n\n機内モードでも出る本文');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toBeVisible();

  // SW が **activate して制御を持つ**まで待つ(登録しただけでは cache は空)
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, {
    timeout: 20_000,
  });

  // ⚠ ここから本番:回線を切って**再読込**する
  await context.setOffline(true);
  await page.reload({ waitUntil: 'commit' });

  // ① 白紙にならない(boot が ready まで進む)
  await expect(page.locator('[data-pkc-slot="root"][data-pkc-boot="ready"]')).toBeAttached({
    timeout: 30_000,
  });

  // ② **中身が読める** ── sidebar に出て、開くと本文が描画される
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows).toHaveCount(1);
  await clickReal(page, '[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toHaveText(
    'オフラインで読む',
  );

  await context.setOffline(false);
  expect(errors).toEqual([]);
});
