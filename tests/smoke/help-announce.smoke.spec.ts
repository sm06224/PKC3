import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, collectPageErrors } from './helpers';

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
 * - 🔴 **面が同じ document に常駐しても、マニュアルの見出しが本文の見出しと
 *   id でぶつからない**こと ── これは `hidden` の面が生きている実ブラウザに
 *   しか無い性質である
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

  /**
   * ④ 🔴 **id がぶつかっていない。** 面は `hidden` で同一 document に常駐するので、
   * マニュアルの見出しが本文と同じ `id` を焼くと `#slug` が別の面へ当たる。
   * ⚠ **document 全体**で数える(面の中だけ見ても、ぶつかりは観測できない)。
   */
  const dupes = await page.evaluate(() => {
    const seen = new Map<string, number>();
    for (const el of document.querySelectorAll('[id]')) {
      const id = el.id;
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  });
  expect(dupes, 'id が重複している(面をまたいで #リンクが誤爆する)').toEqual([]);

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
