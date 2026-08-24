import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * 🔴 **予定の面 ── 本物の drag で本文が書き替わる**(#292 段③)。
 *
 * > user 指示 2026-08-23:「**なんで双方向にする発想がでねぇんだよ!**」
 *
 * 🔴 unit(`tests/adapter/schedule-view.test.ts`)は繋がりを見ている。
 * **ここが見るのは「実際に掴めるか」**である ── unit の drag は event を手で
 * 撃つので、`draggable` が false でも通る(ブラウザの門を通らない)。
 * ⚠ つまり「掴めない札」は**実機でしか捕まらない**(CLAUDE.md §2)。
 *
 * 🔑 そして**本文が 1 度も消えない**ことも、ここでしか見られない ──
 * これが user 指示①(「もう一つ PKC が開いて混乱する」)への答えである。
 */
test('🔴 予定のタブで札を掴んで日へ落とすと、本文の日付が変わる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill('- [ ] 見積を送る @2026-08-25\n- [ ] 体裁のチェック');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ① 予定のタブへ(⚠ アプリの一覧ではない ── 左の列のタブである)
  await clickReal(page, '[data-pkc-browse="schedule"]');
  const pane = page.locator('[data-pkc-browse-pane="schedule"]');
  await expect(pane, '予定の面が出ていない').toBeVisible();

  /**
   * 🔴 **本文は消えていない。** ①の実害はここだった ── 予定を見るために
   * 真ん中を明け渡す必要は無い。
   */
  await expect(
    page.locator('[data-pkc-view-pane="detail"]'),
    '予定を開いたら本文が消えた(①の実害そのもの)',
  ).toBeVisible();

  // ② 日付を書いた行だけが札になっている
  const card = pane.locator('[data-pkc-region="schedule-cards"] > [data-pkc-entry]');
  await expect(card, '札の枚数が違う(日付の無い行まで出ている)').toHaveCount(1);
  await expect(card, '記法が札の字に残っている').toContainText('見積を送る');

  // ③ 🔴 **本物の drag** ── 8/25 の札を掴んで 8/28 の升目へ落とす
  const target = pane.locator('[data-pkc-drop-date="2026-08-28"]');
  await expect(target, '落とし先の升目が無い').toBeVisible();
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  expect(from, '札の位置が取れない').not.toBeNull();
  expect(to, '升目の位置が取れない').not.toBeNull();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  // ⚠ **途中を経由する** ── 1 回の move では `dragover` が出ないブラウザが在る
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 });
  /**
   * 🔴 **落とせる所は、落とす前に分かる**(掴んで通ったときだけ光る)。
   * ⚠ ここを見ないと「落とせたが、user には落とせるか分からなかった」が通る。
   */
  await expect(target, '落とし先が光っていない').toHaveAttribute('data-pkc-dropping', '');
  await page.mouse.up();

  // ④ 🔴 **本文が書き替わった**(画面だけ動いて本文は元のまま、を作らない)
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '本文の日付が書き替わっていない').toHaveValue(
    '- [ ] 見積を送る @2026-08-28\n- [ ] 体裁のチェック',
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');

  // ⑤ 札も新しい日の束に居る(本文だけ直って画面が古い、を作らない)
  await expect(
    pane.locator('[data-pkc-region="schedule-group"][data-pkc-drop-date="2026-08-28"] [data-pkc-entry]'),
    '札が新しい日へ移っていない',
  ).toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **点が付いても、升目の高さが動かない**(#303 から持ち越した唯一の主張)。
 *
 * ## なぜ持ち越すのか
 *
 * cowork 実機レポート #15「**同じ座標を 2 回押すと別の日に当たる**」── 旧カレンダーは
 * 予定を `td` の直下に積んでいたので、1 件入るごとにその週の内在高が増え、
 * **下の行が押し下がって**いた(実測で週の上端が最大 53px ずれた)。
 * ⚠ 小さな月では**升目が落とし先そのもの**なので、ずれると
 * **別の日へ落ちる = データが黙って動く**。#303 より悪い。
 *
 * ## ⚠ ここは「規則が在るか」ではなく「実寸が同じか」を見る
 *
 * 1 稿目は CSS を構文で読み、点の `::after` が `position: absolute` であることを
 * pin した。⚠ **測ったら、その規則は no-op だった** ── 点は 3px で、升目の
 * 行ボックス(11px × line-height 1.4)より小さいので、流れの中に置いても
 * 高さを押し広げない(実測: 絶対配置でも静的でも **26px / 26px**)。
 * 🔑 だから守るべきは規則の綴りではなく**高さが揃っていること**である
 * (CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れるのを見る」)。
 * ⚠ この形なら、将来「件数の数字を出す」ような**本当に押し広げる変更**を捕まえる
 *   ── 旧カレンダーが実際にそれで壊れた。
 */
test('🔴 予定のある日とない日で、小さな月の升目の高さが同じ', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill(
      ['- [ ] 予定 A @2026-08-25', '- [ ] 予定 B @2026-08-25 09:00', '- [ ] 予定 C @2026-08-25 14:00'].join(
        '\n',
      ),
    );
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-browse="schedule"]');

  // ⚠ **前提** ── 点が付いた日が実在する(付いていなければ何も検めていない)
  const dotted = page.locator('[data-pkc-drop-date="2026-08-25"][data-pkc-has]');
  await expect(dotted, '予定のある日に点が付いていない(前提が崩れている)').toBeVisible({
    timeout: 20_000,
  });

  const heights = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('[data-pkc-field="schedule-week"] > button')];
    const has = cells.filter((c) => c.hasAttribute('data-pkc-has'));
    const bare = cells.filter((c) => !c.hasAttribute('data-pkc-has'));
    const h = (el: Element): number => +el.getBoundingClientRect().height.toFixed(2);
    return { has: has.map(h), bare: bare.map(h) };
  });
  // ⚠ **空振り防止** ── 両側に升目が在ること(片側が 0 件だと下の比較は空回り)
  expect(heights.has.length, '点の付いた升目が 0 件').toBeGreaterThan(0);
  expect(heights.bare.length, '点の無い升目が 0 件').toBeGreaterThan(0);
  // 🔑 **全部が同じ高さ**(点の有無で分かれていないこと)
  const all = [...heights.has, ...heights.bare];
  expect(
    new Set(all).size,
    `升目の高さが揃っていない(落とし先がずれる): ${JSON.stringify(heights)}`,
  ).toBe(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **期間の札を、本物の drag でずらす**(#344 段①)。
 *
 * 🔴 unit(`tests/adapter/schedule-view.test.ts`)は「何枚出るか」「本文がどう変わるか」を
 * 見ている。**ここが見るのは実機でしか捕まらない 2 つ**である ──
 * ① 期間の札が**掴める**か(`draggable` の門は unit の合成 event を素通りする)
 * ② **どの日の札を掴んだか**が荷物に載るか(荷物は実際の `dragstart` でしか作られない)
 *
 * ⚠ 観測点は**保存された本文** ── 札が動いただけでは意味が無い。
 */
test('🔴 期間の札を掴んでずらすと、長さを保ったまま本文が書き替わる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill('- [ ] 大阪出張 @2026-08-25..2026-08-28');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-browse="schedule"]');
  const pane = page.locator('[data-pkc-browse-pane="schedule"]');
  await expect(pane, '予定の面が出ていない').toBeVisible();

  // ① 4 日ぶんの札に展開されている(1 枚を日から日へ動かしていない)
  await expect(
    pane.locator('[data-pkc-region="schedule-cards"] > [data-pkc-entry]'),
    '期間が日数ぶんの札になっていない',
  ).toHaveCount(4);
  // ⚠ 札は「いつまでか」を出す(束の見出しには終わりが出ないため)
  await expect(
    pane.locator('[data-pkc-region="schedule-cards"] > [data-pkc-task-range]').first(),
  ).toContainText('〜08/28');

  // ② 🔴 3 日目(8/27)の札を掴んで、8/30 の升目へ落とす = +3 日
  const grabbed = pane.locator(
    '[data-pkc-region="schedule-group"][data-pkc-drop-date="2026-08-27"] [data-pkc-entry]',
  );
  await expect(grabbed, '8/27 の札が無い').toHaveCount(1);
  const target = pane.locator('[data-pkc-drop-date="2026-08-30"]');
  const from = await grabbed.boundingBox();
  const to = await target.boundingBox();
  expect(from, '札の位置が取れない').not.toBeNull();
  expect(to, '升目の位置が取れない').not.toBeNull();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 });
  await expect(target, '落とし先が光っていない').toHaveAttribute('data-pkc-dropping', '');
  await page.mouse.up();

  // ③ 🔴 **長さは 4 日のまま**、掴んだ日が落とした日に来ている
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(ta, '期間が長さを保ったままずれていない').toHaveValue(
    '- [ ] 大阪出張 @2026-08-28..2026-08-31',
  );
  await clickReal(page, '[data-pkc-action="cancel-edit"]');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
