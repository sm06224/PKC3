import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 2 ペインタブファイラ(#241 段⑥-a)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * 1. **実マウスの 2 クリック** ── 合成 `click` を 2 回撃つのと、実機で 2 回押すのは別
 * 2. **面が本当に見えているか** ── `hidden` の付け替えと CSS の噛み合いは
 *    happy-dom では読めない(`toBeVisible` は実レイアウトを見る)
 * 3. **左右が本当に横に並んでいるか** ── `grid-template-columns: 1fr auto 1fr` が
 *    効いていなければ、片方が画面の外へ落ちる(unit は幅を持たない)
 */

const PANE = (side: string): string =>
  `[data-pkc-region="dual-pane"][data-pkc-side="${side}"]`;
const ROWS = (side: string): string => `${PANE(side)} [data-pkc-region="dual-table"] tbody tr`;

/**
 * 🔴 **本物の導線で開く**(user 指摘 2026-08-19「2 ペインファイラは**アプリとして**
 * Office のように組み込みの導線を用意しろ」)。
 * ⚠ 1 稿目は左の列の帯のボタンを押していたが、**そのボタンはもう無い** ──
 *   ここを直さないと、導線を消した瞬間に smoke ごと嘘になる。
 * ⚠ タイルは**アプリのタブを開かないと描かれない**(左の列は探し方で切り替わる)。
 */
async function openDual(page: Page): Promise<void> {
  await clickReal(page, '[data-pkc-browse="launcher"]');
  await clickReal(page, '[data-pkc-action="open-tile"][data-pkc-tile="builtin:dual"]');
}

async function makeFolder(page: Page, title: string): Promise<void> {
  await createEntry(page, 'folder');
  const t = page.locator('[data-pkc-field="editor-title"]');
  if (await t.count()) await t.fill(title);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
}

test('🔴 2 ペインを開いて、左で選んだものを右の場所へ移す', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await makeFolder(page, 'はこ');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ① 面を開く(左の列のボタン)
  await openDual(page);
  await expect(page.locator('[data-pkc-view-pane="dual"]')).toBeVisible();
  await expect(page.locator('[data-pkc-view-pane="detail"]'), '本文の面が出たまま').toBeHidden();

  /**
   * ② 🔴 **左右が横に並んでいる**(縦積みや、片方が画面外に落ちていない)。
   * ⚠ 「要素が在る」だけでは足りない ── **座標**で見る(CSS が効いていなければ
   *   `x` が同じになる / 片方の幅が 0 になる)。
   */
  const left = await page.locator(PANE('left')).boundingBox();
  const right = await page.locator(PANE('right')).boundingBox();
  expect(left, '左のペインが描かれていない').not.toBeNull();
  expect(right, '右のペインが描かれていない').not.toBeNull();
  expect(right!.x, '左右が横に並んでいない').toBeGreaterThan(left!.x + left!.width - 1);
  expect(Math.abs(left!.width - right!.width), '左右の幅が違う(元と先が対等に見えない)')
    .toBeLessThan(2);

  await expect(page.locator(ROWS('left'))).toHaveCount(2);
  await expect(page.locator(ROWS('right'))).toHaveCount(2);

  // ③ 🔴 実マウスの 2 クリックで、**右だけ**がフォルダの中へ入る
  await page.locator(ROWS('right')).first().dblclick();
  /**
   * ⚠ **パンくずだけを見る**(着地前レビュー R7)。ペイン全体で探すと、
   * ルートに居るときは**表の行そのものが「はこ」**なので、ダブルクリックが
   * 1 ミリも効かなくても真になる(CLAUDE.md §1「面へスコープする」)。
   */
  await expect(page.locator(`${PANE('right')} [data-pkc-region="dual-crumbs"]`)).toContainText(
    'はこ',
  );
  await expect(page.locator(ROWS('right')), '右がフォルダに入れていない').toHaveCount(0);
  await expect(page.locator(ROWS('left')), '押していない左まで動いた').toHaveCount(2);

  // ④ 左のノートを選ぶ ── 焦点が左へ移り、向きの字も変わる
  await page.locator(ROWS('left')).nth(1).click();
  await expect(page.locator(PANE('left'))).toHaveAttribute('data-pkc-focused', '');
  await expect(page.locator('[data-pkc-field="dual-move"]')).toContainText('右へ移す');

  // ⑤ 移す ── 右(= はこの中)に現れ、左からは消える
  await clickReal(page, '[data-pkc-field="dual-move"]');
  await expect(page.locator(ROWS('right')), '右へ移っていない').toHaveCount(1);
  await expect(page.locator(ROWS('left')), '左から消えていない').toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 何も選ばずに押したら、理由が画面に出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await openDual(page);

  await clickReal(page, '[data-pkc-field="dual-move"]');
  /**
   * ⚠ **観測点は状態の行だけ**(CLAUDE.md §1 の 7 度目)── root 全体の
   * `textContent` で探すと、お知らせのカードや本文に満たされて常に真になる。
   */
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('移すものを選んでください');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 タブを足して、別の場所を 1 つのペインに持てる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeFolder(page, 'はこ');
  await openDual(page);

  const tabs = page.locator(`${PANE('left')} [data-pkc-region="dual-tab"]`);
  await expect(tabs).toHaveCount(1);
  // ⚠ 最後の 1 枚には閉じる口を出さない(押しても何も起きないボタンを作らない)
  await expect(page.locator(`${PANE('left')} [data-pkc-action="dual-tab-close"]`)).toHaveCount(0);

  await clickReal(page, `[data-pkc-action="dual-tab-add"][data-pkc-side="left"]`);
  await expect(tabs).toHaveCount(2);
  await page.locator(ROWS('left')).first().dblclick();
  await expect(tabs.nth(1), '2 枚目のタブが行き先を名乗っていない').toContainText('はこ');
  await expect(tabs.nth(0), '足す前のタブまで動いた').toContainText('ルート');

  // 1 枚目へ戻ると、ルートの中身が出る
  await tabs.nth(0).locator('[data-pkc-action="dual-tab-activate"]').click();
  await expect(page.locator(ROWS('left'))).toHaveCount(1);

  await page.locator(`${PANE('left')} [data-pkc-action="dual-tab-close"]`).first().click();
  await expect(tabs).toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **キーボードだけで動かせる**(#273。user 指摘 2026-08-19
 * 「OS のファイラと同じことができないといけません / 往年の FD などを見習って」)。
 *
 * ⚠ unit は合成 event と happy-dom の `activeElement` を見ている ── 実機で
 * **本当に焦点が乗り、本当のキーが届くか**はここでしか分からない
 * (焦点の移動は実ブラウザと happy-dom で最も食い違う所である)。
 */
test('🔴 2 ペインをキーボードだけで動かす (#273)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeFolder(page, 'はこ');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await openDual(page);

  // ① 行を押して焦点を作る(ここから先は**キーだけ**)
  await page.locator(ROWS('left')).first().click();
  await expect(page.locator(PANE('left'))).toHaveAttribute('data-pkc-focused', '');

  // ② ↓ で送れる ── 印が動いた行に付く
  await page.keyboard.press('ArrowDown');
  await expect(
    page.locator(`${PANE('left')} [data-pkc-entry][data-pkc-marked]`),
    '↓ で印が動いていない',
  ).toHaveCount(1);

  // ③ Tab で反対のペインへ(FD の基本操作)
  await page.keyboard.press('Tab');
  await expect(page.locator(PANE('right')), 'Tab で反対側へ移っていない').toHaveAttribute(
    'data-pkc-focused',
    '',
  );

  // ④ Enter でフォルダの中へ ── 押した側だけが入る
  await page.keyboard.press('Enter');
  await expect(page.locator(`${PANE('right')} [data-pkc-region="dual-crumbs"]`)).toContainText(
    'はこ',
  );
  await expect(page.locator(ROWS('left')), '押していない側まで入った').toHaveCount(2);

  // ⑤ Backspace で戻れる
  await page.keyboard.press('Backspace');
  await expect(page.locator(ROWS('right')), 'Backspace で親へ戻れない').toHaveCount(2);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **その場で名前を打ち替える**(#273 段④)。
 * ⚠ 焦点と `select()`、そして「打っている最中に面の鍵へ化けない」ことは
 * 実ブラウザでしか確かめられない(合成 event では焦点の意味論が違う)。
 */
test('🔴 F2 で名前を打ち替えられる (#273)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeFolder(page, 'はこ');
  await openDual(page);

  await page.locator(ROWS('left')).first().click();
  await page.keyboard.press('F2');
  const input = page.locator(`${PANE('left')} [data-pkc-field="dual-rename"]`);
  await expect(input, 'F2 で入力欄が出ていない').toBeVisible();
  // ⚠ 出た時点で**打てる**(全選択されている)── 打ち直すだけで置き換わる
  await page.keyboard.type('あたらしい名前');
  await page.keyboard.press('Enter');
  await expect(input, '確定したのに入力欄が残っている').toHaveCount(0);
  await expect(page.locator(ROWS('left')).first()).toContainText('あたらしい名前');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
