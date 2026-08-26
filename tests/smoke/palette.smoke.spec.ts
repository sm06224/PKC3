import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp, useSplitEditor } from './helpers';

/**
 * 🔴 **操作を名前で探す**(#425 段①)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * 1. **本物の `<dialog showModal()`** ── happy-dom にも `<dialog>` は在るが、
 *    **焦点が本当に器の中へ移るか**(開いた直後に打てるか)は実機でしか見えない。
 *    ⚠ ここが落ちると「開いたのに打てない」= 面が丸ごと使えない。
 * 2. **実ブラウザが配る `code`** ── `Ctrl+Shift+P` は unit では自分で書いた
 *    `code` を渡している。実際の打鍵で同じ名前が来るかはここでしか確かめられない。
 * 3. **既定動作を奪っていないか** ── `Ctrl+Shift+P` は Firefox の
 *    「プライベートウィンドウ」と同じ綴りである。少なくとも Chromium で
 *    **アプリが生きたまま**開けることを見る。
 */
test('🔴 名前で探して実行できる ── 開く / 絞る / Enter で走る (#425)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  const dialog = page.locator('[data-pkc-region="app-dialog"]');
  const filter = page.locator('[data-pkc-field="palette-filter"]');
  const rows = page.locator('[data-pkc-field="palette-row"]');

  // ① 押しボタンで開く ── **マウスだけで完結する**(不可侵指示)
  await clickReal(page, '[data-pkc-action="open-palette"]');
  await expect(dialog, '押しても開かない').toBeVisible();
  await expect(rows.first(), '一覧が空のまま出ている').toBeVisible();

  /**
   * ② 🔴 **開いた直後にそのまま打てる** ── 焦点が探す欄に無いと、
   *   user は「開いたのに反応しない」と受け取る(実機でしか見えない層)。
   */
  await expect(filter, '開いた直後に探す欄へ焦点が無い').toBeFocused();
  const before = await rows.count();
  await page.keyboard.type('集計');
  await expect
    .poll(() => rows.count(), { message: '打っても絞られない' })
    .toBeLessThan(before);
  await expect(rows.first()).toHaveAttribute('data-pkc-command', 'view-query');

  // ③ Enter で走る(いちばん上の押せる行)
  await page.keyboard.press('Enter');
  await expect(dialog, 'Enter を押しても器が閉じない').toBeHidden();
  await expect(
    page.locator('[data-pkc-view-pane="query"]'),
    'Enter で選んだ操作が走っていない',
  ).toBeVisible();

  /**
   * ④ 🔴 **近道でも開く**(実ブラウザの `code` が届くか)。
   * ⚠ アプリが生きたまま開くこと ── ここで窓ごと持っていかれると `errors` 以前に
   *   以降の locator が全部落ちる。
   */
  await page.keyboard.press('Control+Shift+P');
  await expect(dialog, '近道で開かない(実機の code が届いていない)').toBeVisible();

  // ⑤ 押せない操作も**出る**が、理由つきで押せない
  await page.keyboard.type('確定');
  const first = rows.first();
  await expect(first, '押せない操作を隠している(user は「無い」と読む)').toBeVisible();
  await expect(first, '押せないのに押せることになっている').toBeDisabled();
  await expect(
    first.locator('[data-pkc-field="palette-why"]'),
    '押せない理由が出ていない',
  ).toContainText('いまは押せません');

  /**
   * ⑥ 🔴 **字を打った状態でも Escape で閉じる**(2026-08-26 にここで踏んだ)。
   *
   * ⚠ 欄を `type="search"` にしていたら、Chromium は **`Escape` を食べて
   *   欄を空にする** ── 器は開いたままで、user には「押しても閉じない」と
   *   しか見えなかった。⚠ **字を消してから押すと通ってしまう**ので、
   *   ここは**打った直後に押す**(空にしない)。
   */
  await expect(filter, '前提が崩れている(欄が空 ── Escape を食べる場面になっていない)')
    .not.toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(dialog, 'Escape で閉じない').toBeHidden();
  await page.keyboard.press('Alt+1');
  await expect(
    page.locator('[data-pkc-region="detail"]'),
    '閉じた後に鍵が死んでいる(焦点が返っていない)',
  ).toBeVisible();

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **編集中の記法をパレットから入れる**(#425 段②-b)。
 *
 * 🔴 **unit では原理的に届かない層**:
 * 1. 器は本物の **`<dialog showModal()`** ── **開いた瞬間に編集欄から焦点が外れ**、
 *    閉じるときに**返る**。この往復が本当に起きるかは実機でしか見えない
 * 2. 🔑 **選択範囲が焦点を失っている間も残るか** ── 残らなければ
 *    「選んだ所ではない所」に記法が入る。⚠ **推測せず、ここで測る**
 *    (2026-08-26 の実測: 開く前 1-4 → 開いている間 1-4 → 閉じた後 1-4)
 */
test('🔴 選んでからパレットで記法を入れると、選んだ範囲に入る (#425 段②-b)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await useSplitEditor(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill('あいうえお');
  await ta.click();
  // 「いうえ」を選ぶ
  await ta.evaluate((el) => {
    (el as HTMLTextAreaElement).setSelectionRange(1, 4);
  });

  const dialog = page.locator('[data-pkc-region="app-dialog"]');
  const filter = page.locator('[data-pkc-field="palette-filter"]');

  await page.keyboard.press('Control+Shift+P');
  await expect(dialog, '編集中に開けない').toBeVisible();

  // 🔴 **「押せません」と出ないこと** ── 段②-a まではここで止まっていた
  await filter.fill('ハイライト');
  const first = page.locator('[data-pkc-field="palette-row"]').first();
  await expect(first, '一覧に出ていない').toBeVisible();
  await expect(
    first.locator('[data-pkc-field="palette-why"]'),
    '本文の欄に居るのに「押せません」と出ている',
  ).not.toContainText('いまは押せません');

  await page.keyboard.press('Enter');
  await expect(dialog, '選んでも閉じない').toBeHidden();

  // 🔴 **選んだ範囲に入っている**(先頭でも末尾でもない)
  await expect(ta, '選んだ範囲に入っていない').toHaveValue('あ==いうえ==お');

  /**
   * 🔑 **続けて打てる** ── 焦点が返っていなければ、次の字は本文に入らない。
   * ⚠ 「入った」だけを見て終えると、**打てなくなっているのに緑**になる
   *   (CLAUDE.md §10 ── 器が「ついでに」返していた性質)。
   */
  await page.keyboard.type('か');
  await expect(ta, '閉じた後に焦点が返っていない').toHaveValue(/か/);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
