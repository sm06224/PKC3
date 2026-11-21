/**
 * 🔴 **本文の入力欄(` ```yaml form `)に打って、設定欄と表に入れる**(#1456)。
 *
 * > user の物語:日報の定型ノートを作る。項目を定義すると**入力欄**が出る。打って保存すると値がそのノートに入り、
 * > 「表に追加」で同じノートの表の末尾に 1 行足せる。
 *
 * 🔑 **unit では届かない 3 つ**を実ブラウザで見る:
 * 1. **押せる欄が本当に出て、打てる**(`interactiveForms` の旗が読む面の描画まで届く)
 * 2. **保存した値が disk まで届き、開き直しても欄に残る**(設定欄 → `vars` → 欄の値)
 * 3. **表への追加が、描いた表の升に出る**(原文の splice が描画まで届く)
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, createEntry, clickReal, useSplitEditor, writesLanded } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const BODY = [
  '# 日報',
  '',
  '```yaml form',
  'title: 日報',
  'table: 日報一覧',
  'fields:',
  '  - name: 氏名',
  '    required: true',
  '  - name: 件数',
  '    type: number',
  '```',
  '',
  '```csv name=日報一覧',
  '氏名,件数',
  '佐藤,5',
  '```',
  '',
].join('\n');

const FORM = '[data-pkc-field="detail-body"] [data-pkc-form]';
const field = (name: string): string => `${FORM} [data-pkc-form-field="${name}"]`;

test('🔴 入力欄に打って保存すると設定欄へ入り、表に追加でき、開き直しても残る (#1456)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '日報');
  await page.fill('[data-pkc-field="editor-body"]', BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  // ── 読む面に入力欄が出る(定義のコード枠のままではない)
  await expect(page.locator(FORM), '入力欄が出ていない').toBeVisible({ timeout: 10_000 });
  await expect(page.locator(field('氏名'))).toBeVisible();
  await expect(page.locator(field('件数'))).toHaveAttribute('type', 'number');
  const cells = '[data-pkc-field="detail-body"] [data-pkc-action="edit-cell"]';
  expect(await page.locator(cells).count(), '前提 ── 種の表は 2 列 × 2 行').toBe(4);

  // ── 打って保存する
  await page.fill(field('氏名'), '山田');
  await page.fill(field('件数'), '12');
  await clickReal(page, `${FORM} [data-pkc-action="form-save"]`);

  // ── 開き直しても残る(disk まで届いた証拠)
  // ⚠ 書き込みが届いてから読み直す(届く前に reload すると、保存した値が消えて見える ── `writesLanded` の注記)
  await writesLanded(page);
  await page.reload();
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(page.locator(field('氏名')), '保存した値が欄に戻らない').toHaveValue('山田', { timeout: 15_000 });
  await expect(page.locator(field('件数'))).toHaveValue('12');

  // ── 表に追加する → 表の升が 2 列分増える
  await clickReal(page, `${FORM} [data-pkc-action="form-row-add"]`);
  await expect(page.locator(cells), '表に 1 行増えていない').toHaveCount(6, { timeout: 10_000 });
  await expect(page.locator(cells).nth(4)).toHaveText('山田');
  await expect(page.locator(cells).nth(5)).toHaveText('12');

  // ── 読み込む: 1 行目(佐藤,5)を入力欄へ
  await page.fill(`${FORM} [data-pkc-form-rowno]`, '1');
  await clickReal(page, `${FORM} [data-pkc-action="form-row-load"]`);
  await expect(page.locator(field('氏名')), '表の行が入力欄に入らない').toHaveValue('佐藤', { timeout: 10_000 });
  await expect(page.locator(field('件数'))).toHaveValue('5');

  // ── 必須が空なら追加を断る(表は増えない)
  await page.fill(field('氏名'), '');
  await clickReal(page, `${FORM} [data-pkc-action="form-row-add"]`);
  await expect(page.locator('body'), '断りの理由が出ない').toContainText(
    '必須の項目が未入力です',
  );
  expect(await page.locator(cells).count(), '断ったのに表が増えた').toBe(6);

  // ── #2002 段 4: 「記録の一覧」で集計の画面が開く(グループ化は template。このノートに出自は無いので「もうありません」)
  await clickReal(page, `${FORM} [data-pkc-action="form-open-list"]`);
  await expect(page.locator('[data-pkc-region="query-bar"]'), '集計の画面が開かない').toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-pkc-region="query-table"]')).toContainText('template');
  // 出自の無いノートなので、行は 1 つも並ばない(次の spec が、出自つきの記録で行・選択・戻りを見る)
  await expect(page.locator('[data-pkc-region="query-rows"] li[data-pkc-entry]')).toHaveCount(0);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **サンプルから記録のノートを作り、入力して「表に追加」で表に 1 行たまる**(#2002 段 2)。
 * 🔑 unit では届かない所:作成の ▼ → 一覧 → 複製の本文が disk を経て**描画された入力欄と表**になること。
 */
