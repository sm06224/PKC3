import { test, expect, type Page, type Locator } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor, dismissAnnounce } from './helpers';

/**
 * 🔴 **Word のような書式ツールバー**(v4.0 Phase 1 / PR-04。ビジョン 3-B)の実ブラウザ検証。
 *
 * 1. 2 ペイン編集・1 画面編集(ライブ)の両方で、取り消し線・下線・ハイライト・文字色(変更 → 差し替え → 解除)を
 *    押して付け、描かれた DOM(`s` / `mark` / `span.pkc-inline-mark[style]`)に出ることを見る
 * 2. 段落の揃え(中央 → 右 → 解除)と字下げ(増 → 減)が `data-pkc-align` / `data-pkc-indent` に出て、解除で元に戻る
 * 3. 「ページ設定 ▾」のポップオーバーで印刷レイアウト表示・用紙・余白を切り替える → 情報ペインと一致し、改ページ `+++` の区切りが出る
 * 4. ▾ の一覧とポップオーバーが帯・画面からはみ出さない / スマホ幅で帯が 1 段のまま(スクリーンショットも撮る)
 *
 * 🔑 押し方は全部実マウス(`clickReal` = mousedown → mouseup → click)── 帯のボタンが本文の欄から焦点を奪わないこと
 *   (1 画面編集では奪うと行が確定して書き込む先が消える)まで含めて見る。
 */

const BAR = '[data-pkc-region="format-bar"]';
const MENU = '[data-pkc-region="context-menu"]';
const PANEL = '[data-pkc-region="page-setup-panel"]';
const RED = '#e03131';
const BLUE = '#1c7ed6';

/** 欄の中の字 `needle` を選ぶ。 */
async function selectIn(field: Locator, needle: string): Promise<void> {
  await field.evaluate((el, n) => {
    const ta = el as HTMLTextAreaElement;
    ta.focus();
    const i = ta.value.indexOf(n);
    if (i < 0) throw new Error(`${n} が欄に無い`);
    ta.setSelectionRange(i, i + n.length);
  }, needle);
}

/** ▾ の一覧を開いて項目を押す。 */
async function pickFromMenu(page: Page, menu: 'color' | 'align', item: string): Promise<void> {
  await clickReal(page, `${BAR} [data-pkc-action="open-format-menu"][data-pkc-format-menu="${menu}"]`);
  await expect(page.locator(MENU)).toBeVisible();
  await clickReal(page, `${MENU} ${item}`);
  await expect(page.locator(MENU)).toBeHidden();
}

/** 一覧・ポップオーバーが画面の内側に収まっているか。 */
async function inViewport(page: Page, sel: string): Promise<void> {
  const r = await page.locator(sel).evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: innerWidth, h: innerHeight };
  });
  expect(r.l, `${sel} が左にはみ出す`).toBeGreaterThanOrEqual(0);
  expect(r.t, `${sel} が上にはみ出す`).toBeGreaterThanOrEqual(0);
  expect(r.r, `${sel} が右にはみ出す`).toBeLessThanOrEqual(r.w);
  expect(r.b, `${sel} が下にはみ出す`).toBeLessThanOrEqual(r.h);
}

