import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 🔴 **チェックの印が押せて、本文に残る**(#277。user 指示 2026-08-19
 * 「チェックリストを含む場合の自動生成で…復活させるのです」)。
 *
 * 🔴 **unit では原理的に届かない層**:
 * ① **本物の `<input type="checkbox">` の click** ── 既定動作で見た目が先に変わる。
 *    本文が書き換わって**描き直された後も**その状態が残るか(見た目だけ変わって
 *    保存されていない、という一番静かな壊れ方をここで見る)
 * ② **開き直しても残るか** ── 直す前の壊れ方はまさにこれ(別のノートへ移って
 *    戻ると全部外れる)だったので、**往復させて**確かめる
 */
test('🔴 チェックを押すと本文に残り、開き直しても消えない (#277)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ノートを 2 件(1 件目にチェックリスト、2 件目は往復のための当て馬)
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live
    .locator('[data-pkc-field="row-source"]')
    .fill('# 買い物\n\n- [ ] 牛乳\n- [ ] 卵');
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const boxes = page.locator('[data-pkc-view-pane="detail"] [data-pkc-action="toggle-task"]');
  await expect(boxes, 'チェックが押せる形で出ていない').toHaveCount(2);
  await expect(boxes.nth(0)).not.toBeChecked();

  // ① 🔴 実クリック → 描き直された後も印が残っている
  await boxes.nth(0).click();
  await expect(boxes.nth(0), '押した印が描き直しで消えた').toBeChecked();
  await expect(boxes.nth(1), '押していない方まで変わった').not.toBeChecked();

  // ② 🔴 別のノートへ行って戻る ── ここが直す前の壊れ方だった
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(
    page.locator('[data-pkc-view-pane="detail"]'),
    '戻ってきていない',
  ).toContainText('買い物');
  const back = page.locator('[data-pkc-view-pane="detail"] [data-pkc-action="toggle-task"]');
  await expect(back.nth(0), '往復したら印が消えた(保存されていない)').toBeChecked();

  // ③ もう一度押すと外れる(片道にしない)
  await back.nth(0).click();
  await expect(back.nth(0), '外れない').not.toBeChecked();

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
