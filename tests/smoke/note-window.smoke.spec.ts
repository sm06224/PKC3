import { test, expect } from '@playwright/test';
import {
  clickReal,
  collectPageErrors,
  createEntry,
  dismissAnnounce,
  gotoApp,
  useSplitEditor,
} from './helpers';

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
    // 🔑 **「すでに」で pin する**(着地前レビュー 💭)── 1 稿目は
    //    「別のウィンドウで開いています」で見ており、**押した瞬間の字**
    //    (`VIEW_WINDOW_OPENING`)に満たされていた
  ).toContainText('すでに別のウィンドウ');
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
  // ⚠ **`clickReal` を通す**(着地前レビュー ⚠9)── 素の `page.click` は
  //    dead click / 遮蔽 / 再描画のリトライを 1 つも通らない(同じ file の中で規則を 2 本にしない)
  await clickReal(win, '[data-pkc-action="phone-menu"]');
  await clickReal(win, '[data-pkc-region="context-menu"] [data-pkc-action="open-note-window"]');
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

/**
 * 🔴 **写した URL で開いたふつうのタブでは、今までどおり付箋を開ける**
 *   (#685 着地前レビュー 🔴1、2026-09-04)。
 *
 * ## 物語
 *
 * マニュアルは「**付箋のアドレス欄をコピーすると、そのノートを直接開くリンクになります**」と
 * やり方まで書いている。user がそのとおりに URL を写して**ふつうのタブ**で開く。
 * ⚠ 直す前は、`container`+`entry` が在るだけで**付箋の旗が立った**ので、
 * その窓の台帳の `mine` が**選んでいるノートに追随**し ──
 * **そのタブでは「別の窓で開く」が二度と効かなくなっていた**。
 * 🔴 しかも出る字は「いま見ているこのウィンドウで開いています」という**説明の顔**なので、
 * user は不具合だと気づけない(この repo がいちばん嫌う形)。
 *
 * 🔑 見分ける印は `w=` ── **こちらが開いた窓にしか付かず、起動直後に外れる**。
 */
