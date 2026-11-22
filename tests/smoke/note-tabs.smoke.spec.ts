/**
 * 🔴 **ノートのタブ列を実ブラウザで通す**(#1982 段 5-3)。
 *
 * unit(happy-dom)では届かない層だけを見る:
 * - 本物の CSS で、**有効なタブが形で示される**(左端の線 = inset の影・太字)
 * - 1 枚では**場所を取らない**(版面が動かない)/ 2 枚で出る
 * - 本物の印刷の media で**消える**
 * - タブ列が**ページを横にはみ出させない**
 *
 * 2 枚目は、いまの画面で user が辿れる道で作る: ピン留めしたノートを開いたまま、一覧の別の行を
 * 普通に押す(ピン留めの有効なタブは差し替えない ── 裁定 2 / 5-1 の `openReplace` の keep)。
 * Ctrl+クリック・中クリック・右クリック・キーは段 5-4 の spec で足す。
 */
import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, dismissAnnounce, gotoApp, openViewPane, useSplitEditor, openBrowse } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

async function makeNote(page: import('@playwright/test').Page, title: string): Promise<void> {
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill(title);
  await page.locator('[data-pkc-field="editor-body"]').fill(`# ${title}\n\n本文`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
}

test('🔴 タブ列: 1 枚では出ない / ピン留めを開いたまま別の行を押すと 2 枚 / 現在地は形 / 押すと切り替わる / × で閉じる / 印刷に出ない', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await makeNote(page, '週次の打ち合わせ');
  await makeNote(page, '読書メモ');

  const bar = page.locator('[data-pkc-region="note-tabs"]');
  // 一覧の行(題名を持つもの。行の中の部品も data-pkc-entry を持つので、題名で行に絞る)
  const rows = page
    .locator('[data-pkc-region="sidebar"] [data-pkc-entry]')
    .filter({ has: page.locator('[data-pkc-field="title"]') });
  await expect(rows).toHaveCount(2);
  // ① 1 枚では出ない(場所も取らない)
  await expect(bar).toBeHidden();
  expect((await bar.boundingBox()) ?? { height: 0 }, 'タブ 1 枚なのに場所を取っている').toMatchObject({ height: 0 });

  // ② ピン留めしたノートを開いたまま、別の行を普通に押す → 2 枚
  const first = rows.filter({ hasText: '週次の打ち合わせ' });
  await first.click();
  await first.click({ button: 'right' });
  await page.locator('[data-pkc-region="context-menu"] [data-pkc-action="pin-note"]').click();
  await rows.filter({ hasText: '読書メモ' }).click();
  await expect(bar).toBeVisible();
  const tabs = bar.locator('[role="tab"]');
  await expect(tabs).toHaveCount(2);
  // ピン留めが先頭、いま開いているのは 2 枚目
  await expect(tabs.nth(0)).toContainText('週次の打ち合わせ');
  await expect(tabs.nth(0).locator('[data-pkc-field="note-tab-pin"]')).toHaveCount(1);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'false');

  // ③ 現在地は形で示す(色だけに頼らない): 有効なタブだけ太字 + 左端の線(inset の影)
  const look = async (i: number) =>
    tabs.nth(i).evaluate((el) => {
      const cell = el.parentElement!;
      return {
        weight: Number(getComputedStyle(el).fontWeight),
        shadow: getComputedStyle(cell).boxShadow + ' ' + getComputedStyle(el).boxShadow,
      };
    });
  const on = await look(1);
  const off = await look(0);
  expect(on.weight, '有効なタブが太字でない').toBeGreaterThanOrEqual(600);
  expect(off.weight, '有効でないタブまで太字').toBeLessThan(600);
  expect(on.shadow, '有効なタブに左端の線が無い').toMatch(/inset/);
  expect(off.shadow, '有効でないタブにも線がある').not.toMatch(/inset/);

  // ④ ページを横にはみ出させない
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'タブ列がページを横にはみ出させている').toBeLessThanOrEqual(0);

  // ⑤ 印刷には出ない
  await page.emulateMedia({ media: 'print' });
  await expect(bar).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await expect(bar).toBeVisible();

  // ⑥ 押すと切り替わる(本文も)
  await tabs.nth(0).click();
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toHaveText('週次の打ち合わせ');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  // フォーカスは押したタブに残る(作り直しで body へ落ちない)
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-pkc-note-tab'))).not.toBeNull();

  // ⑦ 有効でない方の × で閉じる → 1 枚になり、列は消える。開いているノートは変わらない
  await bar.locator('[data-pkc-action="close-note-tab"]').nth(1).click();
  await expect(bar).toBeHidden();
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toHaveText('週次の打ち合わせ');
  // ノートは消えない
  await expect(rows).toHaveCount(2);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 タブの操作(段 5-4): 中クリックで新しいタブ / Alt+PageDown・PageUp / タブの右クリックで閉じる・開き直す / 矢印と Delete', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await makeNote(page, '一つ目');
  await makeNote(page, '二つ目');
  await makeNote(page, '三つ目');
  const bar = page.locator('[data-pkc-region="note-tabs"]');
  const rows = page
    .locator('[data-pkc-region="sidebar"] [data-pkc-entry]')
    .filter({ has: page.locator('[data-pkc-field="title"]') });
  const tabs = bar.locator('[role="tab"]');
  const title = page.locator('[data-pkc-field="detail-body"] h1');

  // ① 通常クリックは差し替え(タブは 1 枚のまま)。中クリックで 2 枚目・3 枚目
  await rows.filter({ hasText: '一つ目' }).click();
  await expect(bar).toBeHidden();
  await rows.filter({ hasText: '二つ目' }).click({ button: 'middle' });
  await expect(tabs).toHaveCount(2);
  await rows.filter({ hasText: '三つ目' }).click({ button: 'middle' });
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(title).toHaveText('三つ目');

  // ② Alt+PageDown は端の次(先頭)へ、Alt+PageUp で戻る
  await page.keyboard.press('Alt+PageDown');
  await expect(title).toHaveText('一つ目');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Alt+PageUp');
  await expect(title).toHaveText('三つ目');

  // ③ 矢印は焦点だけ動かす(有効なタブ・本文は変わらない)/ Enter で有効に
  await tabs.nth(2).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(title).toHaveText('三つ目');
  await page.keyboard.press('Enter');
  await expect(title).toHaveText('二つ目');

  // ④ 右クリック → タブを閉じる(押したタブ。3 枚目)
  await tabs.nth(2).click({ button: 'right' });
  const menu = page.locator('[data-pkc-region="context-menu"]');
  await expect(menu.locator('[data-pkc-action="reopen-note-tab"]')).toBeDisabled();
  await menu.locator('[data-pkc-action="close-note-tab"]').click();
  await expect(tabs).toHaveCount(2);
  await expect(title).toHaveText('二つ目');

  // ⑤ 閉じたタブを開き直す
  await tabs.nth(0).click({ button: 'right' });
  await menu.locator('[data-pkc-action="reopen-note-tab"]').click();
  await expect(tabs).toHaveCount(3);
  await expect(title).toHaveText('三つ目');

  // ⑥ Delete で焦点のタブを閉じる
  await tabs.nth(0).focus();
  await page.keyboard.press('Delete');
  await expect(tabs).toHaveCount(2);

  // ⑦ 行の右クリック「新しいタブで開く」── いまのタブはそのまま
  await rows.filter({ hasText: '一つ目' }).click({ button: 'right' });
  await menu.locator('[data-pkc-action="open-note-new-tab"]').click();
  await expect(tabs).toHaveCount(3);
  await expect(title).toHaveText('一つ目');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 周辺の整合(段 5-5): 右クリックを閉じてもタブが残る / 2 ペイン中は灰色で押すと戻る / スマホ幅は「開いているノート ▾」', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await makeNote(page, '一つ目');
  await makeNote(page, '二つ目');
  await makeNote(page, '三つ目');
  const bar = page.locator('[data-pkc-region="note-tabs"]');
  const rows = page
    .locator('[data-pkc-region="sidebar"] [data-pkc-entry]')
    .filter({ has: page.locator('[data-pkc-field="title"]') });
  const tabs = bar.locator('[role="tab"]');
  const title = page.locator('[data-pkc-field="detail-body"] h1');
  const menu = page.locator('[data-pkc-region="context-menu"]');

  await rows.filter({ hasText: '一つ目' }).click();
  await rows.filter({ hasText: '二つ目' }).click({ button: 'middle' });
  await expect(tabs).toHaveCount(2);
  await tabs.nth(0).click();
  await expect(title).toHaveText('一つ目');

  const backBefore = await page.locator('[data-pkc-action="nav-back"]').isDisabled();
  // ① 行を右クリック → 何も選ばず Esc。タブも本文も元のまま(「三つ目」に差し替わらない)
  await rows.filter({ hasText: '三つ目' }).click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toContainText('一つ目');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(title).toHaveText('一つ目');
  // 履歴も元のまま(unit が past の中身を見る。ここは実ブラウザで「戻る」の押せる・押せないが変わらないこと)
  expect(await page.locator('[data-pkc-action="nav-back"]').isDisabled()).toBe(backBefore);

  // ② 2 ペイン: タブ列は同じ場所に灰色で出る。押すと通常ビューへ戻ってそのノートを開く
  await openBrowse(page, 'launcher');
  const before = await bar.boundingBox();
  await openViewPane(page, 'dual');
  await expect(bar).toHaveAttribute('data-pkc-dimmed', '');
  await expect(bar, '2 ペイン中にタブ列が消えた').toBeVisible();
  const during = await bar.boundingBox();
  expect(during?.y, 'タブ列の位置が動いた').toBe(before?.y);
  const dimColor = await tabs.nth(1).locator('[data-pkc-field="note-tab-title"]').evaluate((el) => getComputedStyle(el).color);
  await expect(tabs.nth(1)).toHaveAttribute('title', '押すと 2 ペインを閉じてこのノートを開きます');
  await tabs.nth(1).click();
  await expect(page.locator('[data-pkc-view-pane="dual"]')).toBeHidden();
  await expect(title).toHaveText('二つ目');
  await expect(bar).not.toHaveAttribute('data-pkc-dimmed', '');
  const normalColor = await tabs.nth(1).locator('[data-pkc-field="note-tab-title"]').evaluate((el) => getComputedStyle(el).color);
  expect(dimColor, '灰色にならない(通常ビューと同じ色)').not.toBe(normalColor);

  // ③ スマホ幅: タブ列は出ず、「開いているノート ▾」から切り替える。帯の高さは増えない
  await page.setViewportSize({ width: 393, height: 727 });
  await dismissAnnounce(page);
  const phoneTabs = page.locator('[data-pkc-field="phone-note-tabs"]');
  await expect(phoneTabs).toBeVisible();
  await expect(bar, 'スマホ幅でタブ列が出ている').toBeHidden();
  const barBox = await page.locator('[data-pkc-region="phone-bar"]').boundingBox();
  expect(barBox?.height, 'ページの帯の高さが増えた').toBeLessThanOrEqual(40);
  await clickReal(page, '[data-pkc-field="phone-note-tabs"]');
  await expect(menu.locator('[data-pkc-action="activate-note-tab"]')).toHaveCount(2);
  await menu.locator('[data-pkc-action="activate-note-tab"]', { hasText: '一つ目' }).click();
  await expect(title).toHaveText('一つ目');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
