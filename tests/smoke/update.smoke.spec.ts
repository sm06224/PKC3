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

test('🔴 新しい版が配られたら案内が出て、押すと入れ替わる', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  const original = readFileSync(SW_PATH, 'utf-8');
  const buildId = /const BUILD = "([^"]+)"/.exec(original)?.[1];
  expect(buildId, 'sw.js に build id が無い(生成器が変わった)').toBeTruthy();
  // ⚠ 下限は**出荷している一覧の件数**から取る(定数を書くと配る物が減っても気づかない)
  const precacheCount = (JSON.parse(
    /const PRECACHE = (\[.*?\]);/.exec(original)?.[1] ?? '[]',
  ) as string[]).length;
  expect(precacheCount, 'sw.js の precache 一覧が読めない').toBeGreaterThan(3);

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

    // 🔴 ①' 先に「あとで」を押す(review M-1)。`main.ts` の
    // `dismissUpdate: () => updatePrompt.dismiss()` を **`apply()` に変異させても
    // 993 unit + 17 smoke が全緑**だった ── 「あとで」が「再読込」として動き、
    // しかも未保存の下書きを巻き込んで reload しても、誰も気づかない配線だった。
    // ⚠ 観測点は「**再読込が起きていない**」こと(面が消えるだけでは足りない)
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__beforeDismiss = true;
    });
    await clickReal(page, '[data-pkc-action="dismiss-update"]');
    await expect(card).toBeHidden();
    expect(
      await page.evaluate(
        () => (window as unknown as Record<string, unknown>).__beforeDismiss === true,
      ),
      '「あとで」で再読込が起きた',
    ).toBe(true);

    // ⚠ 見送っても待機中の worker は残る ── 開き直せばまた出る(そこから ② へ)
    await page.reload();
    await expect(page.locator('[data-pkc-slot="root"][data-pkc-boot="ready"]')).toBeAttached();
    await expect(card).toBeVisible({ timeout: 20_000 });

    // 🔴 ①'' 編集中に押したら**聞く**(review M-2 / M-1-b)。`main.ts` の
    // `isEditing` の配線は unit からは届かない ── `() => false` に変異させても
    // 全緑だった。再読込は open editor の本文を捨てる(本文は AppState にしか
    // 無く `beforeunload` も無い)ので、ここが死ぬと**黙って下書きが消える**
    // ⚠ 再読込後は何も選択されていない ── 先に開かないと編集導線が出ない
    await clickReal(page, '[data-pkc-region="entry-list"] [data-pkc-entry]');
    await clickReal(page, '[data-pkc-action="start-edit"]');
    await expect(page.locator('[data-pkc-field="editor-body"]')).toBeVisible();
    let asked: string | null = null;
    page.once('dialog', (d) => {
      asked = d.message();
      void d.dismiss(); // ⚠ **断る** ── 何も起きないことを見る
    });
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__beforeConfirm = true;
    });
    await clickReal(page, '[data-pkc-action="apply-update"]');
    await expect.poll(() => asked, { timeout: 5_000 }).not.toBeNull();
    expect(asked!).toContain('編集中');
    expect(
      await page.evaluate(
        () => (window as unknown as Record<string, unknown>).__beforeConfirm === true,
      ),
      '断ったのに再読込が起きた',
    ).toBe(true);
    // ⚠ 断ったら導線は残る(押し直せる)
    await expect(page.locator('[data-pkc-action="apply-update"]')).toBeVisible();
    await clickReal(page, '[data-pkc-action="cancel-edit"]');

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
      const keys = await caches.keys();
      const name = keys.find((k) => k.startsWith('pkc3:'));
      const entries = name ? (await (await caches.open(name)).keys()).length : 0;
      return { waiting: Boolean(reg?.waiting), keys, entries };
    });
    expect(active.waiting).toBe(false);
    // 🔴 **cache 名は丸ごと突き合わせる**(round-2 review H-1)。当初は
    // `endsWith(':smoketest0000')` で見ていたが、H-1 の修正で増えた
    // **印(`pkc3-active:…`)だけでその条件が満たされる** ── precache が
    // 空でも緑になった(実証: 実エントリ 8 → 1 でも全 spec 緑)
    expect(active.keys).toContain('pkc3:%2F:smoketest0000');
    expect(active.keys).not.toContain(`pkc3:%2F:${buildId}`);
    // 🔴 **下限も置く**(CLAUDE.md「tripwire は上限だけでなく下限も」)。
    // 名前が在るだけでは「空の cache が在る」と区別できない
    expect(active.entries, '更新後の precache が痩せている').toBe(precacheCount);

    // ④ **中身は消えていない**(更新はデータを飛ばさない)
    const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
    await expect(rows).toHaveCount(1);

    // ⑤ 🔴 **更新後もオフラインで読める**。①〜④ は「cache が在る」までしか
    // 見ておらず、**中身が使える**かは見ていない ── オフライン smoke は
    // 初回 install 経路しか通らないので、更新経路はここでしか守られない
    await context.route('**/*', (route) => route.abort('internetdisconnected'));
    await page.reload({ waitUntil: 'commit' });
    await expect(page.locator('[data-pkc-slot="root"][data-pkc-boot="ready"]')).toBeAttached({
      timeout: 30_000,
    });
    await expect(page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]')).toHaveCount(1);
    await context.unroute('**/*');
  } finally {
    // ⚠ 生成物を書き換えたまま終えると、後続の spec と検品が別物を見る
    writeFileSync(SW_PATH, original);
  }

  expect(errors).toEqual([]);
});
