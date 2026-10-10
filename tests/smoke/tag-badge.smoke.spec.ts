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

/**
 * 設定の select を選ぶ。⚠ `<select>` は押すと OS の一覧が開くので、届くことだけ見る。
 * ⚠ #1038 段J で一度ボタンの列にしたが、実測で `TAB_SWEEP` の複数幅で 2 行に
 *   折れたため、この項目だけプルダウンへ戻した(§9 の覆る条件)。
 */
async function chooseBadge(page: Page, value: string): Promise<void> {
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const select = page.locator('[data-pkc-field="tag-badge-select"]');
  await expectReachable(page, select);
  await select.selectOption(value);
  await page.locator('[data-pkc-region="filer-table"] [data-pkc-action="select-entry"]').first().click();
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();
}

/**
 * 🔴 **タグに色を付ける / 外す**(#1457)。情報ペインの札の「色」を押す ── 色を選ぶ窓は
 * 付箋・線と同じ部品(`input[data-pkc-field="color-pick"]`)で、`change` で 1 回だけ撃つ。
 * ⚠ OS の色選択は実ブラウザでも開けないので、窓の `change` を合成して選んだことにする
 *   (押し所に手が届くこと・窓が開くこと・選んだ後の画面は本物を通る)。
 */
async function paintTag(page: Page, tag: string, hex: string): Promise<void> {
  const pick = page.locator(
    `[data-pkc-region="inspector"] [data-pkc-field="inspector-body-tag"][data-pkc-tag="${tag}"] [data-pkc-action="tag-color-pick"]`,
  );
  await expectReachable(page, pick);
  await clickReal(page, pick);
  await expect(page.locator('input[data-pkc-field="color-pick"]'), '押しても色を選ぶ窓が出ない').toHaveCount(1);
  await page.evaluate((v) => {
    const input = document.querySelector<HTMLInputElement>('input[data-pkc-field="color-pick"]')!;
    input.value = v;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, hex);
  await expect(page.locator('input[data-pkc-field="color-pick"]'), '使い終わった窓が残っている').toHaveCount(0);
}

async function unpaintTag(page: Page, tag: string): Promise<void> {
  await clickReal(
    page,
    `[data-pkc-region="inspector"] [data-pkc-field="inspector-body-tag"][data-pkc-tag="${tag}"] [data-pkc-action="tag-color-clear"]`,
  );
}

const bgOf = (loc: ReturnType<Page['locator']>) =>
  loc.evaluate((el) => getComputedStyle(el).backgroundColor);

test('🔴 本文のタグが札で出て、押すと一覧が絞られる (#550 段③)', async ({ page }) => {
  const errors = collectPageErrors(page);
  /**
   * ⚠ **探す欄が出ている面で見る** ── 既定はフォルダのタブで、そちらでは
   *   `entry-filter` が畳まれている(値は state に入っても画面に出ない)。
   *   観測点は**user が実際に見る欄**にする。
   */
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

  /**
   * 🔴 **色を付けたタグだけが色つきの札になる**(#1457)── 本文の札と情報ペインの札の両方。
   * ⚠ 色の付いていない `家事` は灰色のまま(対照群)。字の色は下地から自動で選ばれる。
   */
  const other = page.locator('[data-pkc-tagline] [data-pkc-tag="家事"]');
  const otherBg = await bgOf(other);
  const side = page.locator(
    '[data-pkc-region="inspector"] [data-pkc-field="inspector-body-tag-find"][data-pkc-tag="買い物"]',
  );
  await expect(side, '情報ペインに本文のタグの札が無い(台の空振り)').toBeVisible();
  await expect(
    page.locator('[data-pkc-action="tag-color-clear"][data-pkc-tag="買い物"]'),
    '色の無いタグに「色を外す」が出ている',
  ).toBeHidden();
  await paintTag(page, '買い物', '#ff8800');
  await expect(chip, '本文の札に色が付かない').toHaveCSS('background-color', 'rgb(255, 136, 0)');
  await expect(side, '情報ペインの札に色が付かない').toHaveCSS('background-color', 'rgb(255, 136, 0)');
  // 🔴 色の押し所を足しても、右の列の中身は右端からはみ出さない(`inspector-fit` と同じ向きの全数)
  const over = await page.locator('[data-pkc-region="inspector"]').evaluate((el) => {
    const vw = document.documentElement.clientWidth;
    return [...el.querySelectorAll('*')]
      .filter((c) => {
        const b = c.getBoundingClientRect();
        return b.width > 0 && b.right > vw;
      })
      .map((c) => c.getAttribute('data-pkc-field') ?? c.getAttribute('data-pkc-action') ?? c.tagName);
  });
  expect(over, '色の押し所で右の列の中身がはみ出している').toEqual([]);
  // #ff8800 は明るいので字は黒
  await expect(chip, '色つきの札の字が読めない色').toHaveCSS('color', 'rgb(0, 0, 0)');
  expect(await bgOf(other), '色を付けていないタグまで色が付いた').toBe(otherBg);
  // 色はコレクションに残る ── 読み直しても付いている
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await page.locator('[data-pkc-region="filer-table"] [data-pkc-action="select-entry"]').first().click();
  await expect(
    page.locator('[data-pkc-tagline] [data-pkc-tag="買い物"]'),
    '読み直すと色が消えた',
  ).toHaveCSS('background-color', 'rgb(255, 136, 0)');
  // 外すと灰色に戻る(片道にしない)
  await unpaintTag(page, '買い物');
  expect(await bgOf(chip), '色を外しても灰色に戻らない').toBe(bg);
  await expect(page.locator('[data-pkc-action="tag-color-clear"][data-pkc-tag="買い物"]')).toBeHidden();

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

  /**
   * 🔴 **色の当たり方は見せ方ごとに違う**(#1457)。
   * バッジ = 下地が色 / 枠だけ = 枠の線だけ色(下地なし)/ 文字のまま = 色は付かない。
   */
  await paintTag(page, '買い物', '#0044cc');
  await expect(chip, 'バッジで下地が色にならない').toHaveCSS('background-color', 'rgb(0, 68, 204)');
  await expect(chip, '暗い下地なのに字が黒のまま').toHaveCSS('color', 'rgb(255, 255, 255)');
  await chooseBadge(page, 'outline');
  await expect(chip, '枠だけなのに下地が付いている').toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(chip, '枠だけで枠の線が色にならない').toHaveCSS('border-top-color', 'rgb(0, 68, 204)');
  await chooseBadge(page, 'plain');
  await expect(chip, '文字のままなのに下地が付いている').toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(chip, '文字のままなのに枠が付いている').toHaveCSS('border-top-width', '0px');
  await chooseBadge(page, 'chip');
  await unpaintTag(page, '買い物');
  expect(await bgOf(chip), '色を外しても灰色に戻らない').toBe(before);

  expect(errors, 'ページ例外が出ている').toEqual([]);
});
