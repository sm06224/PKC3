/**
 * 🔴 **打ちながら出る候補**(#1449 `/` 記法 / #1450 `@` ノートと日付)と、チェック項目 1 つの日付(#426 段②)。
 *
 * ## unit では原理的に届かない 3 つ
 *
 * ① **本物のキー入力**(`keyboard.type` / `Tab` / `Esc`)── 合成 event では既定の動き(Tab で焦点が動く・
 *    Esc で編集が終わる)を奪えたかが分からない
 * ② **caret の真下に出ること**(実際のレイアウト)── happy-dom は座標が全部 0
 * ③ **入れた字が保存まで届く**(`commit-edit` を通す)
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, dismissAnnounce, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const BODY = '[data-pkc-field="editor-body"]';
const MENU = '[data-pkc-region="inline-complete"]';

test('🔴 行頭の / と @ で候補が caret の下に出て、Tab で入る(Esc は編集を終わらせない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  const ta = page.locator(BODY);
  await ta.click();

  await page.keyboard.type('/見出し');
  const menu = page.locator(MENU);
  await expect(menu, '行頭の / で候補が出ない').toBeVisible();
  // 🔑 caret の直下 ── 欄の上端より下・欄の幅の中に出ている(座標が 0,0 のままではない)
  const box = await menu.boundingBox();
  const taBox = await ta.boundingBox();
  expect(box && taBox && box.y > taBox.y && box.x >= taBox.x - 1, '候補が caret の近くに出ていない').toBe(true);

  // Esc は候補を閉じるだけ(編集は続く)
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(ta, 'Esc で編集が終わった').toBeVisible();

  // 出し直して Tab で入れる(見出し2 は 2 番目)
  await page.keyboard.press('Control+A');
  await page.keyboard.type('/見出し2');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  await expect(ta, 'Tab で見出し2 に置き換わらない').toHaveValue('## ');
  await expect(ta, 'Tab で焦点が欄から出た').toBeFocused();

  // @ で日付
  await page.keyboard.type('提出 @today');
  await expect(menu.locator('[data-pkc-field="inline-complete-item"]').first()).toContainText('今日');
  await page.keyboard.press('Tab');
  await expect(ta).toHaveValue(/^## 提出 @\d{4}-\d{2}-\d{2}\s*$/u);

  // 行の途中の / では出ない
  await page.keyboard.type(' A/B');
  await expect(menu).toHaveCount(0);

  await dismissAnnounce(page).catch(() => undefined);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 本文のチェック項目を右クリックして、今日の予定にし、日付を外す', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator(BODY).fill('- [ ] 見積を送る\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const item = page.locator('[data-pkc-field="detail-body"] li.pkc-task-item', { hasText: '見積を送る' });
  await expect(item).toBeVisible();
  await item.click({ button: 'right', position: { x: 40, y: 6 } });
  const menu = page.locator('[data-pkc-region="context-menu"]');
  await expect(menu.locator('[data-pkc-action="task-item-date-clear"]'), '日付が無いのに外すが出ている').toHaveCount(0);
  await menu.locator('[data-pkc-action="task-item-date-today"]').click();
  await expect(item, '日付が書かれない').toContainText(/\d{4}-\d{2}-\d{2}|今日/u);

  await item.click({ button: 'right', position: { x: 40, y: 6 } });
  await expect(menu.locator('[data-pkc-action="task-item-date-clear"]'), '日付があるのに外すが出ない').toBeVisible();
  await menu.locator('[data-pkc-action="task-item-date-clear"]').click();
  await expect(item, '日付が外れない').not.toContainText(/\d{4}-\d{2}-\d{2}/u);
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
