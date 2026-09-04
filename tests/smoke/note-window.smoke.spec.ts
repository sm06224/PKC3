import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, dismissAnnounce, gotoApp } from './helpers';

/**
 * 🔴 **このノートを別の窓で開く ── 付箋**(#685 段②、user 裁定 2026-09-04)。
 *
 * > 「**スマホ用の幅狭画面はPCでも活躍してます!/ 画面の隅に表示したメモ追記を
 * > 使ってどんどんスクラップできてます / 付箋的に使えるのもいいですね /
 * > マルチで付箋開けるといいかもね**」(利用者の感想 2026-09-04)
 *
 * ## ⚠ ここでしか測れないもの
 *
 * unit が持つのは「**どんな URL を組むか**」まで(`view-window.test.ts` /
 * `permalink-view.test.ts`)。🔑 ここが持つのは **その URL で開いた窓が、
 * 本当にそのノートを開いて立ち上がるか**である ── 段① と段② は
 * **別々に緑でも、繋がっていなければ意味が無い**(CLAUDE.md §7
 * 「両端が相手を模した stub と話していると、綴りの食い違いが両方緑のまま通る」)。
 */
test('🔴 別の窓で開くと、その窓がそのノートを開いて立ち上がる (#685)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);

  // ⚠ **2 件作る** ── 1 件だと「たまたま先頭が開いた」と区別が付かない
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('ひとつめ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('ふたつめ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // 🔑 いま開いているのは「ふたつめ」── これが連れて行かれる相手である
  await expect(
    page.locator('[data-pkc-region="inspector"]'),
    '前提が崩れた(ふたつめを開いていない)',
  ).toContainText('ふたつめ');

  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  const win = await popup;
  const winErrors = collectPageErrors(win);
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });

  /**
   * ⓪ 🔴 **開くのは「面」ではなく、そのノート**(着地前レビュー M1)。
   * ⚠ 直す前は、`openViewInWindow(null, …)` の `null` を面の名前に変える変異が
   *   **生き延びた** ── 下の①は `inspector` を見ており、`inspector.render` は
   *   `viewMode` に関係なく毎回走るので、2 ペインで立ち上がっても題名は当たる。
   *   その変異が入ると付箋の中央に 2 ペインが出て、**本文が消える**
   *   (= この機能が存在する理由そのものが壊れる)。
   */
  await expect(
    win.locator('[data-pkc-view-pane="detail"]'),
    '付箋が面で立ち上がっている(本文が出ていない)',
  ).toBeVisible({ timeout: 20_000 });
  expect(win.url(), '面を指す断片で開いている(付箋ではない)').not.toContain('view=');

  /**
   * ⓪-2 🔴 **最初から細い窓で出る**(user 裁定 2026-09-04)。
   * ⚠ 直す前は大きさを 1 つも渡していなかったので、押すと「もう 1 個の PKC」
   *   (3 列)が既定の大きさで出ていた ── 付箋にするには
   *   「窓の端を掴んで 720px より細くする」という**教わらないと分からない一手**が要った。
   * 🔑 **原文 pin ではなく実測で見る**(2026-09-04)── headless でも
   *   `window.open` の寸法は効く(実測 420x720)。原文だけを見ていた 1 稿目は、
   *   付箋を面の窓の口で開く変異を**素通りさせた**。
   */
  const outer = await win.evaluate(() => ({ w: window.outerWidth, h: window.outerHeight }));
  expect(outer.w, `細い窓で出ていない(${outer.w}px)── 開いた瞬間に 3 列が出る`).toBeLessThanOrEqual(720);
  // ⚠ **1 枚ずつの画面になっていること**まで見る(幅だけだと器の規則が壊れても緑)
  await expect(
    win.locator('[data-pkc-region="shell"][data-pkc-layout="phone"]'),
    '細い窓なのに 1 枚ずつの画面になっていない',
  ).toBeAttached();

  /**
   * ① 🔴 **開いた窓が、そのノートを開いている**(段① と段② が繋がっている)。
   * ⚠ **題名で見る** ── 「何か開いた」では、先頭のノートが開いただけでも真になる。
   */
  await expect(
    win.locator('[data-pkc-region="inspector"]'),
    '別の窓が、連れて行ったノートを開いていない',
  ).toContainText('ふたつめ', { timeout: 20_000 });

  /**
   * ② 🔴 **元の窓は動かない**(user 要望の本体 ── 付箋は本文を退かさない)。
   */
  await expect(
    page.locator('[data-pkc-region="inspector"]'),
    '元の窓のノートが入れ替わった',
  ).toContainText('ふたつめ');

  /**
   * ③ 🔴 **何枚でも開ける**(「マルチで付箋」)── 窓を使い回さない。
   */
  /**
   * ③ 🔴 **窓の題名にノートの題名が入る**(着地前レビュー ⚠3 / 動線レビュー 欠陥 1)。
   * ⚠ **タスクバーで見分けるため**である ── 直す前は何枚開いても全部「PKC3」で、
   *   「何枚でも開けます」が売りの機能なのに、並べた瞬間に見分けられなかった。
   */
  await expect
    .poll(() => win.title(), { timeout: 15_000 })
    .toBe('ふたつめ — PKC3');

  /**
   * ④ 🔴 **付箋に follower の帯を出さない**(着地前レビュー 🔴1 / 動線レビュー 欠陥 4)。
   * ⚠ 状態の行は **1 行**なので、常設の帯が「別の窓の変更と重なりました…」のような
   *   **本当に読ませたい文を横へ押し出す**(#300 段④ が消した理由がそのまま当てはまる)。
   * 🔑 対照群は `app-window-status.smoke.spec.ts` が持っている
   *   ── あちらが「ふつうの 2 枚目のタブでは出る」を先に見ている。
   */
  await expect(
    win.locator('[data-pkc-region="status"]'),
    '付箋に常設バッジが出ている(読ませたい文を押し出す)',
  ).not.toContainText('複数タブ: このタブの保存は本体タブ経由です');

  /**
   * ⑤ 🔴 **同じノートの 2 枚目は作らない**(user 裁定 2026-09-04)。
   * ⚠ データは安全だが、同じものが 2 枚並ぶと「操作をしくじった」と読まれる。
   * 🔑 観測点は **窓が増えないこと + 理由が出ること**の 2 つ ── 片方だけだと、
   *   「黙って何もしない」実装でも緑になる(無言の dead click)。
   */
  const pagesBefore = context.pages().length;
  await page.bringToFront();
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '2 枚目を止めた理由が出ていない(押しても何も起きないに見える)',
  ).toContainText('別のウィンドウで開いています');
  expect(context.pages().length, '同じノートの窓が 2 枚開いた').toBe(pagesBefore);

  /**
   * ⑥ 🔴 **違うノートなら今までどおり増える**(「マルチで付箋」)。
   * ⚠ **対照群である** ── これが無いと、⑤ を「全部止める」実装で満たせてしまう。
   */
  const popup2 = context.waitForEvent('page');
  await page
    .locator('[data-pkc-region="filer-table"] [data-pkc-entry]')
    .filter({ hasText: 'ひとつめ' })
    .first()
    .click();
  await expect(
    page.locator('[data-pkc-region="inspector"]'),
    '前提が崩れた(別のノートを開いていない)',
  ).toContainText('ひとつめ');
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  const win2 = await popup2;
  await expect(win2.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(
    win2.locator('[data-pkc-region="inspector"]'),
    '2 枚目が連れて行ったノートを開いていない',
  ).toContainText('ひとつめ', { timeout: 20_000 });
  await expect(
    win.locator('[data-pkc-region="inspector"]'),
    '1 枚目が 2 枚目に潰された(窓を使い回している)',
  ).toContainText('ふたつめ');

  await win.close();
  await win2.close();

  expect(winErrors, `別の窓で page error: ${winErrors.join(' / ')}`).toEqual([]);
  expect(errors, `元の窓で page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **初めて押した 1 回目が、お知らせで埋まらない**(#685 動線レビュー 欠陥 1、2026-09-04)。
 *
 * ## 物語
 *
 * user は起動直後のお知らせカードで「ノートを別のウィンドウで開けるようになりました」を
 * 読む。**カードを閉じずに**、読んでいたノートを右クリックして「別の窓で開く」を押す。
 * ⚠ 420px の窓は 1 枚ずつの画面なので、お知らせは `grid-area: detail; z-index: 2` で
 * **面いっぱい**に出て、上の帯まで覆う ── **付箋の中身も戻る口も 1 つも見えない**。
 *
 * 🔑 **いちばん印象に残る回**である(新しい機能を初めて押した、その 1 回)。
 * ⚠ 上の spec は `dismissAnnounce` を**先に**呼ぶので、この回を 1 度も通っていなかった。
 */
test('🔴 お知らせを閉じずに押しても、別の窓にはノートが出る (#685)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('ふせんにする');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  /**
   * 🔑 **お知らせを「未読」に戻す** ── 既読は `localStorage` に入るので、
   *   これをしないと 2 枚目でも出ない(= この検査は**何も見ない**)。
   */
  await page.evaluate(() => {
    try {
      localStorage.removeItem('pkc3.notices.seen');
    } catch {
      /* 使えない箱では次の前提で落ちる */
    }
  });

  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  const win = await popup;
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });

  /**
   * ⚠ **前提を先に確かめる** ── 未読に戻せていなければ、以下の「出ていない」は
   *   何も証明しない(CLAUDE.md §1 の空振り)。本体の窓を読み直して出ることを見る。
   */
  const check = await context.newPage();
  await gotoApp(check);
  await expect(
    check.locator('[data-pkc-region="announce"]'),
    '前提が崩れた(未読に戻せていないので、この検査は空振りする)',
  ).toBeVisible({ timeout: 20_000 });
  await check.close();

  // 🔴 **付箋の窓にはお知らせを出さない**(押した物が出る)
  await expect(
    win.locator('[data-pkc-region="announce"]'),
    '付箋の窓がお知らせで埋まっている(押したのに、頼んだ物が出ない)',
  ).toBeHidden();
  await expect(
    win.locator('[data-pkc-region="inspector"]'),
    '付箋の窓がそのノートを開いていない',
  ).toContainText('ふせんにする', { timeout: 20_000 });

  await win.close();
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **付箋の中から同じノートを押しても、2 枚目は出ない**
 *   (#685 動線レビュー 欠陥 3、2026-09-04)。
 *
 * ⚠ 直す前は台帳が**自分の名乗りを数えなかった**ので、A を出している窓にとって
 *   A は「どこにも無い」だった ── お知らせにもマニュアルにも「2 枚目を作りません」と
 *   **条件なしで**書いたのに、押した場所で約束が変わっていた。
 * ⚠ そのうえ 2 枚並ぶと互いを台帳に載せるので、片方を閉じると **3 枚目も開けた**。
 */
test('🔴 付箋の中から同じノートを押しても 2 枚目は出ない (#685)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('ひとりぼっち');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  const win = await popup;
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(
    win.locator('[data-pkc-region="inspector"]'),
    '前提が崩れた(付箋がそのノートを開いていない)',
  ).toContainText('ひとりぼっち', { timeout: 20_000 });

  const before = context.pages().length;
  await win.click('[data-pkc-action="phone-menu"]');
  await win.click('[data-pkc-region="context-menu"] [data-pkc-action="open-note-window"]');
  // 🔑 観測点は **窓が増えないこと + 理由が出ること**の 2 つ ── 片方だけだと
  //    「黙って何もしない」実装でも緑になる(無言の dead click)
  await expect(
    win.locator('[data-pkc-region="status"]'),
    '付箋の中から押したときに、いま見ているのがそれだと言っていない',
  ).toContainText('いま見ているこのウィンドウ');
  expect(context.pages().length, '付箋の中から押して 2 枚目が開いた').toBe(before);

  await win.close();
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
