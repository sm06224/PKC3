/**
 * 🔴 **種類の札が、押した面でちゃんと応える**(#478)。
 *
 * ## unit では原理的に届かない
 *
 * 壊れていたのは**面を移ったときに描き直されないこと**である ──
 * つまり **`BrowseRouter` が面ごとに何を描くか**という配線の話で、
 * 描画器 1 つを単体で呼ぶ unit では**その配線を 1 度も通らない**
 * (CLAUDE.md §7「A と B が合意していることは、A の test にも B の test にも書けない」)。
 *
 * ## 直す前に実際に起きていたこと(実測)
 *
 * | 手順 | 札 | 「解除」 | 一覧 |
 * |---|---|---|---|
 * | 予定タブで「ノート」を押す | 🔴 `[false]` のまま | 🔴 無し | ─ |
 * | 一覧へ戻る | `[true]` | 出る | 🔴 **3 → 2** |
 *
 * ⚠ **押した瞬間は嘘をつき、戻ったとき初めて本当のことを言う**。
 * ⚠ しかもその面からは**解除できない**(「解除」が出ないので)。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

const BAR = '[data-pkc-region="kind-bar"]';
const CHIP = `${BAR} [data-pkc-action="toggle-kind-filter"]`;
const CLEAR = `${BAR} [data-pkc-field="kind-clear"]`;

/** 2 種類ぶん作る ── ⚠ 1 種類だと札はそもそも出ない(押しても変わらないため)。 */
async function seedTwoKinds(page: import('@playwright/test').Page): Promise<void> {
  for (const kind of ['text', 'textlog', 'text']) {
    await createEntry(page, kind);
    const commit = page.locator('[data-pkc-action="commit-edit"]').first();
    if ((await commit.count()) > 0) await clickReal(page, '[data-pkc-action="commit-edit"]');
  }
}

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

test('🔴 予定タブで札を押すと、その場で押された印と「解除」が出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await seedTwoKinds(page);

  await clickReal(page, '[data-pkc-browse="list"]');
  const chips = page.locator(CHIP);
  expect(await chips.count(), '前提: 一覧で札が 2 つ以上出ている').toBeGreaterThanOrEqual(2);

  // 予定タブへ移っても札は在る(そこでは絞りが効くので出したまま)
  await clickReal(page, '[data-pkc-browse="schedule"]');
  await expect(page.locator(BAR), '予定タブで札の帯が消えた(そこでは絞りが効く)').toBeVisible();

  const first = chips.first();
  await expect(first, '押す前から押された印が付いている').toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator(CLEAR), '押す前から「解除」が出ている').toHaveCount(0);

  await first.click();
  // 🔴 **押したその場で**応える(戻るまで分からない、にしない)
  await expect(first, '押しても印が付かない(絞りは入っているのに嘘をつく)').toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator(CLEAR), '押しても「解除」が出ない(その面から戻せない)').toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 絞りが効かないタブ(連絡先)では、札を出さない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await seedTwoKinds(page);

  await clickReal(page, '[data-pkc-browse="list"]');
  await expect(page.locator(BAR), '前提: 一覧では札が出ている').toBeVisible();

  await clickReal(page, '[data-pkc-browse="contacts"]');
  /**
   * ⚠ **押せない札を出さない** ── 連絡先の面は `kindFilter` を読まないので、
   *   そこで押すと**その場では何も起きないのに絞りだけ入る**
   *   (あとで一覧へ行くとノートが消えている)。
   */
  await expect(
    page.locator(BAR),
    '連絡先で札が出ている(押しても何も起きないのに、絞りだけ入る)',
  ).toBeHidden();

  // ⚠ **戻れば出る**(畳んだだけで、絞りの口を失っていない)
  await clickReal(page, '[data-pkc-browse="list"]');
  await expect(page.locator(BAR), '一覧へ戻っても札が出ない(口を失った)').toBeVisible();

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
