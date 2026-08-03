import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gotoApp, clickReal } from './helpers';

/**
 * P7 段⑧: **boot 前に交代されたタブが救われる**(設計 doc 段⑧ 実装記録)。
 *
 * 🔴 この機構は **1 行殺しても誰も鳴らなかった**(round-3 review H-3 で実証:
 * `location.reload()` を no-op にしても unit 1066 件 + smoke 17 件が全緑)。
 * `tests/adapter/preboot-swap.test.ts` は「いつ読み直すか」の判断しか見ておらず、
 * `tests/adapter/bootstrap-wiring.test.ts` は原文検査なので、
 * **渡した container が本物か / callback が実際に読み直すか**は原理的に見えない。
 *
 * ⚠ ここだけが**実タブ 2 枚**で確かめる ── lease 待ちのタブは、更新に巻き込まれた
 * まま進むと**旧 build の hash 付き URL** を取りに行って起動不能になる。
 */
const SW_PATH = fileURLToPath(new URL('../../dist/sw.js', import.meta.url));

test('🔴 lease 待ちのタブは、別タブの更新に気づいて読み直す', async ({ context }) => {
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

    // タブ B: 後から開く → lease 待ちで止まる(boot は解決しない)
    const b = await context.newPage();
    await b.goto('/');
    await expect(b.locator('[data-pkc-slot="root"]')).toContainText('別のタブで開いています', {
      timeout: 20_000,
    });
    // ⚠ **前提が成立していることを見る** ── boot 済みだとこの test は別物になる
    expect(await b.locator('[data-pkc-slot="root"]').getAttribute('data-pkc-boot')).toBeNull();

    // この document が生きている印(**再読込で必ず消える**もの)
    await b.evaluate(() => {
      (window as unknown as Record<string, unknown>).__prebootProbe = true;
    });
    expect(
      await b.evaluate(
        () => (window as unknown as Record<string, unknown>).__prebootProbe === true,
      ),
    ).toBe(true);

    // 🔴 別 build を配って、**タブ A から**更新を適用する
    writeFileSync(SW_PATH, original.replace(`"${buildId}"`, '"prebootswap00"'));
    await a.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update();
    });
    const card = a.locator('[data-pkc-region="update"]');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await clickReal(a, '[data-pkc-action="apply-update"]');

    // ✅ B は**自分で読み直す**(押していないのに、まだ何も持っていないから安全)
    await b.waitForFunction(
      () => (window as unknown as Record<string, unknown>).__prebootProbe === undefined,
      null,
      { timeout: 20_000 },
    );
    // ⚠ **弁別しているのは上の probe だけ**である。A も「再読込」で自分を読み直す
    // ので lease を手放し、B はそのまま起動する ── 「B が起動する」は
    // preboot が無くてもこの環境では成立する(旧 hash の chunk が preview server
    // にまだ在るため)。ここで見ているのは「**壊れて終わらない**」ことだけ
    await expect(b.locator('[data-pkc-slot="root"][data-pkc-boot="ready"]')).toBeAttached({
      timeout: 30_000,
    });
  } finally {
    writeFileSync(SW_PATH, original);
  }
});
