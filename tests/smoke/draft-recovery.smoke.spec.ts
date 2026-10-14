/**
 * 保存していない編集の復元(#1376)── 実ブラウザで「打つ → 保存せずに閉じる → 開き直す → 1 行 → 戻す / 消す」。
 *
 * 動線:ノートを書いて保存 → 編集に入って打ち足す(題名も変える)→ **保存せずにタブを閉じる** →
 *   同じプロファイルで開き直す → 画面の下に「保存していない編集が残っています(題名)」の 1 行 →
 *   「戻す」で編集に入り、打っていた字と題名が入っている(1 行は編集中は隠れる)→ 「編集をやめる」で元の本文に戻り、
 *   控えは残って 1 行がまた出る → 「消す」で控えが消える。
 *
 * ⚠ 2 つの page は**同じ context**(OPFS / IndexedDB / Web Locks は origin + profile 単位)。
 * ⚠ 控えの到着は「止まって 1 秒」の書込を待ってから見ている ── つまりここで通るのは**定時の書込**であって、
 *   `pagehide` / `visibilitychange` で待たずに書く経路ではない(そちらは unit の `draft-recovery.test.ts` が持つ)。
 */
import { test, expect, type Page } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp, modClickReal, useSplitEditor, writesLanded } from './helpers';

const BASE = '# 買い物\n牛乳\n';
const TYPED = '# 買い物\n牛乳\nパンを足した\n';
const TITLE = '買い物リスト(直した)';

type Stored = { cid: string; lid: string; at: number; body: string; title: string };

/** 端末に控えられている物を読む。⚠ 無いときに空の DB を作って、アプリの open(v1)を壊さない。 */
async function storedDrafts(page: Page, withSeed = false): Promise<Stored[]> {
  const all = await page.evaluate(
    () =>
      new Promise<Stored[]>((resolve) => {
        const req = indexedDB.open('pkc3-drafts', 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('drafts')) req.result.createObjectStore('drafts');
        };
        req.onerror = () => resolve([]);
        req.onsuccess = () => {
          const db = req.result;
          const q = db.transaction('drafts').objectStore('drafts').getAll();
          q.onsuccess = () => {
            db.close();
            resolve(q.result as Stored[]);
          };
          q.onerror = () => resolve([]);
        };
      }),
  );
  return withSeed ? all : all.filter((d) => d.cid !== 'seed');
}

/** 書いて保存し、編集に入って打ち足し、控えが端末に届くまで待つ。保存はしない。 */
async function typeWithoutSaving(page: Page, afterBoot?: () => Promise<void>): Promise<void> {
  await gotoApp(page);
  if (afterBoot) await afterBoot();
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(BASE);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await writesLanded(page);
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.fill(TYPED);
  const title = page.locator('[data-pkc-field="editor-title"]');
  await title.fill(TITLE);
  // 控えが端末に届くまで(止まって 1 秒)── 固定の待ちではなく届いたかを見る
  await expect
    .poll(async () => (await storedDrafts(page)).map((d) => [d.body, d.title]), { timeout: 10_000 })
    .toEqual([[TYPED, TITLE]]);
}

