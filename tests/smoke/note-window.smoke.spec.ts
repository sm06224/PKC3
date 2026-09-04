import { test, expect } from '@playwright/test';
import { clickReal, createEntry, dismissAnnounce, gotoApp } from './helpers';

/**
 * 🔴 **このノートを別の窓で開く ── 付箋**(#685 段②、user 裁定 2026-09-04)。
 *
 * > 「**スマホ用の幅狭画面はPCでも活躍してます!/ 画面の隅に表示したメモ追記を
 * > 使ってどんどんスクラップできてます / 付箋的に使えるのもいいですね /
 * > マルチで付箋開けるといいかもね**」(利用者の感想 2026-09-04)
 *
 * ## ⚠ ここでしか測れないもの
 *
 * unit が持つのは「**どんな URL を組むか**」まで(`view-window.test.ts` /
 * `permalink-view.test.ts`)。🔑 ここが持つのは **その URL で開いた窓が、
 * 本当にそのノートを開いて立ち上がるか**である ── 段① と段② は
 * **別々に緑でも、繋がっていなければ意味が無い**(CLAUDE.md §7
 * 「両端が相手を模した stub と話していると、綴りの食い違いが両方緑のまま通る」)。
 */
test('🔴 別の窓で開くと、その窓がそのノートを開いて立ち上がる (#685)', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);

  // ⚠ **2 件作る** ── 1 件だと「たまたま先頭が開いた」と区別が付かない
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('ひとつめ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('ふたつめ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // 🔑 いま開いているのは「ふたつめ」── これが連れて行かれる相手である
  await expect(
    page.locator('[data-pkc-region="inspector"]'),
    '前提が崩れた(ふたつめを開いていない)',
  ).toContainText('ふたつめ');

  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  const win = await popup;
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });

  /**
   * ① 🔴 **開いた窓が、そのノートを開いている**(段① と段② が繋がっている)。
   * ⚠ **題名で見る** ── 「何か開いた」では、先頭のノートが開いただけでも真になる。
   */
  await expect(
    win.locator('[data-pkc-region="inspector"]'),
    '別の窓が、連れて行ったノートを開いていない',
  ).toContainText('ふたつめ', { timeout: 20_000 });

  /**
   * ② 🔴 **元の窓は動かない**(user 要望の本体 ── 付箋は本文を退かさない)。
   */
  await expect(
    page.locator('[data-pkc-region="inspector"]'),
    '元の窓のノートが入れ替わった',
  ).toContainText('ふたつめ');

  /**
   * ③ 🔴 **何枚でも開ける**(「マルチで付箋」)── 窓を使い回さない。
   */
  const popup2 = context.waitForEvent('page');
  await page.bringToFront();
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  const win2 = await popup2;
  await expect(win2.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  expect(win2, '2 枚目が 1 枚目と同じ窓になっている(使い回している)').not.toBe(win);

  await win.close();
  await win2.close();
});
