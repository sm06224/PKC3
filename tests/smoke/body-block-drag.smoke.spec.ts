/**
 * 🔴 **本文の塊を掴んで並べ替える**(#684 段①)を、実ブラウザで見る。
 *
 * ## ⚠ ここでしか見られないもの
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 実マウスで ⠿ を掴み、別の塊の下へ落とすと**本文が書き替わって刻印の並びが変わる** | 本物の HTML5 D&D(`DataTransfer` / dragover の座標 / 保存の往復)は happy-dom に無い |
 * | 🔴 **字の選択が生きている** ── 段落の字をドラッグすると選べる(塊が動き出さない) | 選択は layout と本物の D&D の判定で決まる |
 *
 * 🔑 観測点は **`data-pkc-source-line` の並び**(本文から描き直された刻印)── DOM の順だけ
 *   見ると「見た目は動いたが本文に書けていない」を素通りする(`place-board.smoke` と同じ型)。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const BODY = ['# 題', '', '段落 A', '', '## 章 B', '', '本文 B', '', '## 章 C', '', '本文 C', ''].join(
  '\n',
);

const HOST = '[data-pkc-region="detail"] [data-pkc-field="detail-body"]';

/** 本文の直下の塊の字(刻印順)。 */
async function order(page: import('@playwright/test').Page): Promise<string[]> {
  return page.locator(`${HOST} > [data-pkc-source-line]`).evaluateAll((els) =>
    els.map((e) => (e.textContent ?? '').trim()),
  );
}

test('🔴 ⠿ を掴んで別の塊の下へ落とすと、本文の並びが書き替わる (#684 段①)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '並べ替えるノート');
  await page.fill('[data-pkc-field="editor-body"]', BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await expect(page.locator(`${HOST}[data-pkc-painted]`)).toBeAttached();
  expect(await order(page), '前提: 描いた並び').toEqual(['題', '段落 A', '章 B', '本文 B', '章 C', '本文 C']);

  // 段落 A に乗せると ⠿ が横に出る
  const para = page.locator(`${HOST} > p`).first();
  await para.hover();
  const grip = page.locator('[data-pkc-field="block-grip"]');
  await expect(grip, '乗せても口が出ない').toBeVisible();
  await expect(grip).toHaveAttribute('data-pkc-block-start', '2');

  // 🔴 実マウスで掴み、「本文 C」の下半分へ落とす
  const g = (await grip.boundingBox())!;
  const target = page.locator(`${HOST} > p`).last();
  const t = (await target.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + 40, g.y + 40, { steps: 4 });
  await page.mouse.move(t.x + t.width / 2, t.y + t.height * 0.8, { steps: 8 });
  // ⚠ 線が出ている = dragover が受けている(落とす前に見る ── 落とした後は印が消える)
  await expect(target, '落とし先に「後」の線が出ない').toHaveAttribute('data-pkc-drop-edge', 'after');
  await page.mouse.up();

  /**
   * 🔴 観測点は**本文から描き直された刻印の並び** ── 保存 → 再読込 → 再描画の往復が
   * 通って初めてこの並びになる。
   */
  await expect
    .poll(() => order(page), { timeout: 5000, message: '本文の並びが書き替わっていない' })
    .toEqual(['題', '章 B', '本文 B', '章 C', '本文 C', '段落 A']);
  // 知らせの隣に「元に戻す」が出る(片道の操作にしない)
  await expect(page.locator('[data-pkc-field="status-undo"]')).toBeVisible();
  await clickReal(page, '[data-pkc-field="status-undo"]');
  await expect
    .poll(() => order(page), { timeout: 5000, message: '元に戻らない' })
    .toEqual(['題', '段落 A', '章 B', '本文 B', '章 C', '本文 C']);

  expect(errors, 'pageerror が出た').toEqual([]);
});

test('🔴 段落の字はドラッグで選べる(塊そのものは掴めない)(#684 段①)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '選ぶノート');
  await page.fill('[data-pkc-field="editor-body"]', BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const para = page.locator(`${HOST} > p`).first();
  const r = (await para.boundingBox())!;
  // 字の上を左から右へドラッグ
  await page.mouse.move(r.x + 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.6, r.y + r.height / 2, { steps: 6 });
  await page.mouse.up();
  const selected = await page.evaluate(() => (window.getSelection()?.toString() ?? '').trim());
  expect(selected, '字をドラッグしても選べない(塊が draggable になっている)').not.toBe('');
  expect('段落 A'.includes(selected) || selected.includes('段落'), `選ばれた字が段落の字でない: ${selected}`).toBe(
    true,
  );
  // 対照群 ── 塊は動いていない
  expect(await order(page)).toEqual(['題', '段落 A', '章 B', '本文 B', '章 C', '本文 C']);
  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **一覧の行を本文へ落とすとリンクになる**(#684 段②)。
 * ⚠ unit は合成 event で `insert-lines` が飛ぶ所まで ── 本物の D&D で一覧の行(`draggable`)が
 *   本文の面まで運ばれ、保存 → 再描画で **押せるリンク**として出ることは実ブラウザでしか見えない。
 */
test('🔴 一覧の行を本文へ落とすと、そのノートへのリンクが本文に入る (#684 段②)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  // 相手のノートを先に作り、次に落とし先のノートを作って開いたままにする
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '相手のノート');
  await page.fill('[data-pkc-field="editor-body"]', '中身\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '受け取るノート');
  await page.fill('[data-pkc-field="editor-body"]', BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await expect(page.locator(`${HOST}[data-pkc-painted]`)).toBeAttached();

  // 左の一覧(フォルダ面)の「相手のノート」の行を掴む
  const row = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]', { hasText: '相手のノート' }).first();
  await expect(row, '掴む行が無い(前提が崩れた)').toBeVisible();
  const from = (await row.boundingBox())!;
  const target = page.locator(`${HOST} > p`).first(); // 段落 A
  const t = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y + 30, { steps: 4 });
  await page.mouse.move(t.x + t.width / 2, t.y + t.height * 0.8, { steps: 8 });
  await expect(target, '本文の上で「後」の線が出ない').toHaveAttribute('data-pkc-drop-edge', 'after');
  await page.mouse.up();

  // 🔴 観測点: 本文から描き直された**押せるリンク**(段落 A の直後に入る)
  const link = page.locator(`${HOST} a`, { hasText: '相手のノート' });
  await expect(link, 'リンクが本文に入っていない').toBeVisible({ timeout: 5000 });
  await expect
    .poll(() => order(page), { timeout: 5000 })
    .toEqual(['題', '段落 A', '相手のノート', '章 B', '本文 B', '章 C', '本文 C']);
  // 対照群 ── 掴んだ行は一覧から消えていない(移していない)
  await expect(row).toBeVisible();
  expect(errors, 'pageerror が出た').toEqual([]);
});
