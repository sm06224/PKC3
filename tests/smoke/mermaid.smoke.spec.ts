import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * P8 段③: 図は **PNG 1 枚**で置く。
 *
 * > user 指示 2026-08-03(不可侵)「mermaid 図のエクスポートをさせるとき以外は
 * > PNG ラスタをキャッシュして、GPU レンダリングで表示して欲しい」
 *
 * 🔴 PKC3 には**描く側が存在しなかった**(placeholder を出すだけで、依存も無し)。
 * ⚠ 観測点は「図が出た」ではなく「**何が DOM に置かれたか**」── SVG を置く実装でも
 * 「図が出た」は通ってしまう。
 */
test('🔴 図は PNG の img で置かれ、SVG を DOM に残さない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('図のノート');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('# 図\n\n```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```\n');

  // ① 編集中のプレビューにも出る(保存するまで図が見えない、を落とす)
  const inPreview = page.locator('[data-pkc-region="editor-preview"] [data-pkc-mermaid-src]');
  await expect(inPreview).toHaveAttribute('data-pkc-mermaid-state', 'ready', {
    timeout: 30000,
  });

  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const host = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });

  // ② 🔴 置かれているのは **img**。しかも中身は PNG
  const placed = await host.evaluate((h) => {
    const img = h.querySelector('img');
    return {
      tag: h.firstElementChild?.tagName ?? 'NONE',
      src: img?.getAttribute('src')?.slice(0, 5) ?? '',
      natural: img?.naturalWidth ?? 0,
    };
  });
  expect(placed.tag, 'img ではないものが置かれている').toBe('IMG');
  expect(placed.src, 'blob の ObjectURL ではない').toBe('blob:');
  expect(placed.natural, '画像が読めていない').toBeGreaterThan(0);

  // ③ 🔴 **SVG を DOM に残さない**(これが「スクロールが GPU に乗る」の実体)
  expect(await page.evaluate(() => document.querySelectorAll('svg').length)).toBe(0);

  // ④ 🔴 焼いた画素が表示幅以上(Retina でボケない ── 等倍で焼く実装を落とす)
  const sharp = await host.evaluate((h) => {
    const img = h.querySelector('img')!;
    return img.naturalWidth / Math.max(1, img.clientWidth) - window.devicePixelRatio;
  });
  expect(sharp, '表示幅に対して焼いた画素が足りない(ボケる)').toBeGreaterThan(-0.05);

  expect(errors).toEqual([]);
});
