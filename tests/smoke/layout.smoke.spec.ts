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
  await clickMenuItem(page, '[data-pkc-action="create-entry"][data-pkc-archetype="text"]');
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
  await clickMenuItem(page, '[data-pkc-action="create-entry"][data-pkc-archetype="todo"]');
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

/**
 * P7b 段⑨c: **導線の再考**(user 指示 2026-08-03
 * 「PKC2 の導線設計も再考する形で実装してください」)。
 *
 * 🔴 PKC3 には**検索・絞り込みの導線が 1 つも無かった** ── ノートが増えたときに
 * 真っ先に要るのは「作る」ではなく「探す」である。サイドバーの先頭をそこに充てた。
 */
test('🔴 一覧を絞り込める(探す導線)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  for (const name of ['りんご', 'みかん', 'りんごジャム']) {
    await clickMenuItem(page, '[data-pkc-action="create-entry"][data-pkc-archetype="text"]');
    await page.locator('[data-pkc-field="editor-title"]').fill(name);
    await clickReal(page, '[data-pkc-action="commit-edit"]');
  }
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows).toHaveCount(3);

  // 絞り込むと**行が減る**(隠すのではなく外す)
  const box = page.locator('[data-pkc-field="entry-filter"]');
  await expect(box).toBeVisible();
  await box.fill('りんご');
  await expect(rows).toHaveCount(2);
  await box.fill('みかん');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('みかん');

  // ⚠ **大文字小文字を問わない**(題名は日本語だけではない)
  await box.fill('');
  await clickMenuItem(page, '[data-pkc-action="create-entry"][data-pkc-archetype="text"]');
  await page.locator('[data-pkc-field="editor-title"]').fill('Apple Pie');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await box.fill('apple');
  await expect(rows).toHaveCount(1);

  // 消せば全部戻る(絞り込みは**捨てていない**)
  await box.fill('');
  await expect(rows).toHaveCount(4);
});

/**
 * P7b review M-4: 絞り込みの**戻り**で行を作り直さない。
 *
 * 🔴 15,000 件で実測すると、絞り込みを消すたびに 0.2〜0.75 秒メインスレッドが
 * 止まっていた ── 外した行を捨てて `createRow` からやり直していたためで、
 * CLAUDE.md が PKC2 の体感悪化の主因として名指しした
 * 「5000 行のサイドバーを作り直す」と同型である。
 * ⚠ 「速くなった」は結果に出ないので、**同じノードが戻ってくるか**で見る
 * (作り直す実装ではここが落ちる)。
 */
test('🔴 絞り込みを戻したとき、行は作り直されない', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  for (const name of ['りんご', 'みかん']) {
    await clickMenuItem(page, '[data-pkc-action="create-entry"][data-pkc-archetype="text"]');
    await page.locator('[data-pkc-field="editor-title"]').fill(name);
    await clickReal(page, '[data-pkc-action="commit-edit"]');
  }
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows).toHaveCount(2);

  // 印を付ける ── 同じ DOM ノードが戻れば印も残る
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(
      '[data-pkc-region="entry-list"] [data-pkc-entry]',
    ))
      (el as HTMLElement).dataset.probe = 'kept';
  });
  const box = page.locator('[data-pkc-field="entry-filter"]');
  await box.fill('りんご');
  await expect(rows).toHaveCount(1);
  await box.fill('');
  await expect(rows).toHaveCount(2);
  const kept = await page.evaluate(
    () =>
      document.querySelectorAll(
        '[data-pkc-region="entry-list"] [data-pkc-entry][data-probe="kept"]',
      ).length,
  );
  expect(kept).toBe(2);
});

/**
 * P7b review L-2: archetype の印は**一覧の行にだけ**出す。
 * ⚠ スコープが無かったので、同じ属性を持つ「新規」メニューのボタンにも出て
 * 「文 +ノート」と表示されていた(実測)。
 */
test('🔴 archetype の印がメニューのボタンに漏れない', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await clickMenuItem(page, '[data-pkc-action="create-entry"][data-pkc-archetype="text"]');
  await page.locator('[data-pkc-field="editor-title"]').fill('印の確認');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const markOf = (sel: string): Promise<string> =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return 'MISSING';
      return getComputedStyle(el, '::before').content;
    }, sel);

  // メニューのボタンには出ない
  await clickReal(page, '[data-pkc-menu="新規"] > [data-pkc-field="menu-label"]');
  const onButton = await markOf(
    '[data-pkc-menu-items] [data-pkc-action="create-entry"][data-pkc-archetype="text"]',
  );
  expect(onButton === 'none' || onButton === '""' || onButton === 'normal').toBe(true);

  // ⚠ 空振り防止 ── 一覧の行には**出ている**(規則ごと消して通す、を落とす)
  const onRow = await markOf('[data-pkc-region="entry-list"] [data-pkc-entry]');
  expect(onRow).toContain('文');
});

/**
 * P7b 段⑨c: 配色(user 指示 2026-08-03「最初はライトとダークのみに」)。
 * ⚠ 「属性が付いた」で止めない ── **実際に色が変わる**ところまで見る。
 */
test('🔴 配色をライト / ダークで切り替えられる', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  const bg = (): Promise<string> =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await clickMenuItem(page, '[data-pkc-action="set-theme"][data-pkc-theme-value="light"]');
  await expect(page.locator('html[data-pkc-theme="light"]')).toBeAttached();
  const light = await bg();

  await clickMenuItem(page, '[data-pkc-action="set-theme"][data-pkc-theme-value="dark"]');
  await expect(page.locator('html[data-pkc-theme="dark"]')).toBeAttached();
  const dark = await bg();

  // 🔴 **実際に色が違う**(属性だけ付けて CSS が無い、を落とす)
  expect(light).not.toBe(dark);
  // 明るさの向き ── ライトのほうが明るい
  const lum = (c: string): number => {
    const [r, g, b] = (c.match(/\d+/g) ?? ['0', '0', '0']).map(Number) as [
      number,
      number,
      number,
    ];
    return r + g + b;
  };
  expect(lum(light), 'ライトのほうが暗い').toBeGreaterThan(lum(dark));

  // ⚠ **選んだ配色が再読込をまたぐ**(毎回選び直させない)
  await page.reload();
  await expect(page.locator('html[data-pkc-theme="dark"]')).toBeAttached();
});
