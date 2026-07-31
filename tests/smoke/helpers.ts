/**
 * smoke 共通 helper(P3-8)。
 * - boot 待ちは DOM 契約 `[data-pkc-boot="ready"]`(main.ts が boot 完了で刻む)
 * - クリックは「その座標で実際に見えて・最前面にある」ことを elementFromPoint で
 *   確認してから実マウスで行う(happy-dom では検証できない層 ── visual parity 規約)
 * - pageerror / console.error は各 spec の最後に 0 件を assert する
 */
import { expect, type Page } from '@playwright/test';

export async function gotoApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({
    timeout: 15_000,
  });
}

export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}

/**
 * 実クリック: 中心座標の最前面要素が target(またはその子孫 / 祖先)であることを
 * 確認してから page.mouse.click。dead click / occlusion / zero-height を検出する。
 */
export async function clickReal(page: Page, selector: string): Promise<void> {
  const el = page.locator(selector).first();
  await expect(el).toBeVisible();
  const box = await el.boundingBox();
  expect(box, `${selector} に boundingBox が無い(画面に出ていない)`).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  const hit = await page.evaluate(
    ({ x, y, sel }) => {
      const at = document.elementFromPoint(x, y);
      const target = document.querySelector(sel);
      return !!(at && target && (at === target || target.contains(at) || at.contains(target)));
    },
    { x: cx, y: cy, sel: selector },
  );
  expect(hit, `${selector} の中心 (${cx},${cy}) が別要素に覆われている`).toBe(true);
  await page.mouse.click(cx, cy);
}