test.describe('2 ペイン編集', () => {
  test.beforeEach(async ({ page }) => {
    await useSplitEditor(page);
  });

  test('🔴 文字装飾・文字色・揃え・字下げ → 帯の並び → ページ設定 ▾ と改ページ → スマホ幅', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoApp(page);
    await dismissAnnounce(page);
    await createEntry(page, 'text');
    const ta = page.locator('[data-pkc-field="editor-body"]');
    const preview = page.locator('[data-pkc-region="editor-preview"]');
    await ta.fill('消す字 線の字 光る字 色の字');

    // ① 文字装飾(押して付け、もう一度で外れる)
    await selectIn(ta, '消す字');
    await clickReal(page, `${BAR} [data-pkc-format="strike"]`);
    await expect(ta).toHaveValue(/~~消す字~~/);
    await expect(preview.locator('s, del')).toHaveText('消す字');
    await selectIn(ta, '線の字');
    await clickReal(page, `${BAR} [data-pkc-format="underline"]`);
    await expect(ta).toHaveValue(/:線の字:underline:/);
    await expect(preview.locator('span.pkc-inline-mark', { hasText: '線の字' })).toHaveCSS('text-decoration-line', 'underline');
    await selectIn(ta, '光る字');
    await clickReal(page, `${BAR} [data-pkc-format="highlight"]`);
    await expect(preview.locator('mark')).toHaveText('光る字');

    // ② 文字色: 赤 → 青(色だけ差し替え)→ 色を解除
    await selectIn(ta, '色の字');
    await clickReal(page, `${BAR} [data-pkc-action="open-format-menu"][data-pkc-format-menu="color"]`);
    await expect(page.locator(MENU)).toBeVisible();
    await expect(ta, '一覧を開いたら本文の欄から焦点が外れた').toBeFocused();
    await inViewport(page, MENU);
    const colorLabels = await page.locator(`${MENU} button`).allTextContents();
    expect(colorLabels).toEqual(['赤', '橙', '緑', '青', '紫', '灰', '色を解除']);
    await page.screenshot({ path: test.info().outputPath('color-menu.png') });
    await clickReal(page, `${MENU} [data-pkc-color="red"]`);
    await expect(ta).toHaveValue(new RegExp(`:色の字:${RED}:`));
    await expect(preview.locator('span.pkc-inline-mark', { hasText: '色の字' })).toHaveCSS('color', 'rgb(224, 49, 49)');
    await pickFromMenu(page, 'color', '[data-pkc-color="blue"]');
    await expect(ta).toHaveValue(new RegExp(`:色の字:${BLUE}:`));
    expect((await ta.inputValue()).match(/:色の字:/g)?.length, '色を差し替えたら囲みが入れ子になった').toBe(1);
    await expect(preview.locator('span.pkc-inline-mark', { hasText: '色の字' })).toHaveCSS('color', 'rgb(28, 126, 214)');
    await pickFromMenu(page, 'color', '[data-pkc-color=""]');
    await expect(ta).toHaveValue('~~消す字~~ :線の字:underline: ==光る字== 色の字');
    await expect(preview.locator('span.pkc-inline-mark', { hasText: '色の字' })).toHaveCount(0);

    // ③ Ctrl+Z で 1 手ずつ戻せる(書き込みは取り消しの履歴を切らない)
    await page.keyboard.press('Control+z');
    await expect(ta).toHaveValue(new RegExp(`:色の字:${BLUE}:`));
    await page.keyboard.press('Control+y');
    await expect(ta).toHaveValue('~~消す字~~ :線の字:underline: ==光る字== 色の字');

    // ④ 段落の揃え: 中央 → 右(差し替え)→ 解除 / 字下げ: 増 → 減
    await ta.fill('揃える段落');
    await ta.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(2, 2));
    await pickFromMenu(page, 'align', '[data-pkc-format="align-center"]');
    await expect(preview.locator('.pkc-format-block')).toHaveAttribute('data-pkc-align', 'center');
    await expect(preview.locator('.pkc-format-block p')).toHaveCSS('text-align', 'center');
    await pickFromMenu(page, 'align', '[data-pkc-format="align-right"]');
    await expect(ta).toHaveValue(':::format{align=right}\n揃える段落\n:::');
    await expect(preview.locator('.pkc-format-block')).toHaveAttribute('data-pkc-align', 'right');
    await pickFromMenu(page, 'align', '[data-pkc-format="align-clear"]');
    await expect(ta).toHaveValue('揃える段落');
    await expect(preview.locator('.pkc-format-block')).toHaveCount(0);
    const leftBefore = await preview.locator('p').evaluate((el) => el.getBoundingClientRect().left);
    await pickFromMenu(page, 'align', '[data-pkc-format="indent-more"]');
    await expect(preview.locator('.pkc-format-block')).toHaveAttribute('data-pkc-indent', '1');
    const leftIndented = await preview.locator('p').evaluate((el) => el.getBoundingClientRect().left);
    expect(leftIndented, '字下げが見た目に効いていない').toBeGreaterThan(leftBefore + 4);
    await pickFromMenu(page, 'align', '[data-pkc-format="indent-less"]');
    await expect(ta).toHaveValue('揃える段落');
    await expect(preview.locator('.pkc-format-block')).toHaveCount(0);

    // ── ④' 帯の並びと幅(同じ起動の続き)
    const tops = await page.locator(`${BAR} [data-pkc-field="format-group"]`).evaluateAll((groups) =>
      groups.map((g) => [...g.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top))),
    );
    for (const [i, g] of tops.entries()) expect(new Set(g).size, `塊 ${i} の途中で折り返している`).toBe(1);
    expect(new Set(tops.flat()).size, `1440px で帯が 3 段以上になった: ${JSON.stringify(tops)}`).toBeLessThanOrEqual(2);
    await page.locator(BAR).screenshot({ path: test.info().outputPath('bar-1440.png') });

    // ── ⑤ 「ページ設定 ▾」と改ページ(同じ起動の続き。保存して新しいノートで)
    await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await page.waitForSelector('[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
    await createEntry(page, 'text');
    await ta.fill('前の段落\n後の段落');
    // 改ページ(「その他 ▾」の中)── 前後の空行を整えて入る
    await ta.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange('前の段落\n'.length, '前の段落\n'.length));
    await clickReal(page, `${BAR} [data-pkc-action="open-format-more"]`);
    await clickReal(page, `${MENU} [data-pkc-format="pagebreak"]`);
    await expect(ta).toHaveValue('前の段落\n\n+++\n\n後の段落');
    await expect(preview.locator('hr.pkc-section-break')).toHaveCount(1);

    // ポップオーバーを開く
    const opener = page.locator(`${BAR} [data-pkc-action="open-page-setup"]`);
    await clickReal(page, opener);
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();
    await expect(opener).toHaveAttribute('aria-expanded', 'true');
    await inViewport(page, PANEL);
    const pb = (await panel.boundingBox())!;
    const ob = (await opener.boundingBox())!;
    expect(pb.y, 'ポップオーバーが ▾ の下に出ていない').toBeGreaterThanOrEqual(ob.y + ob.height - 1);
    expect(Math.abs(pb.x - ob.x), `ポップオーバーの左端が ▾ の左端から離れている(${pb.x} / ${ob.x})`).toBeLessThanOrEqual(2);
    await page.screenshot({ path: test.info().outputPath('page-setup-panel.png') });

    // 用紙・余白 → 下書きの前書き・情報ペインと一致(編集中でも選べる)
    await panel.locator('select[data-pkc-note-layout-field="pageFormat"]').selectOption('a4-landscape');
    await panel.locator('select[data-pkc-note-layout-field="pageMargin"]').selectOption('wide');
    await expect(ta).toHaveValue(/page_format: a4-landscape/);
    await expect(ta).toHaveValue(/page_margin: wide/);
    const pane = page.locator('[data-pkc-field="inspector-page-layout"]');
    await expect(pane.locator('select[data-pkc-note-layout-field="pageFormat"]')).toHaveValue('a4-landscape');
    await expect(pane.locator('select[data-pkc-note-layout-field="pageMargin"]')).toHaveValue('wide');
    await expect(pane.locator('select[data-pkc-note-layout-field="pageMargin"]')).toBeEnabled();
    // 情報ペインで変える → ポップオーバーも一致
    await pane.locator('select[data-pkc-note-layout-field="pageMargin"]').selectOption('narrow');
    await expect(page.locator(PANEL).locator('select[data-pkc-note-layout-field="pageMargin"]')).toHaveValue('narrow');
    await expect(ta).toHaveValue(/page_margin: narrow/);

    // 印刷レイアウト表示を入れる → 情報ペインのボタンも入になり、保存した本文で改ページの区切りが見える
    await clickReal(page, page.locator(PANEL).locator('[data-pkc-action="toggle-print-layout"][data-pkc-print-layout-choice="on"]'));
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-pkc-print-layout'))).toBe('1');
    await expect(pane.locator('[data-pkc-action="toggle-print-layout"][data-pkc-print-layout-choice="on"]')).toHaveAttribute('aria-pressed', 'true');
    // Esc で閉じ、編集は続いている
    await page.keyboard.press('Escape');
    await expect(page.locator(PANEL)).toBeHidden();
    await expect(page.locator('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]')).toBeVisible();
    await expect(opener).toBeFocused();
    await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await page.waitForSelector('[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
    const view = page.locator('[data-pkc-region="detail"] > [data-pkc-view-pane="detail"]');
    await expect(view).toHaveAttribute('data-pkc-page-format', 'a4-landscape');
    const hr = view.locator('hr.pkc-section-break');
    await expect(hr).toHaveCount(1);
    expect(await hr.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('counter(pkc-sheet) " ページ目"');
    await page.screenshot({ path: test.info().outputPath('print-layout-after.png') });

    // ── ⑥ スマホ幅(同じ起動の続き。編集に入り直す)
    await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
    await expect(page.locator(BAR)).toBeVisible();
    // スマホ幅: 1 段のまま(残りは「…」の中)
    await page.setViewportSize({ width: 390, height: 800 });
    const phone = await page.locator(`${BAR} button`).evaluateAll((els) =>
      els.filter((e) => e.checkVisibility()).map((e) => ({
        label: e.querySelector('[data-pkc-field="label"]')?.textContent ?? '',
        top: Math.round(e.getBoundingClientRect().top),
      })),
    );
    expect(phone.map((b) => b.label), 'スマホ幅で 1 段に残すボタンが変わった').toEqual(['太字', '斜体', 'リンク', '箇条書き', 'チェック', '…']);
    expect(new Set(phone.map((b) => b.top)).size, 'スマホ幅で帯が 2 段になった').toBe(1);
    await page.locator(BAR).screenshot({ path: test.info().outputPath('bar-phone.png') });
    // 「…」で全部出したとき、▾ のボタンも押せて一覧が画面に収まる
    await clickReal(page, `${BAR} [data-pkc-field="format-more"]`);
    await clickReal(page, `${BAR} [data-pkc-action="open-format-menu"][data-pkc-format-menu="align"]`);
    await expect(page.locator(MENU)).toBeVisible();
    await inViewport(page, MENU);
    await page.keyboard.press('Escape');
    await clickReal(page, `${BAR} [data-pkc-action="open-page-setup"]`);
    await expect(page.locator(PANEL)).toBeVisible();
    await inViewport(page, PANEL);
    await page.screenshot({ path: test.info().outputPath('page-setup-phone.png') });

    expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
  });
});

