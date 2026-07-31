/**
 * smoke #1(P3-8): boot → 作成 → 打鍵 → 保存 → rendered が「画面に見える」。
 * happy-dom の e2e が保証しない層(実座標のクリック・可視高さ・pageerror 0)を検品。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal } from './helpers';

test('boot → ノート作成 → 編集 → 保存が画面に反映される', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await clickReal(page, '[data-pkc-action="create-entry"][data-pkc-archetype="text"]');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.click();
  await page.keyboard.type('# 視覚検品\n\n==ハイライト== 本文');

  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const h1 = page.locator('[data-pkc-field="detail-body"] h1');
  await expect(h1).toBeVisible();
  await expect(h1).toContainText('視覚検品');
  const box = await h1.boundingBox();
  expect(box!.height).toBeGreaterThan(0); // 「生成された」ではなく「画面に出ている」
  await expect(page.locator('[data-pkc-field="detail-body"] mark')).toBeVisible();

  // sidebar にも行が見えている(タイトルは既定命名)
  await expect(
    page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]'),
  ).toHaveCount(1);

  expect(errors).toEqual([]);
});
