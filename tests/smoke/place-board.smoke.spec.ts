/**
 * 🔴 **自由配置の板**(#283 P4)を、実ブラウザで見る。
 *
 * ## ⚠ ここでしか見られないもの
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 塊が**実際にその座標に描かれる**(CSS の position が効く) | happy-dom は layout を持たない |
 * | 🔴 **実マウスの掴み → 本文の x= / y= が書き替わり、描き直しても残る** | pointer capture・座標・保存の往復は実物でしか通らない |
 *
 * 🔑 観測点は **data-pkc-x(本文の記法から描き直された値)** ── style だけ見ると
 *   「見た目は動いたが本文に書けていない」を素通りする(#513 の「成功と同じ見た目」の型)。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const BOARD = [
  ':::format{#p1 .pkc-place x=120 y=40 w=320 h=200}',
  '### 買い出し',
  '- 牛乳',
  ':::',
  '',
  ':::format{#p2 .pkc-place x=460 y=40 w=200 h=120}',
  'めも',
  ':::',
].join('\n');

test('🔴 板の塊が座標に置かれ、掴んで動かすと本文が書き替わる (#283 P4)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '板のノート');
  await page.fill('[data-pkc-field="editor-body"]', BOARD);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  // 🔴 2 つの塊が、書いた座標に置かれている(相対位置で見る ── 器の原点に依らない)
  const p1 = page.locator('[data-pkc-region="detail"] #p1');
  const p2 = page.locator('[data-pkc-region="detail"] #p2');
  await expect(p1).toBeVisible();
  const b1 = (await p1.boundingBox())!;
  const b2 = (await p2.boundingBox())!;
  expect(Math.round(b2.x - b1.x), '横の並びが記法どおりでない').toBe(460 - 120);
  expect(Math.round(b2.y - b1.y), '縦の並びが記法どおりでない').toBe(0);
  expect(Math.round(b1.width), '幅が記法どおりでない').toBe(320);

  // 🔴 掴んで動かす ── grip を実マウスで掴み、+100 / +60 動かして離す
  const grip = page.locator('#p1 [data-pkc-field="place-grip"]');
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + 100, g.y + g.height / 2 + 60, { steps: 5 });
  await page.mouse.up();

  /**
   * 🔴 観測点は**本文から描き直された属性** ── 保存 → 再読込 → 再描画の往復が
   * 通って初めてこの値になる(style だけなら掴んだ瞬間に変わってしまう)。
   */
  await expect(p1, '本文に書き戻されていない(見た目だけ動いた)').toHaveAttribute(
    'data-pkc-x',
    '220',
    { timeout: 5000 },
  );
  await expect(p1).toHaveAttribute('data-pkc-y', '100');

  // ⚠ 対照群: 掴んでいない塊は動いていない
  await expect(p2).toHaveAttribute('data-pkc-x', '460');

  expect(errors, 'pageerror が出た').toEqual([]);
});

