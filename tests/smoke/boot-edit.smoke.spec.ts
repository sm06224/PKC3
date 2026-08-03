/**
 * smoke #1(P3-8): boot → 作成 → 打鍵 → 保存 → rendered が「画面に見える」。
 * happy-dom の e2e が保証しない層(実座標のクリック・可視高さ・pageerror 0)を検品。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal, createEntry } from './helpers';

test('boot → ノート作成 → 編集 → 保存が画面に反映される', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
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

  // ── P5b: 2 回目の編集 → 履歴 → 復元(前進変異)が画面に反映される ──
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await ta.fill('# 二稿');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toContainText('二稿');

  await clickReal(page, '[data-pkc-action="show-history"]');
  const panel = page.locator('[data-pkc-field="history-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('li')).toHaveCount(1); // 初稿(変更前)が 1 件
  await clickReal(page, '[data-pkc-action="restore-revision"]');
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toContainText('視覚検品');
  await expect(panel).toHaveCount(0); // 復元で panel は畳まれる

  // ── P5b: 削除 → ゴミ箱 → 復元(sidebar に戻る)──
  page.once('dialog', (d) => void d.accept()); // 削除の confirm
  await clickReal(page, '[data-pkc-action="delete-entry"]');
  await expect(
    page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]'),
  ).toHaveCount(0);

  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="filer"]');
  await clickReal(page, '[data-pkc-action="show-trash"]');
  const trash = page.locator('[data-pkc-region="filer-trash"]');
  await expect(trash.locator('li')).toHaveCount(1);
  await clickReal(page, '[data-pkc-action="restore-trash"]');
  await expect(
    page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]'),
  ).toHaveCount(1); // 復元で sidebar に戻る
  await expect(trash.locator('li')).toHaveCount(0);

  expect(errors).toEqual([]);
});
