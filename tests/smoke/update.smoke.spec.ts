import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gotoApp, collectPageErrors, clickReal } from './helpers';

/**
 * P7 段⑤: **更新が user に届く**(設計 doc §2-3)。
 *
 * 🔴 この機構は「壊れても誰も気づかない」種類である ── 更新は滅多に来ないので、
 * 案内が出ない / 押しても交代しない / 交代しても再読込しない、のどれも
 * 手元の操作では踏まない。**実際に別 build の `sw.js` を配って**確かめる。
 *
 * ⚠ unit(`tests/adapter/update-prompt.test.ts` / `sw-source.test.ts`)は
 * 「アプリ側の判断」と「SW 側の応答」を別々に見ているだけで、**その 2 つが
 * 実際につながっているか**は誰も見ていない ── 配線は実物でしか確かめられない
 * (P7 段③ review H-1 と同じ穴)。
 */
const SW_PATH = fileURLToPath(new URL('../../dist/sw.js', import.meta.url));

test('🔴 新しい版が配られたら案内が出て、押すと入れ替わる', async ({ page }) => {
  const errors = collectPageErrors(page);
  const original = readFileSync(SW_PATH, 'utf-8');
  const buildId = /const BUILD = "([^"]+)"/.exec(original)?.[1];
  expect(buildId, 'sw.js に build id が無い(生成器が変わった)').toBeTruthy();

  try {
    await gotoApp(page);

    // 消えては困るものを 1 つ置く(更新で飛ばないことの観測点)
    await clickReal(page, '[data-pkc-action="create-entry"][data-pkc-archetype="text"]');
    const ta = page.locator('[data-pkc-field="editor-body"]');
    await expect(ta).toBeVisible();
    await ta.click();
    await page.keyboard.type('# 更新をまたぐ');
    await clickReal(page, '[data-pkc-action="commit-edit"]');
    await expect(page.locator('[data-pkc-field="detail-body"] h1')).toBeVisible();

    // 旧 SW が制御を持つまで待つ(ここが無いと「初回インストール」になり、
    // 待機は起きず案内も出ない ── 案内が出ない理由を取り違える)
    await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, {
      timeout: 20_000,
    });

    // ⚠ この時点では案内は**出ていない**(出ていたら初回インストールに出す
    // 実装 = 「初めて開いた人に更新の案内」になっている)
    await expect(page.locator('[data-pkc-region="update"]')).toBeHidden();

    // 🔴 ここから本番。**別 build の sw.js を配る**。SW 本体の script は
    // 既定で HTTP cache を経由しない(updateViaCache は imports)ので、
    // reload するとブラウザが取り直して差分に気づく
    writeFileSync(SW_PATH, original.replace(`"${buildId}"`, '"smoketest0000"'));
    await page.reload();
    await expect(page.locator('[data-pkc-slot="root"][data-pkc-boot="ready"]')).toBeAttached();

    // ① 案内が出る
    const card = page.locator('[data-pkc-region="update"]');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator('[data-pkc-field="update-text"]')).toHaveText(/新しい版/);

    // ② 押すと交代して**再読込まで進む**(押しただけで止まらない)。
    // 🔴 観測点は「**この document が入れ替わったか**」。当初は
    // 「controller があって boot が ready」で待っていたが、**押す前の
    // ページが既にその条件を満たしている** ── 待ちが即座に通り、その後の
    // `evaluate` が再読込に巻き込まれて `Execution context was destroyed` で
    // 落ちた(CI で実際に踏んだ)。⚠ ローカルで緑だったのは時間の綾で、
    // **再読込が起きたことは一度も確かめていなかった**
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__beforeReload = true;
    });
    await clickReal(page, '[data-pkc-action="apply-update"]');
    await page.waitForFunction(
      () =>
        !(window as unknown as Record<string, unknown>).__beforeReload &&
        document.querySelector('[data-pkc-slot="root"]')?.getAttribute('data-pkc-boot') ===
          'ready',
      null,
      { timeout: 20_000 },
    );
    await page.waitForLoadState();

    // ③ 新しい版が制御しており、案内はもう出ていない
    await expect(page.locator('[data-pkc-region="update"]')).toBeHidden();
    const active = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { waiting: Boolean(reg?.waiting), cacheKeys: await caches.keys() };
    });
    expect(active.waiting).toBe(false);
    // 🔴 新 build の cache になっており、旧 build の cache は残っていない
    expect(active.cacheKeys.some((k) => k.endsWith(':smoketest0000'))).toBe(true);
    expect(active.cacheKeys.some((k) => k.endsWith(`:${buildId}`))).toBe(false);

    // ④ **中身は消えていない**(更新はデータを飛ばさない)
    const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
    await expect(rows).toHaveCount(1);
  } finally {
    // ⚠ 生成物を書き換えたまま終えると、後続の spec と検品が別物を見る
    writeFileSync(SW_PATH, original);
  }

  expect(errors).toEqual([]);
});
