/**
 * 🔴 **本文の中のタグが、札で出て・押せて・見せ方を変えられる**(#550 段③)。
 *
 * > user 要望 2026-08-29:「**そして、タグはバッジ化して表示が必要**」
 *
 * ⚠ **unit では原理的に届かない** ── happy-dom は CSS を計算しないので、
 *   「札に**実際に下地が付いている**」も「**押し所に手が届く**」も見られない。
 *   ここは本物のブラウザで通す(CLAUDE.md「視覚を持つ feature は
 *   visual parity test を最低 1 件」)。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  gotoApp,
  createEntry,
  clickReal,
  collectPageErrors,
  expectReachable,
  useListBrowse,
} from './helpers';

const BODY = ['# 買い物メモ', '', '#買い物 #家事', '', '牛乳と洗剤を買う。'].join('\n');

async function writeNote(page: Page, body: string): Promise<void> {
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill(body);
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"] p').first()).toBeVisible();
}

/** 設定の select を選ぶ。⚠ `<select>` は押すと OS の一覧が開くので、届くことだけ見る。 */
async function chooseBadge(page: Page, value: string): Promise<void> {
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const select = page.locator('[data-pkc-field="tag-badge-select"]');
  await expectReachable(page, select);
  await select.selectOption(value);
  await page.locator('[data-pkc-region="entry-list"] [data-pkc-action="select-entry"]').first().click();
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();
}

test('🔴 本文のタグが札で出て、押すと一覧が絞られる (#550 段③)', async ({ page }) => {
  const errors = collectPageErrors(page);
  /**
   * ⚠ **探す欄が出ている面で見る** ── 既定はフォルダのタブで、そちらでは
   *   `entry-filter` が畳まれている(値は state に入っても画面に出ない)。
   *   観測点は**user が実際に見る欄**にする。
   */
  await useListBrowse(page);
  await gotoApp(page);
  await writeNote(page, BODY);

  const chip = page.locator('[data-pkc-tagline] [data-pkc-tag="買い物"]');
  await expect(chip, '本文のタグが札になっていない').toBeVisible();
  await expect(chip, '井桁が消えている').toHaveText('#買い物');

  /**
   * 🔴 **札に実際に下地が付いている**(CSS が当たっている)。
   * ⚠ 「class が在る」では足りない ── 規則が 1 本も無くても class は在る
   *   (CLAUDE.md「名前が在るかの検査は、中身が空でも通る」)。
   */
  const bg = await chip.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg, '札の下地が透明のまま(CSS が当たっていない)').not.toBe('rgba(0, 0, 0, 0)');

  /** 🔴 **押し所に手が届く**(別の要素が覆っていない)。 */
  await expectReachable(page, chip);

  // 🔴 押すと一覧が絞られる
  await clickReal(page, '[data-pkc-tagline] [data-pkc-tag="買い物"]');
  await expect(
    page.locator('[data-pkc-field="entry-filter"]'),
    '押しても一覧が絞られていない',
  ).toHaveValue('買い物');

  expect(errors, 'ページ例外が出ている').toEqual([]);
});

test('🔴 見せ方を「文字のまま」にすると、下地が消える (#550 段③)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await useListBrowse(page);
  await gotoApp(page);
  await writeNote(page, BODY);

  const chip = page.locator('[data-pkc-tagline] [data-pkc-tag="買い物"]');
  const before = await chip.evaluate((el) => getComputedStyle(el).backgroundColor);
  // ⚠ **前提** ── 既定は札である(ここが透明だと、以下は何も見ていない)
  expect(before, '前提が崩れた(既定が札になっていない)').not.toBe('rgba(0, 0, 0, 0)');

  await chooseBadge(page, 'plain');
  const after = await chip.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(after, '「文字のまま」にしても下地が残っている').toBe('rgba(0, 0, 0, 0)');
  // 🔑 **字は消えない**(見え方だけが変わる ── 本文は 1 バイトも動かない)
  await expect(chip, '字まで消えた').toHaveText('#買い物');

  // 🔑 **戻せる**(片道にしない)
  await chooseBadge(page, 'chip');
  const back = await chip.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(back, '札へ戻せない').toBe(before);

  expect(errors, 'ページ例外が出ている').toEqual([]);
});
