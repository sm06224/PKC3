/**
 * 🔴 **見出しから自動で作る目次**(#493)を、実ブラウザで見る。
 *
 * > user 報告 2026-08-27:「**自動で見出しから生成された TOC が PKC2 にはあるけど、
 * > PKC3 にはない**」
 *
 * ## ⚠ ここでしか見られないもの
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 **本文が実際にその見出しまで送られる** | happy-dom はスクロールを持たない |
 * | 🔴 目次の印が、**本物の描画が刻んだ id** と噛み合う | 描画は markdown-it の実物 |
 *
 * 🔑 観測点は**送られた量**(`scrollTop`)と**見出しが画面に来たか** ──
 *   「押せた」だけを見ると、飛んでいなくても通る。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

const TOC = '[data-pkc-region="inspector"] [data-pkc-action="toc-jump"]';

/** 見出しの間に十分な本文を挟む ── 短いと**送らなくても見えて**しまう。 */
const BODY = [
  '# 最初の章',
  ...Array.from({ length: 40 }, (_, i) => `一行目の本文 ${i}`),
  '## 途中の節',
  ...Array.from({ length: 40 }, (_, i) => `二つ目の本文 ${i}`),
  '# 最後の章',
  'ここが終わり',
].join('\n');

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

test('🔴 見出しのあるノートで目次が出て、押すとそこまで送られる (#493)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 800 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '長いノート');
  await page.fill('[data-pkc-field="editor-body"]', BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  // 🔴 **目次が出る**(手で `:::toc` と書いていないのに)
  await expect(page.locator(TOC), '目次が出ていない').toHaveCount(3);
  expect(await page.locator(TOC).allTextContents()).toEqual([
    '最初の章',
    '途中の節',
    '最後の章',
  ]);

  /**
   * 🔴 **押したら本文が送られる。**
   * ⚠ 観測点は 2 つ ── ①送られた量が増えた ②その見出しが**画面の上のほう**に来た。
   *   ①だけだと「どこかへ送られた」で通り、②だけだと元から見えていた回で通る。
   */
  /**
   * 🔴 **押したら本文が送られる。**
   *
   * ⚠ 観測点は 2 つ ── ①送られた量が増えた ②その見出しが**画面の上のほう**に来た。
   *   ①だけだと「どこかへ送られた」で通り、②だけだと元から見えていた回で通る。
   * ⚠ **`h2[id]` で拾う** ── ノートの**題名も `<h2>`** で描かれるので、素の `h2` は
   *   題名(y=8)に当たる(実測で 1 度踏んだ)。id を持つのは本文の見出しだけである。
   * ⚠ **真ん中の見出しを押す** ── いちばん最後の見出しでは、その先に本文が
   *   足りないので**送りきれない**(実測:器 507px に対し見出しは 1709px の位置)。
   *   それは「終わりより先へは送れない」だけなので、観測点として使わない。
   */
  const scroller = page.locator('[data-pkc-region="detail"]');
  const target = page.locator('[data-pkc-region="detail"] h2[id]').first();
  const beforeY = (await target.boundingBox())?.y ?? 0;
  expect(beforeY, '前提が崩れている(押す前から画面の上に在る)').toBeGreaterThan(500);
  const before = await scroller.evaluate((el) => el.scrollTop);

  await clickReal(page, `${TOC} >> nth=1`);
  await page.waitForTimeout(150);

  const after = await scroller.evaluate((el) => el.scrollTop);
  expect(after, `送られていない(${before} → ${after})`).toBeGreaterThan(before);
  const box = await target.boundingBox();
  expect(box, '押した見出しが画面から消えた').not.toBeNull();
  expect(box!.y, `見出しが上へ来ていない(${beforeY} → ${box!.y})`).toBeLessThan(beforeY - 300);
  expect(box!.y, `画面の上のほうに来ていない(y=${box!.y})`).toBeLessThan(300);

  /**
   * 🔴 **本文の「目次」を開くと、いま読んでいる章の行が光る**(#1168)。
   *
   * ⚠ 観測点は 2 つ ── ①**印の位置**(`data-pkc-active` が**どの行か**。1 行だけ)
   *   ②**その印に見た目が在る**(計算後の太さと左の線 ── 属性だけでは「付けた」しか言えない)。
   * ⚠ **印が動くことを 3 通りで見る**(動かない印は飾りである)── 先頭(最初の章の上に
   *   題名が在って線に届かない形)/ 途中(線を越えた最後の章)/ 末尾(最後の章が短くて
   *   線まで届かない形)。
   * 🔴 **この「目次」ボタンは本文の右上の隅に留まる**(#1178)── 途中まで送った所
   *   (900px)で、**画面の中に在って押せる**ことを見る。かつては flex の最後の子で
   *   本文の末尾にしか無く、924px 送ると y=892(画面 800)で、押すために末尾まで送っていた。
   *   ⚠ 開いた後の送りは DOM の印だけで見る(ポップオーバーも一緒に動くため、見た目の確認は
   *   開いた直後に済ませる)。
   */
  const QUICK = '[data-pkc-region="detail"] .pkc-quick-toc';
  const QITEM = `${QUICK} .pkc-quick-toc-item`;
  await scroller.evaluate((el) => {
    el.scrollTop = 900;
  });
  const viewportH = page.viewportSize()?.height ?? 0;
  const btnBox = await page.locator(`${QUICK} .pkc-quick-toc-btn`).boundingBox();
  expect(btnBox, '目次のボタンが描かれていない').not.toBeNull();
  expect(btnBox!.y, `途中まで送った所で目次のボタンが画面の外(y=${btnBox!.y} / 画面 ${viewportH})`).toBeLessThan(
    viewportH - btnBox!.height,
  );
  expect(btnBox!.y, `目次のボタンが画面の上へはみ出している(y=${btnBox!.y})`).toBeGreaterThanOrEqual(0);
  // 🔑 「先頭へ戻る」の押しと同じ右の列に居る(= 2 つで 1 組に読める)── 右端が揃う
  const topBox = await page.locator('[data-pkc-region="detail"] .pkc-back-to-top').boundingBox();
  expect(topBox, '先頭へ戻るの押しが描かれていない(前提)').not.toBeNull();
  expect(
    Math.abs(btnBox!.x + btnBox!.width - (topBox!.x + topBox!.width)),
    `目次の押しと先頭へ戻るの押しの右端が揃っていない(${btnBox!.x + btnBox!.width} / ${topBox!.x + topBox!.width})`,
  ).toBeLessThanOrEqual(1);
  await clickReal(page, `${QUICK} .pkc-quick-toc-btn`);
  await expect(page.locator(`${QUICK} .pkc-quick-toc-popover`), 'クイック目次が開かない').toBeVisible();
  await expect(page.locator(QITEM), '前提が崩れている(目次の行が 3 本でない)').toHaveCount(3);
  // ポップオーバーは押しの近くに開き、画面の内側に収まる
  const pop = await page.locator(`${QUICK} .pkc-quick-toc-popover`).boundingBox();
  const vw = page.viewportSize()?.width ?? 0;
  expect(pop!.y, '目次が押しの下に開いていない').toBeGreaterThanOrEqual(btnBox!.y);
  expect(pop!.x, '目次が画面の左へはみ出している').toBeGreaterThanOrEqual(0);
  expect(pop!.x + pop!.width, '目次が画面の右へはみ出している').toBeLessThanOrEqual(vw);
  const activeRows = async (): Promise<number[]> =>
    page.locator(QITEM).evaluateAll((els) =>
      els.flatMap((el, i) => (el.hasAttribute('data-pkc-active') ? [i] : [])),
    );
  await expect.poll(activeRows, '途中で開いたのに、いま読んでいる章が光っていない').toEqual([1]);

  // 見た目の規則が在る(太字 + 左の線)── 光っていない行との差で見る
  const look = await page.locator(`${QITEM}[data-pkc-active]`).evaluate((el) => {
    const weightOf = (e: Element | null): number =>
      Number(getComputedStyle(e?.querySelector('.pkc-quick-toc-link') as Element).fontWeight);
    return {
      weight: weightOf(el),
      plainWeight: weightOf(document.querySelector('.pkc-quick-toc-item:not([data-pkc-active])')),
      shadow: getComputedStyle(el).boxShadow,
      plainShadow: getComputedStyle(
        document.querySelector('.pkc-quick-toc-item:not([data-pkc-active])') as Element,
      ).boxShadow,
    };
  });
  expect(look.weight, '光った行が太字でない').toBeGreaterThanOrEqual(700);
  expect(look.plainWeight, '光っていない行まで太い(区別が付かない)').toBeLessThan(look.weight);
  expect(look.plainShadow, '前提が崩れている(光っていない行に線が在る)').toBe('none');
  expect(look.shadow, '光った行に左の線が無い').not.toBe('none');
  expect(look.shadow, '線が 色 + 左 2px の inset でない').toMatch(/rgb.*\b2px\b.*inset/);

  // 先頭へ送る → 1 行目 / 途中の節を上端へ → 2 行目
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(activeRows, '先頭へ送っても印が動かない').toEqual([0]);
  await target.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect.poll(activeRows, '途中の節を上端へ送っても印が動かない').toEqual([1]);
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(activeRows, '末尾まで送っても最後の章が光らない').toEqual([2]);

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **見出しが無いノートでは行ごと出さない**(#493 / PKC2 と同じ作法)。
 * ⚠ 右の列は混んでいる(#500)ので、押せない物を常設しない。
 */
test('🔴 見出しが無いノートでは目次の行が出ない (#493)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '短いノート');
  await page.fill('[data-pkc-field="editor-body"]', '見出しの無い本文だけ\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  await expect(page.locator(TOC), '押せない目次が出ている').toHaveCount(0);
  await expect(
    page.locator('[data-pkc-region="inspector"] [data-pkc-field="inspector-toc"]'),
    '値だけ畳んで「目次」の見出しが残っている',
  ).toBeHidden();

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **畳んだ章の中の見出しへ、目次から開いて飛べる**(#514)。
 *
 * ⚠ 直す前は hit が見つかる(querySelectorAll は hidden も拾う)のに、
 *   display:none の要素への `scrollIntoView` が no-op ── 断りの分岐にも入らず
 *   **無言の dead click** だった。ここは実ブラウザでしか見えない
 *   (happy-dom は「hidden へは送れない」を再現しない)。
 */
test('🔴 畳んだ章の中の見出しへ、目次から開いて飛べる (#514)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 800 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '畳むノート');
  await page.fill('[data-pkc-field="editor-body"]', BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  // 最初の章を畳む → 途中の節(h2)が隠れる
  await page
    .locator('[data-pkc-region="detail"] h1 [data-pkc-action="toggle-heading-fold"]')
    .first()
    .click();
  const target = page.locator('[data-pkc-region="detail"] h2[id]').first();
  await expect(target, '前提が崩れている(畳めていない)').toBeHidden();

  // 目次から「途中の節」を押す → 開いて、画面の上まで送られる
  await clickReal(page, `${TOC} >> nth=1`);
  await page.waitForTimeout(150);
  await expect(target, '開いていない(無言の dead click のまま)').toBeVisible();
  const box = await target.boundingBox();
  expect(box, '見出しが画面に無い').not.toBeNull();
  expect(box!.y, `見出しが画面の上に来ていない(y=${box!.y})`).toBeLessThan(300);

  /**
   * 🔴 **同じ道中で、ログの日の行を見る**(#1441。畳みの道に足す ── 起動は増やさない)。
   * 2 日 × 2 件のログ → 日の行が 2 つ。最初の日を押す → その日の 2 件が隠れ、次の日は見えたまま。
   * もう一度押す → 戻る。⚠ 押した印(`aria-expanded`)に**見た目の規則が在る**ことも、
   * 実ブラウザの計算後の色で見る(属性を付けただけで終わらせない)。
   */
  const LOGBODY = [
    '## 2026-10-09 09:00:00',
    '一日目の一件目',
    '## 2026-10-09 10:00:00',
    '一日目の二件目',
    '## 2026-10-10 09:00:00',
    '二日目の一件目',
    '## 2026-10-10 10:00:00',
    '二日目の二件目',
  ].join('\n\n');
  await createEntry(page, 'textlog');
  await page.fill('[data-pkc-field="editor-body"]', LOGBODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const days = page.locator('[data-pkc-region="detail"] [data-pkc-field="detail-body"] [data-pkc-log-day]');
  await expect(days, '日の行が 2 つ出ていない').toHaveCount(2);
  await expect(days.nth(0)).toHaveText('2026-10-09(金)');
  await expect(days.nth(1)).toHaveText('2026-10-10(土)');
  const bodyP = page.locator('[data-pkc-region="detail"] [data-pkc-field="detail-body"] p');
  await expect(bodyP.filter({ visible: true }), '前提が崩れている(最初は 4 件とも見える)').toHaveCount(4);
  // ⚠ 触れている間の色(:hover)に満たされない ── マウスを外してから測る
  await page.mouse.move(0, 0);
  const openColor = await days.nth(0).evaluate((el) => getComputedStyle(el).color);

  await days.nth(0).click();
  await expect(days.nth(0)).toHaveAttribute('aria-expanded', 'false');
  await expect(bodyP.filter({ visible: true })).toHaveText(['二日目の一件目', '二日目の二件目']);
  await expect(days.nth(1), '次の日の行まで隠れた').toBeVisible();
  await page.mouse.move(0, 0);
  const foldedColor = await days.nth(0).evaluate((el) => getComputedStyle(el).color);
  expect(foldedColor, '畳んだ印に見た目の規則が無い(開いているときと同じ色)').not.toBe(openColor);

  await days.nth(0).click();
  await expect(days.nth(0)).toHaveAttribute('aria-expanded', 'true');
  await expect(bodyP.filter({ visible: true }), '戻らない(片道)').toHaveCount(4);

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **設定を開いたまま目次を押すと、本文の面へ戻って飛ぶ**(#514)。
 * ⚠ 面は hidden で常駐するので、直す前は「見つかるのに送れない」無言だった。
 */
test('🔴 設定を開いたまま目次を押すと、本文へ戻って飛ぶ (#514)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1400, height: 800 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '設定から戻るノート');
  await page.fill('[data-pkc-field="editor-body"]', BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(
    page.locator('[data-pkc-view-pane="settings"]'),
    '前提が崩れている(設定が開いていない)',
  ).toBeVisible();

  await clickReal(page, `${TOC} >> nth=1`);
  await page.waitForTimeout(150);
  await expect(
    page.locator('[data-pkc-view-pane="detail"]'),
    '本文の面へ戻っていない',
  ).toBeVisible();
  const target = page.locator('[data-pkc-region="detail"] h2[id]').first();
  await expect(target, '見出しが見えていない').toBeVisible();
  const box = await target.boundingBox();
  expect(box!.y, `見出しが画面の上に来ていない(y=${box!.y})`).toBeLessThan(300);

  expect(errors, 'pageerror が出た').toEqual([]);
});
