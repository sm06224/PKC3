/**
 * 🔴 **保存の状態が、実ブラウザの設定の面に出る**(#347、user 裁定 2026-08-23)。
 *
 * > 「**#347 で「守られていません」は気になるから見るだけで**」
 *
 * ⚠ unit(`tests/adapter/persist-notice.test.ts`)は**文言と state の畳み方**を見る。
 * ここが見るのは **user が実際に辿り着けるか**である ── 設定を開いて、
 * その行が**目に入る**こと。⚠ happy-dom では「面が hidden で常駐する」ことまでしか
 * 分からず、**見えているか**は実ブラウザにしか無い。
 *
 * ⚠ **どの状態が出るかは pin しない** ── headless の engagement で
 * `persisted` にも `denied` にもなりうる(環境で変わる = 製品の主張ではない)。
 * 🔑 **主張は「4 つのうちどれかが出ていること」**にする ── 空欄なら、
 * user は何も分からないまま設定を閉じることになる。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, collectPageErrors } from './helpers';

test('🔴 設定に「このアプリのデータ」の行が出て、空欄ではない', async ({ page }) => {
  // 🔴 **例外を 1 度も見ていなかった**(#713、2026-09-05)── 設定の面は
  //    boot の後半で組まれるので、そこで落ちても「行が在る」だけで緑になる
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');

  const row = page.locator('[data-pkc-field-persist="persist-state"]');
  await expect(row, '保存の状態の行が画面に無い').toBeVisible();

  // 🔑 4 つの文面のどれかが出ている(空欄で閉じさせない)
  await expect(row).toHaveText(
    /消さない扱いにしています|消すことがあります|対応していません|まだ確かめていません/,
  );

  /**
   * 🔴 **押しかけない側**(裁定の半分)── この行に押せるものは無い。
   * ⚠ ボタンを置くと、それが「押しかけ」の入口になる。
   */
  const dd = page.locator('[data-pkc-field-persist="persist-state"]').locator('xpath=..');
  expect(await dd.locator('button, input, select').count(), '押せるものを置いた').toBe(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
