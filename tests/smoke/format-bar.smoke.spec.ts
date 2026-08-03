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

test('🔴 ログは閲覧中に「追記」を押すと日時の節が足される', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'textlog');

  // 一度書いて保存し、**閲覧の状態**に戻す(ここが追記の出発点)
  await page.locator('[data-pkc-field="editor-body"]').fill('前の記録');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-action="start-edit"]')).toBeVisible();

  // 🔴 閲覧中に押す ── 編集に入って、末尾に日時の節が足される
  await clickReal(page, '[data-pkc-action="append-section"]');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  const value = await ta.inputValue();
  expect(value.split('\n')[0]).toBe('前の記録');
  expect(value).toMatch(/\n## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n\n$/);

  // ⚠ **カーソルが末尾にある**(そのまま打ち始められる)── ここが合っていないと
  // 「押したのに書けない」になる
  expect(await ta.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(value.length);
  await page.keyboard.type('今日のできごと');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('今日のできごと');

  expect(errors).toEqual([]);
});
