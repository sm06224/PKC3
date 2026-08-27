/**
 * 🔴 **表のセルを押したら、そのセルが打てる**(#418 段①)。
 *
 * > user の物語(#418): 左上の「新規」で **「表」** を選ぶ。5 列 × 3 行の空の表が
 * > 出る。**A1 に「品名」と打ちたい。** ── 押すと表が消えて CSV の原文が出て、
 * > どのカンマが A1 なのかを目で数えることになっていた。
 *
 * 🔑 **unit では届かない 3 つ**を実ブラウザで見る:
 * 1. **本当に「表」の入口から作れるか**(seed の記法が変わったら、ここで落ちる)
 * 2. **押した升に焦点が入るか**(happy-dom の `focus` は本物ではない)
 * 3. **確定した字が disk まで届き、開き直しても残るか**
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal, createEntry } from './helpers';

/** 表の升(押せる口を持つもの)。 */
const CELL = '[data-pkc-field="detail-body"] [data-pkc-action="edit-cell"]';

test('🔴 「表」を作って、升に打てる ── 原文を数えなくてよい (#418 段①)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'spreadsheet');
  // ⚠ 作った直後は編集の面 ── 保存して読む面へ戻す(押せるのは読む面だけ)
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const cells = page.locator(CELL);
  await expect(cells.first(), '表の升が押せる形で出ていない').toBeVisible({ timeout: 10_000 });
  // 🔑 前提 ── 種は 5 列 × 3 行(ここが崩れたら以降の数え方が意味を失う)
  expect(await cells.count(), '升の数が種と違う').toBe(15);

  // ── A1 を押すと、その升だけが入力欄になる
  await cells.first().click();
  const input = page.locator('[data-pkc-field="cell-input"]');
  await expect(input, '押した升が入力欄にならない').toBeVisible();
  expect(await page.locator('[data-pkc-field="cell-input"]').count(), '欄が 2 つ以上出た').toBe(1);
  // ⚠ **原文の欄が出ていない**(これが user の不満そのものである)
  await expect(page.locator('[data-pkc-field="editor-body"]')).toHaveCount(0);

  await page.keyboard.type('品名');
  await page.keyboard.press('Enter');

  // ── 打った字が升に入っている
  await expect(cells.first(), '打った字が升に入っていない').toHaveText(/品名/, {
    timeout: 10_000,
  });

  /**
   * 🔴 **読み込み直しても残る**(disk まで届いた証拠)。
   * ⚠ 画面の字だけ見ると、本文に書かれていなくても緑になる。
   * ⚠ 読み直すと**何も選ばれていない**ので、一覧から開き直す
   *   (初稿はここで「升が 1 つも無い」と落ちた ── 製品ではなく test の話)。
   */
  await page.reload();
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(page.locator(CELL).first(), '読み直したら消えた').toHaveText(/品名/, {
    timeout: 15_000,
  });

  expect(errors).toEqual([]);
});

test('🔴 行と列を足せて、消せる ── 5 列で足りなくなっても原文へ戻らない (#418 段①)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'spreadsheet');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  const cells = page.locator(CELL);
  await expect(cells.first()).toBeVisible({ timeout: 10_000 });
  expect(await cells.count()).toBe(15);

  // ── 列を足す(5 → 6 列 = 18 升)
  await page
    .locator('[data-pkc-action="shape-cell"][data-pkc-cell-what="col"][data-pkc-cell-mode="add"]')
    .first()
    .click({ force: true });
  await expect(cells, '列が足されていない').toHaveCount(18, { timeout: 10_000 });

  // ── 行を足す(3 → 4 行 = 24 升)
  await page
    .locator('[data-pkc-action="shape-cell"][data-pkc-cell-what="row"][data-pkc-cell-mode="add"]')
    .first()
    .click({ force: true });
  await expect(cells, '行が足されていない').toHaveCount(24, { timeout: 10_000 });

  // 🔴 **双方向** ── 足したものを消せる(片道の操作を作らない)
  await page
    .locator(
      '[data-pkc-action="shape-cell"][data-pkc-cell-what="row"][data-pkc-cell-mode="remove"]',
    )
    .first()
    .click({ force: true });
  await expect(cells, '行を消せていない').toHaveCount(18, { timeout: 10_000 });

  expect(errors).toEqual([]);
});

/**
 * 🔴 **升に式を打つと、結果が出る**(#418 段②)。
 *
 * 🔑 **unit では届かない 2 つ**を実ブラウザで見る:
 * 1. **打った式が disk まで届き、開き直しても結果が出るか**(= 本文に式が残っている)
 * 2. **押すと式のほうが出るか**(結果を掴んでいたら、打ち直すたびに式が消える)
 */
test('🔴 升に式を打つと結果が出て、押すと式が出る(#418 段②)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'spreadsheet');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  const cells = page.locator(CELL);
  await expect(cells.first()).toBeVisible({ timeout: 10_000 });

  // A1 = 2 / B1 = 3 / C1 = =A1*B1
  for (const [i, text] of [
    [0, '2'],
    [1, '3'],
    [2, '=A1*B1'],
  ] as const) {
    await cells.nth(i).click();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    // ⚠ 1 打ちごとに描き直しを待つ ── 待たずに次を押すと古い升を掴む
    await expect(cells.nth(i)).not.toHaveText('', { timeout: 10_000 });
  }

  // 🔴 升には**結果**が出る
  await expect(cells.nth(2), '式が計算されていない').toHaveText(/6/, { timeout: 10_000 });

  // 🔴 押すと**式**が出る(結果ではない)
  await cells.nth(2).click();
  await expect(page.locator('[data-pkc-field="cell-input"]')).toHaveValue('=A1*B1');
  await page.keyboard.press('Escape');

  // 🔴 読み込み直しても残る(本文に式が入っている証拠)
  await page.reload();
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(page.locator(CELL).nth(2), '読み直したら消えた').toHaveText(/6/, {
    timeout: 15_000,
  });

  expect(errors).toEqual([]);
});
