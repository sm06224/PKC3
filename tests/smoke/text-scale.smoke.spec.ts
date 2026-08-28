import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, expectReachable } from './helpers';

/**
 * 🔴 **文字の大きさを user が変えられる**(#504。user 指示 2026-08-28)。
 *
 * > 「**文字のサイズ小さくなったけど なんかしました?**」
 * > 「**正直変更はユーザーに委ねて欲しい**」
 *
 * 🔴 **unit では原理的に届かない層**:
 * ① **実際に描かれた字の大きさ**(`getComputedStyle` / `boundingBox`)── CSS を
 *    持たない happy-dom では常に既定値で、`var()` の解決も起きない
 * ② 🔴 **読み幅が動かないこと** ── `--read-w` は `rem` なので `body` を動かしても
 *    1px も変わらない、という**当の主張**は実ブラウザでしか測れない。
 *    ⚠ これが崩れると**図が焼き直る**(ラスタの鍵は器の幅を含む ── 不可侵指示
 *    2026-08-03)
 * ③ **読み込み直しても残ること**(保存 → 起動時の適用の往復)
 */

const BODY = '# 題\n\n本文の段落です。ここの字の大きさを測ります。\n';

test('🔴 文字の大きさを変えると本文の字が実際に変わり、読み幅は動かない (#504)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill(BODY);
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const para = page.locator('[data-pkc-field="detail-body"] p').first();
  await expect(para).toContainText('本文の段落です。');

  /** 描かれた字の大きさ(px)と、段の幅。 */
  const measure = async (): Promise<{ font: number; width: number }> =>
    para.evaluate((el) => ({
      font: Number.parseFloat(getComputedStyle(el).fontSize),
      width: Math.round(el.getBoundingClientRect().width),
    }));

  const before = await measure();
  // ⚠ **空振り防止** ── 既定が本当に 13px であること(ここがずれると以下は無意味)
  expect(before.font, '既定の字の大きさが 13px でない(表と CSS がずれている)').toBeCloseTo(13, 1);

  // ① 設定 → 表示 → 文字の大きさ = 大
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const select = page.locator('[data-pkc-field="text-scale-select"]');
  // 🔑 押さずに「届くこと」だけ確かめる(`<select>` は押すと OS の一覧が開く)
  await expectReachable(page, select);
  await select.selectOption('large');

  /**
   * ② 本文へ戻って測る ── **その場で効いている**(読み込み直し不要)。
   * 🔑 戻り方は**一覧の行を押す**(`layout.smoke` の「設定を開いてもノートを押せば
   *   戻る」と同じ道)── `set-view` に `detail` は無い。
   */
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(para).toBeVisible();
  const after = await measure();
  expect(after.font, '選んだのに字が大きくなっていない').toBeGreaterThan(before.font + 1);

  /**
   * ③ 🔴 **読み幅は動かない** ── `--read-w` は `rem`(`html` 基準)なので、
   *   `body` の大きさを変えても段の幅は 1px も動かないのが正しい。
   * ⚠ ここが動くと、同じノートを開き直すたびに**図が焼き直される**。
   */
  expect(
    Math.abs(after.width - before.width),
    `読み幅まで動いた(${before.width} → ${after.width})── 図が焼き直る`,
  ).toBeLessThan(2);

  // ④ 🔴 読み込み直しても残る(保存 → 起動時の適用)
  await page.reload();
  // ⚠ 読み込み直した直後はノートを選んでいない ── 開き直してから測る
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click({ timeout: 15_000 });
  await expect(page.locator('[data-pkc-field="detail-body"] p').first()).toBeVisible({
    timeout: 15_000,
  });
  const reloaded = await measure();
  expect(reloaded.font, '読み込み直したら既定へ戻った(保存されていない)').toBeCloseTo(
    after.font,
    1,
  );

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
