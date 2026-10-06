import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';
import { chromiumLaunch } from './playwright.config';
// ⚠ 手で書き写さない ── `[data-pkc-field="capture-trim"]` の textContent は
//   `trimMarkText()` の戻り値そのもの(`captures.ts`)。字を直した日に
//   両方そのままで緑にならないよう、実装の出力を直に引く。
import { trimMarkText } from '../../src/features/audio/trim-text';
// ⚠ 音声認識の部品の名前・大きさの下限は**実装の定数から引く**(手で並べると、定数を差し替えた日に
//   この偽の部品だけが古い構成のまま緑になる)。alias を持たない pure な定数だけを引く。
import {
  ASR_PARTS,
  ASR_RUNTIME_FILES,
  asrMemoryNote,
  asrModelDir,
  asrModelFloorBytes,
} from '../../src/features/asr/asr-parts';
import { createHash } from 'node:crypto';

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
  /**
   * 🔴 **「繋いだこと」を数える計器**(#772 段① B)。
   *
   * ⚠ 段⑥ の「入にしても進む」だけでは**空振りする** ── **1 度も繋がなくても**
   *   音は普通に進むので、`currentTime` が動いたことは
   *   「整える鎖を通った」証拠に**ならない**(CLAUDE.md §1)。
   * 🔑 だから**器と横取りの回数を数える** ── アプリより先にこれを仕込むので、
   *   アプリ側のコードは 1 行も変えずに観測できる。
   * ⚠ 数えるだけで、**素の `AudioContext` の振る舞いは変えない**。
   */
  await page.addInitScript(() => {
    const w = window as unknown as {
      AudioContext: typeof AudioContext;
      __pkcAudio?: { ctx: number; src: number };
    };
    const mark = { ctx: 0, src: 0 };
    w.__pkcAudio = mark;
    const Real = w.AudioContext;
    w.AudioContext = class extends Real {
      constructor(...args: ConstructorParameters<typeof AudioContext>) {
        super(...args);
        mark.ctx += 1;
        const orig = this.createMediaElementSource.bind(this);
        this.createMediaElementSource = (el: HTMLMediaElement): MediaElementAudioSourceNode => {
          mark.src += 1;
          return orig(el);
        };
      }
    } as unknown as typeof AudioContext;
  });
  /**
   * 🔴 **端末のメモリを小さく見せる**(#772 段② の台)── 実機の値は箱で変わるので、
   * 「押す前に出る案内」を**どの箱でも**見られるよう、読ませる値を固定する。
   * ⚠ `navigator.deviceMemory` を差すだけで、ほかの動きは変えない(音声認識の節だけが読む)。
   */
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'deviceMemory', { value: 2, configurable: true });
  });
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
  await expect(mark, '押し方の案内が出ていない').toHaveText(trimMarkText(null, null));

  /**
   * 🔴 **説明文の位置**(#683 の裁定 C)── 目印が 1 つも無いあいだは**ボタンより前**、
   *   付けたら**ボタンの後ろ**。⚠ 実ブラウザの DOM の順で見る(帯は印のたびに組み直される)。
   */
  const noteBeforeButtons = (): Promise<boolean> =>
    mark.evaluate((note) => {
      const start = note.parentElement?.querySelector('[data-pkc-field="capture-trim-start"]');
      return start != null && (note.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
  expect(await noteBeforeButtons(), '目印が無いのに、説明文がボタンの後ろに居る').toBe(true);

  /**
   * ⚠ **印は「いま鳴っている所」なので、位置を動かしてから押す。**
   * 🔑 動かせたことを**先に確かめる** ── 動かせていなければ 2 つの印が同じ値になり、
   *   reducer が片方を落とすので、**この段の失敗が「印が付かない」に化ける**
   *   (CLAUDE.md §4「対照群が届かない回は判定不能と書く」)。
   */
  /**
   * 🔴 **止めてから合わせる**。⚠ **止まっていることまで見る** ──
   *   鳴ったままだと、`clickReal`(要素まで送って押す)の**数十〜百数十ミリ秒**の
   *   あいだに位置が進み、**押した所が読んだ値と違う**。
   *   🔑 実際、これで 1 度 0.12 秒ずれた(2.12 対 2.00)── ⚠ **切り出しの側は
   *   正しい**(本物の録音 2 本を 1.0〜3.0 で切って、ブラウザが `duration` を
   *   **2 ちょうど**と答えるのを実測済み)。⚠ だから**緩めずに、前提のほうを検める**。
   */
  const seek = async (to: number): Promise<number> => {
    /**
     * 🔴 **合わせ終わるまで待つ**(`seeked`)。
     *
     * ⚠ `currentTime` に代入すると、**その値がすぐ読み返せる**が、
     *   それは「頼んだ値」であって「落ち着いた値」ではない ── `MediaRecorder` の
     *   webm は `Cues` を持たないので、ブラウザは近い所から**前へ解いて**落ち着く。
     *   🔑 だから合わせた直後に読むと、後から動く値を掴む。
     */
    await player.evaluate(
      async (el: HTMLMediaElement, t) =>
        new Promise<void>((done) => {
          el.pause();
          if (Math.abs(el.currentTime - t) < 0.001) {
            done();
            return;
          }
          el.addEventListener('seeked', () => done(), { once: true });
          el.currentTime = t;
        }),
      to,
    );
    await expect
      .poll(() => player.evaluate((el: HTMLMediaElement) => el.seeking), {
        message: `再生位置を ${to} 秒へ動かし終えていない`,
      })
      .toBe(false);
    const at = await player.evaluate((el: HTMLMediaElement) => ({
      currentTime: el.currentTime,
      paused: el.paused,
    }));
    expect(
      at.paused,
      `止めたのに鳴っている(${at.currentTime.toFixed(3)} 秒)── 押すまでに位置が進むので、印が読んだ値とずれる`,
    ).toBe(true);
    // ⚠ **落ち着いた値が頼んだ所の近くに在る**(`Cues` が無いので、ぴったりとは限らない)
    expect(at.currentTime, `${to} 秒へ合わせたのに ${at.currentTime.toFixed(3)} 秒に居る`).toBeCloseTo(
      to,
      1,
    );
    // 🔑 **押す直前の実測値を返す** ── 切り出しの長さは「頼んだ 2 秒」ではなく
    //    **押した所の差**で決まる
    return at.currentTime;
  };

  const at0 = await seek(1.0);
  await clickReal(page, '[data-pkc-field="capture-trim-start"]');
  await expect(mark, '「ここから」の印が付いていない').toContainText('ここから 0:01');
  expect(await noteBeforeButtons(), '目印を付けたのに、説明文が前に居座っている').toBe(false);
  /**
   * 🔴 **印を付けても、聞いている器は作り直されない**(この段で見つけた欠陥)。
   * ⚠ 作り直されると `<audio>` が**頭へ戻って鳴り出す** ── 印は「聞きながら」
   *   押すものなので、それでは動線が成り立たない。
   * 🔑 観測点は**同じ器か**(`currentTime` が保たれているか)。
   */
  await expect
    .poll(() => player.evaluate((el: HTMLMediaElement) => el.currentTime), {
      message: '印を付けたら、聞いていた所が頭へ戻った(器が作り直されている)',
    })
    .toBeCloseTo(at0, 1);

  const at1 = await seek(3.0);
  await clickReal(page, '[data-pkc-field="capture-trim-end"]');
  // ⚠ **押した後も止まったまま**(押す前後で位置が動いていないことを、その場で採る)
  const after = await player.evaluate((el: HTMLMediaElement) => ({
    currentTime: el.currentTime,
    paused: el.paused,
  }));
  expect(
    after.currentTime,
    `押している間に位置が動いた(${at1.toFixed(3)} → ${after.currentTime.toFixed(3)} 秒、paused=${String(after.paused)})`,
  ).toBeCloseTo(at1, 1);
  await expect(mark, '両方の印がそろっていない').toContainText('0:01〜0:03(0:02)');

  await clickReal(page, '[data-pkc-field="capture-trim-run"]');

  // 🔴 **一覧に 1 件増え、元も残っている**(上書きしない ── 裁定)
  await expect(rows, '切り出したものが一覧に増えていない').toHaveCount(2, { timeout: 15_000 });
  /**
   * 🔴 **さっきまで見ていたノートが退いていない**(着地前の動線レビュー 欠陥 1)。
   * ⚠ `CREATE_ENTRY` は**選択を作った添付へ移す**ので、返さないと中央が
   *   「定例会議」から**切り出したばかりの添付**に化ける ── user は
   *   「録音を切っただけなのに、読んでいたノートが閉じられた」と読む(#300 / #666)。
   */
  await expect(detail, '切り出したら、読んでいたノートが画面から消えた').toContainText('定例会議');
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
    /**
     * 🔴 **大きさは復号の前に採る**(この段で見つけた空振り)。
     * ⚠ `decodeAudioData` は渡された `ArrayBuffer` を**手放させる**(detach)ので、
     *   後から `byteLength` を読むと**必ず 0** ── 「元より小さい」を見る assert が
     *   **中身に関わらず通る**(§1 空振り)。
     */
    const size = bytes.byteLength;
    /**
     * 🔴 **長さは「読み終えた器」で測る**(この段で 5 回赤くして分かった)。
     *
     * ⚠ 画面の器は `autoplay` で鳴らしながら読んでいるので、`readyState` が
     *   メタデータまで来た時点の `duration` は **最後の block の時刻**である ──
     *   最後の packet の長さも、頭と尻の札も、まだ効いていない。
     *   実測(同じ file、2 回とも一致):
     *   **最後の block 2100ms → 2.10 と答え / 2040ms → 2.04 と答える**。
     *   ⚠ そして**読み終えると 2 ちょうど**になる(器を作り直して測ると一致)。
     * 🔑 だから**この file だけを読む器を 1 つ作って**測る ── 見たいのは
     *   「**作った file が頼んだ長さか**」であって、画面の器の読み込み具合ではない。
     * ⚠ `new Blob([bytes])` は**写しを作る**ので、この後の復号で `bytes` が
     *   手放されても、こちらの器には効かない。
     */
    const probe = document.createElement('audio');
    probe.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/webm' }));
    const duration = await new Promise<number>((res) => {
      probe.onloadedmetadata = (): void => res(probe.duration);
      probe.onerror = (): void => res(Number.NaN);
      setTimeout(() => res(Number.NaN), 5000);
    });
    URL.revokeObjectURL(probe.src);
    const ctx = new OfflineAudioContext(1, 48000, 48000);
    const buf = await ctx.decodeAudioData(bytes);
    const ch = buf.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < ch.length; i += 1) sum += Math.abs(ch[i]!);
    // ⚠ `screenDuration` は診断用 ── 画面の器が途中の値を返すことの記録
    return { duration, screenDuration: el.duration, bytes: size, energy: sum / ch.length };
  });
  /**
   * 🔑 **長さは「押した所の差」と突き合わせる**(「頼んだ 2 秒」ではない)。
   * ⚠ `seek` の門は ±0.05 を許すので、2.0 と直に比べると**計器の遊びで落ちる**
   *   ── 実際 1 度それで赤くなった(2.1 対 2.0)。製品の約束は
   *   「**押した所のとおりに切れる**」であって「ちょうど 2 秒」ではない。
   */
  const wanted = at1 - at0;
  expect(
    cutInfo.duration,
    `押した所(${at0.toFixed(3)}〜${at1.toFixed(3)} = ${wanted.toFixed(3)} 秒)のとおりに切れていない(${JSON.stringify(cutInfo)})`,
  ).toBeCloseTo(wanted, 1);
  // 🔑 **音が入っている**(無音を作っていない)
  expect(cutInfo.energy, `音が入っていない(${JSON.stringify(cutInfo)})`).toBeGreaterThan(0);
  // ⚠ **元より小さい**(丸ごと写していない)。⚠ 0 でないことも見る(空振り防止)
  expect(cutInfo.bytes, '大きさを測れていない(復号の後に読んでいる)').toBeGreaterThan(0);
  expect(cutInfo.bytes, '切り出したのに元と同じ大きさ').toBeLessThan(38_000);

  /**
   * ## 段⑥ ── **聞きやすくする を入れても、音が止まらない**(#772 段① B)
   *
   * 🔴 **ここでしか通らない道が在る。** 整える鎖は `AudioContext` の上に組むが、
   *   **happy-dom に `AudioContext` は無い**ので、`webAudioHost()` は
   *   **単体テストから 1 度も実行されない**(CLAUDE.md §2「経路が一度も通っていない」)。
   *
   * 🔴 そして**この機能がいちばん恐れているのは無音**である ── 鎖を通した要素は、
   *   器が止まっていると**進まない**(再生機は押せるのに動かない)。
   *
   * ⚠ **対照群を先に採る**(CLAUDE.md §4)── 切のまま進むことを見てから入にする。
   *   ⚠ 対照群が進まない回は「**この箱では鳴らせない**」であって、製品の判定はできない
   *   ── そう読める文言で落とす。
   *
   * 🔑 起動は増やさない ── **同じ窓の続き**で面を行き来するだけである。
   */
  /**
   * 鳴らして、`currentTime` が動くまで待つ。⚠ 返すのは**進んだ秒数**。
   *
   * ⚠ **鳴らす口は 2 通りある**(1 稿目はここを外して 3 回とも赤くした)── この面は
   *   `this.playing?.lid === item.lid` で**排他に**描くので、
   *   **既に開いている行に「聞く」は無い**(在るのは器と「閉じる」)。
   *   🔑 だから**在るほうを使う**:押していなければ「聞く」、開いていれば器そのもの。
   */
  const playsOn = async (label: string): Promise<number> => {
    if ((await cutRow.locator('[data-pkc-field="capture-play"]').count()) > 0) {
      await clickReal(
        page,
        '[data-pkc-capture]:has-text("(0:01〜0:03)") [data-pkc-field="capture-play"]',
      );
    }
    const el = cutRow.locator('[data-pkc-field="capture-media"]');
    await expect(el, `${label}:再生機が画面に出ていない`).toBeVisible();
    /**
     * ⚠ **鳴らせなかったのか、鳴っているのに進まないのか**を分ける ──
     *   前者は**この箱の都合**(ブラウザが音を止めた)、後者は**製品の欠陥**である。
     */
    const started = await el.evaluate((m: HTMLMediaElement) => {
      m.currentTime = 0;
      return m.play().then(
        () => 'ok',
        (e: unknown) => String(e),
      );
    });
    expect(started, `${label}:ブラウザが再生を断った(この箱の都合 ── 判定不能)`).toBe('ok');
    await expect
      .poll(() => el.evaluate((m: HTMLMediaElement) => m.currentTime), {
        message: `${label}:鳴らし始めたのに再生機が進まない`,
        timeout: 8000,
      })
      .toBeGreaterThan(0.02);
    const at = await el.evaluate((m: HTMLMediaElement) => m.currentTime);
    await el.evaluate((m: HTMLMediaElement) => m.pause());
    return at;
  };
  const counts = async (): Promise<{ ctx: number; src: number }> =>
    page.evaluate(
      () => (window as unknown as { __pkcAudio: { ctx: number; src: number } }).__pkcAudio,
    );

  // ⚠ **対照群**(切のまま)── ここが落ちたら、以降は判定不能である
  const plainAt = await playsOn('この箱では音が進まない(以降は判定不能)');
  /**
   * 🔴 **切のままなら、音の通り道に触っていない**(この機能の最重要の約束)。
   * ⚠ 触ってしまうと、その再生機は以後**鎖なしでは鳴らない**体になる。
   */
  expect(
    await counts(),
    '切のままなのに音の通り道を横取りしている(以後、鎖なしでは鳴らない体になる)',
  ).toEqual({ ctx: 0, src: 0 });

  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await clickReal(page, '[data-pkc-field="voice-boost"]');
  await expect(
    page.locator('[data-pkc-field="voice-boost"]'),
    '設定を押したのに印が付かない',
  ).toBeChecked();

  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="captures"]');
  const boostedAt = await playsOn('🔴 聞きやすくする を入れたら音が止まった(無音の形)');
  expect(
    boostedAt,
    `対照群 ${plainAt.toFixed(3)} は進んだのに、入にしたら進まない`,
  ).toBeGreaterThan(0.02);
  /**
   * 🔴 **空振り防止** ── 上の「進んだ」は、**1 度も繋がなくても**成り立つ。
   * 🔑 だから「本当に鎖を通したこと」を、数えた回数で確かめる。
   */
  const on = await counts();
  expect(on.src, '入にしたのに、音の通り道を 1 度も通していない(整っていない)').toBeGreaterThan(0);
  expect(on.ctx, '器を作っていない / 再生機ごとに作り直している').toBe(1);

  // 🔴 **切に戻しても進む**(外して終わりにしていない = 無音にしていない)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await clickReal(page, '[data-pkc-field="voice-boost"]');
  await expect(page.locator('[data-pkc-field="voice-boost"]')).not.toBeChecked();
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="captures"]');
  await playsOn('🔴 切に戻したら音が止まった(出口へつなぎ直していない)');
  // ⚠ 切に戻しても**器は捨てない**(捨てると、通している音が無音になる)
  expect(await counts(), '切に戻したときに器を作り直している').toEqual({ ...on, src: on.src });

  /**
   * ## 段⑦ ── **音声認識(文字にする)**(#772 段②)
   *
   * 🔴 **unit では原理的に届かない層**:
   *  ① **本物のワーカー** ── 部品(blob: の ESM)を `import()` して、結果を返す
   *  ② **本物の `AudioContext`** ── 録った webm を復号して、16kHz の PCM にできるか
   *  ③ **本物の IndexedDB** ── 取り込んだ部品を Blob のまま置き、読み戻して worker へ渡せるか
   *  ④ 押す前のメモリの案内が**ボタンの下**に実際に出る(DOM の順だけでは位置は言えない)
   *
   * 🔴 **本物の重みは CI に無い**(81MB / 254MB)ので、**偽の部品**を `page.route` で返す:
   *   実行の部品は「`pipeline` が決まった字を返す」だけの小さな ESM、重みは**ゼロ詰め**(目録の
   *   下限を満たす大きさだけ)。⚠ だからここが言えるのは**仕組みの配線**であって、
   *   **認識の当たり具合・本物の重みでの動作は言えない**(本物の transformers + ORT + whisper-base を
   *   blob 経由で実走した結果は別 ── 報告に書く)。
   * ⚠ **起動は増やさない** ── 同じ窓の続きで、システムと「音/動画」を行き来するだけである。
   */
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
  const light = ASR_PARTS[0]!;
  const FAKE_TEXT = '偽の文字起こし';
  const jsText = [
    'export const env = { backends: { onnx: { wasm: {} } } };',
    // 🔑 #1232 段 a: 時刻つきの区切り(`chunks`。秒)も返す ── 末尾の終わりは null(whisper の仕様)
    `export async function pipeline() { return async (pcm) => ({ text: '${FAKE_TEXT}:' + pcm.length, chunks: [`,
    `  { timestamp: [0, 2.5], text: ' 一行目の偽の字' }, { timestamp: [65.2, null], text: '${FAKE_TEXT}:' + pcm.length }] }); }`,
    // ⚠ 目録の下限(約 100KB)を満たす大きさまで、注釈で埋める
    ...Array.from({ length: 2500 }, (_, i) => `// padding ${i} ${'x'.repeat(40)}`),
  ].join('\n');
  /** 偽の部品 1 件。⚠ 中身は**ページの中で作る**(46MB を引数で渡さない)── `text` か `zeros`(ゼロ詰めの長さ)。 */
  type FakeFile = { path: string; text?: string; zeros?: number };
  const fakeSpec: FakeFile[] = [
    { path: ASR_RUNTIME_FILES[0]!, text: jsText },
    { path: ASR_RUNTIME_FILES[1]!, text: '// loader\n'.repeat(1000) },
    { path: ASR_RUNTIME_FILES[2]!, zeros: 5_100_000 },
    { path: `${asrModelDir(light)}config.json`, text: '{"fake":true}' },
    // 重みは「目録の下限(定数の半分)」を満たす大きさだけのゼロ詰め
    {
      path: `${asrModelDir(light)}onnx/model_quantized.onnx`,
      zeros: asrModelFloorBytes(light) + 1000,
    },
  ];
  const entryOf = (f: FakeFile): { path: string; bytes: number; sha256: string } => {
    const bytes = f.text !== undefined ? Buffer.byteLength(f.text) : f.zeros!;
    // ⚠ 32MB を超える物は sha256 を照合しない(実装の作り)── ここは形が合う値を入れるだけ
    const sha256 =
      bytes > 32 * 1024 * 1024 ? 'f'.repeat(64) : sha(f.text !== undefined ? Buffer.from(f.text) : Buffer.alloc(f.zeros!));
    return { path: f.path, bytes, sha256 };
  };
  const manifest = JSON.stringify({
    version: 'smoke-1',
    runtime: fakeSpec.filter((f) => ASR_RUNTIME_FILES.includes(f.path)).map(entryOf),
    models: { light: fakeSpec.filter((f) => f.path.startsWith('models/')).map(entryOf) },
  });
  /**
   * 🔴 **`page.route` ではなく、ページの `fetch` を差す**。⚠ PKC3 は service worker を登録しており、
   * その `respondWith` が要求を受けるので **`page.route` は当たらない**(`external-images.smoke.spec.ts`
   * の 404 の注記と同じ ── 当てると SPA の index.html が 200 で返って「目録として読めません」になる)。
   * 🔑 差すのは**この 1 か所だけ**(`/asr-pack/` を含む URL)で、ほかの要求は素の `fetch` へ通す。
   * ⚠ 取りに行った path を数える(同一オリジンの `/asr-pack/` だけから取った / 2 回目は取らない、を見るため)。
   */
  await page.evaluate(
    ({ spec, manifestText }) => {
      const w = window as unknown as { __asrRequests?: string[] };
      w.__asrRequests = [];
      const real = window.fetch.bind(window);
      const enc = new TextEncoder();
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const u = new URL(raw, location.href);
        if (!u.pathname.includes('/asr-pack/')) return real(input, init);
        w.__asrRequests!.push(u.pathname);
        const rel = decodeURIComponent(u.pathname.replace(/^.*\/asr-pack\//, ''));
        if (rel === 'pack.json') return new Response(manifestText, { status: 200 });
        const f = spec.find((x) => x.path === rel);
        if (f === undefined) return new Response('nf', { status: 404 });
        return new Response(f.text !== undefined ? enc.encode(f.text) : new Uint8Array(f.zeros ?? 0), { status: 200 });
      };
    },
    { spec: fakeSpec, manifestText: manifest },
  );
  const asrRequests = (): Promise<string[]> =>
    page.evaluate(() => (window as unknown as { __asrRequests: string[] }).__asrRequests);

  const statusLine = page.locator('[data-pkc-region="status"]');
  const originalRow = page.locator('[data-pkc-capture]:not(:has-text("(0:01〜0:03)"))').first();

  // 入口と節の字は**画面から読む**(案内の字がこれと一致することを見る ── 手で「システム → 保存領域 → 音声認識」と書かない)
  const settingsTab = '[data-pkc-action="set-view"][data-pkc-view="settings"]';
  await clickReal(page, settingsTab);
  const navLabel = ((await page.locator(settingsTab).first().textContent()) ?? '').trim();
  const asrSection = page.locator('[data-pkc-region="settings-asr"]');
  await asrSection.scrollIntoViewIfNeeded();
  const sectionLabel = ((await asrSection.locator('h4').textContent()) ?? '').trim();
  // 音声認識の節は「保存領域」の節の中に在る ── 案内の道順はその見出しも通る
  const storageLabel = (
    (await page.locator('[data-pkc-region="settings-storage"] > h3').first().textContent()) ?? ''
  ).trim();
  expect(navLabel.length, '入口の名前を読めていない').toBeGreaterThan(0);
  expect(storageLabel.length, '保存領域の見出しを読めていない').toBeGreaterThan(0);
  expect(sectionLabel.length, '節の見出しを読めていない').toBeGreaterThan(0);
  const asrPath = `${navLabel} → ${storageLabel} → ${sectionLabel}`;

  // ④ 🔴 押す前に、メモリの案内が**ボタンの下**に出る。ボタンは押せるまま
  const installLight = asrSection.locator(
    '[data-pkc-action="install-asr-part"][data-pkc-part="light"]',
  );
  const memoryNote = asrSection.locator('[data-pkc-part="light"] [data-pkc-field="asr-memory-note"]');
  await expect(installLight, '取り込むボタンが出ていない').toBeVisible();
  await expect(memoryNote, 'メモリが足りない見込みの端末なのに、案内が出ていない').toBeVisible();
  expect(await memoryNote.textContent(), '案内の字が実装の出力と違う').toBe(asrMemoryNote(light, 2));
  const btnBox = (await installLight.boundingBox())!;
  const noteBox = (await memoryNote.boundingBox())!;
  expect(noteBox.y, '案内がボタンの下に出ていない(同じ高さか上)').toBeGreaterThanOrEqual(
    btnBox.y + btnBox.height - 1,
  );
  await expect(installLight, '案内を出した端末でボタンを塞いだ').toBeEnabled();
  expect(await installLight.textContent(), 'ボタンの字に大きさと説明が無い').toMatch(
    /約 [\d.]+ MB、1 分の音に約 \d+ 秒/,
  );
  expect(await asrRequests(), '押す前に部品を取りに行った(勝手に取りに行かない)').toEqual([]);

  // ① 部品が無いまま「文字にする」→ 取り込みへ案内する(押して無言にしない)
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="captures"]');
  await clickReal(page, originalRow.locator('[data-pkc-field="capture-transcribe"]'));
  await expect(statusLine, '部品が無いのに案内が出ない').toContainText(
    asrPath,
  );
  expect(await asrRequests(), '部品が無いのに取りに行った').toEqual([]);

  // ③ 取り込む → 「取り込み済み」(取り込むボタンは隠れ、消すボタンが出る)
  await clickReal(page, settingsTab);
  await clickReal(page, installLight);
  const installed = asrSection.locator('[data-pkc-part="light"] [data-pkc-field="asr-installed"]');
  await expect(installed, '取り込んだのに「取り込み済み」が出ない')
    .toBeVisible({ timeout: 60_000 })
    .catch(async (e: unknown) => {
      // ⚠ 落ちた回に「画面が何と言っていたか / 何を取りに行ったか」を残す(「hidden」だけでは原因に近づけない)
      const said = ((await statusLine.textContent().catch(() => null)) ?? '(読めない)').trim().slice(0, 200);
      const progress = ((await asrSection.locator('[data-pkc-field="asr-progress"]').textContent().catch(() => null)) ?? '').trim();
      throw new Error(
        `${(e as Error).message}\n  状態の行: ${said}\n  進み: ${progress}\n  取りに行った: ${(await asrRequests().catch(() => [])).join(', ')}\n  page error: ${errors.join(' / ')}`,
        { cause: e },
      );
    });
  await expect(installed).toContainText('取り込み済み');
  await expect(installLight, '取り込み済みなのに取り込むボタンが残っている').toBeHidden();
  await expect(
    asrSection.locator('[data-pkc-action="remove-asr-part"][data-pkc-part="light"]'),
  ).toBeVisible();
  // ⚠ もう一方(当たりやすい)は影響を受けない
  await expect(
    asrSection.locator('[data-pkc-action="install-asr-part"][data-pkc-part="accurate"]'),
  ).toBeVisible();
  // 🔴 部品は同一オリジンの /asr-pack/ だけから取った(目録 1 + 実行の部品と重みの全部)
  const afterInstall = await asrRequests();
  expect(
    afterInstall.length,
    `取った file の数が目録と合わない: ${afterInstall.join(', ')}`,
  ).toBe(1 + fakeSpec.length);
  const firstRound = afterInstall.length;

  // ① 取り込んだ後に「文字にする」→ 録音のノートの末尾に、見出しつきで足される
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="captures"]');
  const transcribe = originalRow.locator('[data-pkc-field="capture-transcribe"]');
  await clickReal(page, transcribe);
  await expect(statusLine, '文字を足したと言っていない').toContainText('文字起こしを足しました', {
    timeout: 60_000,
  });
  // 終わったらボタンは元の字・押せる状態に戻る(「文字にしています…」で止まらない)
  await expect(transcribe).toHaveText('文字にする');
  await expect(transcribe).toBeEnabled();
  // 🔴 2 回目は取りに行かない(部品は端末の保管から読む)
  expect((await asrRequests()).length, '文字にするたびに部品を取りに行っている').toBe(firstRound);

  // 足された本文を、そのノートを開いて**目で読む**(状態ではなく画面)
  await clickReal(page, originalRow.locator('[data-pkc-field="capture-name"]'));
  const body = page.locator('[data-pkc-view-pane="detail"]');
  await expect(body, 'ノートの末尾に日時の見出しが足されていない').toContainText(
    /文字起こし \d{4}-\d{2}-\d{2} \d{2}:\d{2}/,
  );
  // 🔴 #1232 段 a: 行ごとに「時刻 字」で足され、1 段落の中で改行(<br>)で割れて見える
  await expect(body, '時刻つきの行(0:00 …)が本文に足されていない').toContainText('0:00 一行目の偽の字');
  await expect(body, '2 行目の時刻(1:05)が本文に無い').toContainText(`1:05 ${FAKE_TEXT}:`);
  await expect(body.locator('p', { hasText: '0:00 一行目の偽の字' }).locator('br'), '行が改行で割れていない').toHaveCount(1);
  const m = new RegExp(`${FAKE_TEXT}:(\\d+)`).exec((await body.textContent()) ?? '');
  expect(m, '偽の部品が返した字が本文に入っていない').not.toBeNull();
  // 🔑 本物の録音を本物の AudioContext で 16kHz に復号した長さ(録音は 4 秒以上)
  expect(Number(m![1]), '復号した音の長さが短すぎる(16kHz で 2 秒未満)').toBeGreaterThan(16_000 * 2);
  expect(Number(m![1]), '復号した音の長さが長すぎる(16kHz で 60 秒超)').toBeLessThan(16_000 * 60);
  // 🔴 元の録音は残っている(添付の情報も、その場で聞ける器も)── 足しただけで、上書きしていない
  await expect(body.locator('[data-pkc-field="attachment-info"]'), '追記したのに添付の情報が消えた').toBeVisible();
  await expect(body.locator('[data-pkc-field="attachment-media"]'), '追記したのに録音の器が消えた').toHaveCount(1);
  /**
   * 🔴 #1232 段 b: 行頭の時刻を押すと、**同じ詳細の再生機**がその位置へ動く(`<audio>` の `currentTime` を読む)。
   * ⚠ 押せる字は本文の描画物なので、unit(happy-dom)は再生機を**模して**しか動かせない ──
   *   実ブラウザで、実際に差された `<audio>` が実際に動くことをここで見る。
   * ⚠ 偽の部品の区切りは `0:00` と `1:05`(録音は数秒)── 録音の長さを超える `1:05` を押す =
   *   **末尾へ寄せられる**はずで、`0:00` の字は「先頭」なので動きを見るには使えない。
   */
  const seekPlayer = body.locator('audio[data-pkc-field="attachment-media"]');
  await expect
    .poll(() => seekPlayer.evaluate((a: HTMLAudioElement) => a.readyState), { message: '再生機が読み込めていない' })
    .toBeGreaterThanOrEqual(1);
  const seekLink = body.locator('[data-pkc-action="seek-media"][data-pkc-seek-ms="65000"]');
  await expect(seekLink, '行頭の 1:05 が押せる字になっていない').toHaveText('1:05');
  expect(await seekPlayer.evaluate((a: HTMLAudioElement) => a.currentTime), '前提: 再生機が先頭に居ない').toBeLessThan(1);
  await clickReal(page, seekLink);
  await expect
    .poll(() => seekPlayer.evaluate((a: HTMLAudioElement) => a.currentTime), {
      // ⚠ 時間を短く切る ── 位置を動かさず**先頭から鳴らしただけ**でも、数秒待てば 1 を超える。押した直後に末尾近くへ居ることを見る
      timeout: 1500,
      message: '時刻を押しても再生機が末尾へ動かない(1:05 は録音より後ろ)',
    })
    .toBeGreaterThanOrEqual(2);
  // 🔑 押せる字は行頭の 2 つだけ(区切りの数と同じ)
  await expect(body.locator('[data-pkc-action="seek-media"]'), '行頭の時刻が行の数だけ出ていない').toHaveCount(2);
  /**
   * 🔴 #1232 段 b(Gemini 裁定 Q3 = B / Q4 = B): **音の再生機は、スクロールしても画面の上に貼り付いて見え続ける** /
   * 時刻に載せると「0:15 から再生」が出る(`title`)。
   * ⚠ 貼り付くのは `<audio>` ではなく**それを包む器**(`<audio>` の親は音の高さしか持たず、そこでは動けない)──
   *   unit(happy-dom)は配置を計算しないので、実ブラウザで**本当に貼り付くか**をここで見る。
   * 🔑 説明を長くする代わりに、説明の末尾へ 3000px の空き箱を足して**読む面の唯一の scroll 箱**
   *   (`[data-pkc-region='detail']`)を 2000px 送る(録音の文字起こしは数行しかないので、そのままでは送れない)。
   *   空き箱は**説明の中**(= 再生機の器の兄弟の中)に足す ── 貼り付きの範囲が「添付の面全体」であることも同時に見る。
   * ⚠ 貼り付き先は**操作の帯**(`detail-bar-slot`・sticky)の**下**(帯の下に隠れない)── 箱の上端ではない。
   *   帯の高さは `detail.ts` が測って渡す(2 段に折れる幅・留めた枠では 34px でない)── 測りは unit(`detail-seek-links`)が見る。
   */
  const stick = await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
    const audio = box.querySelector<HTMLElement>('audio[data-pkc-field="attachment-media"]')!;
    const link = box.querySelector<HTMLElement>('.pkc-seek-link')!;
    const bar = box.querySelector<HTMLElement>('[data-pkc-field="detail-bar-slot"]')!;
    const desc = box.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
    const spacer = document.createElement('div');
    spacer.setAttribute('data-pkc-probe', 'sticky-spacer');
    spacer.style.height = '3000px';
    desc.append(spacer);
    const top0 = { audio: audio.getBoundingClientRect().top, box: box.getBoundingClientRect().top };
    box.scrollTop = 2000;
    const r = {
      scrolled: box.scrollTop,
      boxTop: box.getBoundingClientRect().top,
      barBottom: bar.getBoundingClientRect().bottom,
      audioTop: audio.getBoundingClientRect().top,
      linkTop: link.getBoundingClientRect().top,
      title: link.getAttribute('title'),
      label: link.getAttribute('aria-label'),
      top0,
    };
    const wrap = audio.parentElement!;
    const style = getComputedStyle(wrap);
    return {
      ...r,
      wrapBackground: style.backgroundColor,
      wrapZIndex: style.zIndex,
      wrapBottom: wrap.getBoundingClientRect().bottom,
    };
  });
  expect(stick.scrolled, '前提: 読む面が 1000px 以上送れていない(貼り付きを見る場面が作れていない)').toBeGreaterThan(1000);
  expect(stick.linkTop, '対照群: 先頭の時刻が画面の上へ流れていない(= 送れていない)').toBeLessThan(stick.boxTop);
  expect(
    Math.abs(stick.audioTop - stick.barBottom),
    `音の再生機が操作の帯の直下に貼り付いていない(再生機 top=${stick.audioTop} / 帯の下端=${stick.barBottom} / 送る前=${stick.top0.audio})`,
  ).toBeLessThanOrEqual(2);
  expect(stick.top0.audio, '前提: 送る前の再生機は貼り付き位置より下に居る(本文の先頭にある)').toBeGreaterThan(stick.barBottom + 2);
  // 🔑 前提:帯が実在して高さを持つ(帯が 0px に潰れると「帯の下端 = 箱の上端」で上の assert が空振りで通る)
  expect(stick.barBottom - stick.boxTop, '前提が崩れている: 操作の帯の高さが 20px 以下(帯が無い / 潰れている)').toBeGreaterThan(20);
  // 🔴 貼り付いた器は**地を塗り、重なりの順を持つ**(塗らないと本文の字が再生機の下から透ける)
  expect(stick.wrapBackground, '貼り付いた器の地が透明(本文が透ける)').not.toBe('rgba(0, 0, 0, 0)');
  expect(stick.wrapZIndex, '貼り付いた器に z-index が無い(本文の押せる物の下に潜る)').not.toBe('auto');
  // 🔴 紙には貼り付かない(`@media print` が解く)── 同じ器の配置を、画面と印刷で比べる(対照群 = 画面は sticky)
  const previewPosition = (): Promise<string> =>
    page.evaluate(
      () => getComputedStyle(document.querySelector('audio[data-pkc-field="attachment-media"]')!.parentElement!).position,
    );
  expect(await previewPosition(), '画面で再生機の器が sticky でない').toBe('sticky');
  await page.emulateMedia({ media: 'print' });
  expect(await previewPosition(), '印刷でも再生機の器が貼り付いたまま').toBe('static');
  await page.emulateMedia({ media: 'screen' });
  /**
   * 🔴 **目次から見出しへ飛んでも、見出しが帯 + 再生機の下に隠れない**(#1232 段 b)。
   * ⚠ 直す前は帯(34px)の下にすら隠れていた(見出しの top が 0.4px ── 再生機と無関係の既存の欠陥)。
   *   `scrollIntoView({ block: 'start' })` は貼り付いた物を知らないので、見出しの側が `scroll-margin-top` を持つ。
   * 🔑 空き箱はまだ残っている(上)ので、見出しは先頭へ寄せられる余白がある。
   */
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!.scrollTop = 0;
  });
  await clickReal(page, page.locator('[data-pkc-region="inspector"] [data-pkc-action="toc-jump"]').first());
  await expect
    .poll(() => page.evaluate(() => document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!.scrollTop), {
      message: '目次を押しても読む面が動かない(見出しへ飛べていない)',
    })
    .toBeGreaterThan(50);
  const jumped = await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
    const head = box.querySelector<HTMLElement>('[data-pkc-field="detail-body"] :is(h1, h2, h3, h4, h5, h6)')!;
    const wrap = box.querySelector('audio[data-pkc-field="attachment-media"]')!.parentElement!;
    return { headTop: head.getBoundingClientRect().top, wrapBottom: wrap.getBoundingClientRect().bottom };
  });
  expect(
    jumped.headTop,
    `飛んだ見出しが貼り付いた再生機の下に隠れている(見出し top=${jumped.headTop} / 再生機の下端=${jumped.wrapBottom})`,
  ).toBeGreaterThanOrEqual(jumped.wrapBottom - 1);
  await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
    box.querySelector('[data-pkc-probe="sticky-spacer"]')?.remove();
    box.scrollTop = 0;
  });
  /**
   * 🔴 **低い窓(高さ 480px 以下)では再生機を貼り付けない**(帯 + 再生機で上の 1/4 が埋まり、読む場所が残らない)。
   * ⚠ 新しい起動は足さない ── 窓の高さだけ変えて、終わったら**元の高さへ戻す**(以降の道中が同じ窓で続く)。
   */
  const originalSize = page.viewportSize()!;
  await page.setViewportSize({ width: originalSize.width, height: 400 });
  expect(await previewPosition(), '高さ 400px の窓でも再生機が貼り付いたまま').toBe('static');
  await page.setViewportSize(originalSize);
  expect(await previewPosition(), '窓の高さを戻しても貼り付きが戻らない').toBe('sticky');
  // 🔑 時刻の案内(マウスを載せたときの小さな字と、読み上げの字が同じ)
  expect(stick.title, '時刻に「から再生」の案内が付いていない').toMatch(/^\d+:\d{2}(?::\d{2})? から再生$/);
  expect(stick.label, '読み上げの字が案内と違う').toBe(stick.title);

  // ⑤ 消す → 取り込むボタンが戻り(双方向)、「文字にする」は再び案内になる
  await clickReal(page, settingsTab);
  await clickReal(page, asrSection.locator('[data-pkc-action="remove-asr-part"][data-pkc-part="light"]'));
  await expect(installLight, '消したのに取り込むボタンが戻らない').toBeVisible({ timeout: 15_000 });
  await expect(installed).toBeHidden();
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="captures"]');
  await clickReal(page, originalRow.locator('[data-pkc-field="capture-transcribe"]'));
  await expect(statusLine, '消したのに文字にできてしまう').toContainText(
    asrPath,
  );

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

