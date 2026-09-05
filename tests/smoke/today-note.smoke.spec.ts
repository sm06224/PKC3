/**
 * 🔴 **「今日」を押すと、その日のノートが開く**(#348、user 裁定 2026-08-23)。
 *
 * ⚠ unit は**規則と繋がり**を見る。ここが見るのは **user が実際に押せるか**である
 * ── happy-dom では「要素が在る」ことまでしか分からず、
 * **覆われていないか / 押せるか**は実ブラウザにしか無い。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, collectPageErrors } from './helpers';

test('🔴 「今日」を押すと今日の日付のノートが開き、2 度目でも増えない', async ({ page }) => {
  /**
   * 🔴 **例外を 1 度も見ていなかった**(#713、2026-09-05)。
   * ⚠ この spec はアプリを開いて 2 度押すのに、`pageerror` も `console.error` も
   *   拾っていなかった ── **本文の作成が例外で落ちても、行が 1 件なら緑**である。
   * 🔑 `collectPageErrors` は落ちた Promise も拾う(Chromium は unhandled rejection を
   *   `pageerror` として上げる ── 2026-09-05 に実測)。
   */
  const errors = collectPageErrors(page);
  await gotoApp(page);

  const today = await page.evaluate(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });

  await clickReal(page, '[data-pkc-action="open-today"]');
  // ⚠ 作成の直後は**編集に入る** ── 題名は編集の面に出る
  const title = page.locator('[data-pkc-field="editor-title"], [data-pkc-field="detail-title"]');
  await expect(title.first(), '今日の日付のノートが開いていない').toHaveValue(
    new RegExp(today),
  );

  // 編集を確定してから、もう一度押す
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-action="open-today"]');

  /**
   * 🔴 **2 度目で増えない**(その日の入れ物は 1 つ)。
   * ⚠ 一覧の**その題名の行**を数える ── 全件を数えると、他の理由で増えた分に
   *   救われて空振りする。
   */
  const rows = page.locator(`[data-pkc-entry]`, { hasText: today });
  await expect(rows, '押すたびに増えている').toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
