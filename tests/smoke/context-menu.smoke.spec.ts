/**
 * 🔴 **右クリックで、その行にできることが出る**(#426 段①)。
 *
 * ## unit では原理的に届かない 3 つ
 *
 * ① **本物の右クリック**(`button: 'right'`)── 合成 event では
 *    ブラウザ既定を奪えたかが分からない
 * ② **既定を奪っていない場面**(リンクの上)── `preventDefault` の有無は
 *    実ブラウザでしか観測できない
 * ③ **押した物が実際に動くか** ── メニューは `data-pkc-action` を置くだけで、
 *    実行は root の委譲がやる。**その配線が繋がっているか**は実物でしか見えない
 *    (CLAUDE.md §7「A と B が合意していることは、A の test にも B の test にも書けない」)
 */
import { test, expect } from '@playwright/test';
import {
  gotoApp,
  clickReal,
  createEntry,
  collectPageErrors,
  useSplitEditor,
  useListBrowse,
} from './helpers';

/**
 * ⚠ **既定は live**(#104 第 2 弾)── この file は全文 textarea(`editor-body`)を
 * 入力の道具に使うので、設定で split を明示する。⚠ **`gotoApp` の前**に呼ぶ。
 * ⚠ 一覧の面も明示する ── 行(`data-pkc-entry`)を右クリックする spec なので。
 */
test.beforeEach(async ({ page }) => {
  await useListBrowse(page);
  await useSplitEditor(page);
});

const MENU = '[data-pkc-region="context-menu"]';

