/**
 * 🔴 **`|` で書いた表も、升を押してその場で打てる**(#708 段④)。
 *
 * > user の物語(#708): 表を書いたあとで「これは升を押して打ちたい」と思っても、
 * > 押せる升が在るのは csv の囲みだけで、markdown の表は原文を開くしかなかった。
 *
 * 🔑 **unit では届かない 3 つ**を実ブラウザで見る:
 * 1. **押した升に焦点が入るか**(happy-dom の `focus` は本物ではない)
 * 2. **`execCommand` の道が通るか**(happy-dom には無いので unit は必ず fallback)
 * 3. **確定した字が disk まで届き、開き直しても残るか**
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal, createEntry, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * ⚠ 升の中に `\|` を入れてある ── **この段でいちばん静かに壊れる形**である。
 *   逃がし直さずに書き戻すと、確定した瞬間に**列が増えて表がずれる**。
 */
const BODY = ['# 買い物', '', '| 品名 | 数 |', '|---|---|', '| りんご\\|青 | 3 |', '', '以上。'].join(
  '\n',
);

const CELL = '[data-pkc-field="detail-body"] [data-pkc-action="edit-cell"]';

test('🔴 markdown の表の升を押して打つと、本文に残る (#708 段④)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('買い物');
  await page.locator('[data-pkc-field="editor-body"]').fill(`${BODY}\n`);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const cells = page.locator(CELL);
  await expect(cells.first(), '升が押せる形で出ていない').toBeVisible({ timeout: 15_000 });
  // 🔑 前提 ── 見出し 2 + 中身 2 の **4 つだけ**(区切りの行には焼かれていない)
  await expect(cells, '押せる升の数が違う(区切りの行にも焼いた?)').toHaveCount(4);

  // ── 押すと、その升だけが入力欄になる(原文の欄は出ない = user の不満そのもの)
  await cells.nth(2).click();
  const input = page.locator('[data-pkc-field="cell-input"]');
  await expect(input, '押した升が入力欄にならない').toBeVisible();
  await expect(page.locator('[data-pkc-field="cell-input"]'), '欄が 2 つ以上出た').toHaveCount(1);
  await expect(page.locator('[data-pkc-field="editor-body"]'), '原文の欄が出た').toHaveCount(0);
  /**
   * 🔑 **焼いた原文は逃がしたまま出る** ── `りんご|青` と出ていたら、確定した瞬間に
   *   列が増える(この段でいちばん静かに壊れる形)。
   */
  await expect(input, '欄に出た原文の逃がしが外れている').toHaveValue('りんご\\|青');

  await page.keyboard.press('Control+a');
  await page.keyboard.type('みかん|橙');
  await page.keyboard.press('Enter');

  // ── 打った字が升に入り、**列は増えていない**
  await expect(cells.nth(2), '打った字が升に入っていない').toHaveText(/みかん\|橙/, {
    timeout: 10_000,
  });
  await expect(cells, '列が増えた(逃がし直していない)').toHaveCount(4);
  await expect(
    page.locator('[data-pkc-field="detail-body"]'),
    '表の外の字まで書き換えた',
  ).toContainText('以上。');

  /**
   * 🔴 **読み込み直しても残る**(disk まで届いた証拠)。
   * ⚠ 画面の字だけ見ると、本文に書かれていなくても緑になる。
   */
  await page.reload();
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(page.locator(CELL).nth(2), '読み直したら消えた').toHaveText(/みかん\|橙/, {
    timeout: 15_000,
  });
  await expect(page.locator(CELL), '読み直したら列が増えていた').toHaveCount(4);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
