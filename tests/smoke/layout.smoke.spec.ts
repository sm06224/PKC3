import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, clickMenuItem } from './helpers';

/**
 * P7b 段⑨: **枠が組めている**(設計 doc §1-4)。
 *
 * 🔴 「CSS が読み込まれた」で止めない ── 読み込まれていてもレイアウトが崩れて
 * いれば同じことである。ここが見るのは**位置関係**:
 * サイドバーと本文が横に並ぶ / かんばんの列が横に並ぶ / 面が重なっていない。
 *
 * ⚠ 段⑨ 以前の実際の姿は「サイドバーが本文の**上に**縦に流れ、かんばんの列が
 * **縦に積まれる**」だった ── どちらもこの spec が落とす形である。
 */
test('🔴 枠が組めている(2 ペイン / 列 / 重なりなし)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  // ① サイドバーと本文が**横に並ぶ**(縦に流れていない)
  const sidebar = await page.locator('[data-pkc-region="sidebar"]').boundingBox();
  const detail = await page.locator('[data-pkc-region="detail"]').boundingBox();
  expect(sidebar, 'サイドバーが画面に無い').not.toBeNull();
  expect(detail, '本文が画面に無い').not.toBeNull();
  expect(sidebar!.width).toBeGreaterThan(0);
  expect(sidebar!.height).toBeGreaterThan(0);
  // 右端が本文の左端を越えない = 重なっていない
  expect(sidebar!.x + sidebar!.width).toBeLessThanOrEqual(detail!.x + 1);

  // ② status は**いちばん下**にあり、本文と重なっていない
  const status = await page.locator('[data-pkc-region="status"]').boundingBox();
  expect(status).not.toBeNull();
  expect(status!.y).toBeGreaterThanOrEqual(detail!.y + detail!.height - 1);

  // ③ 面(更新の案内 / 注意)は**既定で場所を取らない**
  //    ⚠ `hidden` が grid item に効かないと、空の箱が行を占めて本文が縮む
  expect(await page.locator('[data-pkc-region="update"]').isVisible()).toBe(false);
  expect(await page.locator('[data-pkc-region="notices"]').isVisible()).toBe(false);

  // ③' 🔴 面が**2 つ同時に出ても重ならない**。
  //    ⚠ ③ は「既定で出ない」しか見ておらず、**両方に同じ grid area を割り当てる
  //    変異が生き残った**(実際に一度そう書いた)── 重なりは「両方出たとき」に
  //    しか観測できない。自然に両方出す(取込の注意 + 待機中の SW)のは高くつくので、
  //    ここでは**強制的に出して位置関係だけ**を見る
  await page.evaluate(() => {
    for (const name of ['update', 'notices']) {
      const el = document.querySelector<HTMLElement>(`[data-pkc-region="${name}"]`);
      if (!el) continue;
      el.hidden = false;
      el.textContent = 'x';
    }
  });
  const upd = (await page.locator('[data-pkc-region="update"]').boundingBox())!;
  const noti = (await page.locator('[data-pkc-region="notices"]').boundingBox())!;
  expect(upd.height).toBeGreaterThan(0);
  expect(noti.height).toBeGreaterThan(0);
  expect(upd.y + upd.height, '更新の案内と注意の面が重なっている').toBeLessThanOrEqual(
    noti.y + 1,
  );
  await page.reload();
  await expect(page.locator('[data-pkc-slot="root"][data-pkc-boot="ready"]')).toBeAttached();

  // ④ サイドバーの行が**覆われていない**(実際にその点に居るのが自分の子孫か)
  await clickReal(page, '[data-pkc-action="create-entry"][data-pkc-archetype="text"]');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const row = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').first();
  const box = await row.boundingBox();
  expect(box, '一覧の行が画面に無い').not.toBeNull();
  const covered = await page.evaluate(
    ({ x, y }) => {
      const at = document.elementFromPoint(x, y);
      const row2 = document.querySelector('[data-pkc-region="entry-list"] [data-pkc-entry]');
      return !(at && row2 && (row2 === at || row2.contains(at)));
    },
    { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
  );
  expect(covered, '一覧の行が何かに覆われている').toBe(false);

  // ⑤ かんばんの列が**横に並ぶ**(縦に積まれていない)
  await clickReal(page, '[data-pkc-action="create-entry"][data-pkc-archetype="todo"]');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="kanban"]');
  const cols = page.locator('[data-pkc-region="kanban-column"]');
  await expect(cols).toHaveCount(2);
  const a = (await cols.nth(0).boundingBox())!;
  const b = (await cols.nth(1).boundingBox())!;
  expect(a.height).toBeGreaterThan(0);
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + 1);

  // ⑥ 表に**罫線がある**(段⑨ 以前は「a b / 1 2」に見えていた)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="calendar"]');
  const border = await page
    .locator('[data-pkc-region="calendar-grid"] td')
    .first()
    .evaluate((el) => getComputedStyle(el).borderTopWidth);
  expect(parseFloat(border), 'カレンダーの枠線が無い').toBeGreaterThan(0);
});