test('🔴 サンプルから作った記録のノートで、入力して表に追加すると行がたまる (#2002)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await clickReal(page, '[data-pkc-field="create-pick"]');
  await clickReal(page, '[data-pkc-region="create-menu"] [data-pkc-action="create-from-template"]');
  const rows = page.locator('[data-pkc-field="pick-template-note"]');
  await expect(rows, 'サンプルが 3 つ並ばない').toHaveCount(3);
  await rows.filter({ hasText: '回帰テストの実施記録' }).click();
  await expect(page.locator('[data-pkc-field="editor-body"]'), 'サンプルの中身が入っていない').toHaveValue(/```yaml form/);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  await expect(page.locator(FORM), '入力欄が出ていない').toBeVisible({ timeout: 10_000 });
  const cells = '[data-pkc-field="detail-body"] [data-pkc-action="edit-cell"]';
  expect(await page.locator(cells).count(), '前提 ── 見出しだけの表(9 列)').toBe(9);

  await page.fill(field('ビルド'), '1.4.2-rc1');
  await page.fill(field('担当者'), '佐藤');
  await page.selectOption(field('結果'), { label: '合格' });
  await clickReal(page, `${FORM} [data-pkc-action="form-row-add"]`);
  await expect(page.locator(cells), '表に 1 行増えていない').toHaveCount(18, { timeout: 10_000 });
  await expect(page.locator(cells).nth(10)).toHaveText('1.4.2-rc1');
  await expect(page.locator(cells).nth(11)).toHaveText('佐藤');

  // ── #2002 段 4: 「記録の一覧」→ この記録ノート自身の題名が行として並び、押すと選ばれ、閉じるとノートへ戻る(再起動しない)
  // ⚠ 列に出るのは「入力を保存」で設定欄(vars)へ入れた値(表に追加しただけでは vars に入らない)
  await clickReal(page, `${FORM} [data-pkc-action="form-save"]`);
  await writesLanded(page);
  await page.evaluate(() => {
    (window as unknown as { __noBoot: number }).__noBoot = 1;
  });
  await clickReal(page, `${FORM} [data-pkc-action="form-open-list"]`);
  await expect(page.locator('[data-pkc-region="query-bar"]'), '集計の画面が開かない').toBeVisible({ timeout: 10_000 });
  const group = page.locator('[data-pkc-region="query-group"][data-pkc-group="回帰テストの実施記録"]');
  await expect(group, 'サンプルの題名で 1 組に集まらない').toBeVisible({ timeout: 10_000 });
  const row = group.locator('li[data-pkc-entry]');
  await expect(row, '記録のノートが行として並ばない').toHaveCount(1);
  const rowTitle = ((await row.locator('[data-pkc-field="title"]').textContent()) ?? '').trim();
  expect(rowTitle, '行の題名が空').not.toBe('');
  // 列: 入力した値が、見出しと同じ並びの升に出る
  const heads = await group.locator('[data-pkc-field="query-column"]').allTextContents();
  const cellTexts = await row.locator('[data-pkc-field="query-cell"]').allTextContents();
  expect(heads.length, '入力欄の値の列が出ない').toBeGreaterThan(0);
  expect(cellTexts[heads.indexOf('ビルド')], 'ビルドの値が行に出ない').toBe('1.4.2-rc1');
  expect(cellTexts[heads.indexOf('担当者')]).toBe('佐藤');
  await row.click();
  await expect(row, '行を押しても選ばれない').toHaveAttribute('data-pkc-selected', '');
  await clickReal(page, '[data-pkc-action="close-pane"]');
  await expect(page.locator(FORM), '閉じてもノートへ戻らない').toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-pkc-region="detail"]')).toContainText(rowTitle);
  expect(
    await page.evaluate(() => (window as unknown as { __noBoot?: number }).__noBoot),
    '一覧を開いて閉じる間に再起動した',
  ).toBe(1);

  expect(errors).toEqual([]);
});
