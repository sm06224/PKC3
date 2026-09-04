import { test, expect } from '@playwright/test';
import {
  clickReal,
  collectPageErrors,
  createEntry,
  dismissAnnounce,
  gotoApp,
  openViewPane,
  useSplitEditor,
} from './helpers';

/**
 * 🔴 **面を開いて戻っても、読んでいた場所に戻る**(user 目線レビュー U-4、2026-08-22)。
 *
 * ## unit では原理的に届かない
 *
 * この欠陥の正体は**実レイアウト**である ── 面は同じスクロール箱の中で `hidden` を
 * 付け替えるので、**開いた面が箱より短いと `scrollTop` がその場で 0 に丸められる**。
 * happy-dom には版面が無いので、この丸めは起きない = 見えない。
 *
 * 実測(直す前。1440×900・300 段落):
 *
 * | | scrollHeight | scrollTop |
 * |---|---|---|
 * | 本文 | 9651 | 1000 |
 * | **短い面を開いている間** | **626**(= clientHeight) | **0 に丸められる** |
 * | 本文へ戻った後 | 9651 に戻る | **0 のまま** |
 * | ヘルプを開いている間 | 4039 | 1000(**長いので偶然残る**) |
 *
 * ⚠ **ヘルプで残るのは偶然**である(マニュアルが長いだけ)── だから
 *   「ヘルプは大丈夫」を根拠にしない。**短い面**で見る
 *   (⚠ 当時はカレンダー。#292 段⑤ で落ちたので集計へ替えた ── 見ている主張は同じ)。
 *
 * ⚠ **戻しはワーカーの後に来る** ── 本文はワーカーで描くので、面を入れ替えた
 *   直後に戻しても中身がまだ無く、また丸められる(実測:400ms 待っても 0)。
 *   `CenterRouter.restoreScroll` が届くまで数フレーム粘る。
 */
test('🔴 短い面を開いて戻ると、読んでいた場所に戻る (U-4)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await useSplitEditor(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  const long = Array.from({ length: 300 }, (_, i) => `${i} 行目の段落です。`).join('\n\n');
  await page.locator('[data-pkc-field="editor-body"]').waitFor();
  await page.evaluate((body) => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = body;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, long);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await page.waitForTimeout(1000);

  const box = '[data-pkc-region="detail"]';
  const top = async (): Promise<number> =>
    page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).scrollTop, box);
  const size = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    return { sh: el.scrollHeight, ch: el.clientHeight };
  }, box);
  // ⚠ **空振り防止** ── そもそもスクロールできる高さが無ければ、この test は
  //    何も確かめていない(本文が短いままだと必ず 0 == 0 で通る)
  expect(size.sh, 'スクロールできる高さが無い(fixture が短い)').toBeGreaterThan(size.ch * 3);

  await page.evaluate((sel) => { (document.querySelector(sel) as HTMLElement).scrollTop = 1000; }, box);
  await page.waitForTimeout(200);
  expect(await top(), '位置を作れていない').toBe(1000);

  // ⚠ 面はアドレスから開く(#300 段③ でタイルは別窓を開くようになった)
  // ⚠ **短い面である必要がある**(#292 段⑤ でカレンダーから集計へ替えた)──
  //    丸めは「開いた面が箱より短い」ときだけ起きるので、長い面に替えると
  //    この test は**何も確かめずに緑**になる。下の対照群がそれを落とす
  await openViewPane(page, 'query');
  // ⚠ **対照群** ── 開いている間は丸められている(= 直しは「戻す」側で効いている。
  //    「そもそも丸められない」に変わったのなら、この test の前提が変わっている)
  expect(await top(), '丸めが起きていない ── 前提が変わった').toBe(0);

  // 帰り道は「× 閉じる」(タイルの再押下は別窓を開いてしまう)
  await clickReal(page, '[data-pkc-action="close-pane"]');
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeVisible();
  await page.waitForTimeout(700);
  expect(await top(), '読んでいた場所へ戻らない').toBe(1000);

  // ⚠ 2 巡目 ── 覚え直しが効く(1 回目の値に固定されない)
  await page.evaluate((sel) => { (document.querySelector(sel) as HTMLElement).scrollTop = 2500; }, box);
  await page.waitForTimeout(200);
  await openViewPane(page, 'query');
  await clickReal(page, '[data-pkc-action="close-pane"]');
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeVisible();
  await page.waitForTimeout(700);
  expect(await top(), '2 巡目で古い位置に固定された').toBe(2500);
  expect(errors, 'page error が出た').toEqual([]);
});

