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
