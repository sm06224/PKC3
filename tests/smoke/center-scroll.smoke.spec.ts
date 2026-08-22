import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

/**
 * 🔴 **面を開いて戻っても、読んでいた場所に戻る**(user 目線レビュー U-4、2026-08-22)。
 *
 * ## unit では原理的に届かない
 *
 * この欠陥の正体は**実レイアウト**である ── 面は同じスクロール箱の中で `hidden` を
 * 付け替えるので、**開いた面が箱より短いと `scrollTop` がその場で 0 に丸められる**。
 * happy-dom には版面が無いので、この丸めは起きない = 見えない。
 *
 * 実測(直す前。1440×900・300 段落):
 *
 * | | scrollHeight | scrollTop |
 * |---|---|---|
 * | 本文 | 9651 | 1000 |
 * | **カレンダーを開いている間** | **626**(= clientHeight) | **0 に丸められる** |
 * | 本文へ戻った後 | 9651 に戻る | **0 のまま** |
 * | ヘルプを開いている間 | 4039 | 1000(**長いので偶然残る**) |
 *
 * ⚠ **ヘルプで残るのは偶然**である(マニュアルが長いだけ)── だから
 *   「ヘルプは大丈夫」を根拠にしない。短い面(カレンダー)で見る。
 *
 * ⚠ **戻しはワーカーの後に来る** ── 本文はワーカーで描くので、面を入れ替えた
 *   直後に戻しても中身がまだ無く、また丸められる(実測:400ms 待っても 0)。
 *   `CenterRouter.restoreScroll` が届くまで数フレーム粘る。
 */
test('🔴 カレンダーを開いて戻ると、読んでいた場所に戻る (U-4)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await useSplitEditor(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  const long = Array.from({ length: 300 }, (_, i) => `${i} 行目の段落です。`).join('\n\n');
  await page.locator('[data-pkc-field="editor-body"]').waitFor();
  await page.evaluate((body) => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = body;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, long);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await page.waitForTimeout(1000);

  const box = '[data-pkc-region="detail"]';
  const top = async (): Promise<number> =>
    page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).scrollTop, box);
  const size = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    return { sh: el.scrollHeight, ch: el.clientHeight };
  }, box);
  // ⚠ **空振り防止** ── そもそもスクロールできる高さが無ければ、この test は
  //    何も確かめていない(本文が短いままだと必ず 0 == 0 で通る)
  expect(size.sh, 'スクロールできる高さが無い(fixture が短い)').toBeGreaterThan(size.ch * 3);

  await page.evaluate((sel) => { (document.querySelector(sel) as HTMLElement).scrollTop = 1000; }, box);
  await page.waitForTimeout(200);
  expect(await top(), '位置を作れていない').toBe(1000);

  await clickReal(page, '[data-pkc-browse="launcher"]');
  const tile = page.locator('[data-pkc-action="open-tile"][data-pkc-tile="builtin:calendar"]');
  await tile.click();
  await expect(page.locator('[data-pkc-view-pane="calendar"]')).toBeVisible();
  // ⚠ **対照群** ── 開いている間は丸められている(= 直しは「戻す」側で効いている。
  //    「そもそも丸められない」に変わったのなら、この test の前提が変わっている)
  expect(await top(), '丸めが起きていない ── 前提が変わった').toBe(0);

  await tile.click();
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeVisible();
  await page.waitForTimeout(700);
  expect(await top(), '読んでいた場所へ戻らない').toBe(1000);

  // ⚠ 2 巡目 ── 覚え直しが効く(1 回目の値に固定されない)
  await page.evaluate((sel) => { (document.querySelector(sel) as HTMLElement).scrollTop = 2500; }, box);
  await page.waitForTimeout(200);
  await tile.click();
  await expect(page.locator('[data-pkc-view-pane="calendar"]')).toBeVisible();
  await tile.click();
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeVisible();
  await page.waitForTimeout(700);
  expect(await top(), '2 巡目で古い位置に固定された').toBe(2500);
  expect(errors, 'page error が出た').toEqual([]);
});
