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
   * ① 🔴 **本当に断片が届いている**。
   * ⚠ 「帯が出た」だけでは足りない ── 1 バイトも録れていない収録でも帯は出る。
   *
   * 🔴 **ここは 2026-08-28 まで空振りだった**(#473 の正体)。
   *   旧稿は `not.toContainText('約 0B')` と書いていたが、帯の字は
   *   `humanBytes` が作るので **`約 0 B`(間に空白)** である
   *   ── #454 で 7 か所の綴りを `512 B` / `2.0 KB` へ寄せたときにずれた。
   * ⚠ つまりこの門は **1 回目の見に必ず真**になり、test は
   *   録り始めた**数ミリ秒後に「止める」を押していた** ── 符号化器が
   *   まだ何も出していない窓で止めるので、`stop()` が `null` を返して
   *   「1 バイトも録れていません」になる。CI でだけ出たのは
   *   **CI のほうが 25〜35% 速い**からである(CLAUDE.md §5 の実測)。
   *
   * 🔑 **否定ではなく肯定で見る** ── `not.toContainText` は綴りがずれた瞬間に
   *   **黙って真**になるが、肯定の形はずれたら**赤くなる**。
   * ⚠ 全体の綴りを写さない(2 本目の書式を置かない)── 見るのは
   *   **量の先頭が 0 以外の数字であること**だけ。`humanBytes` は 1024 未満を
   *   `n B` と書くので、`0.5 KB` のような形は原理的に出ない。
   */
  await expect(status, '1 バイトも積んでいない(断片が届いていない)').toContainText(
    /約 [1-9]/,
    { timeout: 15_000 },
  );

  /**
   * 🔴 **4 秒まで録る**(#683 段②a のため)。
   *
   * ⚠ 断片が 1 つ届いた所で止めると、録音は **1 秒ほど**しかない ── その中で
   *   前後を削っても、印の字は**両方 `0:00`** になり、**どちらの印が付いたのか
   *   test から見分けられない**(`elapsedText` は秒どまり)。
   * 🔑 4 秒あれば `0:01`〜`0:03` を指せるので、**印も名前も見分けが付く**。
   * ⚠ 足したのは**待ち時間 3 秒**だけで、起動は 1 つも増えていない。
   */
  await expect(status, '4 秒まで録れていない').toContainText(/録音中 0:0[4-9]/, {
    timeout: 20_000,
  });

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

  /**
   * 🔴 **⑤ 録った音の前後を削る**(#683 段②a。user 裁定 2026-09-14)。
   *
   * 🔴 **unit では原理的に届かない層**:unit は**自分で組んだ最小の webm**しか
   *   相手にできない(`tests/features/webm-opus.test.ts`)── ここでしか言えないのは
   *   **本物の `MediaRecorder` が吐いた物を切り出して、ブラウザがそれを鳴らせる**
   *   ことである。
   * 🔑 **計器を分ける**(実測 2026-09-14)── 長さは **`<audio>.duration`**、
   *   音が入っているかは**復号**。⚠ `decodeAudioData` は端の指示
   *   (`CodecDelay` / `DiscardPadding`)を**読まない**ので、長さを訊いてはいけない。
   * ⚠ **起動を増やさない** ── 同じ窓の続きでやる(`scripts/smoke-budget.mjs`)。
   */
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="captures"]');
  const rows = page.locator('[data-pkc-capture]');
  await expect(rows, '録ったものが一覧に出ていない').toHaveCount(1);

  await clickReal(page, '[data-pkc-field="capture-play"]');
  const player = page.locator('[data-pkc-capture] [data-pkc-field="capture-media"]');
  await expect(player, 'その場で聞く器が出ていない').toHaveCount(1);
  await expect
    .poll(() => player.evaluate((el: HTMLMediaElement) => el.readyState), {
      message: '器は出たが中身を読めていない',
    })
    .toBeGreaterThanOrEqual(1);

  const mark = page.locator('[data-pkc-field="capture-trim"]');
  await expect(mark, '押し方の案内が出ていない').toContainText('「ここから」');

  /**
   * ⚠ **印は「いま鳴っている所」なので、位置を動かしてから押す。**
   * 🔑 動かせたことを**先に確かめる** ── 動かせていなければ 2 つの印が同じ値になり、
   *   reducer が片方を落とすので、**この段の失敗が「印が付かない」に化ける**
   *   (CLAUDE.md §4「対照群が届かない回は判定不能と書く」)。
   */
  const seek = async (to: number): Promise<void> => {
    await player.evaluate((el: HTMLMediaElement, t) => {
      el.pause();
      el.currentTime = t;
    }, to);
    await expect
      .poll(() => player.evaluate((el: HTMLMediaElement) => el.currentTime), {
        message: `再生位置を ${to} 秒へ動かせない(前提が崩れている)`,
      })
      .toBeCloseTo(to, 1);
  };

  await seek(1.0);
  await clickReal(page, '[data-pkc-field="capture-trim-start"]');
  await expect(mark, '「ここから」の印が付いていない').toContainText('ここから 0:01');

  await seek(3.0);
  await clickReal(page, '[data-pkc-field="capture-trim-end"]');
  await expect(mark, '両方の印がそろっていない').toContainText('0:01〜0:03(0:02)');

  await clickReal(page, '[data-pkc-field="capture-trim-run"]');

  // 🔴 **一覧に 1 件増え、元も残っている**(上書きしない ── 裁定)
  await expect(rows, '切り出したものが一覧に増えていない').toHaveCount(2, { timeout: 15_000 });
  await expect(
    page.locator('[data-pkc-field="capture-name"]', { hasText: '(0:01〜0:03)' }),
    '名前に範囲が入っていない',
  ).toHaveCount(1);

  /**
   * 🔴 **切り出した物が本当に鳴らせる**(この段の本命)。
   * ⚠ `duration` だけでは足りない ── **中身が無音でも合う**。だから
   *   **復号して音が入っていること**まで見る(#683 設計 doc §8)。
   */
  const cutRow = page.locator('[data-pkc-capture]', { hasText: '(0:01〜0:03)' });
  await clickReal(page, '[data-pkc-capture]:has-text("(0:01〜0:03)") [data-pkc-field="capture-play"]');
  const cutPlayer = cutRow.locator('[data-pkc-field="capture-media"]');
  await expect
    .poll(() => cutPlayer.evaluate((el: HTMLMediaElement) => el.readyState), {
      message: '切り出した物を鳴らせない(器が中身を読めていない)',
    })
    .toBeGreaterThanOrEqual(1);
  const cutInfo = await cutPlayer.evaluate(async (el: HTMLMediaElement) => {
    const bytes = await (await fetch(el.src)).arrayBuffer();
    const ctx = new OfflineAudioContext(1, 48000, 48000);
    const buf = await ctx.decodeAudioData(bytes);
    const ch = buf.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < ch.length; i += 1) sum += Math.abs(ch[i]!);
    return { duration: el.duration, bytes: bytes.byteLength, energy: sum / ch.length };
  });
  // 🔑 長さは `<audio>` が言う値で見る(頼んだのは 1.0〜3.0 秒 = 2 秒)
  expect(cutInfo.duration, `切り出した長さが違う(${JSON.stringify(cutInfo)})`).toBeCloseTo(2.0, 1);
  // 🔑 **音が入っている**(無音を作っていない)
  expect(cutInfo.energy, `音が入っていない(${JSON.stringify(cutInfo)})`).toBeGreaterThan(0);
  // ⚠ **元より小さい**(丸ごと写していない)
  expect(cutInfo.bytes, '切り出したのに元と同じ大きさ').toBeLessThan(38_000);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
