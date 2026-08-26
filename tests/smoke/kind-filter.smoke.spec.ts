import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 🔴 **種類で絞る**(#411)を実ブラウザで通す。
 *
 * 🔴 **unit では原理的に届かない層だけ**を見る:
 * 1. **札が実際に押せる**(重なり・`pointer-events`・帯の高さ)── happy-dom は
 *    版面を組まないので、**在るのに押せない**を 1 度も見られない
 * 2. **一覧タブとフォルダタブをまたいで効き続ける** ── 面の切替は実際の
 *    描画順で起きる(unit は面を 1 つずつしか組んでいない)
 * 3. **絞ったまま作る**と絞りが外れて、作った物が**画面に出る**
 */
test('🔴 種類の札で絞れる ── 面をまたいでも効き、作れば外れる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ノート 1 件 + フォルダ 1 件(= 種類が 2 つ ── 札が出る条件)
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await createEntry(page, 'folder');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-browse="list"]');
  const rows = page.locator('[data-pkc-region="entry-list"] li');
  await expect(rows).toHaveCount(2);

  const bar = page.locator('[data-pkc-region="kind-bar"]');
  await expect(bar, '種類が 2 つあるのに札の帯が出ていない').toBeVisible();
  const folderChip = page.locator('[data-pkc-action="toggle-kind-filter"][data-pkc-kind="folder"]');
  await expect(folderChip).toHaveCount(1);

  /**
   * ⚠ **`clickReal`(本物のマウス)で押す** ── `dispatchEvent` だと、
   *   帯が別の物に覆われていても通ってしまう(「在るのに押せない」を見逃す)。
   */
  await clickReal(page, '[data-pkc-action="toggle-kind-filter"][data-pkc-kind="folder"]');
  await expect(rows, '札を押したのに行が減っていない').toHaveCount(1);
  await expect(folderChip).toHaveAttribute('aria-pressed', 'true');

  // ② 面をまたいでも効き続ける(帯はタブの外に在る)
  await clickReal(page, '[data-pkc-browse="filer"]');
  await expect(
    page.locator('[data-pkc-region="filer-table"] tbody tr'),
    'フォルダ面で絞りが黙って外れた',
  ).toHaveCount(1);
  await expect(bar, '面を変えたら札の帯が消えた(絞りは効いたままなので混乱する)').toBeVisible();

  // ③ 解除で戻る
  await clickReal(page, '[data-pkc-field="kind-clear"]');
  await expect(page.locator('[data-pkc-region="filer-table"] tbody tr')).toHaveCount(2);

  /**
   * ④ 🔴 **絞ったまま作ると、絞りが外れて作った物が出る**(review M-2 の再演)。
   * ⚠ 外れないと、作った物は一生一覧に出ない ── user は「効かなかった」と
   *   思って Esc を押し、**新規未編集 cancel の掃除で entry ごと消える**。
   */
  await clickReal(page, '[data-pkc-browse="list"]');
  await clickReal(page, '[data-pkc-action="toggle-kind-filter"][data-pkc-kind="folder"]');
  await expect(rows).toHaveCount(1);
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(rows, '絞ったまま作った物が一覧に出ていない').toHaveCount(3);
  await expect(
    page.locator('[data-pkc-field="kind-clear"]'),
    '作ったのに種類の絞りが残っている',
  ).toHaveCount(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toHaveLength(0);
});