test('🔴 写した URL のタブでも、付箋は今までどおり開ける (#685)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('うつしたさき');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // 🔑 **user と同じ手順で URL を作る** ── 付箋を開いて、そのアドレスを写す
  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  const first = await popup;
  await expect(first.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  const copied = first.url();
  await first.close();
  expect(copied, '前提が崩れた(ノートを名指す断片になっていない)').toContain('entry=');
  expect(copied, '前提が崩れた(合図がアドレスに残っている ── これでは検査にならない)').not.toContain(
    'w=',
  );

  // ⚠ **ふつうのタブ**でその URL を開く(user が写して貼るのと同じ)
  const pasted = await context.newPage();
  await pasted.setViewportSize({ width: 1440, height: 900 });
  await pasted.goto(copied);
  await expect(pasted.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  // ⚠ お知らせは 1 枚目で閉じてある(既読は同じ入れ物で共有される)── ここでは出ない
  await expect(
    pasted.locator('[data-pkc-region="inspector"]'),
    '前提が崩れた(写した URL でノートが開いていない)',
  ).toContainText('うつしたさき', { timeout: 20_000 });

  // 🔴 **そのタブでも付箋は開ける**(直す前はここで窓が出なかった)
  const popup2 = context.waitForEvent('page');
  await clickReal(pasted, '[data-pkc-action="open-note-window"]');
  const win = await popup2;
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(
    win.locator('[data-pkc-region="inspector"]'),
    '別の窓がそのノートを開いていない',
  ).toContainText('うつしたさき', { timeout: 20_000 });

  await win.close();
  await pasted.close();
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **立ち上がる前に 2 度押しても、窓は 1 枚**(#685 着地前レビュー ⚠7、2026-09-04)。
 *
 * ## 物語
 *
 * 押しても 2.5 秒は何も起きない(合図を待つ)ので、user は「効いていない」と思って
 * **もう一度押す** ── まさに「押した瞬間の返事」を足した当の場面である。
 * ⚠ 付箋が台帳に名乗るのは **`startApp` が終わってから**(storage の初期化・
 * メタ一覧・shell の組み立ての後)なので、直す前はその間**台帳が空**で、
 * **同じノートの窓が 2 枚開いた**。⚠ しかもその 2 枚は互いを台帳に載せるので、
 * 片方を閉じると行が消えて **3 枚目も開けた**。
 *
 * 🔑 だから**開く側が見込みを先に載せる**(`reserve`)。
 */
test('🔴 立ち上がる前に 2 度押しても、窓は 1 枚 (#685)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('にどおし');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const opened: import('@playwright/test').Page[] = [];
  const watch = (p: import('@playwright/test').Page) => void opened.push(p);
  context.on('page', watch);
  // ⚠ **待たずに 2 回押す** ── 1 枚目が名乗る前に 2 回目が来る形にする
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  /**
   * ⚠ 合図の猶予(2.5 秒)を跨いで待つ ── ここで待たないと、
   *   「まだ開いていないだけ」と「開かなかった」を区別できない。
   */
  await page.waitForTimeout(3500);
  context.off('page', watch);

  expect(opened.length, `立ち上がる前の 2 度押しで ${opened.length} 枚開いた`).toBe(1);
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '2 回目を止めた理由が出ていない',
  ).toContainText('すでに別のウィンドウ');

  for (const w of opened) await w.close();
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **追記欄を畳んでいても、付箋は追記欄つきで開く**(#690 ② A′、user 裁定 2026-09-04)。
 *
 * ## 物語
 *
 * 本体の窓で「閲覧メインだから」と追記欄を畳んでいる人が、付箋を開く。
 * 付箋の売りは「隅に置いて追記欄にどんどん書き足せる」なのに、直す前は端末の記録
 * (`pkc3.panes`)が付箋にもそのまま効いて、**本文の下に 8px の帯だけ**が出ていた。
 *
 * ## ⚠ ここでしか測れないもの
 *
 * unit(`note-window-panes.test.ts`)は台帳と描画を別々に見る ── **付箋の旗が立った瞬間に
 * 配線(`main.ts` の `enterNoteWindow`)が本当に呼ばれ、実物の CSS で欄が見える**ことは
 * ここでしか分からない(`main.ts` はどの test からも実行されない ── CLAUDE.md §2)。
 * 🔑 観測点は 3 つ:①付箋で打つ欄が**見える** ②帯を押すと**畳める・戻せる**(dead click で
 * ない)③その間**端末の記録が 1 度も動かない**(2 回押した後に見る ── 1 回目は記録と
 * 同じ値へ戻るので、書いても見分けが付かない)。
 */
test('🔴 追記欄を畳んでいても、付箋は追記欄つきで開き、畳んでも本体の記録は動かない (#690 ②)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('たたんだまま');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // 🔑 **user と同じ手で畳む**(帯を押す)── 記録に直接書くと、書く側の経路を見ない
  await clickReal(page, '[data-pkc-action="toggle-pane"][data-pkc-pane="append"]');
  await expect(
    page.locator('[data-pkc-region="shell"]'),
    '前提が崩れた(本体の窓で追記欄が畳まれていない)',
  ).toHaveAttribute('data-pkc-hidden-panes', /append/);
  expect(
    await page.evaluate(() => localStorage.getItem('pkc3.panes')),
    '前提が崩れた(畳みが端末の記録に入っていない ── これでは検査にならない)',
  ).toContain('append');

  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  const win = await popup;
  const winErrors = collectPageErrors(win);
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(
    win.locator('[data-pkc-region="inspector"]'),
    '前提が崩れた(付箋がそのノートを開いていない)',
  ).toContainText('たたんだまま', { timeout: 20_000 });

  // ① 🔴 付箋では追記欄が出ている(記録が「畳む」でも)
  await expect(
    win.locator('[data-pkc-region="shell"]'),
    '付箋なのに端末の記録どおり追記欄が畳まれている',
  ).not.toHaveAttribute('data-pkc-hidden-panes', /append/);
  await expect(
    win.locator('[data-pkc-field="append-input"]'),
    '付箋に追記欄の打つ欄が見えない(帯だけが出ている)',
  ).toBeVisible();

  // ② 🔴 帯は効く(dead click を作らない)── 畳めて、戻せる
  await clickReal(win, '[data-pkc-action="toggle-pane"][data-pkc-pane="append"]');
  await expect(
    win.locator('[data-pkc-field="append-input"]'),
    '付箋で帯を押しても追記欄が畳まれない(dead click)',
  ).toBeHidden();
  await clickReal(win, '[data-pkc-action="toggle-pane"][data-pkc-pane="append"]');
  await expect(
    win.locator('[data-pkc-field="append-input"]'),
    '付箋で帯をもう一度押しても追記欄が戻らない',
  ).toBeVisible();

  // ③ 🔴 端末の記録は動いていない(書いていれば 2 回目で `append` が消えている)
  expect(
    await page.evaluate(() => localStorage.getItem('pkc3.panes')),
    '付箋の畳みが端末の記録へ書かれた(本体の窓の見え方まで変わる)',
  ).toContain('append');
  // ⚠ 対照群 ── 本体の窓は畳まれたまま
  await expect(
    page.locator('[data-pkc-region="shell"]'),
    '本体の窓の畳みが付箋の操作で変わった',
  ).toHaveAttribute('data-pkc-hidden-panes', /append/);

  await win.close();
  expect(winErrors, `付箋で page error: ${winErrors.join(' / ')}`).toEqual([]);
  expect(errors, `元の窓で page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **付箋を開いた直後、カーソルは追記欄に在る**(#690 I4、user 裁定 2026-09-04)。
 *
 * ⚠ 直す前は開いた直後の焦点が本文に在り、user は毎回打つ欄を 1 度押してから
 *   書き始めていた ── 何枚も開く使い方では、その 1 手が枚数ぶん積まれる。
 * 🔑 unit は「頼めば入る」を見る。ここが持つのは**付箋の旗から焦点まで配線が繋がって
 *   いる**こと(`main.ts` の `enterNoteWindow` → `focusInputOnceReady`)と、
 *   実物の CSS で `hidden` が解けた欄に**本当に焦点が乗る**ことである。
 */
test('🔴 付箋を開いた直後、カーソルは追記欄に在る (#690 I4)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('かーそる');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  const win = await popup;
  const winErrors = collectPageErrors(win);
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(
    win.locator('[data-pkc-region="inspector"]'),
    '前提が崩れた(付箋がそのノートを開いていない)',
  ).toContainText('かーそる', { timeout: 20_000 });

  // 🔴 本文が届いた時点で、打つ欄に焦点が在る
  await expect(
    win.locator('[data-pkc-field="append-input"]'),
    '付箋を開いた直後に追記欄へ焦点が入っていない(書き始めるのに 1 手余計に要る)',
  ).toBeFocused({ timeout: 20_000 });
  // ⚠ 対照群 ── 本体の窓では焦点を動かしていない
  await expect(
    page.locator('[data-pkc-field="append-input"]'),
    '本体の窓でも追記欄へ焦点が入った(付箋だけの挙動のはず)',
  ).not.toBeFocused();

  await win.close();
  expect(winErrors, `付箋で page error: ${winErrors.join(' / ')}`).toEqual([]);
  expect(errors, `元の窓で page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **付箋で目次を押しても、題名と住所が残る**(#693 案 A、2026-09-04)。
 *
 * ## 物語
 *
 * 付箋(`#pkc?container=…&entry=…`)で `:::toc` の見出しを押す。目次のリンクは
 * 素の `<a href="#…">` なので、ブラウザが断片を `#<見出し id>` に丸ごと入れ替える。
 * ⚠ 直す前はそれで付箋の旗が降り、**題名が「PKC3」に戻る / 「複数タブ」の帯が
 * 復活する / `F5` でノートが出ない**が 1 度の押下で全部起きていた。
 *
 * ## ⚠ ここでしか測れないもの
 *
 * unit(`deep-link.test.ts`)は「`hashchange` が届いたら住所を戻す」まで。
 * 🔑 ここが持つのは **本物のブラウザが断片を入れ替えて `hashchange` を撃ち、
 * その後で見出しへ飛んだまま住所が戻っていること**(飛びを邪魔していないこと)。
 */
test('🔴 付箋で目次を押しても、題名と住所が残る (#693)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await useSplitEditor(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('めじるし');
  // ⚠ 見出しの間に十分な本文を挟む ── 短いと飛ばなくても見えてしまう
  await page.locator('[data-pkc-field="editor-body"]').fill(
    [
      ':::toc',
      '# 最初の章',
      ...Array.from({ length: 60 }, (_, i) => `一行目の本文 ${i}`),
      '## 途中の節',
      ...Array.from({ length: 60 }, (_, i) => `二つ目の本文 ${i}`),
    ].join('\n'),
  );
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const popup = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="open-note-window"]');
  const win = await popup;
  const winErrors = collectPageErrors(win);
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect.poll(() => win.title(), { timeout: 15_000 }).toBe('めじるし — PKC3');
  const before = win.url();
  expect(before, '前提が崩れた(付箋の住所がノートを名指していない)').toContain('entry=');

  const TOC_LINK = '[data-pkc-region="toc"] a[href^="#"]';
  await expect(win.locator(TOC_LINK), '前提が崩れた(目次が出ていない)').toHaveCount(2);
  const heading = win.locator('[data-pkc-region="detail"] h2[id]').first();
  const beforeY = (await heading.boundingBox())?.y ?? 0;
  expect(beforeY, '前提が崩れた(押す前から見出しが画面の上に在る)').toBeGreaterThan(600);

  await clickReal(win, `${TOC_LINK} >> nth=1`);
  await win.waitForTimeout(300);

  // ① 🔴 **飛びは邪魔しない** ── 見出しが画面の上へ来ている
  const box = await heading.boundingBox();
  expect(box, '押した見出しが画面から消えた').not.toBeNull();
  expect(box!.y, `見出しへ飛んでいない(${beforeY} → ${box!.y})`).toBeLessThan(300);

  // ② 🔴 **住所は元へ戻っている**(`F5` でこのノートが出る / `Ctrl+D` が効く)
  await expect.poll(() => win.url(), { timeout: 5_000 }).toBe(before);

  // ③ 🔴 **身元は残っている** ── 題名は「PKC3」に戻らず、follower の帯も出ない
  await expect.poll(() => win.title(), { timeout: 5_000 }).toBe('めじるし — PKC3');
  await expect(
    win.locator('[data-pkc-region="status"]'),
    '目次を押しただけで「複数タブ」の帯が復活した(付箋の旗が降りた)',
  ).not.toContainText('複数タブ');

  /**
   * ④ ⚠ **対照群** ── 本体の窓(付箋でない)では今までどおり住所が `#<id>` になる
   *   (見出し id のアンカーリンク #658 を壊していない)。
   */
  await page.bringToFront();
  await clickReal(page, `${TOC_LINK} >> nth=1`);
  await expect.poll(() => new URL(page.url()).hash, { timeout: 5_000 }).toMatch(/^#(?!pkc\?).+/);

  await win.close();
  expect(winErrors, `付箋で page error: ${winErrors.join(' / ')}`).toEqual([]);
  expect(errors, `元の窓で page error: ${errors.join(' / ')}`).toEqual([]);
});
