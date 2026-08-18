/**
 * smoke #1(P3-8): boot → 作成 → 打鍵 → 保存 → rendered が「画面に見える」。
 * happy-dom の e2e が保証しない層(実座標のクリック・可視高さ・pageerror 0)を検品。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal, createEntry, useSplitEditor, useListBrowse } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useListBrowse(page);
  await useSplitEditor(page);
});

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

  await clickReal(page, '[data-pkc-browse="filer"]');
  await clickReal(page, '[data-pkc-action="show-trash"]');
  const trash = page.locator('[data-pkc-region="filer-trash"]');
  await expect(trash.locator('li')).toHaveCount(1);
  await clickReal(page, '[data-pkc-action="restore-trash"]');
  // ⚠ 一覧は**別のタブ**にある(P8 段⑤)── 戻ってから数える
  await clickReal(page, '[data-pkc-browse="list"]');
  await expect(
    page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]'),
  ).toHaveCount(1); // 復元で一覧に戻る
  // ⚠ ゴミ箱は**フォルダのタブへ戻ってから**数える ── 隠れている面は描き直されない
  // ので、一覧を出したまま数えると「前に描いた古い DOM」を見ることになる
  // (3 回に 2 回落ちる flake の正体。user が見る形で観測する)
  await clickReal(page, '[data-pkc-browse="filer"]');
  await expect(trash.locator('li')).toHaveCount(0);

  expect(errors).toEqual([]);
});
