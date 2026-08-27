import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, collectPageErrors } from './helpers';
import { withStateOnFail } from './state-dump';

/**
 * 🔴 **予定の知らせを入にすると、その場で本当に音が鳴る**(#280)。
 *
 * 🔴 **unit では原理的に届かない層**:
 * ① **`AudioContext` は happy-dom に無い** ── `createChime()` は unit から
 *    **1 行も実行されない**(CLAUDE.md §2「弱いのではなく走っていない」)。
 *    ⚠ 音を作る所は**実ブラウザでしか動かない**ので、ここでしか見られない
 * ② **ブラウザの自動再生の制限** ── 「user が触っていないページ」の音は止まる。
 *    🔑 だから**押した直後に鳴らす**形にしてあり、それが本当に通るかは
 *    実ブラウザでないと言えない
 *
 * ⚠ **時間が来て鳴るところは回していません** ── 時刻の粒は 1 分で、刻みは
 *   30 秒なので、実時間で待つと最悪 90 秒かかります(そして日付をまたぐ回で
 *   ぶれます)。⚠ 「回していない」であって「動かない」ではありません ──
 *   採り方は `tests/features/alarm-due.test.ts`、段取りは
 *   `tests/adapter/alarm-service.test.ts` が両方向とも通しています。
 */
test('🔴 予定の知らせを入にすると、その場で音が鳴る (#280)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  /**
   * 🔴 **観測点は「本物の `AudioContext` が作られたか」**である。
   *
   * ⚠ 1 稿目は**状態の行の字**だけを見ていた ── ところが変異試験 A12
   *   (`alarmChime.play()` を `Promise.resolve(true)` に差し替える)が
   *   **生き延びた**:音を 1 度も作らなくても同じ字が出るからである。
   *   🔑 **字は「そう書いた」ことしか言わない** ── 音そのものを見るには、
   *   ブラウザの口を数えるしかない(CLAUDE.md §1「救い手が変わっただけ」)。
   * ⚠ `addInitScript` はページの script より先に走るので、boot で
   *   `createChime()` が読む時点で既に包まれている。
   */
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w['__pkcAudioCtx'] = 0;
    const Real = w['AudioContext'] as (new () => AudioContext) | undefined;
    if (!Real) return;
    w['AudioContext'] = function (this: unknown) {
      w['__pkcAudioCtx'] = (w['__pkcAudioCtx'] as number) + 1;
      return new Real();
    } as unknown as new () => AudioContext;
  });
  await gotoApp(page);

  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const box = page.locator('[data-pkc-field="alarm-enabled"]');
  await expect(box, '設定に「予定の知らせ」が無い').toHaveCount(1);
  await expect(box, '既定で入になっている(音は割り込みなので既定は切)').not.toBeChecked();

  /**
   * ⚠ **できないことが画面に書いてある**(#280 の本文)── 曖昧にすると、
   *   user は**鳴る前提で予定を任せて失う**。
   */
  await expect(
    page.locator('[data-pkc-region="settings-body"]'),
    '「開いている間だけ」と書いていない',
  ).toContainText('開いている間だけ');

  await clickReal(page, '[data-pkc-field="alarm-enabled"]');
  await expect(box, '押しても入にならない').toBeChecked();

  /**
   * 🔴 **本当に鳴らせたか**を状態の行で見る ── ⚠ 「鳴った」と「鳴らせなかった」で
   *   出る字が違うので、**どちらの経路を通ったかが読める**。
   * ⚠ ここが「鳴らせませんでした」になるなら、それは実ブラウザで
   *   `AudioContext` が通っていないということである(unit では見えない層)。
   */
  await withStateOnFail(page, '知らせの設定が音まで届いていない', async () => ({}), async () => {
    await expect(page.locator('[data-pkc-region="status"]')).toContainText(
      'この音で知らせます',
      { timeout: 10_000 },
    );
  });

  /**
   * 🔴 **本当に音を作った**(字だけでは言えない)。
   * ⚠ 起動しただけでは 0 でなければならない ── 押していないのに音の器を
   *   抱えるのは、常駐を作るのと同じである。
   */
  expect(
    await page.evaluate(() => (window as unknown as Record<string, number>)['__pkcAudioCtx']),
    '音の器を 1 つも作っていない(字だけ出して鳴らしていない)',
  ).toBeGreaterThanOrEqual(1);

  // ⚠ **切に戻せる**(片道の設定を作らない)
  await clickReal(page, '[data-pkc-field="alarm-enabled"]');
  await expect(box, '切に戻せない').not.toBeChecked();

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
