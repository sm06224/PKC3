import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 🔴 **ヘルプの面とお知らせの帯**(P11 段④⑤。user 指示 2026-08-07)。
 *
 * ## なぜ実ブラウザで見るのか
 *
 * unit(happy-dom)は**生成の正しさ**しか示さない。ここで見るのは
 * unit では観測できないことだけ:
 *
 * - **押せる**こと(帯のボタンが実際に最前面に居て、クリックが届く)
 * - **マニュアルが本当に描かれる**こと(worker 経路 ── unit は口を差し替えている)
 * - 🔴 **マニュアルの見出しが、本文の `#リンク` を横取りしない**こと ──
 *   面は `hidden` で同一 document に常駐するので **id はぶつかりうる**
 *   (ぶつからないことは要求できない ── user が同じ見出しを書けば必ず起きる)。
 *   守るのは「`#slug` が本文の面に当たる」ほうである
 */
test('🔴 ヘルプの面が開き、マニュアルが描かれる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');

  // ① 版が**文字で**出る(hover の title ではない ── タッチ端末にも届く)
  const ver = page.locator('[data-pkc-field="help-version"]');
  await expect(ver).toBeVisible();
  expect((await ver.textContent()) ?? '', '版が出ていない').toMatch(/^pkc3 v\d/);

  // ② 過去のお知らせが出る
  await expect(page.locator('[data-pkc-help-notice]').first()).toBeVisible();

  /**
   * ③ 🔴 **マニュアルが描かれている**(worker 経路)。
   * ⚠ 器が在るだけでは足りない ── 「読み込んでいます…」のまま止まる形が
   *   まさにこの経路の失敗である。**中身の見出しが出たこと**を見る。
   */
  const manual = page.locator('[data-pkc-region="help-manual"]');
  await expect(manual).toBeVisible();
  await expect(manual.locator('h2', { hasText: '画面のならび' })).toBeVisible({
    timeout: 10_000,
  });

  expect(errors).toEqual([]);
});

/**
 * 🔴 **マニュアルの見出しが、本文の `#リンク` を横取りしない**(2026-08-08 に
 * 書き直した)。
 *
 * 面は `hidden` で**同一 document に常駐**するので、マニュアルの見出しが焼く
 * `id` は本文の見出しと**必ずぶつかりうる**(実測: 本文に `## 4. 画面のならび`
 * と書くと、`4-画面のならび` が detail と help の 2 面に出る)。
 *
 * ⚠ **1 巡目の検査は「重複が 0 件」を要求していたが、主張そのものが間違っていた** ──
 * user が同じ見出しを書けば必ず重複するので、守れない条件である。しかも
 * **ノートを 1 件も作っていなかった**ので、重複しうる材料がゼロ = 空振りでもあった
 * (CLAUDE.md「fixture のゼロ件の次元は測っていない次元」)。
 *
 * 🔑 **実害の形で書く**: 重複してよい。守るべきは
 *  ① `#slug` が**本文の面**に当たること(document 順で detail が先に在る)
 *  ② マニュアル側が**文書内アンカーを 1 つも持たない**こと(unit が pin 済み)
 * ── この 2 つが成り立つ限り、user の `#リンク` は自分の本文へ着く。
 */
test('🔴 マニュアルを開いても、本文の #リンクは本文へ着く', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  // ⚠ **マニュアルと同じ見出し**を本文に書く(ぶつかる材料を作る)
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('## 4. 画面のならび\n\n本文。\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // マニュアルを描かせる(ここで初めて help 側の id が生える)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="help"]');
  await expect(
    page.locator('[data-pkc-region="help-manual"] h2', { hasText: '画面のならび' }),
  ).toBeVisible({ timeout: 10_000 });

  const r = await page.evaluate(() => {
    const paneOf = (el: Element | null): string | null =>
      el?.closest('[data-pkc-view-pane]')?.getAttribute('data-pkc-view-pane') ?? null;
    const id = '4-画面のならび';
    const all = [...document.querySelectorAll(`[id="${CSS.escape(id)}"]`)];
    return { count: all.length, winner: paneOf(document.getElementById(id)) };
  });

  // ⚠ 前提: **本当にぶつかっている**(ぶつかっていなければ何も見ていない)
  expect(r.count, '同じ id が 2 面に出ていない(fixture の空振り)').toBeGreaterThan(1);
  // 🔴 それでも `#slug` は**本文の面**に当たる
  expect(r.winner, 'マニュアルの見出しが本文の #リンクを横取りした').toBe('detail');

  expect(errors).toEqual([]);
});

/**
 * 🔴 **起動したときのお知らせ**。⚠ かぶせる窓ではないので、**帯が出たまま
 * 作業できる**ことも観測点である(本文の面が押せる)。
 */
test('🔴 お知らせの帯が出て、閉じると次から出ない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  const band = page.locator('[data-pkc-region="announce"]');
  await expect(band, '起動時にお知らせが出ていない').toBeVisible({ timeout: 10_000 });
  // ⚠ 閉じたら二度と読めない、と思わせない
  await expect(band.locator('[data-pkc-field="announce-where"]')).toContainText('ヘルプ');

  /**
   * ⚠ **帯が出たまま作業できる**(かぶせる窓にしていない)。
   * `clickReal` はその座標で実際に最前面に居ることを確かめてから押すので、
   * 帯が本文を覆っていればここで落ちる。
   */
  await clickReal(page, '[data-pkc-field="create-pick"]');
  await page.keyboard.press('Escape');

  await clickReal(page, '[data-pkc-action="dismiss-announce"]');
  await expect(band, '閉じても残っている').toBeHidden();

  // 🔴 読んだものは**次の起動でも出ない**(既読が保存されている)
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(band, '読んだお知らせが出直している').toBeHidden();

  expect(errors).toEqual([]);
});
