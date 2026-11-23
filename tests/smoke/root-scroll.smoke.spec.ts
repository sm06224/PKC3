/**
 * 🔴 **画面全体(文書ルート)が下へスクロールしない**(実機報告: 追記欄の下に約 150px の空白が出て、画面全体が持ち上がる)。
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 PC の幅で、情報ペインの開閉・長い表のあるログ・追記欄・追記の送信・編集中(caret を末尾へ)のどれでも
 * |    `document.documentElement.scrollHeight <= innerHeight` で、ルートの位置は 0 | grid の行の解決と、はみ出しの合計は実ブラウザ |
 * | 🔴 何かが下へはみ出しても(本体に 150px の箱を足す)、ホイールでも `scrollIntoView` でもルートは 0 のまま | スクロールの連鎖は実ブラウザ |
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, dismissAnnounce, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const TABLE = [
  `| ${Array.from({ length: 6 }, (_, i) => `列${i + 1}`).join(' | ')} |`,
  `| ${Array.from({ length: 6 }, () => '---').join(' | ')} |`,
  ...Array.from({ length: 80 }, (_, r) => `| ${Array.from({ length: 6 }, (_, i) => `値${r}-${i}`).join(' | ')} |`),
].join('\n');
const FIXTURE = ['## 2026-10-01 09:00:00', TABLE, ...Array.from({ length: 30 }, (_, i) => `段落 ${i + 1}`)].join('\n\n');

async function rootState(page: Page): Promise<{ scrollHeight: number; inner: number; top: number }> {
  return page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    inner: innerHeight,
    top: document.scrollingElement?.scrollTop ?? 0,
  }));
}

async function expectRootStill(page: Page, label: string): Promise<void> {
  // ホイールを本文の外(下の端)で回す ── ルートがスクロールできるなら、ここで動く
  const vh = page.viewportSize()!.height;
  await page.mouse.move(700, vh - 4);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(150);
  const s = await rootState(page);
  // ⚠ ガード(位置を 0 へ戻す JS)が CSS の代わりを務めてしまうので、CSS 自体も見る(ホイールで 1 コマ揺れない)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY), `${label}: html の overflow`).toBe('hidden');
  expect(s.scrollHeight, `${label}: 文書が画面より背が高い(${s.scrollHeight} > ${s.inner})`).toBeLessThanOrEqual(s.inner);
  expect(s.top, `${label}: 画面全体が下へスクロールした`).toBe(0);
}

for (const [w, h] of [
  [1440, 900],
  [1280, 720],
] as const) {
  test(`🔴 ${w}×${h}: 情報ペインの開閉・長い表・追記欄・追記・編集中でも、画面全体は動かない`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await gotoApp(page);
    await dismissAnnounce(page);
    await createEntry(page, 'textlog');
    await page.fill('[data-pkc-field="editor-body"]', FIXTURE);
    await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await page.waitForSelector('[data-pkc-action="start-edit"]');
    await expect(page.locator('[data-pkc-field="append-input"]')).toBeVisible();
    await expectRootStill(page, '情報ペインを開いたまま');

    const grip = page.locator('[data-pkc-action="toggle-pane"][data-pkc-pane="inspector"]').first();
    await grip.click();
    await expect(page.locator('[data-pkc-region="inspector"]')).toBeHidden();
    await expectRootStill(page, '情報ペインを閉じた');

    await page.click('[data-pkc-field="append-input"]');
    await page.keyboard.type('追記のテスト');
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('[data-pkc-field="append-input"]')).toHaveValue('');
    await expectRootStill(page, '追記を送った後');

    await page.click('[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
    await page.focus('[data-pkc-field="editor-body"]');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('x');
    await expectRootStill(page, '編集中(caret を末尾へ)');
  });
}

test('🔴 下へはみ出す物があっても、ホイールでも scrollIntoView でも画面全体は 0 のまま', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  // 何かの要素が 150px はみ出した状態を作る(実機の報告の形)
  await page.evaluate(() => {
    const stray = document.createElement('div');
    stray.setAttribute('data-probe', 'stray');
    stray.style.cssText = 'height:150px';
    document.body.append(stray);
  });
  await page.mouse.move(700, 450);
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(150);
  expect((await rootState(page)).top, 'ホイールで画面全体が持ち上がった').toBe(0);
  await page.evaluate(() => document.querySelector('[data-probe="stray"]')!.scrollIntoView());
  await page.waitForTimeout(150);
  expect((await rootState(page)).top, 'scrollIntoView で画面全体が持ち上がったまま').toBe(0);
  const shellBottom = await page.locator('[data-pkc-region="shell"]').evaluate((el) => el.getBoundingClientRect().bottom);
  expect(shellBottom, 'shell の下端が画面の下端からずれた').toBe(900);
});
