/**
 * smoke: 画像に描き込む(#683 段③)。
 *
 * 動線:添付の画像を開く →「画像に描き込む」→ 別ウィンドウで描く → 「新しい画像として保存」
 *       → 新しい添付が増え、元は変わらない / 「やめる」→ 何も増えない。
 *
 * 観測点は画素である(属性の有無ではない):描いた場所が赤くなっていること・
 * 元の画像の同じ場所は青のままであること・大きさが同じであること。
 */
import { test, expect, type Page } from '@playwright/test';
import { clickReal, collectPageErrors, gotoApp } from './helpers';

/** 青一色の 240×160 PNG(描いた跡が画素で分かる)。 */
async function bluePng(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 240;
    c.height = 160;
    const g = c.getContext('2d')!;
    g.fillStyle = '#3060c0';
    g.fillRect(0, 0, 240, 160);
    return c.toDataURL('image/png');
  });
  return Buffer.from(dataUrl.split(',')[1]!, 'base64');
}

/** 窓の台の (x, y)(画像の座標)の画素。 */
async function pixelOf(win: Page, x: number, y: number): Promise<[number, number, number]> {
  return win.evaluate(
    ([px, py]) => {
      const c = document.querySelector<HTMLCanvasElement>('[data-pkc-field="image-draw-canvas"]')!;
      const d = c.getContext('2d')!.getImageData(px!, py!, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!] as [number, number, number];
    },
    [x, y],
  );
}

/** 画像座標 → 画面座標(台は縮めて出ることがあるので、枠から換算する)。 */
async function screenOf(win: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return win.evaluate(
    ([px, py]) => {
      const c = document.querySelector<HTMLCanvasElement>('[data-pkc-field="image-draw-canvas"]')!;
      const r = c.getBoundingClientRect();
      return { x: r.left + (px! * r.width) / c.width, y: r.top + (py! * r.height) / c.height };
    },
    [x, y],
  );
}

async function drag(win: Page, from: [number, number], to: [number, number]): Promise<void> {
  const a = await screenOf(win, from[0], from[1]);
  const b = await screenOf(win, to[0], to[1]);
  await win.mouse.move(a.x, a.y);
  await win.mouse.down();
  await win.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await win.mouse.move(b.x, b.y, { steps: 4 });
  await win.mouse.up();
}

const isRed = (p: [number, number, number]): boolean => p[0] > 180 && p[1] < 90 && p[2] < 90;
const isBlue = (p: [number, number, number]): boolean => p[2] > 150 && p[0] < 100;
const isBlack = (p: [number, number, number]): boolean => p[0] < 40 && p[1] < 40 && p[2] < 40;

/** ウィンドウ側の画像を、主ページの <img> から読んだ画素(元と新しい添付を比べる)。 */
async function shownPixel(
  page: Page,
  x: number,
  y: number,
): Promise<{ w: number; h: number; px: [number, number, number] }> {
  const img = page.locator('img[data-pkc-field="attachment-media"]').first();
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth))
    .toBeTruthy();
  return img.evaluate(
    (el, [px, py]) => {
      const i = el as HTMLImageElement;
      const c = document.createElement('canvas');
      c.width = i.naturalWidth;
      c.height = i.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(i, 0, 0);
      const d = g.getImageData(px!, py!, 1, 1).data;
      return { w: i.naturalWidth, h: i.naturalHeight, px: [d[0]!, d[1]!, d[2]!] as [number, number, number] };
    },
    [x, y],
  );
}

