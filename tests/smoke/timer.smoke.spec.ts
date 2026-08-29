import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';
import { withStateOnFail } from './state-dump';

/**
 * 🔴 **計って止めると、そのノートの本文に作業時間が入る**(#279。user 指示
 * 2026-08-19「…連絡先、**タイマー**、アラートは組み込みアプリでリリースしたい」)。
 *
 * 🔴 **unit では原理的に届かない層**:
 * ① **本物の `setInterval`** ── 刻みを張って外すのは実装の中なので、
 *    unit は手で撃っている。**放っておいて字が動くか**はここでしか見られない
 * ② **帯の行が指の下で作り直されていないか** ── 1 秒ごとに描き直すので、
 *    行ごと作り直す実装だと**押している最中に「止める」が消える**。
 *    ⚠ unit は DOM を持たないので、この欠陥は原理的に見えない
 * ③ **押した結果が本文の面に出るまで**(reducer → 書込 → 描画の全段)
 */
/**
 * 🔴 **狭い窓でも「止める」に手が届く**(2026-08-29。#582 の全数調査で見つけた欠陥②)。
 *
 * ## なぜ実ブラウザで見るのか
 *
 * ⚠ 直す前は `@media (max-width: 1100px)` / `(max-width: 720px)` の
 *   `grid-template-areas` に **`timers` の行が無かった** ── 区画名の無い
 *   `grid-area` は**暗黙のトラックへ落ちる**ので、帯が**右端の細い列**へ化けた。
 *   実測では **480px で x=528**(窓の外)に出ており、**止める口が画面に無い**。
 * 🔴 `app.css` の当のコメントが破れていた:「**止める口が消えると、マイクが回り続ける**」。
 *
 * ## ⚠ 字面の検査では届かない
 *
 * `announce.test.ts` は CSS の区画の**名前**を見るが、
 * 「**押せる所に在るか**」は**版面を組んでみないと分からない**
 * (CLAUDE.md「描画と状態は別物」── 視覚を持つ feature は実ブラウザで 1 件見る)。
 *
 * 🔑 観測点は **`elementFromPoint`** にする ── `toBeVisible()` は
 *   「窓の外に出ている」も「他の帯と重なって押せない」も**通してしまう**。
 */
test('🔴 狭い窓でも、止める口が画面の中に在って押せる (#582)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 480, height: 800 });
  await gotoApp(page);
  await createEntry(page, 'text');

  await clickReal(page, '[data-pkc-field="start-timer"]');
  const bar = page.locator('[data-pkc-region="timer-bar"]');
  await expect(bar, '押しても帯が出ない').toBeVisible();

  const stop = bar.locator('[data-pkc-action="stop-timer"]');
  const box = (await stop.boundingBox())!;
  expect(box, '止める口の位置が採れない').not.toBeNull();

  // ① 🔴 **窓の中に在る**(直す前は x=528 / 窓幅 480 = 外に出ていた)
  const vw = page.viewportSize()!.width;
  expect(box.x, `止める口が窓の外に出ている(x=${box.x} / 窓幅 ${vw})`).toBeGreaterThanOrEqual(0);
  expect(
    box.x + box.width,
    `止める口が窓からはみ出している(右端 ${box.x + box.width} / 窓幅 ${vw})`,
  ).toBeLessThanOrEqual(vw);

  // ② 🔴 **その点を押すと本当に「止める」に当たる**(重なって覆われていない)
  const hit = await page.evaluate(
    ({ x, y }: { x: number; y: number }) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest('[data-pkc-action]')?.getAttribute('data-pkc-action') ?? null;
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  expect(hit, '止める口の上に別の物が重なっている(押しても止まらない)').toBe('stop-timer');

  // ③ 🔴 **本文の下に在る**(横の暗黙の列へ化けていない)
  const detail = (await page.locator('[data-pkc-region="detail"]').boundingBox())!;
  expect(box.y, '帯が本文の下ではなく横に出ている').toBeGreaterThanOrEqual(detail.y);

  // ④ ⚠ **押して実際に止まる**(位置だけ直っても、押せなければ意味がない)
  await clickReal(page, '[data-pkc-action="stop-timer"]');
  await expect(bar, '押しても止まらない').toBeHidden();

  expect(errors, '例外が出た').toEqual([]);
});

test('🔴 計って止めると、開いていたノートの本文に作業時間が入る (#279)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill('# 設計メモ');
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const bar = page.locator('[data-pkc-region="timer-bar"]');
  await expect(bar, '押す前から帯が出ている').toBeHidden();

  await clickReal(page, '[data-pkc-field="start-timer"]');
  await expect(bar, '押しても帯が出ない').toBeVisible();
  const entry = bar.locator('[data-pkc-field="timer-entry"]');
  /**
   * ⚠ **名前と経過が両方出ている** ── ⚠ 「どのノートを計っているか」の
   *   突き合わせは unit(`timer-service.test.ts`)が持つ。ここで題名の字を
   *   写すと、題名の決まり方を変えた瞬間に**この spec が落ちる**(製品は正しいのに)。
   */
  await expect(entry, '名前と経過が 1 行で出ていない').toHaveText(/\S+ \d+:\d\d$/);

  /**
   * ① 🔴 **放っておいて字が動く**(刻みが本当に張られている)。
   * ⚠ 「帯が出た」だけでは足りない ── 刻みを張り忘れても帯は出る
   *   (そして**経過が 0:00 のまま止まって見える**)。
   */
  const stop = bar.locator('[data-pkc-action="stop-timer"]');
  /**
   * ② 🔴 **行は作り直されていない**(押している最中に消えない)。
   *
   * 🔑 観測点は **その node に付けた印が残っているか** ── 字が同じでも、
   *   node が入れ替わっていれば押している指の下から消えている
   *   (CLAUDE.md §4「user が見る面で測る」)。
   * ⚠ node そのものを返して比べることはできない(`evaluate` の返り値は
   *   写しなので、**別物でも一致してしまう**)── 印にする。
   */
  await stop.evaluate((el) => {
    (el as unknown as Record<string, unknown>)['__pkcTimerNode'] = 1;
  });
  await expect(entry, '経過が動かない(刻みが張られていない)').toContainText('0:02', {
    timeout: 15_000,
  });
  expect(
    await stop.evaluate(
      (el) => (el as unknown as Record<string, unknown>)['__pkcTimerNode'] === 1,
    ),
    '1 秒ごとに行を作り直している(押している最中に「止める」が消える)',
  ).toBe(true);

  await clickReal(page, '[data-pkc-action="stop-timer"]');
  await expect(bar, '止めたのに帯が残っている').toBeHidden();

  // ③ 🔴 **開いていたノートのまま**、その本文に 1 行入っている
  const detail = page.locator('[data-pkc-view-pane="detail"]');
  await withStateOnFail(page, '本文に作業時間が入っていない', async () => ({}), async () => {
    await expect(detail, '止めたら別の物が開いている').toContainText('設計メモ');
    await expect(detail, '作業時間の行が本文に無い').toContainText('作業 ');
  });

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
