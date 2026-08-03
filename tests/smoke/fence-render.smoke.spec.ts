/**
 * smoke #3(P3-8): csv fence の表と html fence の sandbox iframe が
 * 「実際に画面に出る」(PKC2 で S4 の iframe 高さ 0 を踏んだ故障クラスの検品)。
 * ⚠ mermaid の実 render は 20s 級の待ちを持つため PR gate に入れない(nightly 検討)。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal, createEntry } from './helpers';

test('csv 表と html sandbox iframe が可視高さを持つ', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  await page.keyboard.type(
    '```csv-render\n列A,列B\n1,2\n```\n\n```html\n<p style="height:120px">sandbox</p>\n```',
  );
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // csv: レンダリング面の table が可視
  const table = page.locator('[data-pkc-field="detail-body"] table').first();
  await expect(table).toBeVisible();
  expect((await table.boundingBox())!.height).toBeGreaterThan(0);

  // html: sandbox iframe が resize message で実高さを得る(srcdoc load 後)
  const iframe = page.locator('iframe[data-pkc-html-render-id]');
  await expect(iframe).toBeAttached();
  await expect
    .poll(
      async () => {
        const box = await iframe.boundingBox();
        return box?.height ?? 0;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThan(100); // 中身(120px)に追従した高さ ── height 0 の再演防止

  expect(errors).toEqual([]);
});