test('🔴 1 画面編集(ライブ)でも、行の欄に居たまま文字色・下線・揃えを付けて外せる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live).toBeVisible();
  await clickReal(page, '[data-pkc-region="editor-live"]');
  const row = live.locator('[data-pkc-field="row-source"]');
  await expect(row).toBeVisible();
  await row.fill('色を付ける字');

  // 文字色: 行が開いたまま(実マウスの mousedown で焦点を奪わない)
  await selectIn(row, '付ける');
  await pickFromMenu(page, 'color', '[data-pkc-color="red"]');
  await expect(row, '一覧から選んだら行が閉じた(書き込む先が消える)').toBeVisible();
  await expect(row).toHaveValue(`色を:付ける:${RED}:字`);
  await clickReal(page, `${BAR} [data-pkc-format="underline"]`);
  await expect(row).toHaveValue(`色を:付ける:${RED}, underline:字`);
  // 揃え(行の中の段落を囲む)
  await pickFromMenu(page, 'align', '[data-pkc-format="align-center"]');
  await expect(row).toHaveValue(`:::format{align=center}\n色を:付ける:${RED}, underline:字\n:::`);
  // 確定すると描画に出る
  await page.keyboard.press('Tab');
  await expect(live.locator('[data-pkc-field="row-source"]')).toHaveCount(0);
  const mark = live.locator('.pkc-format-block[data-pkc-align="center"] span.pkc-inline-mark');
  await expect(mark).toHaveText('付ける');
  await expect(mark).toHaveCSS('color', 'rgb(224, 49, 49)');
  await expect(mark).toHaveCSS('text-decoration-line', 'underline');

  // 解除: 描かれた段落を押して行を開き、色を解除 → 揃えを解除
  await clickReal(page, live.locator('span.pkc-inline-mark'));
  const row2 = live.locator('[data-pkc-field="row-source"]');
  await expect(row2).toBeVisible();
  await selectIn(row2, '付ける');
  await pickFromMenu(page, 'color', '[data-pkc-color=""]');
  await clickReal(page, `${BAR} [data-pkc-format="underline"]`);
  await pickFromMenu(page, 'align', '[data-pkc-format="align-clear"]');
  await expect(row2).toHaveValue('色を付ける字');
  await page.keyboard.press('Tab');
  await expect(live.locator('.pkc-format-block')).toHaveCount(0);
  await expect(live.locator('span.pkc-inline-mark')).toHaveCount(0);
  await expect(live).toContainText('色を付ける字');

  // ページ設定 ▾ はライブでも開けて、選ぶと前書きに入る
  await clickReal(page, `${BAR} [data-pkc-action="open-page-setup"]`);
  await expect(page.locator(PANEL)).toBeVisible();
  await page.locator(PANEL).locator('select[data-pkc-note-layout-field="pageColumns"]').selectOption('2');
  await expect(page.locator('[data-pkc-field="inspector-page-layout"] select[data-pkc-note-layout-field="pageColumns"]')).toHaveValue('2');
  await page.keyboard.press('Escape');
  await expect(page.locator(PANEL)).toBeHidden();
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  await expect(page.locator('[data-pkc-region="detail"] > [data-pkc-view-pane="detail"]')).toHaveAttribute('data-pkc-note-columns', '2');

  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});
