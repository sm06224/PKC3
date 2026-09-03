import { test, expect, type Page } from '@playwright/test';
import {
  clickReal,
  collectPageErrors,
  createEntry,
  dismissAnnounce,
  gotoApp,
} from './helpers';
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
/**
 * 🔴 **スマホ用画面では「時間を計る」は ⋯ の中に在る**(#632 段①)。
 *
 * ⚠ 押し口(`create-bar`)は**左の列の中**なので、スマホでは本文を開いている間
 *   見えていない。⚠ **一覧へ戻れば押せる**(user 裁定 2026-09-02 で、戻っても
 *   ノートは開いたままになった)が、それは**画面に出ていないノートに入る**という
 *   ことなので、本文を見たまま押せる ⋯ のほうが読み違えようがない。
 *   ⚠ 一覧に居て**何も開いていない**ときは、押した時点で断られる(同じ裁定)。
 * 🔑 だから本文ページの **⋯** から同じ受け手を呼ぶ。⚠ この関数は
 *   **狭い窓でだけ**使う ── 広い窓では今までどおり左の列を押す(経路を変えない)。
 */
async function startTimerOnPhone(page: Page): Promise<void> {
  await clickReal(page, '[data-pkc-field="phone-menu"]');
  await clickReal(page, '[data-pkc-region="context-menu"] [data-pkc-action="start-timer"]');
}

test('🔴 狭い窓でも、止める口が画面の中に在って押せる (#582)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 480, height: 800 });
  await gotoApp(page);
  // ⚠ スマホの幅ではお知らせが画面いっぱい(user 裁定 2026-09-02)── 先に畳む
  await dismissAnnounce(page);
  await createEntry(page, 'text');

  await startTimerOnPhone(page);
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

/**
 * 🔴 **2 本目からが本番**(#586。2026-08-29 に実測で原因確定)。
 *
 * ⚠ 上の spec は **1 本しか走らせていない**ので、これを見逃していた ──
 *   素の `1fr` は **`minmax(auto, 1fr)`** なので、**帯の最小幅が列を押し広げる**。
 *   実測: 480px の窓で **1 本 480 → 2 本 571 → 3 本 845px**、
 *   3 本目では**録音の「止める」まで画面の外**へ出ていた。
 * 🔑 「直したはずの欠陥が、2 本目で戻る」型なので **数を増やして見る**
 *   (CLAUDE.md「fixture のゼロ件の次元は測っていない次元」の **1 件版**)。
 *
 * ⚠ **合成の台で代用しない**(1 度これで外した)── 幅の広い子を差し込む形は
 *   「列を留めても自分が溢れる」ので、**直す前も後も同じように落ちる**。
 *   実物の帯で測ること。
 */
test('🔴 狭い窓でタイマーを 3 本走らせても、画面が横に広がらない (#586)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 480, height: 800 });
  await gotoApp(page);
  const vw = page.viewportSize()!.width;
  const stops = page.locator('[data-pkc-action="stop-timer"]');

  /**
   * ⚠ **お知らせの帯を先に畳む** ── 480px では **253px** を占め、
   *   下の「保存」を覆ってしまう(user も最初にこれを閉じる)。
   * 🔑 ここで畳まないと、この台は**製品ではなく帯に阻まれて**落ちる。
   */
  const dismiss = page.locator('[data-pkc-action="dismiss-announce"]');
  while ((await dismiss.count()) > 0) {
    await clickReal(page, '[data-pkc-action="dismiss-announce"]');
    await page.waitForTimeout(120);
  }

  /**
   * ⚠ **計るのは「いま開いているノート」1 件につき 1 本**なので、2 本走らせるには
   *   ノートを 2 件作り、**そのつど編集から出る**必要がある。
   *
   * 🔴 **2026-09-02 に「中央の保存」へ戻した**(#632 段①)。
   * ⚠ 直す前はここに「保存は追記欄の側を押す ── 編集の帯の側は狭い窓で追記欄に
   *   覆われていて押せない(#588)」と書いてあった。スマホ用画面で**その覆いが
   *   無くなった**ので、回避を残すと**直った物を直っていないことにする**。
   *   ⚠ 覆いが戻ったらここで落ちる(それが正しい)── 押せることは
   *   `phone.smoke.spec.ts` が `elementFromPoint` で別に見ている。
   * ⚠ 2 件目を作るには**一覧ページへ戻る**(スマホでは左の列が同時に出ない)。
   */
  const save = page.locator('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  /**
   * 🔴 **3 本走らせる**(#632 段② の着地前レビュー E)。
   * ⚠ この spec の注記自身が「実測: 1 本 480 → 2 本 571 → **3 本 845px**、
   *   3 本目では**録音の「止める」まで画面の外**へ出ていた」と書いている ──
   *   2 本で止めると、記録に在る**いちばん重い場面**を測っていない。
   */
  for (let i = 0; i < 3; i += 1) {
    if (i > 0) await clickReal(page, '[data-pkc-field="phone-back"]');
    await createEntry(page, 'text');
    await clickReal(page, save);
    await startTimerOnPhone(page);
    await expect(stops, `${i + 1} 本目が始まらない(台の空振り)`).toHaveCount(i + 1);
  }

  // 🔴 **版面が窓より広がらない**(直す前は 2 本で 571px = 窓の 1.19 倍)
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(wide, `画面が横に広がっている(${wide}px / 窓幅 ${vw})`).toBeLessThanOrEqual(vw);

  /**
   * 🔴 **走っている本数だけ、止める口が画面の中に在って押せる**(#586 の残り半分)。
   *
   * ⚠ **直す前は 1 本目しか見ていませんでした** ── 帯の中で横に流れる作りなので
   *   (`app.css` の `overflow-x: auto`)、2 本目は **x=595**(窓幅 480 の外)に置かれ、
   *   **帯を横へ払わないと届かない**。この spec 自身が「ここでは見ません /
   *   #586 の残り半分として起票してある」と書いていました。
   * 🔴 **#632 段② で直したので、注記を assert に裏返します**(user 裁定 2026-09-02)──
   *   スマホの版面では帯を **1 件 1 行に折る**ので、何本走っていても全部画面に在る。
   * 🔑 **全数を見る**(1 本目だけ見ない)── これは #588 が名指しで戒めている形で、
   *   「1 個目だけを見た」ことがまさに発見を遅らせた理由である。
   */
  const seen = await stops.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        right: Math.round(r.x + r.width),
        hit: at?.closest('[data-pkc-action]')?.getAttribute('data-pkc-action') ?? null,
      };
    }),
  );
  expect(seen, '止める口が 3 本ぶん出ていない(台の空振り)').toHaveLength(3);
  seen.forEach((m, i) => {
    expect(m.right, `${i + 1} 本目の止める口が窓からはみ出している(${m.right} / 窓 ${vw})`)
      .toBeLessThanOrEqual(vw);
    expect(m.hit, `${i + 1} 本目の止める口が押せない(覆われているか画面の外)`).toBe(
      'stop-timer',
    );
  });

  expect(errors, '例外が出た').toEqual([]);
});