test('🔴 行を右クリックすると、その行にできることが出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('右クリックの的\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const row = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').first();
  await expect(row, '行が出ていない').toBeVisible();
  await expect(page.locator(MENU), '押す前からメニューが出ている').toHaveCount(0);

  await row.click({ button: 'right' });
  const menu = page.locator(MENU);
  await expect(menu, 'right click でメニューが出ない').toBeVisible();

  // 🔑 **中身が在る**(空の箱を出していない)。⚠ 綴りではなく**押せる口**で数える
  const items = menu.locator('button[data-pkc-action]');
  expect(await items.count(), 'メニューが空').toBeGreaterThanOrEqual(3);
  // ⚠ 名前が出ている(図案だけの箱にしない)
  await expect(menu, '「削除」が出ていない').toContainText('削除');
  await expect(menu, '「履歴」が出ていない').toContainText('履歴');

  // 🔴 **器の中に収まっている**(画面の外へ出ると下の項目に手が届かない)
  const box = await menu.boundingBox();
  expect(box, 'メニューに大きさが無い').not.toBeNull();
  const vp = page.viewportSize();
  expect(box!.x, 'メニューが左へはみ出している').toBeGreaterThanOrEqual(0);
  expect(box!.y, 'メニューが上へはみ出している').toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, 'メニューが右へはみ出している').toBeLessThanOrEqual(vp!.width + 1);
  /**
   * 🔴 **下辺も見る**(#587 C-3 の着地後レビュー)。⚠ 直す前は `x + width` だけを見ており、
   *   **`y + height` を 1 度も見ていなかった** ── 説明欄を足して背が伸びた変更が
   *   そのまま素通りした(CLAUDE.md §1「tripwire は上限だけでなく下限も」の縦版)。
   */
  expect(box!.y + box!.height, 'メニューが下へはみ出している').toBeLessThanOrEqual(
    vp!.height + 1,
  );

  // ⚠ Escape で閉じる
  await page.keyboard.press('Escape');
  await expect(page.locator(MENU), 'Escape で閉じない').toHaveCount(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **メニューの下に、指している項目の説明が出る**(#587 C-3。user 裁定 2026-08-30
 * 「一度推奨で入れて、使用感をテストしたい」)。
 * ⚠ unit では原理的に届かない 2 つ:① 欄が**本当に 2 行の高さ**に収まっているか
 *   (happy-dom は採寸しない)② 実際のマウスの移動で `mouseover` が届くか。
 */
test('🔴 メニューの下に、指している項目の説明が出る(乗せても、キーで選んでも) (#587 C-3)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('説明の的\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const row = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').first();
  await row.click({ button: 'right' });
  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  const hint = menu.locator('[data-pkc-field="context-menu-hint"]');
  await expect(hint, '説明の欄が無い').toBeVisible();

  // 開いた直後は先頭(焦点)の項目の説明
  const items = menu.locator('button[data-pkc-action]');
  const firstHint = (await items.first().getAttribute('data-pkc-hint')) ?? '';
  expect(firstHint, '先頭の項目に説明が無い(前提が崩れている)').not.toBe('');
  await expect(hint).toHaveText(firstHint);

  // 乗せると、その項目の説明に変わる
  const del = menu.locator('button[data-pkc-action="delete-entry"]');
  await del.hover();
  await expect(hint, '乗せた項目の説明に変わらない').toContainText('ゴミ箱');
  // ⚠ tooltip は付けない(1 秒待つと下の項目に重なる箱 ── C-1 の欠点)
  expect(await del.getAttribute('title')).toBeNull();

  // 🔴 2 行に収まっている(3 行目が出て下へ伸びない)
  const fits = await hint.evaluate((el) => {
    const cs = getComputedStyle(el);
    const lines = parseFloat(cs.lineHeight) * 2;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    return { h: el.getBoundingClientRect().height, max: lines + pad + 1 };
  });
  expect(fits.h, `欄が 2 行を超えている(${fits.h}px > ${fits.max}px)`).toBeLessThanOrEqual(fits.max);
  /**
   * 🔴 **下限も見る**(#587 C-3 の着地後レビュー)。⚠ 直す前は `<=` の片側だけだったので、
   *   **縮む方向が素通り**していた ── `height: calc(1.4em * 2)` は `box-sizing: border-box`
   *   のもとで padding 7px と border 1px を食い、内容領域は 1.5 行ぶんしか無かった
   *   (2 行目の下半分が切れる)。🔑 上の `max` の式が**正しい目標高**である。
   */
  expect(fits.h, `欄に 2 行ぶんの高さが無い(${fits.h}px < ${fits.max}px)`).toBeGreaterThanOrEqual(
    fits.max - 2,
  );

  // キーで焦点を移しても変わる(マウスを持たない人にも届く)
  await page.keyboard.press('Tab');
  const secondHint = (await items.nth(1).getAttribute('data-pkc-hint')) ?? '';
  expect(secondHint).not.toBe(firstHint);
  await expect(hint, 'キーで選んだ項目の説明に変わらない').toHaveText(secondHint);

  await page.keyboard.press('Escape');
  await expect(page.locator(MENU)).toHaveCount(0);
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **押した項目が実際に動く**(配線が繋がっている)。
 *
 * ⚠ 観測点は**メニューの外**にする ── メニューが閉じただけでは
 *   「押せた」と言えない(閉じるのは押した副作用ではなく、こちらの後始末である)。
 * 🔑 `履歴` を選ぶと**履歴の面が開く** ── これは root の委譲が
 *   `show-history` を実行しないと起きない。
 */
/**
 * 🔴 **画面の端で開いても、説明の欄まで画面の中に収まる**(#587 C-3 の着地後レビュー)。
 *
 * ⚠ この筋は**一度も通っていなかった** ── 既存の clamp の検査は
 *   **左上の 1 行目**を右クリックするので、`Math.min` の分岐に入らない
 *   (CLAUDE.md §2「経路が一度も通っていない」)。
 * ⚠ unit では原理的に届かない(happy-dom の `getBoundingClientRect` は全部 0)。
 *
 * 🔑 **2 方向を別々に見る** ── 縦は「一覧のいちばん下の行」、横は
 *   「右の情報ペインのボタン」で開く。⚠ 直す前は説明欄を足す**前**に採寸していたので、
 *   横は 192px・縦は約 44px ぶん、画面の外へ出ていた。
 */
test('🔴 画面の下・右で右クリックしても、説明の欄まで画面の中に収まる (#587 C-3)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  /**
   * 🔑 **画面を低くする** ── 既定の 720px では一覧の下端が y≈418 までしか来ず、
   *   メニュー(高さ約 285px)を出しても画面に収まってしまう = **clamp の分岐に入らない**
   *   (実測して分かった。前提の assert が下に在る)。
   */
  await page.setViewportSize({ width: 1280, height: 500 });
  // ⚠ 一覧を画面の下まで届かせる ── 1 件だけだと、行はいつも上端に居る(= 分岐に入らない)
  for (let i = 0; i < 12; i++) {
    await createEntry(page, 'text');
    await page.locator('[data-pkc-field="editor-body"]').fill(`端の的 ${i}\n`);
    await clickReal(page, '[data-pkc-action="commit-edit"]');
  }
  const vp = page.viewportSize()!;

  // ── 縦: 一覧のいちばん下の行
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  const last = rows.last();
  await last.scrollIntoViewIfNeeded();
  const lastBox = (await last.boundingBox())!;
  /**
   * 🔑 **行の下端で押す** ── 押した座標がそのままメニューの出る位置なので、
   *   行のどこを押すかで clamp が要るかどうかが変わる。
   */
  const clickY = lastBox.y + lastBox.height - 2;
  await last.click({ button: 'right', position: { x: 6, y: lastBox.height - 2 } });
  const menu = page.locator(MENU);
  await expect(menu, '右クリックでメニューが出ない').toBeVisible();
  // 🔑 空振り防止 ── 説明の欄が本当に載っていること(載っていなければ縦は伸びない)
  await expect(
    menu.locator('[data-pkc-field="context-menu-hint"]'),
    '説明の欄が出ていない(この検査が見たいものが無い)',
  ).toBeVisible();
  const down = (await menu.boundingBox())!;
  /**
   * ⚠ **前提を assert する**(§1)── 押した所からそのまま出しても収まる位置なら、
   *   この検査は clamp の分岐に**一度も入っていない**(空振り)。
   * 🔑 だから前提は「**押した所 + メニューの高さが画面を超える**」である。
   * ⚠ 「落ちた」ではなく「前提が崩れている」と読める文言にする ── 台が変わったとき、
   *   製品の不具合と読み違えないため。
   */
  expect(
    clickY + down.height,
    `前提が崩れている: この位置なら clamp は要らない(押した y=${clickY} + 高さ ${down.height} <= 画面 ${vp.height})`,
  ).toBeGreaterThan(vp.height);
  expect(
    down.y + down.height,
    `メニューが下へはみ出している(下端 ${down.y + down.height} / 画面 ${vp.height})`,
  ).toBeLessThanOrEqual(vp.height + 1);
  await page.keyboard.press('Escape');
  await expect(page.locator(MENU)).toHaveCount(0);

  // ── 横: 右の情報ペインのボタン(行と同じ `data-pkc-entry` を持つ)
  /**
   * 🔑 **高さは戻す** ── 500px のままだと情報ペインの押し所が右クリックを受けない
   *   (実測)。⚠ 縦と横は**別の主張**なので、それぞれ成り立つ台で見る。
   */
  await page.setViewportSize({ width: 1280, height: 720 });
  const vpWide = page.viewportSize()!;
  const rightSide = page
    .locator('[data-pkc-region="inspector"] [data-pkc-entry]')
    .first();
  await expect(rightSide, '情報ペインに押し所が無い').toBeVisible();
  const rBox = (await rightSide.boundingBox())!;
  expect(
    rBox.x,
    `前提が崩れている: 情報ペインの押し所が画面の右半分に居ない(x=${rBox.x} / 画面 ${vpWide.width})`,
  ).toBeGreaterThan(vpWide.width / 2);

  await rightSide.click({ button: 'right' });
  await expect(menu, '情報ペインの右クリックでメニューが出ない').toBeVisible();
  const side = (await menu.boundingBox())!;
  /**
   * ⚠ **前提を assert する** ── 押した所からそのまま出しても収まる幅なら空振りである。
   */
  expect(
    rBox.x + side.width,
    `前提が崩れている: この位置なら clamp は要らない(押した x=${rBox.x} + 幅 ${side.width} <= 画面 ${vpWide.width})`,
  ).toBeGreaterThan(vpWide.width);
  expect(
    side.x + side.width,
    `メニューが右へはみ出している(右端 ${side.x + side.width} / 画面 ${vpWide.width})`,
  ).toBeLessThanOrEqual(vpWide.width + 1);
  await page.keyboard.press('Escape');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 メニューの項目を押すと、その操作が実際に走る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('履歴を見る的\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const row = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').first();
  await row.click({ button: 'right' });
  await expect(page.locator(MENU)).toBeVisible();

  await page.locator(`${MENU} button[data-pkc-action="show-history"]`).click();
  // ⚠ **メニューの外**で確かめる
  await expect(
    page.locator('[data-pkc-field="history-panel"]'),
    '「履歴」を押しても履歴の面が開かない(配線が繋がっていない)',
  ).toBeVisible();
  await expect(page.locator(MENU), '押した後もメニューが残っている').toHaveCount(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **ブラウザ既定を奪う場面を最小にする**(CLAUDE.md §10)。
 *
 * ⚠ 本文のリンクの上で既定を消すと、「リンクをコピー」が**代わりも無いまま消える**。
 * 🔑 だから**そこでは自前のメニューを出さない**(= 既定が出る)。
 *
 * ⚠ **この test が守っているのは「結果」であって、特定の門ではない**
 *   (2026-08-27、変異試験 N2)── 段① では
 *   **行の判定(`[data-pkc-entry]` の外なら返す)がどのみち先に返す**ので、
 *   リンクの除外を消してもこの test は落ちない。
 * 🔑 **それでよい** ── 見たいのは「リンクの上でメニューが出ないこと」であって、
 *   どの行が止めたかではない。⚠ 段② で本文の上でも受けるようになったら、
 *   **この test は自動的に除外の門を見るようになる**(結果で書いてあるため)。
 */
test('🔴 本文のリンクの上では、自前のメニューを出さない(既定を残す)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('[そと](https://example.com/x) を置く\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const link = page.locator('[data-pkc-region="detail"] a[href^="https://"]').first();
  await expect(link, '前提: 本文にリンクが出ていない').toBeVisible();
  await link.click({ button: 'right' });
  // ⚠ 既定を奪っていない = 自前のメニューは出ない
  await expect(
    page.locator(MENU),
    'リンクの上で自前のメニューを出している(「リンクをコピー」が消える)',
  ).toHaveCount(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **編集中は出さない ── 出すと「別のノート」に効く**。
 *
 * ⚠ `delete-entry` などは「押した行」ではなく**選んでいるノート**に効く。
 * 編集中は行の選択が断られる(`selectEntryOrExplain`)ので、そこでメニューを出すと
 * **さっきまで選んでいた別のノートに効く**メニューになる ── 静かに間違った物を消す。
 * 🔑 だから**選べなかったら出さない**。⚠ 理由は画面に出ている(黙って何も起きない、にしない)。
 */
test('🔴 編集中に行を右クリックしても出ない ── 理由は画面に出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('1 件目\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('2 件目\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-action="start-edit"]');
  /**
   * 🔴 **編集に入り切るのを待つ**(2026-08-27。フル走で 2 回再現した)。
   *
   * ⚠ `clickReal` は**押すだけ**で、面の入れ替えは非同期である。待たずに次の
   *   右クリックへ進むと、**まだ編集中でない**ので**メニューは正しく出る** ──
   *   落ちるのは製品ではなく、この test が**前提を確かめていない**からである。
   * ⚠ 直下の `status.isVisible()` は**待たない一読**なので、前提の代わりにならない
   *   (編集に入っていても入っていなくても false で通る)。
   */
  await expect(
    page.locator('[data-pkc-field="editor-body"]'),
    '編集に入っていない(前提が崩れた)',
  ).toBeVisible();
  const status = page.locator('[data-pkc-region="status"]');
  expect(await status.isVisible(), '前提: 編集に入った時点で既に理由が出ている').toBe(false);

  await page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').last().click({
    button: 'right',
  });
  // 🔴 出ない
  await expect(
    page.locator(MENU),
    '編集中なのにメニューが出た(選べていないので別のノートに効く)',
  ).toHaveCount(0);
  // ⚠ **黙っていない**
  await expect(status, '断ったのに理由が出ていない').toBeVisible();
  await expect(status).toContainText('編集');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **右ペインが唯一の入口だった 3 つに、2 本目の道ができた**(#500)。
 *
 * ## なぜ足したか(実測。既定の窓 1280×720・実ブラウザ)
 *
 * | ノート | 右ペインをスクロールしないと見えない量 | PDF は押せるか |
 * |---|---|---|
 * | 空に近い(既存 smoke の fixture) | 0px | ✅ |
 * | 見出し **10** | **100px** | 🔴 **押せない** |
 * | 見出し **20** + タグ | **360px** | 🔴 **押せない** |
 *
 * 境目は**見出し 5〜10 の間**。さらに右ペインは**畳める**(#497)ので、
 * 畳んだ user からは**画面ごと消える**。だから見出し 10 本のノートで組む。
 *
 * ## ⚠ 「右ペインの帯が届かないこと」は assert しない
 *
 * それは**いま直したい欠陥**であって、**守りたい性質ではない** ── #501 で
 * 帯を整理して届くようになったら、この test は**良い変更で赤くなる**。
 * 🔑 だから測った値は上の表に残し、assert するのは
 * **「右クリックから刷れる」という、直った後も成り立つ側**にする。
 *
 * ## 🔴 unit では原理的に届かない ── **lid の解決が 2 か所の合意**だから(§7)
 *
 * メニューは **`root` に生える**(行の中ではない)ので、`export-entry-pdf` の
 * `target.closest('[data-pkc-entry]')` は **必ず null** ── 実際に効いているのは
 * **`selectedLid` への fallback** であり、その `selectedLid` を入れているのは
 * **右クリックの側**(`selectEntryOrExplain`)である。
 * ⚠ どちらの unit もこの合意を見ていない(片方は menu の中身、片方は binder の分岐)。
 * 🔑 だから **別のノートを選んだ状態から**右クリックする ── そうしないと
 * 「作った直後で B が選ばれている」に救われて、**何も確かめていない**test になる。
 */
test('🔴 右ペインが届かないノートでも、右クリックから紙に出せる (#500)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ① 先に別のノートを作る(= 対照群。これが選ばれている状態から始める)
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('# あちらのノート\n\nこちらを刷ってはいけない。\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ② 刷りたいノート ── 実測の境目を越える見出し 10 本
  const heads = Array.from({ length: 10 }, (_, i) => `## 見出し ${i + 1}\n\n段落 ${i + 1}。\n`).join('\n');
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(`# 刷りたいノート\n\n${heads}`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows, '前提: 行が 2 つ出ていない').toHaveCount(2);

  /**
   * 🔴 **対照群へ寄せる** ── 「あちらのノート」を選んでおく。
   * ⚠ ここを省くと、直前に作った「刷りたいノート」が選ばれたままなので、
   *   **右クリックが選び直していなくても通ってしまう**。
   */
  // ⚠ 行に出るのは**題名**(`ノート 1` / `ノート 2`)で、本文の見出しではない ──
  //    だから行は**作った順**で採り、開いたことは**本文の中身**で確かめる
  await rows.first().click();
  await expect(
    page.locator('[data-pkc-field="detail-body"]'),
    '前提: 対照群が開いていない',
  ).toContainText('あちらのノート');

  // 印刷が**始まった**ことを採る(押した瞬間ではない。§5 ── 2 つのビルドで成り立つ唯一の点)
  await page.evaluate(() => {
    (globalThis as unknown as Record<string, unknown>).__printed = 0;
    window.addEventListener('beforeprint', () => {
      (globalThis as unknown as Record<string, unknown>).__printed =
        ((globalThis as unknown as Record<string, number>).__printed ?? 0) + 1;
    });
  });

  // ③ **刷りたいほう**を右クリック
  await rows.last().click({ button: 'right' });
  const menu = page.locator(MENU);
  await expect(menu, '右クリックでメニューが出ない').toBeVisible();

  const pdf = menu.locator('button[data-pkc-action="export-entry-pdf"]');
  await expect(pdf, '右クリックに「PDF」が無い(右ペインを畳むと届かない)').toBeVisible();
  // ⚠ 3 つとも出ている(1 つだけ足して満足しない)
  await expect(menu.locator('button[data-pkc-action="export-entry-docx"]')).toHaveCount(1);
  await expect(menu.locator('button[data-pkc-action="export-entry-pptx"]')).toHaveCount(1);

  await pdf.click();

  // ④ **メニューの外**で確かめる ── 印刷が始まり、しかも**刷ったのは押した行**
  await expect
    .poll(async () => page.evaluate(() => (globalThis as unknown as Record<string, number>).__printed))
    .toBeGreaterThan(0);
  await expect(
    page.locator('[data-pkc-field="detail-body"]'),
    '押した行ではなく、選んでいたほうを刷っている(lid の解決が合意していない)',
  ).toContainText('刷りたいノート');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **本文の上で右クリックすると、段組みを切り替えられる**(#426 段② / #522)。
 *
 * user 指示 2026-08-28(#522):
 *
 * > **段組表示を表示変更導線をセンターペインもしくはショートカット、
 * > コンテキストメニューに用意したいくらいには気に入った**
 *
 * ## unit では原理的に届かない 2 つ
 *
 * ① **本物の右クリック**(`button: 'right'`)── 本文の上でブラウザ既定を
 *    奪えたかは、実ブラウザでしか見えない
 * ② 🔴 **段組みが本当に効くか** ── `cycleReadColumns` は**器を採寸**して
 *    「いま何段で出ているか」を決める。happy-dom には版面の幅が無いので、
 *    unit は**属性が動いたことしか見られない**
 */
test('🔴 本文を右クリックすると段組みを切り替えられる (#426 段② / #522)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  const body = Array.from({ length: 30 }, (_, i) => `段落 ${i + 1}。これは段組みを見るための本文です。`).join('\n\n');
  await page.locator('[data-pkc-field="editor-body"]').fill(`# 段組みの的\n\n${body}\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();

  const before = await page.evaluate(() =>
    document.documentElement.getAttribute('data-pkc-read-columns'),
  );

  // ① 本文の**段落の上**で右クリック(⚠ リンクや図の上ではない)
  await page.locator('[data-pkc-field="detail-body"] p').first().click({ button: 'right' });
  const menu = page.locator(MENU);
  await expect(menu, '本文で右クリックしてもメニューが出ない').toBeVisible();
  const cycle = menu.locator('button[data-pkc-action="cycle-read-columns"]');
  await expect(cycle, '段組みの切替が出ていない').toBeVisible();
  // ⚠ 行の一覧が出ていない(押した物と効く先が食い違わない)
  await expect(
    menu.locator('button[data-pkc-action="delete-entry"]'),
    '本文のメニューに削除が出ている',
  ).toHaveCount(0);

  await cycle.click();

  // ② **メニューの外**で確かめる ── 段数が動き、画面の下に何段か出る
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.getAttribute('data-pkc-read-columns')),
    )
    .not.toBe(before);
  await expect(page.locator('[data-pkc-region="status"]'), '何段になったか出ていない').toContainText(
    '段組み',
  );
  await expect(page.locator(MENU), '押した後もメニューが残っている').toHaveCount(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **見出しを右クリックすると、その章にできることが出る**(#426 段② の残り)。
 *
 * ## unit では原理的に届かない所
 *
 * この動線の肝は「**メニューの器は root の直下に出るので、押したボタンは
 * 押した物の中に居ない**」ことである ── unit の合成 DOM でも再現はできるが、
 * ⚠ **本物の右クリックで、本物の描画が焼いた刻印**(`data-pkc-source-line`)から
 * 行が引けるかは、実物でしか見えない(fixture の刻印は手で書いた物である)。
 * 🔑 だから見るのは**畳んだ結果、配下が実際に画面から消えるか**である。
 */
test('🔴 見出しを右クリックすると、その章を畳める (#426 段②)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('## 第 1 章\n\nこの段落は第 1 章の中身です。\n\n## 第 2 章\n\n第 2 章の中身。\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();

  const inSection = page.locator('[data-pkc-field="detail-body"] p').first();
  await expect(inSection, '章の中身が出ていない').toBeVisible();

  // ① 見出しの上で右クリック
  await page.locator('[data-pkc-field="detail-body"] h2').first().click({ button: 'right' });
  const menu = page.locator(MENU);
  await expect(menu, '見出しで右クリックしてもメニューが出ない').toBeVisible();
  await expect(menu, '「ここから編集する」が出ていない').toContainText('ここから編集する');
  await expect(menu, '「ここに追記する」が出ていない').toContainText('ここに追記する');
  /**
   * 🔴 **本文の物も残っている**(差し替えていない)── ここが落ちると、
   * 見出しの上でだけ #522 の段組み切替が使えなくなる。
   */
  await expect(
    menu.locator('button[data-pkc-action="cycle-read-columns"]'),
    '見出しの上で段組みの切替が消えている',
  ).toBeVisible();

  // ② 畳む ── ⚠ **運べているか**の本命(押したボタンは見出しの中に居ない)
  await menu.locator('button[data-pkc-action="toggle-heading-fold"]').click();
  await expect(inSection, 'メニューから押しても章が畳まれない').toBeHidden();
  await expect(page.locator(MENU), '押した後もメニューが残っている').toHaveCount(0);

  // ③ もう一度出す(片道の操作にしない)
  await page.locator('[data-pkc-field="detail-body"] h2').first().click({ button: 'right' });
  await expect(menu, '畳んでいるのに「畳む」と書いてある').toContainText('中身を出す');
  await menu.locator('button[data-pkc-action="toggle-heading-fold"]').click();
  await expect(inSection, '畳んだものを出せない').toBeVisible();

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **見出しを右クリックして「この章をコピー」を押すと、章の原文が clipboard に入る**(#677)。
 *
 * ⚠ unit では原理的に届かない 2 つ:① **本物の `navigator.clipboard`** に届くか
 *   (happy-dom は差し替え物)② 押した物が **root の委譲**を通って実際に動くか
 *   (メニューは `data-pkc-action` を置くだけ ── 配線は実物でしか見えない)。
 * 🔑 観測点は**アプリ自身の合図**(状態の行の文言)+ **clipboard の中身**の 2 つ ──
 *   後者だけだと「1 つ前の内容」を読む濡れ衣が起きる(`copy-body.smoke.spec.ts` の注記)。
 * ⚠ **章末が `:::` の囲み**である本文にする ── 閉じの `:::` まで入ることが、この機能の
 *   当の主張(`:::` の刻印は開き行にしか無いので、終端の取り方を誤ると閉じが落ちる)。
 */
test('🔴 見出しを右クリックして「この章をコピー」を押すと、章の原文が閉じの ::: まで入る (#677)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('## 第 1 章\n\n:::note\n囲みの中\n:::\n\n## 第 2 章\n\n第 2 章の中身。\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const h2 = page.locator('[data-pkc-field="detail-body"] h2').first();
  await expect(h2, '本文が出ていない').toContainText('第 1 章');

  await h2.click({ button: 'right' });
  const menu = page.locator(MENU);
  await expect(menu, '見出しで右クリックしてもメニューが出ない').toBeVisible();
  await menu.locator('button[data-pkc-action="copy-chapter-md"]').click();
  // ① アプリ自身の合図(状態の行)── メニューは押した瞬間に畳まれるので、光る合図は使えない
  await expect(page.locator('[data-pkc-region="status"]'), '写した合図が出ない').toContainText(
    '章をコピーしました',
  );
  await expect(page.locator(MENU), '押した後もメニューが残っている').toHaveCount(0);
  // ② clipboard の中身 ── 見出しから次の見出しの直前まで、閉じの ::: を含めて原文のまま
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text, '章の原文が丸ごと入っていない(閉じの ::: まで)').toBe(
    '## 第 1 章\n\n:::note\n囲みの中\n:::\n',
  );

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
