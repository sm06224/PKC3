import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 🔴 **チェックの印が押せて、本文に残る**(#277。user 指示 2026-08-19
 * 「チェックリストを含む場合の自動生成で…復活させるのです」)。
 *
 * 🔴 **unit では原理的に届かない層**:
 * ① **本物の `<input type="checkbox">` の click** ── 既定動作で見た目が先に変わる。
 *    本文が書き換わって**描き直された後も**その状態が残るか(見た目だけ変わって
 *    保存されていない、という一番静かな壊れ方をここで見る)
 * ② **開き直しても残るか** ── 直す前の壊れ方はまさにこれ(別のノートへ移って
 *    戻ると全部外れる)だったので、**往復させて**確かめる
 */
test('🔴 チェックを押すと本文に残り、開き直しても消えない (#277)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ノートを 2 件(1 件目にチェックリスト、2 件目は往復のための当て馬)
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live
    .locator('[data-pkc-field="row-source"]')
    // 🔑 入れ子と繰り返しの行を持たせる(#1173 の「リストをそろえる」が同じ道中で見られる)
    .fill('# 買い物\n\n- [ ] 牛乳\n- [ ] 卵\n  - [ ] Mサイズ\n- [ ] ゴミ出し @2026-09-07 毎週');
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const boxes = page.locator('[data-pkc-view-pane="detail"] [data-pkc-action="toggle-task"]');
  await expect(boxes, 'チェックが押せる形で出ていない').toHaveCount(4);
  await expect(boxes.nth(0)).not.toBeChecked();

  /**
   * 🔴 **右の列の「チェック項目」が押すたびに動く**(#1216)。⚠ 新しい起動は足さない ──
   * 既にある道中(押す → 往復 → 一括)に assert を足す。
   * 🔑 観測点は右の列の値の字(`inspector-tasks`)。項目は 4 件(入れ子も数える)。
   */
  const progress = page.locator('[data-pkc-region="inspector"] [data-pkc-field="inspector-tasks"]');
  await expect(progress, '右の列にチェック項目の行が出ていない').toHaveText('0 / 4 完了 (0%)');
  await expect(progress).toBeVisible();

  // ① 🔴 実クリック → 描き直された後も印が残っている
  await boxes.nth(0).click();
  await expect(boxes.nth(0), '押した印が描き直しで消えた').toBeChecked();
  await expect(boxes.nth(1), '押していない方まで変わった').not.toBeChecked();
  await expect(progress, '押したのに右の数が動かない').toHaveText('1 / 4 完了 (25%)');

  // ② 🔴 別のノートへ行って戻る ── ここが直す前の壊れ方だった
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  // 🔴 チェック項目の無いノートでは行ごと畳まれる(対照群: 上で出ていた)
  await expect(progress, '項目の無いノートで行が残った').toBeHidden();
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(
    page.locator('[data-pkc-view-pane="detail"]'),
    '戻ってきていない',
  ).toContainText('買い物');
  const back = page.locator('[data-pkc-view-pane="detail"] [data-pkc-action="toggle-task"]');
  await expect(back.nth(0), '往復したら印が消えた(保存されていない)').toBeChecked();
  await expect(progress, '往復したら右の数が戻らない').toHaveText('1 / 4 完了 (25%)');

  // ③ もう一度押すと外れる(片道にしない)
  await back.nth(0).click();
  await expect(back.nth(0), '外れない').not.toBeChecked();
  await expect(progress, '外したのに右の数が減らない').toHaveText('0 / 4 完了 (0%)');

  /**
   * ④ 🔴 **項目の字を右クリックして、リストを丸ごとそろえる**(#1173)。
   *
   * ⚠ **本物の右クリック**(合成 event ではブラウザ既定を見られない)。字の上で押す ──
   *   箱の上はブラウザ既定のメニューを残す(奪わない)ので、ここでは出ない。
   * 🔑 観測点は**画面の箱**(押したリストの全部が変わり、繰り返しの行だけ残る)と、
   *   **読み込み直しても残ること**(本文へ書かれた証拠)。
   */
  const pane = page.locator('[data-pkc-view-pane="detail"]');
  const MENU = '[data-pkc-region="context-menu"]';
  await pane.locator('li.pkc-task-item', { hasText: '牛乳' }).first().click({
    button: 'right',
    position: { x: 60, y: 8 },
  });
  const run = page.locator(`${MENU} [data-pkc-action="task-run-done"]`);
  await expect(run, '字の上で右クリックしても「すべて完了にする」が出ない').toHaveText(
    'このリストをすべて完了にする',
  );
  await expect(page.locator(`${MENU} [data-pkc-action="task-run-open"]`)).toHaveText(
    'このリストをすべて未完了に戻す',
  );
  await clickReal(page, run);
  await expect(back.nth(0), '牛乳が完了にならない').toBeChecked();
  await expect(back.nth(1), '卵が完了にならない').toBeChecked();
  await expect(back.nth(2), '入れ子の Mサイズが完了にならない').toBeChecked();
  await expect(back.nth(3), '🔴 繰り返しの行まで完了にした').not.toBeChecked();
  await expect(progress, '一括で完了にしたのに右の数が動かない').toHaveText('3 / 4 完了 (75%)');
  await expect(
    page.getByText('1 件は繰り返しなので触りませんでした'),
    '繰り返しを飛ばした知らせが出ていない',
  ).toBeVisible();

  // 🔴 読み込み直しても残る(保存されている)
  await page.reload();
  // ⚠ 題名は「ノート 1」(付けていない)── ② と同じく先頭の行を開き、本文が出るのを待つ
  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await expect(rows.first(), '読み直したら一覧が空').toBeVisible({ timeout: 15_000 });
  await rows.first().click();
  await expect(pane, '買い物のノートが開けていない').toContainText('買い物');
  await expect(back.nth(0), '読み直したら完了が消えた(保存されていない)').toBeChecked();
  await expect(back.nth(2), '読み直したら入れ子の完了が消えた').toBeChecked();
  await expect(back.nth(3), '読み直したら繰り返しの行が動いていた').not.toBeChecked();
  await expect(progress, '読み直したら右の数が違う').toHaveText('3 / 4 完了 (75%)');

  // ⑤ 戻せる(片道にしない)── 「すべて未完了に戻す」
  await pane.locator('li.pkc-task-item', { hasText: '卵' }).first().click({
    button: 'right',
    position: { x: 60, y: 8 },
  });
  await clickReal(page, `${MENU} [data-pkc-action="task-run-open"]`);
  for (const n of [0, 1, 2, 3]) {
    await expect(back.nth(n), `${n} 番目が未完了に戻らない`).not.toBeChecked();
  }
  await expect(progress, '戻したのに右の数が動かない').toHaveText('0 / 4 完了 (0%)');

  // ⑥ 箱の上の右クリックは、ブラウザ既定のメニューを残す(こちらのメニューを出さない)
  await back.nth(0).click({ button: 'right' });
  await expect(page.locator(MENU), '箱の上でこちらのメニューが出た').toHaveCount(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