test('保存せずにタブを閉じて開き直すと 1 行出る。戻す → 字と題名が入り、やめれば元のまま・1 行が戻る', async ({
  page,
  context,
}) => {
  await useSplitEditor(page);
  await typeWithoutSaving(page);

  await page.close({ runBeforeUnload: false }); // 保存せずに死ぬ

  const next = await context.newPage();
  const errors = collectPageErrors(next);
  await useSplitEditor(next);
  await gotoApp(next);

  const offer = next.locator('[data-pkc-region="draft-offer"]');
  await expect(offer, '保存していない編集の 1 行が出ていない').toBeVisible({ timeout: 15_000 });
  await expect(offer.locator('[data-pkc-field="draft-offer-text"]')).toHaveText(
    /^保存していない編集が残っています\(.+\)$/,
  );
  await expect(offer.locator('button')).toHaveText(['戻す', '消す']);
  // 乗せたときの字:「消す」がノートを消す操作に読まれない
  await expect(offer.locator('[data-pkc-action="discard-draft"]')).toHaveAttribute('title', /ノートは消えません/);
  // 🔴 見た目:1 行に高さがあり、画面の外にはみ出していない
  const box = await offer.boundingBox();
  expect(box!.height, '1 行の高さが無い').toBeGreaterThan(10);
  expect(box!.y + box!.height, '画面の外にはみ出している').toBeLessThanOrEqual(
    next.viewportSize()!.height,
  );

  await clickReal(next, '[data-pkc-action="restore-draft"]');
  const ta = next.locator('[data-pkc-field="editor-body"]');
  await expect(ta, '編集に入っていない').toBeVisible();
  await expect(ta).toHaveValue(TYPED);
  await expect(next.locator('[data-pkc-field="editor-title"]')).toHaveValue(TITLE);
  await expect(offer, '編集中も 1 行が残っている').toBeHidden();
  // 戻した直後に 1 度だけ言う
  await expect(next.locator('[data-pkc-region="status"]')).toContainText('保存していない編集を戻しました');

  // 🔴 戻しただけでは何も書いていない:やめれば元の本文に戻る
  await clickReal(next, '[data-pkc-action="cancel-edit"]');
  // 戻した字は「打った内容」なので、やめる前に聞かれる(2f068705、依頼 71-1)。聞かれたうえで「編集をやめる」を選ぶ
  await expect(next.locator('[data-pkc-region="app-dialog"]'), '打った内容を捨てるかが聞かれない').toContainText(
    '打った内容を捨てますか',
  );
  await clickReal(next, '[data-pkc-field="dialog-ok"]');
  await expect(next.locator('[data-pkc-field="detail-body"]')).toContainText('牛乳');
  await expect(next.locator('[data-pkc-field="detail-body"]')).not.toContainText('パンを足した');
  // 🔴 やめても控えは残り、1 行がまた出る(戻した字を二度と戻せなくしない)
  await expect(offer, 'やめたら 1 行が戻らない').toBeVisible({ timeout: 10_000 });
  expect((await storedDrafts(next)).map((d) => [d.body, d.title])).toEqual([[TYPED, TITLE]]);
  expect(errors).toEqual([]);
});

test('消す:1 行も控えも消え、開き直しても出ない', async ({ page, context }) => {
  await useSplitEditor(page);
  await typeWithoutSaving(page);
  await page.close({ runBeforeUnload: false });

  const next = await context.newPage();
  const errors = collectPageErrors(next);
  await useSplitEditor(next);
  await gotoApp(next);
  const offer = next.locator('[data-pkc-region="draft-offer"]');
  await expect(offer).toBeVisible({ timeout: 15_000 });

  await clickReal(next, '[data-pkc-action="discard-draft"]');
  await expect(offer).toBeHidden();
  await expect.poll(async () => (await storedDrafts(next)).length, { timeout: 10_000 }).toBe(0);
  // 本文は動いていない(保存されていたのは BASE)。消しただけではノートは開かない ── 自分で開く
  await next.locator('[data-pkc-region="filer-table"] [data-pkc-entry]').first().click();
  await expect(next.locator('[data-pkc-field="detail-body"]')).toContainText('牛乳');
  await expect(next.locator('[data-pkc-field="detail-body"]')).not.toContainText('パンを足した');

  await next.close({ runBeforeUnload: false });
  const again = await context.newPage();
  const errors2 = collectPageErrors(again);
  await useSplitEditor(again);
  await gotoApp(again);
  // 対照群:前の回は 1 行が出ていた。今回は(起動が落ち着いた後も)出ない
  await expect(again.locator('[data-pkc-boot="ready"]')).toBeAttached();
  await again.waitForTimeout(1500); // 起動後に非同期で出る物なので、出ないことは少し待ってから見る
  await expect(again.locator('[data-pkc-region="draft-offer"]')).toBeHidden();
  expect(errors).toEqual([]);
  expect(errors2).toEqual([]);
});