/**
 * 🔴 **別のノートを見てから戻ると、読んでいた場所から出る**(#690 ①。
 * user 裁定 2026-09-04、案 A)。
 *
 * 直す前は「編集へ入る直前」しか憶えておらず、A を中ほどまで読んで一覧で B を
 * 選び、A へ戻ると**必ず先頭**だった。unit(`detail-scroll.test.ts`)は器の値だけを
 * 見るので、ここで見るのは**実レイアウトの丸め**を挟んでも戻ること ──
 * B は短いので、B を見ている間は箱の `scrollTop` が実際に 0 へ丸められる。
 *
 * ⚠ 戻しは**本文がワーカーから届いた後**に走る(上の test と同じ)── 押した直後に
 *   読むと、まだ中身が無くて 0 に見える。`data-pkc-painted` が A を指してから読む。
 */
test('🔴 別のノートを見てから戻ると、読んでいた場所から出る (#690 ①)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await useSplitEditor(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);

  // ⚠ **2 件作る** ── A は長く(送れる)、B は短く(見ている間に丸められる)
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('ながい');
  const long = Array.from({ length: 300 }, (_, i) => `${i} 行目の段落です。`).join('\n\n');
  await page.evaluate((body) => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = body;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, long);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('みじかい');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  /** 一覧の行(題名 → lid)。⚠ 画面から採る ── 保存の綴りを推測しない。 */
  const lidOf = async (title: string): Promise<string> =>
    await page.evaluate((t) => {
      const rows = [...document.querySelectorAll('[data-pkc-region="sidebar"] [data-pkc-entry]')];
      const hit = rows.find((r) => (r.textContent ?? '').includes(t));
      return hit?.getAttribute('data-pkc-entry') ?? '';
    }, title);
  const longLid = await lidOf('ながい');
  const shortLid = await lidOf('みじかい');
  expect(longLid, '前提が崩れた(ながい の行が一覧に無い)').not.toBe('');
  expect(shortLid, '前提が崩れた(みじかい の行が一覧に無い)').not.toBe('');
  expect(longLid, '前提が崩れた(2 件が同じ行を指している)').not.toBe(shortLid);

  const box = '[data-pkc-region="detail"]';
  const top = async (): Promise<number> =>
    page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).scrollTop, box);
  /** その lid の本文が描けた印(`detail.ts` の `PAINTED_ATTR`)を待つ。 */
  const painted = (lid: string) =>
    page.locator(`[data-pkc-field="detail-body"][data-pkc-painted="${lid}"]`);

  await clickReal(page, `[data-pkc-entry="${longLid}"]`);
  await expect(painted(longLid)).toBeAttached();
  const size = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    return { sh: el.scrollHeight, ch: el.clientHeight };
  }, box);
  // ⚠ **空振り防止** ── 送れる高さが無ければ、この test は何も確かめていない
  expect(size.sh, 'スクロールできる高さが無い(fixture が短い)').toBeGreaterThan(size.ch * 3);
  await page.evaluate((sel) => { (document.querySelector(sel) as HTMLElement).scrollTop = 1000; }, box);
  await page.waitForTimeout(200);
  expect(await top(), '位置を作れていない').toBe(1000);

  // 別のノート(短い)へ ── ⚠ **対照群**: 初めて開くノートは先頭から。
  //    短いので、直しが「B にも 1000 を持ち込む」形に壊れても丸めで 0 に見える ──
  //    だから B 側は unit が守る(ここは A へ戻る側だけを主張する)
  await clickReal(page, `[data-pkc-entry="${shortLid}"]`);
  await expect(painted(shortLid)).toBeAttached();
  expect(await top(), '初めてのノートが先頭から始まらない').toBe(0);

  // 🔴 A へ戻る ⇒ 読んでいた場所から
  await clickReal(page, `[data-pkc-entry="${longLid}"]`);
  await expect(painted(longLid)).toBeAttached();
  await expect
    .poll(top, { message: '別のノートを見てから戻ると先頭へ飛ぶ', timeout: 3_000 })
    .toBe(1000);

  // ⚠ 2 巡目 ── 憶え直しが効く(1 回目の値に固定されない)
  await page.evaluate((sel) => { (document.querySelector(sel) as HTMLElement).scrollTop = 2500; }, box);
  await page.waitForTimeout(200);
  await clickReal(page, `[data-pkc-entry="${shortLid}"]`);
  await expect(painted(shortLid)).toBeAttached();
  await clickReal(page, `[data-pkc-entry="${longLid}"]`);
  await expect(painted(longLid)).toBeAttached();
  await expect
    .poll(top, { message: '2 巡目で古い位置に固定された', timeout: 3_000 })
    .toBe(2500);
  expect(errors, 'page error が出た').toEqual([]);
});
