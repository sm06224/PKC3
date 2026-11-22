/**
 * 🔴 **ログを新しい順に並べる**(#2018 1。user 裁定 2026-11-22)── 実ブラウザで、**見た目の上下**が入れ替わることを見る。
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 「古い順」ボタンを押すと、新しい記録が**画面の上**に来る(入れ子の追いログは親の下のまま)| `order` は happy-dom で配置に映らない |
 * | 🔴 ふつうのノートの段落の位置は、設定を変えても 1px も動かない(flex はログの新しい順だけ) | 余白の重なりは実寸でしか測れない |
 * | 🔴 設定画面の列と、読む面のボタンが同じ値を映す(双方向) | 本物の設定画面 |
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const BODY = '[data-pkc-region="detail"] [data-pkc-field="detail-body"]';

async function tops(page: Page, texts: readonly string[]): Promise<number[]> {
  const out: number[] = [];
  for (const t of texts) {
    const box = await page.locator(`${BODY} p`, { hasText: t }).first().boundingBox();
    if (box === null) throw new Error(`「${t}」が描かれていない`);
    out.push(Math.round(box.y));
  }
  return out;
}

test('🔴 ログの並べ替え: 新しい記録が上に来て、入れ子は親の下のまま / ふつうのノートは 1px も動かない (#2018 1)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await page.evaluate(() => localStorage.removeItem('pkc3.log-order'));

  // 対照群: ふつうのノートの段落の位置を先に測る
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-body"]', ['# 見出し', 'ふつう一', '## 小見出し', 'ふつう二'].join('\n\n'));
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const plainBefore = await tops(page, ['ふつう一', 'ふつう二']);
  const plainLid = await page.locator(BODY).getAttribute('data-pkc-painted');

  await createEntry(page, 'textlog');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    ['## 2026-10-09 09:00:00', '古い記録', '### 2026-10-09 09:30:00', '古い記録の追い', '## 2026-10-10 08:00:00', '新しい記録'].join('\n\n'),
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  const btn = page.locator(`${BODY} [data-pkc-field="log-order"]`);
  await expect(btn, '並べ替えのボタンが出ていない').toHaveText('古い順');
  const [old0, follow0, new0] = (await tops(page, ['古い記録', '古い記録の追い', '新しい記録'])) as [number, number, number];
  expect(old0 < follow0 && follow0 < new0, '前提: 古い順で上から書いた順').toBe(true);
  // 古い順のログは flex にならない(通常の流れ)
  expect(await page.locator(BODY).evaluate((el) => getComputedStyle(el).display)).toBe('block');

  await btn.click();
  await expect(btn).toHaveText('新しい順');
  const [old1, follow1, new1] = (await tops(page, ['古い記録', '古い記録の追い', '新しい記録'])) as [number, number, number];
  expect(new1, '新しい記録が上に来ていない').toBeLessThan(old1);
  expect(old1, '入れ子の追いログが親の下に居ない').toBeLessThan(follow1);
  expect(await page.evaluate(() => localStorage.getItem('pkc3.log-order'))).toBe('desc');

  // 設定画面の列も「新しい順」(双方向)── そこで「古い順」を押すと戻る
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const choice = page.locator('[data-pkc-field="log-order-select"]');
  await expect(choice.locator('[data-pkc-log-order-value="desc"]')).toHaveAttribute('aria-pressed', 'true');
  await choice.locator('[data-pkc-log-order-value="asc"]').click();
  await expect(choice.locator('[data-pkc-log-order-value="asc"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('pkc3.log-order'))).toBe('asc');

  // 新しい順にした状態で、ふつうのノートの段落が 1px も動かない
  await page.evaluate(() => localStorage.setItem('pkc3.log-order', 'desc'));
  await page.locator(`[data-pkc-region="sidebar"] [data-pkc-entry="${String(plainLid)}"]`).first().click();
  await expect(page.locator(BODY)).toHaveAttribute('data-pkc-painted', String(plainLid));
  expect(await tops(page, ['ふつう一', 'ふつう二']), 'ふつうのノートの段落が動いた').toEqual(plainBefore);
  expect(await page.locator(BODY).evaluate((el) => getComputedStyle(el).display)).toBe('block');

  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});
