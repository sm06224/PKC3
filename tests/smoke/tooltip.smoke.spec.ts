/**
 * 🔴 **上側のツールチップ**(#1982 A3)。unit(happy-dom)では寸法が全部 0 なので、置き場所は実ブラウザでしか測れない。
 *
 * ① 画面の中ほどのボタン: 出た吹き出しの下端が `min(対象の上端, ポインタ y)` より上
 * ② 左の縦のバーの先頭(上に収まらない): 下へ落とさず横へ。対象とポインタのどちらにも重ならない
 * ③ 出ている間だけ標準の `title` が退避され、離れたら戻る
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, collectPageErrors, dismissAnnounce } from './helpers';

const TIP = '[data-pkc-region="tooltip"]';

async function hoverCenter(page: Page, sel: string): Promise<{ x: number; y: number; rect: DOMRect }> {
  const box = await page.locator(sel).first().boundingBox();
  if (box === null) throw new Error(`見えない: ${sel}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(0, 300);
  await page.mouse.move(x, y, { steps: 4 });
  return { x, y, rect: { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height } as DOMRect };
}

test('🔴 画面の中ほどのボタンでは、対象とポインタの両方より上に出る。title は出ている間だけ退避', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  // 中ほどに在る、title を持つボタン(上端が 150px より下のもの)を探す
  const sel = await page.evaluate(() => {
    const cands = [...document.querySelectorAll<HTMLElement>('button[title]')];
    const hit = cands.find((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.top > 150 && r.left > 300 && r.bottom < innerHeight - 50;
    });
    if (hit === undefined) return null;
    hit.setAttribute('data-pkc-tip-probe', '');
    return '[data-pkc-tip-probe]';
  });
  expect(sel, 'title を持つ中ほどのボタンが無い').not.toBeNull();
  const title = await page.locator(sel!).getAttribute('title');
  const { y, rect } = await hoverCenter(page, sel!);
  await expect(page.locator(TIP)).toBeVisible({ timeout: 3000 });
  await expect(page.locator(sel!)).not.toHaveAttribute('title', /.*/);
  expect(await page.locator(sel!).getAttribute('data-pkc-tip-title')).toBe(title);
  const t = (await page.locator(TIP).boundingBox())!;
  expect(t.y + t.height).toBeLessThanOrEqual(Math.min(rect.top, y) + 0.5);
  await page.mouse.move(5, 5);
  await expect(page.locator(TIP)).toBeHidden();
  await expect(page.locator(sel!)).toHaveAttribute('title', title!);
  expect(errors, `page error: ${errors.join(" / ")}`).toEqual([]);
});

test('🔴 左の縦のバーの先頭(上に収まらない)では、下へ落とさず横に出て、対象にもポインタにも重ならない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  const sel = '[data-pkc-region="rail"] button[title]';
  await expect(page.locator(sel).first()).toBeVisible();
  const title = await page.locator(sel).first().getAttribute('title');
  const { x, y, rect } = await hoverCenter(page, sel);
  await expect(page.locator(TIP)).toBeVisible({ timeout: 3000 });
  const t = (await page.locator(TIP).boundingBox())!;
  const side = await page.locator(TIP).getAttribute('data-pkc-tip-side');
  expect(side).toBe('right');
  expect(t.x).toBeGreaterThanOrEqual(rect.right);
  expect(t.x).toBeGreaterThan(x);
  expect(t.y).toBeGreaterThanOrEqual(0);
  // ポインタの点を含まない
  expect(x >= t.x && x <= t.x + t.width && y >= t.y && y <= t.y + t.height).toBe(false);
  await page.mouse.move(900, 600);
  await expect(page.locator(TIP)).toBeHidden();
  await expect(page.locator(sel).first()).toHaveAttribute('title', title!);
  expect(errors, `page error: ${errors.join(" / ")}`).toEqual([]);
});
