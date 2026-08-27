import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';
import { chromiumLaunch } from './playwright.config';

/**
 * 🔴 **録音して止めると、開いていたノートに入る**(#413。user 要望 2026-07-16
 * 「録音と画面収録を…これで、会議メモをうまく残せるはず」)。
 *
 * 🔴 **unit では原理的に届かない層**:
 * ① **本物の `MediaRecorder`** ── unit の stub は `stop()` で同期に撃つが、実物は
 *    最後の断片を**あとから**配る。`rec.start(1000)` で本当に断片が届くか、
 *    届いた bytes が本当に帯へ出るかは、ここでしか見られない
 * ② **本物の `getUserMedia`** ── 許可・track・停止まで通す
 * ③ **止めたあとに画面が何を出しているか** ── 添付が選択を奪ったまま終わると
 *    「会議メモを書いていたのに、止めたら別の物が開いている」になる
 *
 * ⚠ **音だけ**を通す。画面収録(`getDisplayMedia`)は headless で
 *   共有元を選べないので、ここでは回さない ── ⚠ 「回していない」であって
 *   「動かない」ではない(段取りは `capture-service.test.ts` が両方通している)。
 *
 * ⚠ 偽のマイクを渡すのは**起動引数**である ── `launchOptions` は丸ごと
 *   差し替わるので、どのバイナリで走るかは config から読む(CLAUDE.md §5)。
 */
test.use({
  launchOptions: {
    ...chromiumLaunch,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

test('🔴 録音を止めると、開いていたノートの本文に入る (#413)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill('# 定例会議');
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const bar = page.locator('[data-pkc-region="capture-bar"]');
  await expect(bar, '押す前から帯が出ている').toBeHidden();

  await clickReal(page, '[data-pkc-field="start-audio-capture"]');
  const status = page.locator('[data-pkc-field="capture-status"]');
  await expect(bar, '押しても帯が出ない').toBeVisible();
  await expect(status, '何を録っているか出ていない').toContainText('録音中');

  /**
   * ① 🔴 **本当に断片が届いている**(`0B` から動く)。
   * ⚠ 「帯が出た」だけでは足りない ── 1 バイトも録れていない収録でも帯は出る。
   */
  await expect(status, '1 バイトも積んでいない(断片が届いていない)').not.toContainText(
    '約 0B',
    { timeout: 15_000 },
  );

  await clickReal(page, '[data-pkc-field="stop-capture"]');
  await expect(bar, '止めたのに帯が残っている').toBeHidden();

  // ③ 🔴 **開いていたノートのまま**(添付が奪った選択が戻っている)
  const detail = page.locator('[data-pkc-view-pane="detail"]');
  await expect(detail, '止めたら別の物が開いている').toContainText('定例会議');
  // 🔴 **その本文に参照が入っている**(添付だけ増えて迷子にならない)
  const ref = detail.locator('a[data-pkc-asset-key]', { hasText: '録音-' });
  await expect(ref, '本文に参照が入っていない').toHaveCount(1);

  // ⚠ **添付そのものも在る**(参照だけ書いて bytes を落としていない)
  await expect(
    page.locator('[data-pkc-region="filer-table"] tbody tr', { hasText: '録音-' }),
    '添付が作られていない',
  ).toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