test('🔴 既定のライブエディタでも、戻すと字と題名が入り、打つと控えが更新される', async ({ page, context }) => {
  // useSplitEditor を呼ばない ── 既定(1 面のライブエディタ)
  await gotoApp(page);
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live).toBeVisible();
  await clickReal(page, '[data-pkc-region="editor-live"]');
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row).toBeVisible();
  await row.fill('# 買い物\n牛乳');
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await writesLanded(page);
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(live).toBeVisible();
  await modClickReal(page, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
  await expect(live.locator('[data-pkc-field="row-source"]')).toHaveValue('牛乳');
  await live.locator('[data-pkc-field="row-source"]').fill('牛乳 パンを足した');
  await page.keyboard.press('Tab');
  await page.locator('[data-pkc-field="editor-title"]').fill(TITLE);
  await expect
    .poll(async () => (await storedDrafts(page)).map((d) => [d.body.includes('パンを足した'), d.title]), {
      timeout: 10_000,
    })
    .toEqual([[true, TITLE]]);
  await page.close({ runBeforeUnload: false });

  const next = await context.newPage();
  const errors = collectPageErrors(next);
  await gotoApp(next);
  const offer = next.locator('[data-pkc-region="draft-offer"]');
  await expect(offer).toBeVisible({ timeout: 15_000 });
  await clickReal(next, '[data-pkc-action="restore-draft"]');
  const liveNext = next.locator('[data-pkc-region="editor-live"]');
  await expect(liveNext, 'ライブエディタで編集に入っていない').toBeVisible();
  await expect(liveNext).toContainText('パンを足した');
  await expect(next.locator('[data-pkc-field="editor-title"]')).toHaveValue(TITLE);
  // 戻した後に打つと、控えが更新される
  await modClickReal(next, '[data-pkc-region="editor-live"] p:nth-of-type(1)');
  await liveNext.locator('[data-pkc-field="row-source"]').fill('牛乳 パンを足した さらに打った');
  await next.keyboard.press('Tab');
  await expect
    .poll(async () => (await storedDrafts(next)).map((d) => d.body.includes('さらに打った')), { timeout: 10_000 })
    .toEqual([true]);
  expect(errors).toEqual([]);
});

test('🔴 控えは 20 件まで:21 件目を書くと、いちばん古い 1 件が落ちる(本物の IndexedDB)', async ({ page }) => {
  await useSplitEditor(page);
  await typeWithoutSaving(page, async () => {
    // 別のコレクション('seed')の古い控えを 20 件、直に置く(アプリの書き手は 1 ノート 1 件しか書けない)
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('pkc3-drafts', 1);
          req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains('drafts')) req.result.createObjectStore('drafts');
          };
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const t = db.transaction('drafts', 'readwrite');
            const s = t.objectStore('drafts');
            for (let i = 1; i <= 20; i++) {
              s.put({ cid: 'seed', lid: `s${i}`, body: 'x', title: '', base: '', at: i, tab: 'SEED' }, `seed\u0000s${i}`);
            }
            t.oncomplete = () => {
              db.close();
              resolve();
            };
            t.onerror = () => reject(t.error);
          };
        }),
    );
  });
  // 21 件目(今打っている控え)が書かれた後は、全体で 20 件。いちばん古い(at=1)が落ちている
  const all = await storedDrafts(page, true);
  expect(all, '20 件を超えて残っている').toHaveLength(20);
  expect(all.map((d) => d.at), '古い控えが落ちていない').not.toContain(1);
  expect(all.some((d) => d.cid !== 'seed' && d.body === TYPED), '今の控えが落ちた').toBe(true);
});
