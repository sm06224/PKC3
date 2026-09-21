/**
 * 🔴 **メッセージ**(設計 doc §7、段②a)。
 *
 * ## なぜ実ブラウザで見るのか
 *
 * unit(happy-dom)は「system 領域のノートを開いたときに、普通のノートと同じ
 * 中央の面に出て、しかし編集・追記の口が出ない」を、実際の DOM ツリー越しに
 * 確かめられない(`renderBar` の system 判定 / `appendModeOf` の `entryMetas` 不在は
 * unit で見ているが、**左の一覧に絶対出ない**ことと**帯の見た目**は実ブラウザで見る)。
 *
 * 🔑 観測点は 1 起動にまとめる(CLAUDE.md「起動を 1 つ足すと以後すべての回に 1.6 秒」):
 *  ① 起動直後、左の一覧に「メッセージ」が無い(system 領域は user の一覧に混ざらない)
 *  ② システム → メッセージ の「開く」で、中央に題名「メッセージ」+ 起動の要約の節が出る
 *  ③ 本文の帯に「編集」が無い(system のノートは読むだけ)
 *  ④ ここまでの一連の操作で `location.hash` は 1 度も変わらない(ディープリンク専用)
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, dismissAnnounce, collectPageErrors } from './helpers';

test('🔴 メッセージ: 一覧に出ない / 開くと中央に出る / 編集は出ない / hash は不変', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);
  const hashAtBoot = await page.evaluate(() => location.hash);
  await dismissAnnounce(page);

  // ① 🔴 左の一覧に「メッセージ」という行は無い(system 領域は user の一覧に混ざらない)
  const sidebarRows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  const sidebarTexts = await sidebarRows.allTextContents();
  expect(
    sidebarTexts.some((t) => t.includes('メッセージ')),
    '「メッセージ」が左の一覧(user のノート)に混ざった',
  ).toBe(false);

  // 「システム」を開く
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const pane = page.locator('[data-pkc-view-pane="settings"]');
  await expect(pane, 'システムの面が開かない').toBeVisible();

  // ② 🔴 メッセージの節の「開く」を押す
  const openBtn = pane.locator('[data-pkc-action="open-messages"]').first();
  await expect(openBtn, '「メッセージ」を開くボタンが無い').toBeVisible();
  await clickReal(page, openBtn);

  // 中央に題名「メッセージ」が出る(detail 面)
  const detailPane = page.locator('[data-pkc-view-pane="detail"]');
  const title = detailPane.locator('[data-pkc-field="detail-title"]');
  await expect(title, 'メッセージのノートが中央に開かない').toHaveText('メッセージ');

  /**
   * 起動の要約の節が本文に出る(§7「起動しました:版…」)。
   * ⚠ **面全体を見る** ── 本文の器の `data-pkc-field` は読み込み中は
   *   `detail-body-host`、md 描画後は `detail-body` に切り替わる
   *   (`detail.ts` の `bodyHost` 再利用)。どちらの瞬間を掴むかに依らせない。
   */
  await expect(detailPane, '本文が読み込まれない').toContainText('起動しました', {
    timeout: 10_000,
  });

  // ③ 🔴 帯に「編集」が無い(system のノートは読むだけ)
  const editBtn = detailPane.locator('[data-pkc-action="start-edit"]');
  await expect(editBtn, '「編集」が system のノートにも出てしまった').toHaveCount(0);

  // ④ 🔴 一連の操作で hash は 1 度も変わっていない(ディープリンク専用)
  const hashAfter = await page.evaluate(() => location.hash);
  expect(hashAfter, `メッセージを開く操作で hash が動いた(${hashAtBoot} → ${hashAfter})`).toBe(
    hashAtBoot,
  );

  expect(errors, 'pageerror が出た').toEqual([]);
});