/**
 * 🔴 **タブレットの縦(768px)でも、止める口が全部画面に在る**
 * (#632 段② の着地前レビュー 欠陥 5)。
 *
 * ⚠ **スマホ用画面の境目(720px)を超える幅**なので、「1 件 1 行に折る」規則は
 *   当たらない ── 直す前はここが `overflow-x: auto` のままで、実測すると
 *   **3 本目の右端が 868px(窓 768)/ `elementFromPoint` は `null`**、
 *   つまり**押せない**。⚠ iOS では横スクロールバーが出ないので、
 *   **続きが在ることも見えない**。
 * 🔑 素の規則を「**入りきらなければ折る**」にしたので、幅に依らず全部画面に在る。
 *   ⚠ 広い窓では 3 本でも 1 行に収まるので、見え方は 1px も変わらない。
 */
test('🔴 タブレットの縦(768px)でも、3 本ぶんの止める口が押せる (#586)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await gotoApp(page);
  await dismissAnnounce(page);
  const vw = page.viewportSize()!.width;
  for (let i = 0; i < 3; i += 1) {
    await createEntry(page, 'text');
    await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await clickReal(page, '[data-pkc-field="start-timer"]');
  }
  const seen = await page
    .locator('[data-pkc-action="stop-timer"]')
    .evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          right: Math.round(r.x + r.width),
          hit: at?.closest('[data-pkc-action]')?.getAttribute('data-pkc-action') ?? null,
        };
      }),
    );
  expect(seen, '止める口が 3 本ぶん出ていない(台の空振り)').toHaveLength(3);
  seen.forEach((m, i) => {
    expect(m.right, `${i + 1} 本目が窓からはみ出している(${m.right} / 窓 ${vw})`)
      .toBeLessThanOrEqual(vw);
    expect(m.hit, `${i + 1} 本目の止める口が押せない`).toBe('stop-timer');
  });
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
