/**
 * 🔴 **「設定」→「システム」の改名 + 先頭の目次**(#1017 段⓪、2026-09-20)。
 *
 * ## なぜ実ブラウザで見るのか
 *
 * unit(happy-dom)はスクロールを持たないので、目次を押して**実際に本文が送られるか**
 * ・「目次へ戻る」で**戻るか**は unit から見えない。また改名の起動時お知らせが
 * **本当にその 1 件目として出るか**も、unit の `NOTICES` 直輸入では
 * 実物の既読管理(`store.seenIds()`)を通らないので確かめられない。
 *
 * 🔑 観測点は 4 つ(1 起動にまとめる ── CLAUDE.md「起動を 1 つ足すと以後すべての
 *   回に 1.6 秒」):
 *  ① 起動直後のお知らせの題名が読める(消す前に読む)
 *  ② 目次のボタンの字が、画面の見出しの字と**同じ順で全部**一致する(「目次へ戻る」が
 *     見出し側に混ざっていないこと ── #1017 段⓪の docstring が戒めている壊れ方)
 *  ③ 目次の最後を押すと、その見出しが画面の上のほうへ送られる
 *  ④ その節の「目次へ戻る」を押すと、目次の位置まで戻る
 *  ⑤ ①〜④ の間、`location.hash` は 1 度も変わらない(hash はディープリンク専用)
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, dismissAnnounce, collectPageErrors } from './helpers';

test('🔴 「システム」の目次: お知らせが読め、押すと移動し、目次へ戻るで戻り、hash は不変', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  // ⑥ の台:コピーの履歴を 1 件だけ持って起動する(store は起動時に 1 度読む)
  await page.addInitScript(() => {
    localStorage.setItem(
      'pkc3.copy.history',
      JSON.stringify([{ at: 1, text: 'smoke の下ごしらえ', html: '' }]),
    );
  });
  await gotoApp(page);

  // ⚠ hash は最初から動かないはず ── 起動直後の値を基準にする
  const hashAtBoot = await page.evaluate(() => location.hash);

  // ① 🔴 起動直後のお知らせの題名が改名を告げている(消す前に読む)
  //    ⚠ `announce-title` は帯の見出し行(「お知らせ(残り N 件)」+ 次へ/閉じる)
  //    であって、個々のお知らせの題名ではない ── 題名は `announce-body` の
  //    `section[data-pkc-announce] h3` に在る(announce.ts の組み立てを実測して確認)。
  const announceBody = page.locator('[data-pkc-field="announce-body"]');
  await expect(announceBody, 'お知らせが出ていない(台の前提が崩れた)').toBeVisible({
    timeout: 10_000,
  });
  const announceItemTitle = announceBody.locator('section[data-pkc-announce] h3').first();
  // ⚠ **新しい順**(#1017 段③-2「これまでのお知らせ」の入口をシステムへ、が
  //   NOTICES の先頭 ── 段③-1「システム」を型ごとの 6 節へ、より新しい)。
  expect(
    (await announceItemTitle.textContent()) ?? '',
    'お知らせの題名が最新のものになっていない',
  /**
   * ⚠ **お知らせを 1 件足すたびに、ここも直る**(2026-09-21 に落ちた)。
   *   `.claude/skills/notice-writing/SKILL.md` に「足す前に前の題名を grep」と
   *   書いてあるのに、足した本人がそれをやらずにフル smoke で落とした。
   * 🔑 直すのは**この 1 行だけ**でよい ── 実装から引く形にすると
   *   「最新が出ている」を**実装の値で確かめる**ことになり、何も守らなくなる。
   */
  ).toContain('ノートを閉じて、コレクションの画面へ戻れるようになりました');
  await dismissAnnounce(page);

  // 「システム」を開く
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const pane = page.locator('[data-pkc-view-pane="settings"]');
  await expect(pane, 'システムの面が開かない').toBeVisible();

  // 画面の題名が「システム」。⚠ `pane-title` は右の情報ペイン(「情報」)にも在るので、
  // システムの面(`pane`)の中に**スコープする**(CLAUDE.md §1「面へスコープする」)。
  const title = pane.locator('[data-pkc-field="pane-title"]');
  await expect(title).toBeVisible();
  expect((await title.textContent())?.trim(), '画面の題名が「システム」ではない').toBe(
    'システム',
  );

  // ② 🔴 目次のボタンの字と、画面の見出しの字が**同じ順で全部**一致する
  //    ⚠ 「目次へ戻る」が見出しの `h3.textContent` に混ざっていないこと
  //    (#1017 段⓪ docstring「目次へ戻るは h3 の子にしない」を実測で確かめる)
  const tocButtons = page.locator(
    '[data-pkc-region="settings-toc"] [data-pkc-action="system-jump"]',
  );
  const tocLabels = await tocButtons.allTextContents();
  expect(tocLabels.length, '目次にボタンが 1 つも無い').toBeGreaterThan(3);
  expect(tocLabels, '目次に「目次へ戻る」が紛れている').not.toContain('目次へ戻る');

  const headingLabels = await page
    .locator('[data-pkc-view-pane="settings"] h3[data-pkc-section]')
    .allTextContents();
  expect(
    headingLabels,
    '見出しに「目次へ戻る」が混ざっている(h3.textContent が汚れた)',
  ).not.toContain('目次へ戻る');
  expect(headingLabels, '目次と見出しの数が一致しない').toHaveLength(tocLabels.length);
  expect(tocLabels, '目次の字が、その順の見出しと一致しない').toEqual(headingLabels);

  // ②-2 🔴 6 節の型ごとの見出しが、この順で並んでいる(#1017 段③-1)。
  //    ⚠ 新しい起動は足さない(CLAUDE.md smoke-budget)── ②で取得済みの
  //    `headingLabels` をそのまま検める
  expect(
    headingLabels,
    '「システム」が型ごとの 6 節へ組み替わっていない',
  ).toEqual(['メッセージ', '設定', '許可', '記録', '保存領域', 'お知らせ']);

  // ③ 🔴 目次の**最後**を押すと、その見出しが画面の上のほうへ送られる
  const scroller = page.locator('[data-pkc-region="detail"]');
  const lastHeading = page.locator('[data-pkc-view-pane="settings"] h3[data-pkc-section]').last();
  const beforeJumpY = (await lastHeading.boundingBox())?.y ?? 0;
  expect(beforeJumpY, '前提が崩れている(最後の見出しが押す前から画面の上に在る)').toBeGreaterThan(
    500,
  );
  const scrollBeforeJump = await scroller.evaluate((el) => el.scrollTop);

  await clickReal(page, tocButtons.last());
  await page.waitForTimeout(150);

  const scrollAfterJump = await scroller.evaluate((el) => el.scrollTop);
  expect(
    scrollAfterJump,
    `目次を押しても送られていない(${scrollBeforeJump} → ${scrollAfterJump})`,
  ).toBeGreaterThan(scrollBeforeJump);
  const afterJumpBox = await lastHeading.boundingBox();
  const viewportH = page.viewportSize()?.height ?? 900;
  expect(afterJumpBox, '押した見出しが画面から消えた').not.toBeNull();
  // ⚠ **これは最後の見出し**なので、その先に本文が無く「先頭ぴったり」までは
  //   送りきれない(`toc.smoke.spec.ts` が同じ理由で「真ん中」を選んでいる注記と同型)。
  //   ここで見るのは「表示域に入ったか」であって「先頭近くまで来たか」ではない。
  // 🔴 **#1017 段③-2 で実測して見つけた穴**:これまでのお知らせの一覧を
  //   「お知らせ」の h3 の中に足したことで、この節が「下に本文がほぼ無い最後の節」
  //   ではなくなり `scrollIntoView` が見出しを画面の先頭ぴったりへ寄せられるように
  //   なった ── ところが先頭には sticky な `pane-bar`(閉じる帯、35px)が乗っており、
  //   見出しと「目次へ戻る」がその真下に隠れて**押せなくなっていた**(下の④で拾う)。
  //   `app.css` の `h3[data-pkc-section] { scroll-margin-top: 40px }` で直した。
  expect(afterJumpBox!.y, `見出しが表示域に入っていない(y=${afterJumpBox!.y})`).toBeGreaterThanOrEqual(
    0,
  );
  expect(afterJumpBox!.y, `見出しが表示域に入っていない(y=${afterJumpBox!.y})`).toBeLessThan(
    viewportH,
  );

  // ④ 🔴 その節の「目次へ戻る」を押すと、目次の位置(先頭)へ戻る
  const backButton = page
    .locator('[data-pkc-view-pane="settings"] [data-pkc-field="settings-back-to-top"]')
    .last();
  await expect(backButton, '「目次へ戻る」ボタンが無い').toBeVisible();

  await clickReal(page, backButton);
  await page.waitForTimeout(150);

  const scrollAfterBack = await scroller.evaluate((el) => el.scrollTop);
  expect(
    scrollAfterBack,
    `「目次へ戻る」を押しても目次へ戻っていない(${scrollAfterJump} → ${scrollAfterBack})`,
  ).toBeLessThan(scrollAfterJump);
  const tocBox = await page.locator('[data-pkc-region="settings-toc"]').boundingBox();
  expect(tocBox, '目次が画面から消えた').not.toBeNull();
  expect(tocBox!.y, `「目次へ戻る」を押しても目次が画面の上のほうに来ていない(y=${tocBox!.y})`).toBeLessThan(
    300,
  );

  // ⑥ 🔴 記録 → 「コピーの履歴を消す」(#1017 段③-1 で足した押し口)。
  //    ⚠ 件数の字は `render()` の外で変わる ── 押した後に **その場で** 0 件に
  //    なることまで見る(状態変化に乗らないので、通知が無いと古い字が残る)
  const copyCount = page.locator(
    '[data-pkc-region="settings-copy-history"] [data-pkc-field="copy-history-count"]',
  );
  await expect(copyCount, '台の前提が崩れている(1 件で起動していない)').toHaveText(
    'いま 1 件あります。',
  );
  await clickReal(
    page,
    '[data-pkc-region="settings-copy-history"] [data-pkc-action="clear-copy-history"]',
  );
  await expect(copyCount, '消したのに件数の字が古いまま').toHaveText('いまは 0 件です。');
  expect(
    await page.evaluate(() => localStorage.getItem('pkc3.copy.history')),
    '消したのに端末に残っている',
  ).toBeNull();

  // ⑤ 🔴 ここまでの一連の操作で hash は 1 度も変わっていない(ディープリンク専用)
  const hashAfter = await page.evaluate(() => location.hash);
  expect(hashAfter, `目次の操作で hash が動いた(${hashAtBoot} → ${hashAfter})`).toBe(hashAtBoot);

  expect(errors, 'pageerror が出た').toEqual([]);
});
