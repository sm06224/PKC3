import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, dismissAnnounce, gotoApp } from './helpers';

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
  const errors = collectPageErrors(page);
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
  const winErrors = collectPageErrors(win);
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });

  /**
   * ⓪ 🔴 **開くのは「面」ではなく、そのノート**(着地前レビュー M1)。
   * ⚠ 直す前は、`openViewInWindow(null, …)` の `null` を面の名前に変える変異が
   *   **生き延びた** ── 下の①は `inspector` を見ており、`inspector.render` は
   *   `viewMode` に関係なく毎回走るので、2 ペインで立ち上がっても題名は当たる。
   *   その変異が入ると付箋の中央に 2 ペインが出て、**本文が消える**
   *   (= この機能が存在する理由そのものが壊れる)。
   */
  await expect(
    win.locator('[data-pkc-view-pane="detail"]'),
    '付箋が面で立ち上がっている(本文が出ていない)',
  ).toBeVisible({ timeout: 20_000 });
  expect(win.url(), '面を指す断片で開いている(付箋ではない)').not.toContain('view=');

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
  /**
   * ③ 🔴 **窓の題名にノートの題名が入る**(着地前レビュー ⚠3 / 動線レビュー 欠陥 1)。
   * ⚠ **タスクバーで見分けるため**である ── 直す前は何枚開いても全部「PKC3」で、
   *   「何枚でも開けます」が売りの機能なのに、並べた瞬間に見分けられなかった。
   */
  await expect
    .poll(() => win.title(), { timeout: 15_000 })
    .toBe('ふたつめ — PKC3');

  /**
   * ④ 🔴 **付箋に follower の帯を出さない**(着地前レビュー 🔴1 / 動線レビュー 欠陥 4)。
   * ⚠ 状態の行は **1 行**なので、常設の帯が「別の窓の変更と重なりました…」のような
   *   **本当に読ませたい文を横へ押し出す**(#300 段④ が消した理由がそのまま当てはまる)。
   * 🔑 対照群は `app-window-status.smoke.spec.ts` が持っている
   *   ── あちらが「ふつうの 2 枚目のタブでは出る」を先に見ている。
   */
  await expect(
    win.locator('[data-pkc-region="status"]'),
    '付箋に常設バッジが出ている(読ませたい文を押し出す)',
  ).not.toContainText('複数タブ: このタブの保存は本体タブ経由です');

  /**
   * ⑤ 🔴 **何枚でも開ける**(「マルチで付箋」)── 窓を使い回さない。
   * ⚠ 1 稿目は `expect(win2).not.toBe(win)` と書いていたが、`popup2` は `win` が
   *   生まれた**後**に張った待ちなので **原理的に `win` は返らない** =
   *   何も検出していなかった(着地前レビュー ⚠6)。
   * 🔑 だから見るのは「**2 枚とも生きていること**」にする ── 使い回すと
   *   1 枚目が navigate で潰される。
   */
  const popup2 = context.waitForEvent('page');
  await page.bringToFront();
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  const win2 = await popup2;
  await expect(win2.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(
    win.locator('[data-pkc-region="inspector"]'),
    '1 枚目が 2 枚目に潰された(窓を使い回している)',
  ).toContainText('ふたつめ');
  await expect(win2.locator('[data-pkc-region="inspector"]')).toContainText('ふたつめ');

  await win.close();
  await win2.close();

  expect(winErrors, `別の窓で page error: ${winErrors.join(' / ')}`).toEqual([]);
  expect(errors, `元の窓で page error: ${errors.join(' / ')}`).toEqual([]);
});
