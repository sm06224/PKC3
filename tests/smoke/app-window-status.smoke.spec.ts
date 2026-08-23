import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp } from './helpers';

/**
 * 🔴 **アプリの窓では、常設の「本体タブ経由です」を出さない**(#300 段④、2026-08-22。
 * 動線レビュー §10)。
 *
 * ## なぜ消すのか ── 「情報を減らしたい」ではない
 *
 * この帯を常設にした理由は #177 の
 * 「**意図と違う**接続形態は user が知るべき事実」である。⚠ アプリの窓は
 * **user が自分でタイルを押して開いた 2 枚目**なので、**その前提が成り立たない** ──
 * 意図どおりであり、しかも user がそこで**できることは何も無い**。
 *
 * ⚠ そして**実害がある**:状態の行は **1 行**なので、常設の帯が
 * 「別の窓の変更と重なりました…」(#178)のような**本当に読ませたい文**を
 * 横へ押し出す。
 *
 * ## 🔴 対照群を必ず置く
 *
 * ⚠ 「出ない」だけを見る test は、**帯そのものを壊しても緑**になる
 * (CLAUDE.md §1「代替物で満たせない条件にする」)。だから
 * **ふつうの 2 枚目のタブでは出る**ことを同じ spec で見る ──
 * 消したのは「アプリの窓のときだけ」であって、機能ごとではない。
 */
const BADGE = '複数タブ: このタブの保存は本体タブ経由です';
const STATUS = '[data-pkc-region="status"]';

test('🔴 アプリの窓は常設バッジを出さない / ふつうの 2 枚目は出す (#300 段④)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  /**
   * ① 🔴 **対照群 ── ふつうの 2 枚目のタブでは出る**(#177 のまま)。
   * ⚠ これを先に見る:出ないなら、以降の「出ない」は**何も証明しない**。
   */
  const plain = await context.newPage();
  await gotoApp(plain);
  await expect(
    plain.locator(STATUS),
    '前提が崩れている(ふつうの 2 枚目でバッジが出ていない)',
  ).toContainText(BADGE, { timeout: 15_000 });
  await plain.close();

  // ② 🔴 **アプリの窓**をタイルから開く(user と同じ手)
  await page.bringToFront();
  await clickReal(page, '[data-pkc-browse="launcher"]');
  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-tile"][data-pkc-tile="builtin:dual"]');
  const win = await popup;
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(win.locator('[data-pkc-view-pane="dual"]')).toBeVisible();

  /**
   * ⚠ **「出ない」は待って確かめる** ── boot の途中で一瞬出て消えるのと、
   *   最初から出ないのは別である。面が見えてから読む(上で待っている)。
   */
  await expect(
    win.locator(STATUS),
    'アプリの窓に常設バッジが出ている(読ませたい文を押し出す)',
  ).not.toContainText(BADGE);

  /**
   * ③ 🔴 **その窓が「ふつうの PKC」に戻ったら、バッジも戻る。**
   * ⚠ ここが無いと「follower の判定ごと壊した」変異が生き延びる ──
   *   消したのは**アプリの窓のときだけ**である、という主張の後半。
   */
  /**
   * ⚠ 離れ方は **`Alt+1`(本文の面へ)**を使う ── `× 閉じる` は
   *   **窓ごと閉じる**(#300 段③)ので、この主張を見る前に画面が消える
   *   (1 稿目はそれで `session closed` になった)。
   */
  await win.keyboard.press('Alt+1');
  await expect(win.locator('[data-pkc-view-pane="detail"]')).toBeVisible();
  await expect(
    win.locator(STATUS),
    '面を離れてもバッジが戻らない(follower の判定ごと消している)',
  ).toContainText(BADGE, { timeout: 15_000 });
  await win.close();

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
