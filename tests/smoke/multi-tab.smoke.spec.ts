/**
 * smoke(#177): 多重タブ ── 2 枚目のタブが本体経由で同じアプリを開く。
 *
 * unit(store-proxy.test.ts)は fake channel で protocol を守る。ここで守るのは
 * **実物の合成**: 実 Chromium の Web Locks(lease)+ BroadcastChannel + OPFS
 * SAHPool worker が、2 つの page で実際に噛み合うこと。
 *
 * ⚠ 2 つの page は**同じ context**で開く(Web Locks / BroadcastChannel / OPFS は
 *   origin + profile 単位 ── context を分けると別世界になり、何も検証しない)。
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal, createEntry, useSplitEditor } from './helpers';

test('2 枚目のタブが本体経由で開き、別ノートは編集でき、同じノートは断られる', async ({
  page,
  context,
}) => {
  const errorsA = collectPageErrors(page);
  await useSplitEditor(page);
  await gotoApp(page);

  // タブ A(本体): ノートを 1 件作って保存
  await createEntry(page, 'text');
  const taA = page.locator('[data-pkc-field="editor-body"]');
  await taA.click();
  await page.keyboard.type('# タブA のノート');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toContainText('タブA のノート');

  // タブ B(follower): 同じアプリが**待機画面ではなく**開く
  const pageB: Page = await context.newPage();
  const errorsB = collectPageErrors(pageB);
  await useSplitEditor(pageB);
  await gotoApp(pageB);
  // 常設バッジ = 本体経由の印
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText(
    '保存は本体タブ経由',
  );
  // A で作ったノートが B の一覧に見える(boot 時の読取が proxy 越しに通った)
  const rowB = pageB.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rowB).toHaveCount(1);

  // B: 同じノートを A が編集中 → B の編集は断られる
  await clickReal(page, '[data-pkc-action="start-edit"]'); // A が編集に入る
  await expect(page.locator('[data-pkc-field="editor-body"]')).toBeVisible();
  await rowB.first().click();
  await clickReal(pageB, '[data-pkc-action="start-edit"]');
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText(
    '別のタブで編集中',
  );
  await expect(pageB.locator('[data-pkc-field="editor-body"]')).toHaveCount(0);

  // A が保存 → B で編集できるようになる(ロック解放が渡る)
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();
  await clickReal(pageB, '[data-pkc-action="start-edit"]');
  const taB = pageB.locator('[data-pkc-field="editor-body"]');
  await expect(taB).toBeVisible();

  // B: 本文を書いて保存(書込が proxy 越しに通る)→ A の画面に反映される
  await taB.fill('# タブB が書いた');
  await clickReal(pageB, '[data-pkc-action="commit-edit"]');
  await expect(pageB.locator('[data-pkc-field="detail-body"] h1')).toContainText(
    'タブB が書いた',
  );
  // A は 'changed' → 一覧の取り直し → REQUEST_BODY で本文も追従する
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toContainText(
    'タブB が書いた',
    { timeout: 10_000 },
  );

  // B: 新規作成も follower から通る(別ノートの並行編集)
  await createEntry(pageB, 'text');
  await pageB.locator('[data-pkc-field="editor-body"]').fill('# 2 件目');
  await clickReal(pageB, '[data-pkc-action="commit-edit"]');
  await expect(rowB).toHaveCount(2);
  await expect(
    page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]'),
  ).toHaveCount(2, { timeout: 10_000 });

  expect(errorsA).toEqual([]);
  expect(errorsB).toEqual([]);
});

test('本体タブを閉じると、2 枚目がその場で本体に昇格する(reload 無し)', async ({
  page,
  context,
}) => {
  await useSplitEditor(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('# 引き継ぎ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const pageB = await context.newPage();
  const errorsB = collectPageErrors(pageB);
  await useSplitEditor(pageB);
  await gotoApp(pageB);
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText(
    '保存は本体タブ経由',
  );

  await page.close(); // 本体の死 ── Web Locks が B へ lease を渡す
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText(
    'このタブが本体になりました',
    { timeout: 15_000 },
  );

  // 昇格後のタブで実際に書ける(実 worker へ乗り換わっている)
  const rowB = pageB.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await rowB.first().click();
  await clickReal(pageB, '[data-pkc-action="start-edit"]');
  const taB = pageB.locator('[data-pkc-field="editor-body"]');
  await expect(taB).toBeVisible();
  await taB.fill('# 昇格後の保存');
  await clickReal(pageB, '[data-pkc-action="commit-edit"]');
  await expect(pageB.locator('[data-pkc-field="detail-body"] h1')).toContainText(
    '昇格後の保存',
  );
  expect(errorsB).toEqual([]);
});
