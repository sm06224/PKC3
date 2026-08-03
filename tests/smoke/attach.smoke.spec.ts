/**
 * smoke #4(P4a): 添付取込(実 file picker input)→ entry 出現 → preview が
 * 「実際に画面に出る」+ Blob 直 put 経路の end-to-end(実 IDB + 実 sqlite meta)。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal, expectImageRendered, clickMenuItem } from './helpers';

// 1x1 PNG(67 bytes)
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('添付取込 → entry 出現 → image preview が可視高さを持つ', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // 常設 hidden input に直接ファイルを渡す(picker ダイアログの代替)
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });

  // sidebar に添付 entry が生え、選択されている
  const row = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(row).toHaveCount(1);
  await expect(row.first()).toContainText('dot.png');

  // preview の img が blob: URL で実際に描画される(lend 経路)
  await expectImageRendered(page, '[data-pkc-field="attachment-media"]');

  // ダウンロード導線の可視 + クリック可能(占有チェック込み)
  await clickReal(page, '[data-pkc-action="download-asset"]');

  // ── P4b: 本文 markdown の asset: 参照が実描画される(placeholder → hydrate)──
  // 添付に割り当てられた key を DL ボタンから読み、text note の本文で参照する
  const assetKey = await page
    .locator('[data-pkc-action="download-asset"]')
    .first()
    .getAttribute('data-pkc-asset-key');
  await clickReal(page, '[data-pkc-action="create-entry"][data-pkc-archetype="text"]');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.click();
  await page.keyboard.type(`![点](asset:${assetKey})\n\n[点をDL](asset:${assetKey})`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await expectImageRendered(page, 'img[data-pkc-asset-key]'); // hydrator が実際に差した
  // DL link も実クリック可能(href 無し ── ナビゲーションを起こさない)
  await clickReal(page, 'a[data-pkc-action="download-asset"]');
  expect(page.url()).not.toContain('asset:'); // asset: へ遷移していない

  // ── P4b: 「添付の整理」(orphan GC)の end-to-end 配線 ──
  // この asset は attachment frontmatter と本文 asset: の両方から参照されて
  // いるので、実 sqlite 走査の結果は「未参照なし」が正(scan が実際に走った証拠)
  const dialogMsg = new Promise<string>((resolve) => {
    page.once('dialog', (d) => {
      resolve(d.message());
      void d.accept();
    });
  });
  await clickMenuItem(page, '[data-pkc-action="purge-orphan-assets"]');
  expect(await dialogMsg).toContain('未参照の添付データはありません');

  expect(errors).toEqual([]);
});
