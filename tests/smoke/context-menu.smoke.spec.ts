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

  // ⚠ Escape で閉じる
  await page.keyboard.press('Escape');
  await expect(page.locator(MENU), 'Escape で閉じない').toHaveCount(0);

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
