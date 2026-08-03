import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * P8 段⑥: **書式パネル**と**追記**を実機で。
 *
 * > user 指摘 2026-08-03「**書式設定系のパネルも必要 / 何もかも足りない /
 * > ログの追記機構とテキストエントリの追記機構も無い**」
 *
 * 🔴 unit(`tests/adapter/format-append.test.ts`)は繋がりを見ている。
 * **ここが見るのは「実際に押せるか」と「並びが揃っているか」** ──
 * user 指摘の中身は寸法の話でもある(「ボタンサイズ揃えはしてください」)。
 * happy-dom には CSS が無いので、揃っているかは実機でしか分からない。
 */
test('🔴 書式パネルが押せて、寸法が揃っていて、プレビューに効く', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  const preview = page.locator('[data-pkc-region="editor-preview"]');
  const bar = page.locator('[data-pkc-region="format-bar"]');
  await expect(bar).toBeVisible();

  // ① 🔴 **高さが 1 種類**(user 指示「ボタンサイズ揃えはしてください」)。
  // ⚠ 「同じ CSS 規則を当てた」ではなく**実測の高さ**を見る ── 文字数の違う
  // ボタンが 14 個並ぶので、揃っていなければここで露見する
  const heights = await bar.locator('button').evaluateAll((els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().height)),
  );
  expect(heights.length).toBeGreaterThan(10);
  expect([...new Set(heights)], `ボタンの高さがばらついている: ${heights.join(',')}`).toHaveLength(1);

  // ② 🔴 パネルが**編集欄の上に接している**(離れていると「何に効くか」が読めない)
  const barBox = (await bar.boundingBox())!;
  const taBox = (await ta.boundingBox())!;
  expect(Math.abs(barBox.y + barBox.height - taBox.y), 'パネルと編集欄が離れている').toBeLessThan(4);

  // ③ 🔴 **選んでから押すと、その範囲に効く**(実マウスで)
  await ta.fill('強調したい');
  await ta.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(0, 2));
  await clickReal(page, '[data-pkc-format="bold"]');
  await expect(ta).toHaveValue('**強調**したい');
  await expect(preview.locator('strong')).toHaveText('強調');

  // ④ 押し直すと外れる(選択は残っているので、そのまま押せる)
  await clickReal(page, '[data-pkc-format="bold"]');
  await expect(ta).toHaveValue('強調したい');

  // ⑤ 雛形も入る(表 = 2 列。⚠ プレビューまで見る ── 記号だけ入って
  // markdown として壊れている、を落とす)
  await ta.fill('');
  await clickReal(page, '[data-pkc-format="table"]');
  await expect(preview.locator('table th')).toHaveCount(2);

  expect(errors).toEqual([]);
});

/**
 * P8 段⑧: **追記型が実際に追記型として動く**。
 *
 * > user 指示 2026-08-03「**追記型は今すぐ実装して、今のままだと、なんの意味もない**」
 *
 * ⚠ 観測点は「本文が増えた」ではなく「**編集画面を開かずに**増えた」── 段⑥ の
 * 実装(編集に入って末尾へ飛ぶ)でも本文は増えるので、そこで止めると作り直しの
 * 意味が test に写らない。
 */
test('🔴 打って押すと、編集画面を開かずに末尾へ足される', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'textlog');
  await page.locator('[data-pkc-field="editor-body"]').fill('前の記録');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const box = page.locator('[data-pkc-field="append-input"]');
  await expect(box).toBeVisible();
  await box.fill('1 件目');
  await clickReal(page, '[data-pkc-action="append-entry"]');

  // ① 🔴 **編集画面が開いていない**(ここが段⑥ との違いの本体)
  await expect(page.locator('[data-pkc-field="editor-body"]')).toHaveCount(0);
  // ② 本文に日時の節ごと入った
  const body = page.locator('[data-pkc-field="detail-body"]');
  await expect(body).toContainText('1 件目');
  await expect(body.locator('h2')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // ③ 欄が空になり、続けて打てる
  await expect(box).toHaveValue('');

  // ④ 2 件目(節が 2 つになる ── 上書きしていない)
  await box.fill('2 件目');
  await page.keyboard.press('Control+Enter');
  await expect(body).toContainText('2 件目');
  await expect(body).toContainText('1 件目');
  await expect(body.locator('h2')).toHaveCount(2);

  // ⑤ 🔴 **再読込しても残っている**(disk に着いている)
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15000 });
  await clickReal(page, '[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('2 件目');

  expect(errors).toEqual([]);
});

test('🔴 編集中は追記できず、理由と出口が画面に出る(競合ロック)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'textlog');
  await page.locator('[data-pkc-field="editor-body"]').fill('元');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-action="start-edit"]');
  // 欄ではなくロックの帯が出る ── **押せないだけ**にしない
  await expect(page.locator('[data-pkc-field="append-form"]')).toBeHidden();
  await expect(page.locator('[data-pkc-field="append-lock-reason"]')).toContainText('編集中');
  // ⚠ 失わない出口が在る(帯の中の「保存して解放」)
  const resolve = page.locator('[data-pkc-field="append-lock"] [data-pkc-action="commit-edit"]');
  await expect(resolve).toBeVisible();
  await clickReal(page, '[data-pkc-field="append-lock"] [data-pkc-action="commit-edit"]');
  // 解けて追記できる
  await expect(page.locator('[data-pkc-field="append-input"]')).toBeVisible();

  expect(errors).toEqual([]);
});
