/**
 * 🔴 **右クリックで表の形を変える**(#708 段②)。
 *
 * > user の物語(#708): markdown で `| 品名 | 数 |` と書いた表を、あとから
 * > **升を押して打てる表にしたい**(逆に、csv の表を他所へ持っていくために
 * > markdown へ落としたい)。どちらの道も無かった。
 *
 * 🔑 **unit では届かない 3 つ**を実ブラウザで見る:
 * 1. **本物の右クリック**(`button: 'right'`)── 合成 event ではブラウザ既定を
 *    奪えたか / メニューが押せる所に出たかが分からない
 * 2. **メニューの項目から実際に効くか** ── メニューは `data-pkc-action` を置くだけで、
 *    実行は root の委譲がやる。**その配線**は実物でしか見えない
 * 3. 🔴 **保存された本文が変わっているか** ── 画面の字だけ見ると、本文に
 *    書かれていなくても緑になる(読み直して残ることまで見る)
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal, createEntry, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const BODY = ['# 買い物', '', '| 品名 | 数 |', '|---|---|', '| りんご | 3 |', '', '以上。'].join(
  '\n',
);

const MENU = '[data-pkc-region="context-menu"]';
/** 押せる升(⚠ #708 段④ で **markdown の表にも出る**ので、これは形の証拠ではない)。 */
const CELL = '[data-pkc-field="detail-body"] [data-pkc-action="edit-cell"]';
/**
 * 🔴 **csv の表になった証拠**(#708 段④ で観測点を差し替えた)。
 *
 * ⚠ 直す前は「升が押せるか」で形を見分けていたが、段④ で **markdown の表の升も
 *   押せるようになった**ので、その印は**両方で真**になった ── 形を見分けられない。
 * 🔑 いま形を分けるのは **行・列を足す ＋ ×**(`shape-cell`)である ── csv の表にしか出ない。
 */
const CSV_ONLY = '[data-pkc-field="detail-body"] [data-pkc-action="shape-cell"]';

test('🔴 表を右クリックして形を変えると、保存された本文も変わる (#708 段②)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('買い物');
  await page.locator('[data-pkc-field="editor-body"]').fill(`${BODY}\n`);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const table = page.locator('[data-pkc-field="detail-body"] table');
  await expect(table, '表が描かれていない').toHaveCount(1, { timeout: 15_000 });
  // 🔑 **前提**:まだ markdown の表である(行・列の ＋ × は出ていない)
  await expect(page.locator(CSV_ONLY), '前提: もう csv の表になっている').toHaveCount(0);

  // ── ① 表を右クリックすると「CSV の表にする」が出る
  await table.locator('td').first().click({ button: 'right' });
  const menu = page.locator(MENU);
  await expect(menu, '表の上で右クリックしてもメニューが出ない').toBeVisible();
  const toCsv = menu.locator('[data-pkc-action="table-to-csv"]');
  await expect(toCsv, '「CSV の表にする」が出ていない').toHaveText('CSV の表にする');

  // ── ② 押すと、升を押して打てる表に変わる
  await clickReal(page, toCsv);
  /**
   * ⚠ **`toBeVisible` では見られない** ── ＋ × は行に乗せるまで `visibility: hidden`
   *   である(`app.css`)。🔑 観測点は「**その印が焼かれているか**」にする。
   */
  await expect(
    page.locator(CSV_ONLY),
    'csv の表になっていない(行・列の ＋ × が焼かれていない)',
  ).not.toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(CELL), '升の数が変わった(表が組み替わった)').toHaveCount(4);
  await expect(table, '表が消えた / 増えた').toHaveCount(1);
  await expect(
    page.locator('[data-pkc-field="detail-body"]'),
    '表の外の字まで書き換えた',
  ).toContainText('以上。');

  /**
   * ── ③ 🔴 **読み込み直しても残る**(本文へ書かれた証拠)。
   * ⚠ 読み直すと何も選ばれていないので、一覧から開き直す(`csv-cell` と同じ作法)。
   */
  await page.reload();
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(page.locator(CSV_ONLY), '読み直したら markdown へ戻った').not.toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.locator(CELL).nth(2), '升の字が消えた').toHaveText(/りんご/);

  /**
   * ── ④ 🔴 **戻せる**(user 指示 2026-08-23「片道の操作を作らない」)。
   * ⚠ 押した先が「もう一度同じ物を押す」ではなく、**反対側の字**が出ることまで見る。
   */
  await page.locator(CELL).first().click({ button: 'right' });
  const toMd = page.locator(`${MENU} [data-pkc-action="table-to-markdown"]`);
  await expect(toMd, '「Markdown の表にする」が出ていない').toHaveText('Markdown の表にする');
  await clickReal(page, toMd);
  await expect(page.locator(CSV_ONLY), 'markdown へ戻っていない(＋ × がまだ出ている)').toHaveCount(
    0,
    { timeout: 15_000 },
  );
  // 🔑 戻っても**升は押せるまま**(#708 段④)── 形は戻り、打ちやすさは残る
  await expect(page.locator(CELL), '戻したら升が押せなくなった').toHaveCount(4);
  await expect(
    page.locator('[data-pkc-field="detail-body"] table'),
    '戻したら表が消えた',
  ).toContainText('りんご');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
