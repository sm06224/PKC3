import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, dismissAnnounce, collectPageErrors } from './helpers';

/**
 * 🔴 **追記しても、読んでいた場所が失われない**(#782。user 報告 2026-09-07)。
 *
 * > 「追記をすると再レンダリングで頭に戻る。これは別窓で開いている同じメモの方も
 * > 同じ挙動で … **別窓側は再レンダリングでもスクロールは固定しておいて欲しい**」
 *
 * ## 🔴 unit では原理的に届かない
 *
 * 壊れ方は「**本文の高さが潰れて、ブラウザが送り位置を 0 に丸める**」である。
 * happy-dom は版面を持たないので `scrollTop` は丸められない ── 位置を見る検査は
 * **あの台では直す前でも緑になる**。ここが唯一の門である。
 * (器の中身が残ることのほうは `tests/adapter/detail-scroll.test.ts` が見る。)
 *
 * ## 実測(2026-09-07、直す前)
 *
 * | 観測 | 送り位置 | 本文の高さ | 塊の数 |
 * |---|---|---|---|
 * | 追記の前 | **1200** | 10208 | 280 |
 * | 器を空にした直後 | 🔴 **0** | 756 → 650 | 1 → 0 |
 * | 本文が戻った後 | 🔴 **0 のまま** | 10240 | 281 |
 */

const LONG = Array.from(
  { length: 140 },
  (_, i) => `## 節 ${i + 1}\n\n本文の行です。ここに字を並べます。${i}`,
).join('\n\n');

const top = (p: Page): Promise<number> =>
  p.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-pkc-region="detail"]');
    return el === null ? -1 : Math.round(el.scrollTop);
  });

async function makeLongNote(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live).toBeVisible();
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill(LONG);
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="append-input"]')).toBeVisible();
}

test('🔴 別の窓が追記しても、こちらの読んでいた場所は動かない (#782)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await makeLongNote(page);

  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  const win = await popup;
  const winErrors = collectPageErrors(win);
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(win.locator('[data-pkc-view-pane="detail"]')).toBeVisible({ timeout: 20_000 });
  await win.setViewportSize({ width: 900, height: 800 });
  await win.waitForTimeout(1000);

  // ⚠ **送れる本文であることを先に検める** ── 短い本文では 0 のままでも緑になる
  const room = await win.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
    return el.scrollHeight - el.clientHeight;
  });
  expect(room, '別窓の本文が短すぎて送れない(空振り)').toBeGreaterThan(2000);
  await win.evaluate(() => {
    document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!.scrollTop = 1200;
  });
  expect(await top(win), '前提が崩れた(送れていない)').toBe(1200);

  await page.locator('[data-pkc-field="append-input"]').fill('別の窓から追記した字');
  await clickReal(page, '[data-pkc-action="append-entry"]');

  // 🔑 **追記が別窓へ届くまで待つ** ── 届く前に測ると「動いていない」で必ず緑になる
  await expect(win.locator('[data-pkc-region="detail"]')).toContainText('別の窓から追記した字', {
    timeout: 15_000,
  });
  expect(await top(win), '別窓の読んでいた場所が失われた').toBe(1200);
  // ⚠ 遅れて飛ぶ形もあるので、落ち着いてからもう一度
  await win.waitForTimeout(800);
  expect(await top(win), '遅れて先頭へ飛んだ').toBe(1200);

  // 🔑 追記した側の窓も動かない(こちらは直す前から動いていない ── 対照群)
  expect(errors, `主の窓の error: ${errors.join(' / ')}`).toEqual([]);
  expect(winErrors, `別窓の error: ${winErrors.join(' / ')}`).toEqual([]);
});

test('🔴 自分の窓で追記しても、読んでいた場所は動かない (#782)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await makeLongNote(page);
  const room = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
    return el.scrollHeight - el.clientHeight;
  });
  expect(room, '本文が短すぎて送れない(空振り)').toBeGreaterThan(2000);
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!.scrollTop = 1500;
  });
  await page.locator('[data-pkc-field="append-input"]').fill('自分の窓で追記した字');
  await clickReal(page, '[data-pkc-action="append-entry"]');
  await expect(page.locator('[data-pkc-region="detail"]')).toContainText('自分の窓で追記した字', {
    timeout: 15_000,
  });
  expect(await top(page), '追記した窓が先頭へ飛んだ').toBe(1500);
  await page.waitForTimeout(800);
  expect(await top(page), '遅れて先頭へ飛んだ').toBe(1500);
  expect(errors, `error: ${errors.join(' / ')}`).toEqual([]);
});
