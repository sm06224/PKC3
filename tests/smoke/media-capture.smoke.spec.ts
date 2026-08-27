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
 * ④ **本当に鳴らせる形か**(段②)── happy-dom の `<audio>` は中身を読まないので、
 *    「器が出た」までしか言えない。実ブラウザで `readyState` を見て初めて
 *    「**その場で聞ける**」が言える
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

test('🔴 録音を止めると本文に入り、その場で聞ける (#413 段①②)', async ({ page }) => {
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
  /**
   * 🔴 **落ちた回に「どの段で止まったか」を残す**(#473)。
   *
   * ⚠ 素の `toHaveCount(1)` は「**0 だった**」としか言わない ── #473 は
   *   **CI のフル走で 2 度観測して、2 度とも原因に 1 歩も近づいていない**
   *   (2026-08-27 の #472 と #486。どちらも `14 × 0 elements` の 1 行だけ)。
   *
   * 🔑 割りたいのは 3 つ。**どれも「参照が 0 件」からは読めない**:
   *   ① **添付そのものは在るか** ── 在れば「bytes は保存できて**本文の書き換えだけ**
   *      届いていない」、無ければ「録れた物がそもそも保存されていない」。
   *      🔑 これが**段を 2 つに割る**唯一の観測点である
   *   ② **別の綴りで入っていないか** ── `hasText` を外して数えれば分かる
   *      (綴り違いなら 0 にならない)
   *   ③ **画面が何を言っているか**(状態の行 / 収録の帯が残っていないか)
   *
   * ⚠ **本文の原文は開かない** ── 編集に入ると状態が動く。読むのは描かれた面だけ。
   */
  const diag = async (): Promise<string> => {
    const read = async (fn: () => Promise<string>): Promise<string> => {
      try {
        return await fn();
      } catch {
        // ⚠ 読めなかったこと自体が手掛かりなので、握り潰さず字にして残す
        return '(読めない)';
      }
    };
    const assets = await read(async () =>
      String(
        await page
          .locator('[data-pkc-region="filer-table"] tbody tr', { hasText: '録音-' })
          .count(),
      ),
    );
    const anyRef = await read(async () => {
      const all = detail.locator('a[data-pkc-asset-key]');
      const n = await all.count();
      if (n === 0) return '0 件';
      const names = (await all.allTextContents()).map((t) => t.trim().slice(0, 24));
      return `${n} 件 [${names.join(' / ')}]`;
    });
    const band = await read(async () =>
      ((await page.locator('[data-pkc-region="status"]').textContent({ timeout: 1_000 })) ?? '(空)')
        .trim()
        .slice(0, 60),
    );
    const capture = await read(async () =>
      (await page.locator('[data-pkc-region="capture-bar"]').isVisible()) ? '出たまま' : '畳んだ',
    );
    return `添付 ${assets} 件 / 参照 ${anyRef} / 状態「${band}」/ 収録の帯 ${capture}`;
  };

  /**
   * 🔴 **待つ前と、待ち切った後の両方を残す**。
   *
   * ⚠ ここは**待つ** assert なので、待つ前に採った状態は「**5 秒前の姿**」でしかない。
   *   遅れて届いた回と、永久に届かない回が**同じ字**になってしまう。
   * 🔑 だから落ちたときに**もう一度**採り、2 つを並べる ── 差そのものが手掛かりで、
   *   たとえば「添付が 0 → 1 に増えたのに参照は 0 のまま」なら、
   *   **止まっているのは本文の書き換えだけ**と読める。
   */
  const before = await diag();
  const withDiag = async (what: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (e) {
      const after = await diag();
      // ⚠ 元の失敗を `cause` で残す ── 診断で**置き換えない**
      //   (どの assert がどう落ちたかは元の文言にしか無い)
      throw new Error(
        `${what}
  待つ前: ${before}
  待ち切った後: ${after}
${(e as Error).message}`,
        { cause: e },
      );
    }
  };

  // 🔴 **その本文に参照が入っている**(添付だけ増えて迷子にならない)
  const ref = detail.locator('a[data-pkc-asset-key]', { hasText: '録音-' });
  await withDiag('本文に参照が入っていない', async () => {
    await expect(ref, '本文に参照が入っていない').toHaveCount(1);
  });

  // ⚠ **添付そのものも在る**(参照だけ書いて bytes を落としていない)
  await withDiag('添付が作られていない', async () => {
    await expect(
      page.locator('[data-pkc-region="filer-table"] tbody tr', { hasText: '録音-' }),
      '添付が作られていない',
    ).toHaveCount(1);
  });

  /**
   * 🔴 **④ その場で聞ける**(#413 段②)。
   *
   * ⚠ ここは**実ブラウザでしか見られない**層である ── happy-dom の `<audio>` は
   *   中身を読まないので、「本当に鳴らせる形か」は unit では原理的に届かない。
   * 🔑 観測点は **`readyState`**(メタデータまで読めたか)── `src` が付いている
   *   だけなら、壊れた blob URL でも真になる(CLAUDE.md §4「放っておいても
   *   変わる観測点を使わない」の逆側:**中身に依存する点**を採る)。
   */
  const media = detail.locator('[data-pkc-field="body-media"]');
  await expect(media, '本文にその場で聞ける器が出ていない').toHaveCount(1);
  await expect(media, '音なのに音の器ではない').toHaveJSProperty('tagName', 'AUDIO');
  await expect
    .poll(
      () => media.evaluate((el: HTMLMediaElement) => el.readyState),
      { message: '器は出たが、中身を読めていない(URL が死んでいる)' },
    )
    .toBeGreaterThanOrEqual(1);
  // ⚠ **保存の道は残っている**(器を置き換えていない)
  await expect(ref, '再生機を置いたらリンクが消えた').toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
