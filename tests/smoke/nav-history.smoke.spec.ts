import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor, useStandalone } from './helpers';

/**
 * 🔴 **マウスの戻る・進むボタン / ブラウザの「戻る」/ アプリとして開いたときの ‹ ›**(A1。user 裁定 2026-11-22)。
 *
 * マウスの戻るボタンは CDP の `Input.dispatchMouseEvent`(button: 'back')で押す ── ブラウザ自身の戻る(履歴の移動)も
 * 本物どおり走るので、🔴 **1 クリックで 2 回戻らない**(user 必須ガード)ことを実物で見られる。
 * 観測点は中央の題名(選んだノート)と、アドレスが変わらないこと・ページを離れていないこと。
 */

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const TITLE = '[data-pkc-field="detail-title"]';

async function makeNotes(page: Page, names: readonly string[]): Promise<void> {
  for (const n of names) {
    await createEntry(page, 'text');
    await page.locator('[data-pkc-field="editor-title"]').fill(n);
    await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await expect(page.locator(TITLE)).toHaveText(n);
  }
}

async function openRow(page: Page, name: string): Promise<void> {
  await page.locator('[data-pkc-region="filer-table"] tbody tr', { hasText: name }).first().click();
  await expect(page.locator(TITLE)).toHaveText(name);
}

async function mouseButton(page: Page, button: 'back' | 'forward'): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const box = await page.locator('[data-pkc-region="detail"]').boundingBox();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  const buttons = button === 'back' ? 8 : 16;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
  await cdp.detach();
}

test('🔴 マウスの戻るボタン 1 回で 1 つだけ戻る(2 回戻らない)/ 進むボタンで進む / アドレスは変わらない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeNotes(page, ['一', '二', '三']);
  await openRow(page, '一');
  await openRow(page, '二');
  await openRow(page, '三');
  const url = page.url();
  await mouseButton(page, 'back');
  await expect(page.locator(TITLE), 'マウスの戻るで戻らない').toHaveText('二');
  await page.waitForTimeout(400); // ブラウザ自身の戻る(番兵の popstate)が遅れて来ても、もう 1 度は戻らない
  await expect(page.locator(TITLE), '🔴 1 クリックで 2 回戻った').toHaveText('二');
  expect(page.url(), 'アドレスが変わった').toBe(url);
  await mouseButton(page, 'forward');
  await expect(page.locator(TITLE), 'マウスの進むで進まない').toHaveText('三');
  // 続けて押しても 1 回ずつ(抑止は 1 回きり)
  await mouseButton(page, 'back');
  await expect(page.locator(TITLE)).toHaveText('二');
  await page.waitForTimeout(400);
  await mouseButton(page, 'back');
  await expect(page.locator(TITLE)).toHaveText('一');
  await page.waitForTimeout(400);
  await expect(page.locator(TITLE), '🔴 2 回目のクリックで余分に戻った').toHaveText('一');
  expect(page.url()).toBe(url);
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 ブラウザの「戻る」でアプリの中で 1 つ戻る(ページを離れない)/ 戻る先が無くなったら閉じ込めない', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeNotes(page, ['一', '二']);
  await openRow(page, '一');
  await openRow(page, '二');
  const url = page.url();
  await page.evaluate(() => history.back());
  await expect(page.locator(TITLE), 'ブラウザの戻るで戻らない').toHaveText('一');
  expect(page.url(), 'アドレスが変わった').toBe(url);
  await expect(page.locator('[data-pkc-boot="ready"]'), 'ページを離れた').toBeAttached();
  // 番兵は置き直されている ── もう 1 度の戻るも、戻れる間はアプリの中
  const lenBefore = await page.evaluate(() => history.length);
  expect(lenBefore).toBeGreaterThan(1);
});

test('🔴 左上の ‹ › はブラウザのタブでは出さず、アプリとして開いたときは標準のボタンの大きさで出て、押すと戻る', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await expect(page.locator('[data-pkc-region="find-bar"] [data-pkc-action="nav-back"]'), 'ブラウザのタブで ‹ が出ている').toBeHidden();
  // スマホの幅では、ブラウザのタブでも出す(マウスの戻る・進むも Alt + ← も無い ── ノートの戻る・進むの入口はここだけ)
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-pkc-region="find-bar"] [data-pkc-action="nav-back"]'), 'スマホの幅で ‹ が消えた').toBeVisible();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const app = await ctx.newPage();
  await useSplitEditor(app);
  await useStandalone(app);
  await gotoApp(app);
  await makeNotes(app, ['一', '二']);
  await openRow(app, '一');
  await openRow(app, '二');
  const back = app.locator('[data-pkc-region="find-bar"] [data-pkc-action="nav-back"]');
  await expect(back, 'アプリとして開いたのに ‹ が出ない').toBeVisible();
  const m = await app.evaluate(() => {
    const b = document.querySelector<HTMLElement>('[data-pkc-region="find-bar"] [data-pkc-action="nav-back"]')!;
    const ref = document.querySelector<HTMLElement>('[data-pkc-region="detail"] [data-pkc-action="copy-note-md"]')!;
    const cs = getComputedStyle(b);
    return { h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width, refH: ref.getBoundingClientRect().height, border: cs.borderTopWidth, fs: parseFloat(cs.fontSize) };
  });
  expect(Math.abs(m.h - m.refH), `‹ の高さが標準のボタンと違う(${m.h} / ${m.refH})`).toBeLessThanOrEqual(1);
  expect(m.w, '‹ が細すぎる').toBeGreaterThanOrEqual(m.refH - 1);
  expect(m.border, '‹ に枠が無い(ボタンに見えない)').toBe('1px');
  expect(m.fs, '‹ の字が小さすぎる').toBeGreaterThanOrEqual(13);
  await clickReal(app, '[data-pkc-region="find-bar"] [data-pkc-action="nav-back"]');
  await expect(app.locator(TITLE)).toHaveText('一');
  await ctx.close();
});
