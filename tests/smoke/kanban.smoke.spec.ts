/**
 * smoke #2(P3-8): todo 作成 → kanban 実クリックトグル → 列移動が画面に出る。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal } from './helpers';

test('kanban のトグルが実クリックで列を移す', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // todo を 1 件作成(seed frontmatter のまま保存)
  await clickReal(page, '[data-pkc-action="create-entry"][data-pkc-archetype="todo"]');
  await expect(page.locator('[data-pkc-field="editor-body"]')).toBeVisible();
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  // 無変更 commit は書かないが entry は残る(fresh は commit で解除)
  await expect(page.locator('[data-pkc-field="detail-body"], pre[data-pkc-field="detail-body"]').first()).toBeAttached();

  await clickReal(page, '[data-pkc-view="kanban"]');
  const openCol = page.locator(
    '[data-pkc-kanban-status="open"] [data-pkc-region="kanban-cards"] [data-pkc-entry]',
  );
  await expect(openCol).toHaveCount(1);

  await clickReal(
    page,
    '[data-pkc-kanban-status="open"] [data-pkc-entry] [data-pkc-action="toggle-todo"]',
  );
  const doneCol = page.locator(
    '[data-pkc-kanban-status="done"] [data-pkc-region="kanban-cards"] [data-pkc-entry]',
  );
  await expect(doneCol).toHaveCount(1); // 書込 ack → 列移動まで
  await expect(openCol).toHaveCount(0);

  expect(errors).toEqual([]);
});
