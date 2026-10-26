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
import { gotoApp, collectPageErrors, createEntry, clickReal, useSplitEditor } from './helpers';

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

  expect(errors).toEqual([]);
});