test('🔴 画像に描き込む ── 描く・取り消す・新しい画像として保存(元は変わらない)/ やめると何も増えない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  const png = await bluePng(page);
  await page.setInputFiles('[data-pkc-field="attach-input"]', { name: 'plan.png', mimeType: 'image/png', buffer: png });
  const draw = page.locator('[data-pkc-action="draw-on-image"]');
  await expect(draw, '画像の詳細に「画像に描き込む」が出ない').toBeVisible();
  await expect(draw).toHaveText('画像に描き込む');

  // ── 1 回目:描いて、1 本取り消して、保存 ──
  const [win] = await Promise.all([page.waitForEvent('popup', { timeout: 10_000 }), clickReal(page, draw)]);
  await win.waitForSelector('[data-pkc-field="image-draw-canvas"]', { timeout: 5000 });
  await expect.poll(() => win.evaluate(() => document.querySelector<HTMLCanvasElement>('[data-pkc-field="image-draw-canvas"]')!.width)).toBe(240);
  expect(await win.title()).toBe('plan.png に描き込む');
  expect(await win.evaluate(() => document.querySelector<HTMLCanvasElement>('[data-pkc-field="image-draw-canvas"]')!.height)).toBe(160);
  // 描く前は青(元の画像がそのまま台に載っている)
  expect(isBlue(await pixelOf(win, 40, 40)), '台に元の画像が載っていない').toBe(true);

  // 🔴 線が無いうちは保存を押せない
  await expect(win.locator('[data-pkc-field="image-draw-save"]'), '線が無いのに保存を押せる').toBeDisabled();

  // 🔴 選んでいる道具・色が「見た目」に出る(属性だけでなく計算後の背景色)
  const bg = (field: string): Promise<string> =>
    win.evaluate((f) => getComputedStyle(document.querySelector(`[data-pkc-field="${f}"]`)!).backgroundColor, field);
  const pen = 'image-draw-tool-pen';
  const rect = 'image-draw-tool-rect';
  await expect(win.locator(`[data-pkc-field="${pen}"]`)).toHaveAttribute('aria-pressed', 'true');
  const penOn = await bg(pen);
  const rectOff = await bg(rect);
  expect(penOn, '選んだ道具が選んでいない道具と見分けられない').not.toBe(rectOff);
  await win.locator(`[data-pkc-field="${rect}"]`).click();
  expect(await bg(rect), '選び直しても見た目が動かない').toBe(penOn);
  expect(await bg(pen)).toBe(rectOff);
  await win.locator(`[data-pkc-field="${pen}"]`).click();

  // ペン(赤・既定)で横に線
  await drag(win, [20, 40], [120, 40]);
  expect(isRed(await pixelOf(win, 70, 40)), 'ペンで引いた線が赤くない').toBe(true);
  // 黒の四角
  await win.locator('[data-pkc-field="image-draw-color-black"]').click();
  await win.locator('[data-pkc-field="image-draw-tool-rect"]').click();
  await drag(win, [20, 80], [120, 130]);
  expect(isBlack(await pixelOf(win, 70, 80)), '四角の辺が黒くない').toBe(true);
  expect(isBlue(await pixelOf(win, 70, 105)), '四角の内側まで塗りつぶしている').toBe(true);
  // 矢印(黒)
  await win.locator('[data-pkc-field="image-draw-tool-arrow"]').click();
  await drag(win, [140, 140], [220, 100]);
  expect(isBlack(await pixelOf(win, 180, 120)), '矢印の軸が描かれていない').toBe(true);

  // 元に戻す = 最後の 1 本(矢印)だけが消える
  await win.locator('[data-pkc-field="image-draw-undo"]').click();
  expect(isBlue(await pixelOf(win, 180, 120)), '元に戻しても矢印が残っている').toBe(true);
  expect(isBlack(await pixelOf(win, 70, 80)), '1 本戻すつもりが四角まで消えた').toBe(true);
  expect(isRed(await pixelOf(win, 70, 40))).toBe(true);

  // 保存 → 窓が閉じ、新しい添付が増える
  const closed = win.waitForEvent('close', { timeout: 10_000 });
  await win.locator('[data-pkc-field="image-draw-save"]').click();
  await closed;
  const made = page.locator('[data-pkc-action="select-entry"][data-pkc-entry]', { hasText: 'plan (描き込み).png' });
  await expect(made.first(), '新しい添付が増えない').toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('描き込んだ画像を保存しました');

  // 新しい添付:同じ大きさで、描いた場所が赤い
  await made.first().click();
  const after = await shownPixel(page, 70, 40);
  expect([after.w, after.h], '大きさが元と違う').toEqual([240, 160]);
  expect(isRed(after.px), '保存した画像に線が焼かれていない').toBe(true);
  // 元の添付:触られていない(同じ場所は青のまま)
  await page
    .locator('[data-pkc-action="select-entry"][data-pkc-entry]', { hasText: 'plan.png', hasNotText: '描き込み' })
    .first()
    .click();
  const orig = await shownPixel(page, 70, 40);
  expect([orig.w, orig.h]).toEqual([240, 160]);
  expect(isBlue(orig.px), '元の画像が書き換わった').toBe(true);

  // ── 2 回目:描いて「やめる」── 何も増えない ──
  const count = (): Promise<number> =>
    page.locator('[data-pkc-action="select-entry"][data-pkc-entry]', { hasText: '描き込み' }).count();
  const before = await count();
  const [win2] = await Promise.all([
    page.waitForEvent('popup', { timeout: 10_000 }),
    clickReal(page, '[data-pkc-action="draw-on-image"]'),
  ]);
  await win2.waitForSelector('[data-pkc-field="image-draw-canvas"]', { timeout: 5000 });
  await expect.poll(() => win2.evaluate(() => document.querySelector<HTMLCanvasElement>('[data-pkc-field="image-draw-canvas"]')!.width)).toBe(240);
  await drag(win2, [20, 20], [100, 60]);
  // 🔴 線があるときの「やめる」は、閉じずに確かめる ── 「続ける」で戻り、「捨てて閉じる」で閉じる
  await win2.locator('[data-pkc-field="image-draw-cancel"]').click();
  await expect(win2.locator('[data-pkc-field="image-draw-confirm"]')).toBeVisible();
  expect(win2.isClosed(), '確かめずに閉じた').toBe(false);
  await win2.locator('[data-pkc-field="image-draw-keep"]').click();
  await expect(win2.locator('[data-pkc-field="image-draw-confirm"]')).toBeHidden();
  // 🔴 開いている間に押し直しても、2 枚目は開かず同じ窓のまま
  let extra = 0;
  page.on('popup', () => (extra += 1));
  await clickReal(page, '[data-pkc-action="draw-on-image"]');
  await page.waitForTimeout(300);
  expect(extra, '押し直したら窓がもう 1 枚開いた').toBe(0);
  const closed2 = win2.waitForEvent('close', { timeout: 10_000 });
  await win2.locator('[data-pkc-field="image-draw-cancel"]').click();
  await win2.locator('[data-pkc-field="image-draw-discard"]').click();
  await closed2;
  // 窓が閉じた後の保存の流れが終わるのを、少なくとも 1 周待ってから数える
  await page.waitForTimeout(500);
  expect(await count(), '「やめる」で添付が増えた').toBe(before);

  // ── 3 回目:窓より大きい画像 ── 縮めて出た台でも、押した所に線が引かれる / 窓を狭めても台が全部見える ──
  const bigUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 3200;
    const g = c.getContext('2d')!;
    g.fillStyle = '#3060c0';
    g.fillRect(0, 0, 1200, 3200);
    return c.toDataURL('image/png');
  });
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'big.png',
    mimeType: 'image/png',
    buffer: Buffer.from(bigUrl.split(',')[1]!, 'base64'),
  });
  await page
    .locator('[data-pkc-action="select-entry"][data-pkc-entry]', { hasText: 'big.png' })
    .first()
    .click();
  const [win3] = await Promise.all([
    page.waitForEvent('popup', { timeout: 10_000 }),
    clickReal(page, '[data-pkc-action="draw-on-image"]'),
  ]);
  await win3.waitForSelector('[data-pkc-field="image-draw-canvas"]', { timeout: 5000 });
  await expect.poll(() => win3.evaluate(() => document.querySelector<HTMLCanvasElement>('[data-pkc-field="image-draw-canvas"]')!.width)).toBe(1200);
  const fit = async (): Promise<{ shown: number; natural: number; bottom: number; inner: number; barBottom: number; top: number }> =>
    win3.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-pkc-field="image-draw-canvas"]')!;
      const r = c.getBoundingClientRect();
      const bar = document.querySelector('[data-pkc-field="image-draw-bar"]')!.getBoundingClientRect();
      return { shown: r.width, natural: c.width, bottom: r.bottom, inner: window.innerHeight, barBottom: bar.bottom, top: r.top };
    });
  const wide = await fit();
  expect(wide.shown, '大きな画像が縮めて出ていない').toBeLessThan(wide.natural);
  expect(wide.bottom, '台の下が窓から切れている').toBeLessThanOrEqual(wide.inner);
  // 縮めて出ているのに、押した所(画像の座標 600,1600 付近)に線が引かれる
  await drag(win3, [550, 1500], [650, 1700]);
  expect(isRed(await pixelOf(win3, 600, 1600)), '縮めて出した台で、押した所に線が引かれていない').toBe(true);
  // 窓を狭めて道具の列が折り返しても、台の下まで見える
  await win3.setViewportSize({ width: 520, height: 700 });
  await expect.poll(async () => (await fit()).shown).toBeLessThan(520);
  const narrow = await fit();
  expect(narrow.bottom, '狭い窓で台の下が切れている').toBeLessThanOrEqual(narrow.inner);
  expect(narrow.top, '台が道具の列の下に潜っている').toBeGreaterThanOrEqual(narrow.barBottom - 1);
  // 🔴 本体が消えているとき、保存を押しても無反応にならない
  await win3.evaluate(() => Object.defineProperty(window, 'opener', { value: null, configurable: true }));
  await win3.locator('[data-pkc-field="image-draw-save"]').click();
  await expect(win3.locator('[data-pkc-field="image-draw-status"]')).toHaveText('元の画面が閉じられたので保存できません');
  expect(win3.isClosed()).toBe(false);
  await win3.close();

  expect(errors).toEqual([]);
});
