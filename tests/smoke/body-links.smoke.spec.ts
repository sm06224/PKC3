import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 🔴 **本文のリンクが実機で押せる**(2026-08-08)。
 *
 * ## なぜ実ブラウザで見るのか
 *
 * unit(happy-dom)は生成の正しさしか示さない。ここで見るのは unit では
 * 観測できないことだけ:
 *
 * - 🔴 **未知スキームへ遷移しない** ── `<a href="entry:…">` の既定動作は
 *   実ブラウザにしか無い。`preventDefault` を忘れると **URL が変わる /
 *   ページが飛ぶ**。happy-dom は `entry:` のナビゲーションを再現しない
 * - 🔴 **キーボードで押せる** ── Tab でフォーカスが乗るか(`tabindex` が
 *   実際に効いているか)は実ブラウザの話
 * - **本当に markdown が焼いているか** ── unit は手で属性を置いているので、
 *   焼く側が変わっても気づかない
 */
test('🔴 本文の entry: リンクを押すと、そのノートが開く(遷移しない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  // ① リンク先のノートを作る(lid は一覧の行から採る ── 手で作らない)
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('リンク先');
  await page.locator('[data-pkc-field="editor-body"]').fill('着いた先の本文。\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const targetLid = await page
    .locator('[data-pkc-region="entry-list"] [data-pkc-entry]')
    .first()
    .getAttribute('data-pkc-entry');
  expect(targetLid, 'リンク先の lid を採れていない(fixture の空振り)').toBeTruthy();

  // ② そこへリンクするノートを作る
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('リンク元');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill(`[あちらへ](entry:${targetLid ?? ''})\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // 🔴 焼く側が本当に action を付けている(unit の手組みが嘘でないこと)
  const link = page.locator('[data-pkc-field="detail-body"] [data-pkc-action="navigate-entry-ref"]');
  await expect(link, '本文にアプリ内リンクが出ていない').toHaveCount(1);

  const urlBefore = page.url();
  await clickReal(page, '[data-pkc-field="detail-body"] [data-pkc-action="navigate-entry-ref"]');

  // 🔴 **開く**
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('着いた先の本文');
  // 🔴 **遷移していない**(`entry:` へ飛ぼうとしていない)
  expect(page.url(), 'ブラウザが未知スキームへ遷移した').toBe(urlBefore);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **`@card` はキーボードでも押せる**(user 指示「マウスだけで完結し、
 * キーボードは近道」)。⚠ 直す前は**フォーカスできるのに Enter が効かない**
 * 要素が 1 種類だけ存在していた。
 */
test('🔴 @card の札にフォーカスが乗り、Enter で開く', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('カードの先');
  await page.locator('[data-pkc-field="editor-body"]').fill('カードで着いた本文。\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const targetLid = await page
    .locator('[data-pkc-region="entry-list"] [data-pkc-entry]')
    .first()
    .getAttribute('data-pkc-entry');

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('カード元');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill(`@[card](entry:${targetLid ?? ''})\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const card = page.locator('[data-pkc-field="detail-body"] [data-pkc-action="navigate-card-ref"]');
  await expect(card, 'カードの札が出ていない').toHaveCount(1);

  /**
   * 🔑 **フォーカスできること自体が観測点**(`tabindex` が効いているか)。
   * ⚠ `focus()` を呼んで確かめる ── Tab の回数はページの構造で変わるので、
   *   ここで数えると構造を変えるたびに壊れる(挙動ではなく形を pin してしまう)。
   */
  await card.focus();
  await expect(card, 'フォーカスが乗らない(キーボードで届かない)').toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('カードで着いた本文');
  expect(errors).toEqual([]);
});
