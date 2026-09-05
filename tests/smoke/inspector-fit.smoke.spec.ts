/**
 * 🔴 **右の列(情報ペイン)の中身が、右端で切れない**(#700)。
 *
 * 1280〜1366 幅では右の列が下限の 220px になる。直す前はタグの行の「欄 + ボタン」が
 * `dl` の `1fr` の下限になって **dd 全部が 41px はみ出し**、「+ タグを足す」が
 * 画面の外で切れていた(押せない)。
 *
 * 🔑 観測点は**全数**である ── `[data-pkc-region="inspector"] *` の右端が窓の中。
 *   名指し(タグの行だけ)にすると、次に増えた行が同じ形で切れても鳴らない。
 * ⚠ 前提を assert する ── 右の列が**下限の幅で出ている**こと(広い窓では
 *   そもそも起きないので、この検査は何も主張しない)と、タグを足す欄が**在る**こと。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, dismissAnnounce } from './helpers';

for (const width of [1280, 1366]) {
  test(`🔴 ${width}×768 で右の列の中身は 1 つも右端からはみ出さない (#700)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 768 });
    await gotoApp(page);
    await dismissAnnounce(page);
    await createEntry(page, 'text');
    await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    const inspector = page.locator('[data-pkc-region="inspector"]');
    await expect(inspector).toBeVisible();
    await expect(inspector.locator('[data-pkc-field="tag-add-input"]'), 'タグを足す欄が無い(台の空振り)').toBeVisible();

    const r = await inspector.evaluate((el) => {
      const vw = document.documentElement.clientWidth;
      const box = el.getBoundingClientRect();
      const over = [...el.querySelectorAll('*')]
        .map((c) => ({ c, b: c.getBoundingClientRect() }))
        .filter(({ b }) => b.width > 0 && b.right > vw)
        .map(
          ({ c, b }) =>
            `${c.tagName.toLowerCase()}[${c.getAttribute('data-pkc-field') ?? c.getAttribute('data-pkc-action') ?? ''}] right=${Math.round(b.right)}`,
        );
      const add = el.querySelector('[data-pkc-action="add-tag"]')!.getBoundingClientRect();
      return { vw, paneW: Math.round(box.width), over, addRight: Math.round(add.right), addW: Math.round(add.width) };
    });
    // 🔑 前提: 右の列は下限の幅(220px 前後)── 広い窓ではこの不具合は起きない
    expect(r.paneW, `右の列が ${r.paneW}px(下限の幅でない ── この幅では不具合が起きない)`).toBeLessThan(260);
    expect(r.over, '右の列の中身が窓の右端からはみ出している').toEqual([]);
    // 「+ タグを足す」は押せる大きさで窓の中に在る(全数の中でも、報告の当の物は名指しで残す)
    expect(r.addW, 'タグを足すボタンが潰れている').toBeGreaterThan(8);
    expect(r.addRight, 'タグを足すボタンが窓の外').toBeLessThanOrEqual(r.vw);
  });
}