test('🔴 狭い画面では 1 カラムへ折る(横に潰れない)', async ({ page }) => {
  // ⚠ 折らないと、サイドバーの最小幅 180px が本文を圧迫して読めなくなる
  await page.setViewportSize({ width: 480, height: 800 });
  await gotoApp(page);
  const sidebar = (await page.locator('[data-pkc-region="sidebar"]').boundingBox())!;
  const detail = (await page.locator('[data-pkc-region="detail"]').boundingBox())!;
  // 縦に積まれる = サイドバーの下端が本文の上端以下
  expect(sidebar.y + sidebar.height).toBeLessThanOrEqual(detail.y + 1);
  // 本文が画面幅いっぱいを使う
  expect(detail.width).toBeGreaterThan(400);
});

/**
 * P7b 段⑨b: **役割メニュー**(user 指示 2026-08-03)。
 *
 * ⚠ 開閉は `<details>` の既定に任せているので、ここが見るのは
 * 「**閉じ方**」と「**畳んでも押せる**」ことである ── 素の `<details>` は
 * 外側を押しても Escape でも閉じず、開きっぱなしのパネルが本文を覆う。
 */
test('🔴 役割メニュー ── 開く / 押せる / 閉じる', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  const outMenu = page.locator('details[data-pkc-menu="書き出す"]');
  const outItems = outMenu.locator('[data-pkc-menu-items]');
  const impMenu = page.locator('details[data-pkc-menu="取り込む"]');

  // ① 既定では**中身が見えない**(畳まれている)
  await expect(outItems).toBeHidden();
  // ⚠ ビューは畳まない(常時使う主軸)
  await expect(page.locator('[data-pkc-action="set-view"]').first()).toBeVisible();

  // ② 開くと中身が出る
  await clickReal(page, 'details[data-pkc-menu="書き出す"] > summary');
  await expect(outItems).toBeVisible();
  await expect(outMenu.locator('[data-pkc-action="export-archive"]')).toBeVisible();

  // ③ 🔴 **本文を押し下げない**(inline に開くと画面が跳ねる)
  const detailBefore = (await page.locator('[data-pkc-region="detail"]').boundingBox())!;
  await clickReal(page, 'details[data-pkc-menu="整理"] > summary');
  const detailAfter = (await page.locator('[data-pkc-region="detail"]').boundingBox())!;
  expect(detailAfter.y, 'メニューを開いたら本文が下がった').toBe(detailBefore.y);

  // ④ 🔴 **排他** ── 別のメニューを開くと前のは閉じる
  await expect(outItems).toBeHidden();

  // ⑤ 🔴 **外側を押すと閉じる**(素の details は閉じない)
  await expect(page.locator('details[data-pkc-menu="整理"] [data-pkc-menu-items]')).toBeVisible();
  await page.mouse.click(900, 600);
  await expect(
    page.locator('details[data-pkc-menu="整理"] [data-pkc-menu-items]'),
  ).toBeHidden();

  // ⑥ 🔴 **Escape で閉じる**
  await clickReal(page, 'details[data-pkc-menu="書き出す"] > summary');
  await expect(outItems).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(outItems).toBeHidden();

  // ⑦ 🔴 **項目を押したら閉じる** ── 開いたままだと、押した結果(注意の面など)を
  //    メニューが覆って「押したのに何も起きていない」ように見える
  await clickMenuItem(page, '[data-pkc-action="import-file"]');
  await expect(impMenu.locator('[data-pkc-menu-items]')).toBeHidden();

  // ⑧ 🔴 押した項目が**実際に働く**。⚠ 「閉じた」だけを見ていると、
  //    `pointerdown` で閉じて **`click` が届かない**実装が素通りする
  //    (メニューは畳まれるのに何も起きない ── 変異試験で実際に生き残った)。
  //    観測点は「確認ダイアログが出たか」= ハンドラに届いた証拠
  let asked: string | null = null;
  page.once('dialog', (d) => {
    asked = d.message();
    void d.dismiss();
  });
  await clickMenuItem(page, '[data-pkc-action="purge-orphan-assets"]');
  await expect.poll(() => asked, { timeout: 5_000 }).not.toBeNull();
  expect(asked!).toContain('添付');
});
