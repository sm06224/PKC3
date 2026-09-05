/**
 * 🔴 **参照元が実ブラウザで出て、押すと移れる**(#348、user 裁定 2026-08-23)。
 *
 * ⚠ unit は state の畳み方と器の組み方を見る。**ここが見るのは通し**である ──
 * 本文にリンクを書いて保存 → 相手を選ぶ → **worker が実際に引いてきて**、
 * 押すと移れるか。⚠ worker(sqlite)を通るのは実ブラウザだけである。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, collectPageErrors, createEntry, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

test('🔴 本文のリンクが「参照元」に出て、押すと移れる', async ({ page }) => {
  /**
   * 🔴 **例外を 1 度も見ていなかった**(#713、2026-09-05)。⚠ ここは worker(sqlite)を
   *   通す唯一の通し検査なのに、**その worker が投げても緑**だった ── 参照元が
   *   出てさえいれば通るので、裏で落ちた Promise は 1 つも記録されない。
   */
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ① 的になるノート
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  await ta.fill('的になるノート\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  /**
   * ⚠ **一覧の region へ絞って lid を採る**(CLAUDE.md §1)── `[data-pkc-entry]` を
   *   document 全体で数えると、情報ペインのボタンに満たされる(nightly を 13 晩
   *   赤にした形)。⚠ 既定の探し方は**ファイラ**なので、行が在るのは
   *   `filer-table` である(`entry-list` の region は在るが空 ── 実測)。
   */
  const lid = await page.evaluate(
    () =>
      document
        .querySelector('[data-pkc-region="filer-table"]')
        ?.querySelector('[data-pkc-entry]')
        ?.getAttribute('data-pkc-entry') ?? null,
  );
  expect(lid, '前提: 的の lid が取れない(この test は何も測っていない)').not.toBeNull();

  // ② 参照する側
  await createEntry(page, 'text');
  const ta2 = page.locator('[data-pkc-field="editor-body"]');
  await ta2.click();
  await ta2.fill(`ここから [的](entry:${lid}) を参照する\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ③ 的を選び直すと、参照元が出る
  await clickReal(page, `[data-pkc-entry="${lid}"]`);
  const box = page.locator('[data-pkc-field="inspector-backlinks"]');
  await expect(box, '参照元の行が無い').toBeVisible();
  const link = box.locator('[data-pkc-field="inspector-backlink"]');
  await expect(link, '参照元が出ていない(worker から届いていない)').toHaveCount(1);

  // ④ 押すと移れる(辿れないと、一覧しても行き止まり)
  await link.click();
  await expect(
    page.locator('[data-pkc-field="detail-body"]'),
    '押しても移れない',
  ).toContainText('参照する');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
