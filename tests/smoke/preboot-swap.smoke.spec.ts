import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gotoApp, clickReal } from './helpers';

/**
 * P7 段⑧ → #177 で書き直し: **2 枚目のタブが、別タブの更新適用で壊れない**。
 *
 * 旧版はここで「lease 待ちで止まったタブが SW 交代で読み直す」を実タブ 2 枚で
 * 確かめていた。#177 以降、2 枚目は**待たずに follower として boot する**ので、
 * その前提(待機で止まる)は同一ビルドの 2 タブでは作れなくなった ──
 * 待機は「本体が旧ビルド(proxy 応答なし)」のときだけの fallback で、
 * その判断は `tests/adapter/preboot-swap.test.ts`(unit)が引き続き守る。
 *
 * いま実タブ 2 枚で守るべき主張はこれ:
 * 1. 2 枚目は follower として boot する(待機画面ではない)
 * 2. タブ A が更新を適用して読み直すと、**A の lease が返り、B がその場で昇格する**
 *    (Web Locks の待ち行列は B が先頭 ── 決定的)
 * 3. どちらのタブも error で終わらない
 */
const SW_PATH = fileURLToPath(new URL('../../dist/sw.js', import.meta.url));

test('🔴 2 枚目(follower)は、別タブの更新適用で昇格して生き残る', async ({ context }) => {
  const original = readFileSync(SW_PATH, 'utf-8');
  const buildId = /const BUILD = "([^"]+)"/.exec(original)?.[1];
  expect(buildId, 'sw.js に build id が無い').toBeTruthy();

  try {
    // タブ A: 先に開いて lease を握る
    const a = await context.newPage();
    await gotoApp(a);
    await a.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, {
      timeout: 20_000,
    });

    // タブ B: 後から開く → 待機ではなく follower boot(#177)
    const b = await context.newPage();
    await gotoApp(b);
    await expect(b.locator('[data-pkc-region="status"]')).toContainText(
      '保存は本体タブ経由',
      { timeout: 20_000 },
    );

    // 🔴 別 build を配って、**タブ A から**更新を適用する
    writeFileSync(SW_PATH, original.replace(`"${buildId}"`, '"prebootswap00"'));
    await a.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update();
    });
    const card = a.locator('[data-pkc-region="update"]');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await clickReal(a, '[data-pkc-action="apply-update"]');

    // ✅ A の読み直しで lease が返り、B が**その場で**昇格する(reload 無し)
    await expect(b.locator('[data-pkc-region="status"]')).toContainText(
      'このタブが本体になりました',
      { timeout: 20_000 },
    );
    expect(await b.locator('[data-pkc-slot="root"]').getAttribute('data-pkc-boot')).toBe(
      'ready',
    );

    // ✅ A も壊れて終わらない(読み直した先は follower か本体か ── どちらも正しい)
    await a.waitForFunction(
      () =>
        document
          .querySelector('[data-pkc-slot="root"]')
          ?.getAttribute('data-pkc-boot') === 'ready',
      null,
      { timeout: 20_000 },
    );
  } finally {
    writeFileSync(SW_PATH, original);
  }
});
