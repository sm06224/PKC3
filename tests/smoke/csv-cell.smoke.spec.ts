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
import { gotoApp, collectPageErrors, createEntry } from './helpers';

/** 表の升(押せる口を持つもの)。 */
const CELL = '[data-pkc-field="detail-body"] [data-pkc-action="edit-cell"]';

test('🔴 「表」を作って、升に打てる ── 原文を数えなくてよい (#418 段①)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'spreadsheet');
  /**
   * 🔴 **保存を挟まない**(#753、2026-09-08)。
   *
   * ⚠ 直す前はここに「作った直後は編集の面 ── **保存して読む面へ戻す**」と書いて
   *   `commit-edit` を押していた。🔴 **それが #753 の当の症状である** ──
   *   マニュアルは「**そのままセルから打てます**」と書いているのに、
   *   実際は保存を 1 回はさむ必要があった(押せる印を焼くのは読む面だけなので、
   *   押した升が**原文の欄に化けて**いた)。
   * 🔑 いまは「表」だけ**読む面で開く**ので、この 1 行が要らない ──
   *   **この行を消したこと自体が回帰試験**である(戻せばここが落ちる)。
   */
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

  /**
   * 🔴 **欄を開いても、隣の升の押し所が動かない**(#750 I1 の実測で判明、2026-09-06)。
   *
   * ⚠ `<input>` の既定は `size="20"` = **20 字ぶんの幅を要求する**ので、放っておくと
   *   開いた升の列が **317px** まで広がり、隣の升が **115px → 88px** に縮む ──
   *   空の升は中身が **＋ ×** だけなので、**その升の真ん中が「＋」ボタンになった**。
   *   押すと欄が開かず、**列が増える**。
   * ⚠ #750 I1 で `Enter` のあと欄が開いたままになるため、この食い違いが
   *   **普通の状態**になるところだった(既存の検査が落ちて教えた)。
   * 🔑 観測点は幅ではなく「**その升の真ん中に何が在るか**」── 幅は端末で変わるが、
   *   「押したい物が押せるか」は変わらない。
   * ⚠ **markdown の表では空振りする**(あちらに ＋ × は無い)ので、ここに置く。
   */
  const hitCenter = async (nth: number): Promise<string> =>
    page.evaluate((i) => {
      const cs = [...document.querySelectorAll('[data-pkc-field="detail-body"] [data-pkc-action="edit-cell"]')];
      const r = cs[i]!.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return `${hit?.tagName}/${hit?.getAttribute('data-pkc-action') ?? ''}`;
    }, nth);
  expect(await hitCenter(1), '欄を開いたら、隣の升の真ん中が升でなくなった').toBe('TD/edit-cell');

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
  // ⚠ 保存を挟まない(#753 ── 表は読む面で開く)
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
  // ⚠ 保存を挟まない(#753 ── 表は読む面で開く)
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

/**
 * 🔴 **csv の表でも、升を続けて 2 つ打てる**(#745)。
 *
 * ⚠ **升の口を焼く場所は 2 つ在る**(`csv-table.ts` と `markdown-render.ts`)。
 *   `md-table-cell.smoke.spec.ts` は後者しか通らないので、こちらを 1 本置く ──
 *   CLAUDE.md §7「同じ値を複数の描画経路へ渡すものは、経路ごとに pin する」。
 * 🔑 この物語は **#418 の頃から在る穴**で、直したのは #745 である。
 */
test('🔴 csv の升も、打った直後に隣を押して続けて打てる (#745)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'spreadsheet');
  // ⚠ 保存を挟まない(#753 ── 表は読む面で開く)

  const cells = page.locator(CELL);
  await expect(cells.first(), '表の升が押せる形で出ていない').toBeVisible({ timeout: 10_000 });
  expect(await cells.count(), '升の数が種と違う').toBe(15);

  /**
   * 🔴 **同じ tick で「確定 → 隣を押す → 打つ」を撃つ。**
   * ⚠ `locator.click()` は要素が落ち着くのを待つので、待った回は書き戻しが先に届き
   *   **この不具合をまたぐ**(#745 が今まで smoke で見えなかった理由)。
   */
  const opened = await page.evaluate(() => {
    const sel = '[data-pkc-field="detail-body"] [data-pkc-action="edit-cell"]';
    const q = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)];
    q()[0]!.click();
    const i1 = document.querySelector<HTMLInputElement>('[data-pkc-field="cell-input"]');
    if (i1 === null) return 'i1 が開かない';
    i1.value = '品名';
    i1.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    q()[1]!.click();
    const i2 = document.querySelector<HTMLInputElement>('[data-pkc-field="cell-input"]');
    if (i2 === null) return 'i2 が開かない';
    // 🔑 空振り防止の印 ── 壊されて開き直されたなら消える
    i2.setAttribute('data-probe-mark', '1');
    i2.value = 'すう';
    return 'ok';
  });
  expect(opened, '前提が崩れた(欄が開いていない)').toBe('ok');

  const input = page.locator('[data-pkc-field="cell-input"]');
  await expect(cells.nth(0), '1 つ目の字が本文に入っていない').toHaveText('品名', {
    timeout: 15_000,
  });
  await expect(input, '書き戻しが届いた瞬間に欄が消えた(#745)').toBeVisible();
  await expect(input, '打ちかけの字が消えた(#745)').toHaveValue('すう');
  await expect(input, '欄が壊されていない(競合の窓に入っていない)').not.toHaveAttribute(
    'data-probe-mark',
    '1',
  );

  // 🔴 続きを打てる(焦点が本文の外へ落ちていない)
  await page.keyboard.type('りょう');
  await page.keyboard.press('Enter');
  await expect(cells.nth(1), '欄が消えて、続きが打てなくなった(#745)').toHaveText('すうりょう', {
    timeout: 15_000,
  });

  expect(errors, `ページで例外が出た: ${errors.join(' / ')}`).toEqual([]);
});
