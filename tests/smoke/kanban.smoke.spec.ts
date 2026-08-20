import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 🔴 **カンバン(封印の解除)**(#277 段②-b。user 指示 2026-08-19
 * 「かつて無くしたカレンダーとカンバンはここで生きてきます」)。
 *
 * 札 1 枚 = **本文のチェック項目 1 行**である(`todo` アーキタイプではない)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * ① **導線が実際に効くか** ── アプリの一覧のタイルを**実クリック**して面が開くか
 *    (封印は「導線を畳んだ」ものなので、戻ったことは導線でしか確かめられない)
 * ② **面が本当に見えているか** ── `hidden` の付け替えと CSS の噛み合いは
 *    happy-dom では読めない(`toBeVisible` は実レイアウトを見る)
 * ③ 🔴 **押した札が、書いた当のノートに効くか** ── ここが本丸である。
 *    直す前の binder は「**いま開いているノート**」の同じ行番号を書き換えていた
 *    ので、盤面から押すと**別のノートが静かに壊れる**。
 *    ⚠ だから**2 件のノート**を作り、**2 件目を開いたまま 1 件目の札を押す**。
 */
test('🔴 アプリの一覧からカンバンを開き、札を押すと元のノートが変わる (#277)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // 1 件目 ── チェックリストを持つノート
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill('# 買い物\n\n- [ ] 牛乳\n- [x] 卵');
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  /**
   * 2 件目 ── ⚠ **同じ行番号にチェックを持つ**当て馬。
   * 🔑 これが要る:1 件目の札を押したときに**こちらが書き換わっていない**ことを
   *   見たいので、書き換わりうる形(同じ行にチェック)にしておく。
   */
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill('# 当て馬\n\n- [ ] 触るな\n- [ ] 触るな2');
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ① 🔴 アプリの一覧に居て、押すと開く(封印が解けている)
  await clickReal(page, '[data-pkc-browse="launcher"]');
  const tile = page.locator('[data-pkc-action="open-tile"][data-pkc-tile="builtin:kanban"]');
  await expect(tile, 'アプリの一覧にカンバンが出ていない').toBeVisible();
  await tile.click();

  // ② 🔴 面が見えている(本文の面は畳まれている)
  await expect(page.locator('[data-pkc-view-pane="kanban"]')).toBeVisible();
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeHidden();

  /**
   * 🔴 **札が本文から出ている**(`todo` アーキタイプではない)。
   * 4 行のチェックが 4 枚の札になり、済みの 1 枚だけが「完了」の列に居る。
   */
  const open = page.locator('[data-pkc-kanban-status="open"] [data-pkc-entry]');
  const done = page.locator('[data-pkc-kanban-status="done"] [data-pkc-entry]');
  await expect(open, '未完了の札の枚数が違う').toHaveCount(3);
  await expect(done, '完了の札の枚数が違う').toHaveCount(1);
  await expect(done.first(), '完了の列に居るのが「卵」でない').toContainText('卵');

  // ③ 🔴 **1 件目の札**を押す。⚠ いま開いている(選ばれている)のは 2 件目である
  const milk = open.filter({ hasText: '牛乳' });
  await expect(milk, '「牛乳」の札が無い').toHaveCount(1);
  await milk.locator('[data-pkc-action="toggle-task"]').click();

  // 🔑 札は往復を待たずに「完了」へ移る(ack が本文を持っているから)
  await expect(
    page.locator('[data-pkc-kanban-status="done"] [data-pkc-entry]').filter({ hasText: '牛乳' }),
    '押した札が完了へ移っていない',
  ).toHaveCount(1);

  /**
   * 🔴 **当て馬が無傷であること** ── ここが「別のノートを書き換える」壊れ方の
   * 検出点。⚠ 盤面の札で見る(本文を開き直さなくても、盤面は本文から出ている)。
   */
  await expect(
    page.locator('[data-pkc-kanban-status="done"] [data-pkc-entry]').filter({ hasText: '触るな' }),
    '押していない当て馬のノートが書き換わった(別ノートへ書き込んでいる)',
  ).toHaveCount(0);

  /**
   * ④ 🔴 **札の字を押すとそのノートが選ばれ、タイルをもう一度押すと本文へ戻る**
   * (お知らせとマニュアルに書いた約束そのもの ── #277 段②-b)。
   * ⚠ 面はここでは変わらない(押したのは「選ぶ」であって「開く」ではない)。
   */
  await page
    .locator('[data-pkc-kanban-status="done"] [data-pkc-entry]')
    .filter({ hasText: '牛乳' })
    .locator('[data-pkc-field="text"]')
    .click();
  await expect(
    page.locator('[data-pkc-view-pane="kanban"]'),
    '札を押しただけで面が変わった',
  ).toBeVisible();
  await tile.click();
  await expect(
    page.locator('[data-pkc-view-pane="detail"]'),
    'タイルをもう一度押しても本文へ戻らない',
  ).toBeVisible();
  const boxes = page.locator('[data-pkc-view-pane="detail"] [data-pkc-action="toggle-task"]');
  await expect(boxes, 'チェックリストのノートに戻っていない').toHaveCount(2);
  await expect(boxes.nth(0), '本文に残っていない(見た目だけ変わっていた)').toBeChecked();

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
