/**
 * 🔴 **タグを「その場で打つ」**(#494)を、実ブラウザで見る。
 *
 * > user 指摘 2026-08-27:「**タグの設定が Apple のメモアプリと違い、直感的に
 * > ここにタグを打つ!って感じの動作じゃなくて yamlfrontmatter なのは問題だ。
 * > しかも設定動線がよくわからん**」
 *
 * ## ⚠ ここでしか見られないもの
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 **打った字が本文に残る**(開き直しても) | 実 worker(sqlite)を通る |
 * | 🔴 **候補が実 worker の走査から出る** | unit の `queryScan` は fake |
 * | 実キーボードの Enter(IME を通らない素の確定) | 合成 event ではない |
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

const INPUT = '[data-pkc-field="tag-add-input"]';
const CHIPS = '[data-pkc-region="inspector"] [data-pkc-field="inspector-tag"]';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/** ノートを 1 件作って保存する(タグを打てる状態 = `ready`)。 */
async function makeNote(page: import('@playwright/test').Page, title: string, body: string) {
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', title);
  await page.fill('[data-pkc-field="editor-body"]', body);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
}

test('🔴 情報ペインでタグを打つと本文に入り、開き直しても残る (#494)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await makeNote(page, '買い出しメモ', '牛乳と卵\n');

  // 🔴 **打つ欄がその場に在る**(user 指摘の中心)
  await expect(page.locator(INPUT), 'タグを打つ欄が情報ペインに無い').toBeVisible();
  await page.fill(INPUT, '買い物');
  await page.locator(INPUT).press('Enter');

  // 札になって出る
  await expect(page.locator(CHIPS)).toHaveCount(1);
  await expect(page.locator(CHIPS).first()).toContainText('買い物');
  // ⚠ 通ったら欄は空(次の 1 つを打てる)
  await expect(page.locator(INPUT)).toHaveValue('');

  /**
   * 🔴 **本文に入っていること**を、画面の札ではなく**本文そのもの**で見る ──
   * 札だけ見ると「画面には出たが disk に届いていない」を素通りする。
   */
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const body = await page.inputValue('[data-pkc-field="editor-body"]');
  expect(body, 'frontmatter に入っていない').toContain('tags:');
  expect(body, 'タグが入っていない').toContain('買い物');
  expect(body, '本文を踏み潰した').toContain('牛乳と卵');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  // 🔴 **読み直しても残る**(disk まで届いた証拠)
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await clickReal(page, '[data-pkc-region="entry-list"] [data-pkc-entry], [data-pkc-entry]');
  await expect(page.locator(CHIPS).first(), '読み直したら消えた').toContainText('買い物');

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **片道の操作を作らない**(裁定 2026-08-23)。
 * ⚠ 打てるのに外せないと、間違えたタグを消すために**本文を開いて frontmatter を
 *   直す**ことになる ── それは動線を 1 つ失うのと同じである。
 */
test('🔴 札の × で外れ、本文からも消える (#494)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await makeNote(page, 'メモ', '---\ntags: [買い物, 家事]\n---\n本文\n');

  await expect(page.locator(CHIPS)).toHaveCount(2);
  await clickReal(
    page,
    '[data-pkc-region="inspector"] [data-pkc-field="inspector-tag-off"][data-pkc-tag="買い物"]',
  );
  await expect(page.locator(CHIPS), '外れていない').toHaveCount(1);
  await expect(page.locator(CHIPS).first()).toContainText('家事');

  await clickReal(page, '[data-pkc-action="start-edit"]');
  const body = await page.inputValue('[data-pkc-field="editor-body"]');
  expect(body, '本文から消えていない').not.toContain('買い物');
  expect(body, 'もう片方まで消えた').toContain('家事');

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **既にあるタグから選べる**(#494 段②)。
 * ⚠ 観測点は**実 worker の走査から来た候補**(unit の fake ではない)。
 */
test('🔴 既に使っているタグが候補に出る (#494 段②)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await makeNote(page, '先のノート', '---\ntags: [請求済]\n---\n本文\n');
  await makeNote(page, '後のノート', '本文だけ\n');

  // ⚠ **焦点が当たるまでは集めない**(打たない人に払わせない)
  expect(
    await page.locator('#pkc-tag-candidates option').count(),
    '開いただけで候補が出ている',
  ).toBe(0);

  await page.locator(INPUT).focus();
  await expect
    .poll(async () => page.locator('#pkc-tag-candidates option').count(), { timeout: 5000 })
    .toBeGreaterThan(0);
  const opts = await page.locator('#pkc-tag-candidates option').allTextContents();
  const values = await page
    .locator('#pkc-tag-candidates option')
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect(values, `候補に「請求済」が無い(${JSON.stringify(opts)})`).toContain('請求済');
  // ⚠ 「未設定」の組(空文字)が混ざっていない ── 押すと空の字がタグになる
  expect(values.includes(''), '空の候補が出ている').toBe(false);

  expect(errors, 'pageerror が出た').toEqual([]);
});
