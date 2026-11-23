/**
 * smoke: SQL 画面の 3 ペイン(#1442 段②)。
 *
 * 動線(画面の中ペイン):「SQL で調べる を開く → 左のスキーマの木に表が自動で並ぶ(図を開かなくても)→
 *   ▸ で列が開く → 列を押すとキャレットの位置へ入る → 表をダブルクリックすると SELECT 文が入る →
 *   実行 → 結果が下に出る → 境目を掴んで動かすと高さが変わり、開き直しても憶えている →
 *   「ER 図」タブで図に切り替わり、「クエリ」で戻る → 木を畳む / 開く(憶える)→ 鍵盤で木を辿る」。
 * 動線(別ウィンドウ):「アプリの一覧の SQL のタイルを押す → 別ウィンドウでも木が自動で並び、結果が出る」。
 *
 * ⚠ 新しい起動は増やさない(#820)── 1 つの test の道中に足す。別ウィンドウは同じ context の 2 つ目の page。
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { gotoApp, clickReal, collectPageErrors, openBrowse, openTile } from './helpers';

const heightOf = async (l: Locator): Promise<number> => (await l.boundingBox())!.height;

async function dragSplitter(page: Page, dy: number): Promise<void> {
  const sp = page.locator('[data-pkc-field="sql-splitter"]');
  const box = (await sp.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy / 2, { steps: 4 });
  await page.mouse.move(x, y + dy, { steps: 4 });
  await page.mouse.up();
}

test('🔴 SQL 画面: 左の木が自動で並び、押す・ダブルクリックで欄へ入り、境目と木の出し入れを憶え、ER 図はタブで切り替わる (#1442 段②)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await page.evaluate(() => localStorage.removeItem('pkc3.sql-layout'));
  await page.evaluate(() => {
    location.hash = '#pkc?view=sql';
  });
  const pane = page.locator('[data-pkc-view-pane="sql"]');
  await expect(pane, 'SQL の面が開かない').toBeVisible({ timeout: 15_000 });

  // ── 木: 図を開いていないのに表が並ぶ(自動で採る)
  const tree = pane.locator('[data-pkc-region="sql-tree"]');
  await expect(tree).toBeVisible();
  const entries = tree.locator('[data-pkc-field="sql-tree-table"][data-pkc-name="entries"]');
  await expect(entries, '図を開かなくても木に表が出る(自動で採る)').toHaveCount(1, { timeout: 15_000 });
  await expect(pane.locator('[data-pkc-region="sql-er"]'), '図は閉じたまま').toBeHidden();
  await expect(entries.locator('[data-pkc-field="sql-tree-rows"]'), '行数が出ない').toHaveText(/\d/);
  // 3 ペインの寸法: 木は左・欄は右上・結果は右下(0px の箱は「出ている」と言えない)
  const treeBox = (await tree.boundingBox())!;
  const input = pane.locator('[data-pkc-field="sql-input"]');
  const inputBox = (await input.boundingBox())!;
  const results = pane.locator('[data-pkc-field="sql-results"]');
  const resultsBox = (await results.boundingBox())!;
  expect(treeBox.width, '木の幅').toBeGreaterThan(150);
  expect(inputBox.x, '欄が木の右にある').toBeGreaterThan(treeBox.x + treeBox.width - 2);
  expect(inputBox.height, '欄が大きい').toBeGreaterThan(120);
  expect(resultsBox.y, '結果が欄の下にある').toBeGreaterThan(inputBox.y + inputBox.height - 2);

  // ── ▸ で列が開く → 列を押すとキャレット位置へ入る
  await input.fill('SELECT  FROM entries');
  await input.evaluate((el) => {
    const t = el as HTMLTextAreaElement;
    t.focus();
    t.setSelectionRange(7, 7);
  });
  await clickReal(page, entries.locator('[data-pkc-field="sql-tree-chevron"]'));
  const lidCol = tree.locator('[data-pkc-field="sql-tree-column"][data-pkc-name="entries"][data-pkc-col="lid"]');
  await expect(lidCol, '列が開かない').toBeVisible();
  await expect(lidCol.locator('[data-pkc-badge="pk"]'), '主キーの印').toBeVisible();
  await clickReal(page, lidCol);
  await expect(input, 'キャレットの位置へ入らない').toHaveValue('SELECT lid FROM entries');

  // ── 表をダブルクリック → SELECT 文(名前が二重に入らない)
  await input.fill('');
  await entries.dblclick();
  await expect(input, 'ダブルクリックで SELECT 文が入らない').toHaveValue('SELECT * FROM entries LIMIT 20');
  // 1 回押し = 名前(少し待ってから入る)
  await input.fill('');
  await entries.click();
  await expect(input, '1 回押しで名前が入らない').toHaveValue('entries');

  // ── 実行 → 結果が下に出る
  await input.fill('SELECT * FROM entries LIMIT 20');
  await clickReal(page, '[data-pkc-action="run-sql"]');
  await expect(pane.locator('[data-pkc-field="sql-table"]'), '結果が出ない').toBeVisible({ timeout: 10_000 });
  expect(
    (await pane.locator('[data-pkc-field="sql-table"]').boundingBox())!.y,
    '結果の表が欄の下にある',
  ).toBeGreaterThan(inputBox.y + inputBox.height - 2);
  // 実行は面の主の操作(濃い地)── 1 つだけ
  await expect(pane.locator('[data-pkc-variant="primary"]')).toHaveCount(1);

  // ── 境目: 掴んで下へ動かすと欄が高くなり、結果が低くなる / 開き直しても憶えている
  const before = { input: await heightOf(input), results: await heightOf(results) };
  await dragSplitter(page, 120);
  const after = { input: await heightOf(input), results: await heightOf(results) };
  expect(after.input, '掴んで下へ動かしても欄が高くならない').toBeGreaterThan(before.input + 60);
  expect(after.results, '結果が低くならない').toBeLessThan(before.results - 60);
  const saved = await page.evaluate(() => localStorage.getItem('pkc3.sql-layout'));
  expect(saved, '離したのに憶えていない').toMatch(/^[01]?:\d+$/);
  // 鍵盤でも動く(↑ を 3 回)
  await page.locator('[data-pkc-field="sql-splitter"]').focus();
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowUp');
  expect(await heightOf(input), '矢印キーで境目が動かない').toBeLessThan(after.input - 10);
  // ダブルクリックで既定へ戻る
  await page.locator('[data-pkc-field="sql-splitter"]').dblclick();
  await expect.poll(async () => Math.abs((await heightOf(input)) - before.input), '既定へ戻らない').toBeLessThan(6);
  // 憶えた割合は読み込み直しても効く
  await dragSplitter(page, 100);
  const splitVar = (): Promise<string> =>
    pane.locator('[data-pkc-field="sql-query-panel"]').evaluate((el) => (el as HTMLElement).style.getPropertyValue('--sql-split'));
  const draggedSplit = await splitVar();
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await page.evaluate(() => {
    location.hash = '#pkc?view=sql';
  });
  await expect(pane).toBeVisible({ timeout: 15_000 });
  await expect.poll(splitVar, '開き直したら境目が戻っている').toBe(draggedSplit);
  // 🔑 面の高さは開き直しで変わりうる(案内カードなど)ので、見るのは割合(欄の高さ / 面の高さ)
  const ratio = async (): Promise<number> =>
    (await heightOf(page.locator('[data-pkc-field="sql-editor"]'))) / (await heightOf(page.locator('[data-pkc-field="sql-query-panel"]')));
  expect(Math.abs((await ratio()) - Number(draggedSplit) / 100), '開き直したら欄の高さの割合が憶えた値でない').toBeLessThan(0.06);

  // ── ER 図はタブで切り替わる(クエリの面は隠れ、欄の中身は残る)
  await input.fill('select 1 as keep');
  const erTab = pane.locator('[data-pkc-field="sql-er-toggle"]');
  const queryTab = pane.locator('[data-pkc-field="sql-query-tab"]');
  await expect(erTab).toHaveAttribute('role', 'tab');
  await expect(queryTab).toHaveAttribute('aria-selected', 'true');
  await clickReal(page, erTab);
  await expect(pane.locator('[data-pkc-field="sql-query-panel"]'), 'ER 図を見ているのにクエリの面が出ている').toBeHidden();
  await expect(pane.locator('[data-pkc-region="sql-er"]')).toBeVisible();
  await expect(pane.locator('[data-pkc-field="sql-er-box"]').first(), '図に四角が出ない').toBeVisible({ timeout: 15_000 });
  await expect(erTab).toHaveAttribute('aria-selected', 'true');
  // 図の中で表を押すと、クエリの欄に書かれる(クエリへ戻ってから確かめる)
  await clickReal(page, queryTab);
  await expect(pane.locator('[data-pkc-field="sql-query-panel"]')).toBeVisible();
  await expect(input, 'タブを替えて打ちかけが消えた').toHaveValue('select 1 as keep');
  // 鍵盤: ER 図のタブへ → (矢印)
  await queryTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(pane.locator('[data-pkc-region="sql-er"]')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(pane.locator('[data-pkc-region="sql-er"]')).toBeHidden();

  // ── 木の出し入れ(憶える)
  const toggle = pane.locator('[data-pkc-field="sql-tree-toggle"]');
  await clickReal(page, toggle);
  await expect(tree, '木が畳まれない').toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('pkc3.sql-layout'))).toMatch(/^0:/);
  const wide = (await input.boundingBox())!.width;
  expect(wide, '木を畳んだら欄が広がる').toBeGreaterThan(inputBox.width + 100);
  await clickReal(page, toggle);
  await expect(tree, '木が戻らない').toBeVisible();

  // ── 鍵盤: ↓ で移る / → で開く / Enter で名前 / Shift+Enter で SELECT 文
  await input.fill('');
  const items = tree.locator('[role="treeitem"]');
  expect(await items.evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex === 0).length), 'ロービングは 1 つ').toBe(1);
  await items.first().focus();
  await page.keyboard.press('ArrowDown');
  const second = items.nth(1);
  await expect(second, '↓ で焦点が移らない').toBeFocused();
  const secondName = (await second.getAttribute('data-pkc-name'))!;
  await page.keyboard.press('ArrowRight');
  await expect(second).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Enter');
  await expect(input, 'Enter で名前が入らない').toHaveValue(new RegExp(secondName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await input.fill('');
  await tree.locator(`[data-pkc-field="sql-tree-table"][data-pkc-name="${secondName}"]`).focus();
  await page.keyboard.press('Shift+Enter');
  await expect(input, 'Shift+Enter で SELECT 文が入らない').toHaveValue(/^SELECT \* FROM .+ LIMIT 20$/);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 SQL 画面(別ウィンドウ 1100×800): 木が自動で並び、結果が出て、境目を動かせる (#1442 段②)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openBrowse(page, 'launcher');
  const opened = page.context().waitForEvent('page', { timeout: 20_000 });
  await openTile(page, '[data-pkc-action="open-tile"][data-pkc-tile="builtin:sql"]');
  const popup = await opened;
  await popup.setViewportSize({ width: 1100, height: 800 });
  await popup.waitForLoadState('domcontentloaded');
  const pane = popup.locator('[data-pkc-view-pane="sql"]');
  await expect(pane, 'SQL の画面が別ウィンドウに出ない').toBeVisible({ timeout: 30_000 });
  // 木は別ウィンドウでも自動で採られる(窓の store は本体へ橋渡し)
  await expect(
    pane.locator('[data-pkc-field="sql-tree-table"][data-pkc-name="entries"]'),
    '別ウィンドウで木に表が出ない',
  ).toHaveCount(1, { timeout: 30_000 });
  const input = pane.locator('[data-pkc-field="sql-input"]');
  // 面が窓いっぱい(一覧・情報・バーは畳まれている)
  expect((await pane.boundingBox())!.width, '面が窓いっぱいでない').toBeGreaterThan(1100 - 60);
  await input.fill('SELECT lid, title FROM entries LIMIT 5');
  await clickReal(popup, '[data-pkc-action="run-sql"]');
  await expect(pane.locator('[data-pkc-field="sql-table"]'), '窓で結果が出ない').toBeVisible({ timeout: 30_000 });
  const before = await heightOf(input);
  await dragSplitter(popup, 100);
  expect(await heightOf(input), '窓で境目が動かない').toBeGreaterThan(before + 50);
  await popup.close();
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
