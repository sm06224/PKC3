import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * 🔴 **予定の面 ── 本物の drag で本文が書き替わる**(#292 段③)。
 *
 * > user 指示 2026-08-23:「**なんで双方向にする発想がでねぇんだよ!**」
 *
 * 🔴 unit(`tests/adapter/schedule-view.test.ts`)は繋がりを見ている。
 * **ここが見るのは「実際に掴めるか」**である ── unit の drag は event を手で
 * 撃つので、`draggable` が false でも通る(ブラウザの門を通らない)。
 * ⚠ つまり「掴めない札」は**実機でしか捕まらない**(CLAUDE.md §2)。
 *
 * 🔑 そして**本文が 1 度も消えない**ことも、ここでしか見られない ──
 * これが user 指示①(「もう一つ PKC が開いて混乱する」)への答えである。
 */
test('🔴 予定のタブで札を掴んで日へ落とすと、本文の日付が変わる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill('- [ ] 見積を送る @2026-08-25\n- [ ] 体裁のチェック');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ① 予定のタブへ(⚠ アプリの一覧ではない ── 左の列のタブである)
  await clickReal(page, '[data-pkc-browse="schedule"]');
  const pane = page.locator('[data-pkc-browse-pane="schedule"]');
  await expect(pane, '予定の面が出ていない').toBeVisible();

  /**
   * 🔴 **本文は消えていない。** ①の実害はここだった ── 予定を見るために
   * 真ん中を明け渡す必要は無い。
   */
  await expect(
    page.locator('[data-pkc-view-pane="detail"]'),
    '予定を開いたら本文が消えた(①の実害そのもの)',
  ).toBeVisible();

  // ② 日付を書いた行だけが札になっている
  const card = pane.locator('[data-pkc-region="schedule-cards"] > [data-pkc-entry]');
  await expect(card, '札の枚数が違う(日付の無い行まで出ている)').toHaveCount(1);
  await expect(card, '記法が札の字に残っている').toContainText('見積を送る');

  // ③ 🔴 **本物の drag** ── 8/25 の札を掴んで 8/28 の升目へ落とす
  const target = pane.locator('[data-pkc-drop-date="2026-08-28"]');
  await expect(target, '落とし先の升目が無い').toBeVisible();
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  expect(from, '札の位置が取れない').not.toBeNull();
  expect(to, '升目の位置が取れない').not.toBeNull();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  // ⚠ **途中を経由する** ── 1 回の move では `dragover` が出ないブラウザが在る
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 });
  /**
   * 🔴 **落とせる所は、落とす前に分かる**(掴んで通ったときだけ光る)。
   * ⚠ ここを見ないと「落とせたが、user には落とせるか分からなかった」が通る。
   */
  await expect(target, '落とし先が光っていない').toHaveAttribute('data-pkc-dropping', '');
  await page.mouse.up();

  // ④ 🔴 **本文が書き替わった**(画面だけ動いて本文は元のまま、を作らない)
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '本文の日付が書き替わっていない').toHaveValue(
    '- [ ] 見積を送る @2026-08-28\n- [ ] 体裁のチェック',
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');

  // ⑤ 札も新しい日の束に居る(本文だけ直って画面が古い、を作らない)
  await expect(
    pane.locator('[data-pkc-region="schedule-group"][data-pkc-drop-date="2026-08-28"] [data-pkc-entry]'),
    '札が新しい日へ移っていない',
  ).toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