test('🔴 entry= の塊は題名の札になり、押すとそのノートを開く (#283 P4)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  // 相手のノートを先に作り、lid を一覧の行から読む
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '相手のノート');
  await page.fill('[data-pkc-field="editor-body"]', '中身\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const lid = await page
    .locator('[data-pkc-region="sidebar"] [data-pkc-entry]')
    .first()
    .getAttribute('data-pkc-entry');
  expect(lid, '前提が崩れている(相手の lid が読めない)').not.toBeNull();

  // 板のノートを作る(札 1 枚)
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '板');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    `:::format{.pkc-place entry=${lid} x=60 y=30 w=240 h=100}\n:::\n`,
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  // 🔴 札に相手の題名が出る(展開ではない ── 中身は写らない)
  const card = page.locator('[data-pkc-field="place-card"]');
  await expect(card, '札に題名が出ていない').toHaveText('相手のノート');

  // 🔴 押すと相手のノートが開く
  await clickReal(page, '[data-pkc-field="place-card"]');
  await expect(
    page.locator('[data-pkc-region="detail"] [data-pkc-field="detail-title"]'),
    '押しても相手が開かない',
  ).toHaveText('相手のノート');

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **右クリックで板を置く**(#676)── 押した座標が本文の `x=` / `y=` になる。
 * ⚠ unit(happy-dom)では器の rect が 0 なので、「器の左上からの差」という座標変換は
 *   実ブラウザでしか見えない(padding / 枠線 / スクロール位置が効く当の所)。
 */
test('🔴 本文を右クリックして「ここに板を置く」と、押した位置に板が書かれる (#676)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '板のノート');
  await page.fill('[data-pkc-field="editor-body"]', BOARD);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const host = page.locator('[data-pkc-field="detail-body"]');
  const hb = (await host.boundingBox())!;
  /**
   * 🔴 **押すのは整数の画面座標**(2026-09-05 に落ちて実測した)。
   *
   * ⚠ 1 稿目は `hb.y + 100` で押していたが、器の上端は **76.75px** のような半端な
   *   位置に来る(実測。上の面の高さは文字の寸法で決まる)。ブラウザは `MouseEvent.clientY`
   *   を**整数に切り捨てる**ので、176.75 で押しても製品が受けるのは **176** ──
   *   `176 − 76.75 = 99.25 → 99` になり、期待の 100 と 1px ずれた。
   * 🔑 器の枠(`clientTop`)とスクロール(`scrollTop`)は**どちらも 0 と実測**した ──
   *   製品の座標変換は正しい。ずれていたのは spec が**実マウスには無い半端な座標**で
   *   押していたこと。だから整数で押し、期待値は「押した画面座標 − 器の上端」の丸めで書く
   *   (器の半端に依らず、実マウスと同じ答えになる)。
   * ⚠ 既存の 2 枚(x=120 / x=460、y=40〜)に当たらない空き地を押す
   */
  const px = Math.floor(hb.x) + 60;
  const py = Math.floor(hb.y) + 100;
  const expectX = String(Math.round(px - hb.x));
  const expectY = String(Math.round(py - hb.y));
  await page.mouse.click(px, py, { button: 'right' });
  const menu = page.locator('[data-pkc-region="context-menu"]');
  await expect(menu).toBeVisible();
  await menu.locator('[data-pkc-action="add-place"]').click();

  /**
   * 🔴 観測点は**本文から描き直された属性**(保存 → 再描画の往復の後の値)。
   * ⚠ 器の枠線ぶん(`clientLeft`)が 0 でなければそのぶんずれる ── 実測して落ちたら、
   *   期待値ではなく `binder.ts` の座標変換を疑う(上の注のとおり、いまは 0)。
   */
  const added = page.locator(`[data-pkc-field="detail-body"] .pkc-place[data-pkc-x="${expectX}"]`);
  await expect(added, `押した位置の x=${expectX} で板が書かれていない`).toHaveCount(1, { timeout: 5000 });
  await expect(added, `押した位置の y=${expectY} で板が書かれていない`).toHaveAttribute('data-pkc-y', expectY);
  // 対照群: 元の 2 枚は動いていない
  await expect(page.locator('[data-pkc-region="detail"] #p1')).toHaveAttribute('data-pkc-x', '120');
  await expect(page.locator('[data-pkc-region="detail"] #p2')).toHaveAttribute('data-pkc-x', '460');

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **右下の角を掴んで大きさを変える**(#676)── 離した大きさが本文の `w=` / `h=` に書き戻る。
 */
test('🔴 板の角を実マウスで掴むと、本文の w= / h= が書き替わる (#676)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '板のノート');
  await page.fill('[data-pkc-field="editor-body"]', BOARD);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const p1 = page.locator('[data-pkc-region="detail"] #p1');
  const handle = page.locator('#p1 [data-pkc-field="place-size"]');
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 80, h.y + h.height / 2 + 40, { steps: 5 });
  await page.mouse.up();

  await expect(p1, '本文に書き戻されていない(見た目だけ変わった)').toHaveAttribute('data-pkc-w', '400', {
    timeout: 5000,
  });
  await expect(p1).toHaveAttribute('data-pkc-h', '240');
  // 対照群: 位置は動いていない / 隣の塊は変わっていない
  await expect(p1).toHaveAttribute('data-pkc-x', '120');
  await expect(page.locator('[data-pkc-region="detail"] #p2')).toHaveAttribute('data-pkc-w', '200');

  expect(errors, 'pageerror が出た').toEqual([]);
});
