import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor, dismissAnnounce } from './helpers';

/**
 * 🔴 ノート単位のページ設定と印刷レイアウト表示(v4.0 Phase 1 / PR-03。ビジョン 3-A)の実ブラウザ検証。
 *
 * 1. 情報ペインの「ページ設定」から用紙(A4 横)・余白(広い)・字体(明朝)を選ぶ → 前書きに書かれ、本文の器と `@page` に即反映
 * 2. 指定の無い別のノートへ移ると、上書きが漏れずアプリの既定へ戻る
 * 3. 印刷レイアウト表示を入れると、紙のシートの幅・余白・`+++` の改ページの区切りが出て、横に溢れない
 * 4. 「すべてアプリの設定に戻す」で前書きから 4 つのキーが消え、通常表示に戻せる(片道を作らない)
 *
 * ⚠ この file は全文 textarea(`editor-body`)で本文を書き・読むので、2 ペインの編集を明示する。
 */
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const PANE = '[data-pkc-region="detail"] > [data-pkc-view-pane="detail"]';
const LAYOUT = '[data-pkc-field="inspector-page-layout"]';

/** ノートを 1 件作って本文を書き、保存する。@returns その lid */
async function makeNote(page: Page, body: string): Promise<string> {
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(body);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  const lid = await page.evaluate(
    () => document.querySelector('[data-pkc-region="sidebar"] [data-pkc-action="select-entry"][data-pkc-entry][data-pkc-selected]')?.getAttribute('data-pkc-entry') ?? null,
  );
  expect(lid, '作ったノートが一覧で選ばれていない').not.toBeNull();
  return lid!;
}

/** いまのノートの原文(前書き込み)を、編集を開いて読む(読んだら編集をやめる)。 */
async function sourceOf(page: Page): Promise<string> {
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  const v = await ta.inputValue();
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="cancel-edit"]');
  await page.waitForSelector('[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  return v;
}

async function selectNote(page: Page, lid: string): Promise<void> {
  await clickReal(page, `[data-pkc-region="sidebar"] [data-pkc-action="select-entry"][data-pkc-entry="${lid}"]`);
  await expect(page.locator(`[data-pkc-region="sidebar"] [data-pkc-entry="${lid}"][data-pkc-selected]`)).toHaveCount(1);
}

const paperCss = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector('style[data-pkc-field="page-paper"]')?.textContent ?? null);

const paraFont = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.querySelector('[data-pkc-field="detail-body"] p')!).fontFamily);

test('🔴 ノートごとのページ設定 → 他のノートへ漏れない → 印刷レイアウト表示 → すべて戻す', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);

  const plain = await makeNote(page, '指定の無いノートの段落。\n');
  const target = await makeNote(page, '最初の段落。\n\n+++\n\n改ページの後の段落。\n');

  // 対照群: 既定(A4 縦)のままの器と紙
  await expect(page.locator(PANE)).not.toHaveAttribute('data-pkc-page-format', /.*/);
  expect(await paperCss(page)).toBe('@page{size:A4 portrait}');
  const fontBefore = await paraFont(page);

  // ① 情報ペインの「ページ設定」から選ぶ(1 つ選ぶたびに前書きへ書かれる)
  const layout = page.locator(LAYOUT);
  await expect(layout).toBeVisible();
  await layout.locator('select[data-pkc-note-layout-field="pageFormat"]').selectOption('a4-landscape');
  await expect(page.locator(PANE)).toHaveAttribute('data-pkc-page-format', 'a4-landscape');
  await layout.locator('select[data-pkc-note-layout-field="pageMargin"]').selectOption('wide');
  await expect.poll(() => paperCss(page)).toBe('@page{size:A4 landscape;margin:30mm}');
  await layout.locator('select[data-pkc-note-layout-field="pageFont"]').selectOption('mincho');
  await expect(page.locator(PANE)).toHaveAttribute('data-pkc-note-font', 'mincho');
  await expect.poll(() => paraFont(page)).toContain('Mincho');
  expect(fontBefore).not.toContain('Mincho');
  // 読み幅は器の上でだけ広がる(:root は A4 縦のまま)
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-pkc-page-format'))).toBe('a4-portrait');
  expect(await page.locator(PANE).evaluate((el) => getComputedStyle(el).getPropertyValue('--read-w').trim())).toBe('62rem');
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--font'))).toBe('');
  // 前書きに書かれている
  const src = await sourceOf(page);
  expect(src).toContain('page_format: a4-landscape');
  expect(src).toContain('page_margin: wide');
  expect(src).toContain('page_font: mincho');
  expect(src).toContain('最初の段落。');
  await expect(layout.locator('[data-pkc-action="reset-note-layout"]')).toBeEnabled();

  // ② 指定の無いノートへ移ると、上書きが漏れずアプリの既定へ戻る
  await selectNote(page, plain);
  await expect(page.locator(PANE)).not.toHaveAttribute('data-pkc-page-format', /.*/);
  await expect(page.locator(PANE)).not.toHaveAttribute('data-pkc-note-font', /.*/);
  await expect.poll(() => paperCss(page)).toBe('@page{size:A4 portrait}');
  expect(await paraFont(page)).toBe(fontBefore);
  await expect(page.locator(LAYOUT).locator('[data-pkc-action="reset-note-layout"]')).toBeDisabled();

  // ③ 戻って、印刷レイアウト表示を入れる
  await selectNote(page, target);
  await expect(page.locator(PANE)).toHaveAttribute('data-pkc-page-format', 'a4-landscape');
  const toggle = page.locator(`${LAYOUT} [data-pkc-action="toggle-print-layout"]`);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await clickReal(page, `${LAYOUT} [data-pkc-action="toggle-print-layout"]`);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveText('印刷レイアウト');
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-pkc-print-layout'))).toBe('1');
  const sheet = await page.evaluate((paneSel) => {
    const pane = document.querySelector<HTMLElement>(paneSel)!;
    const body = pane.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
    const cs = getComputedStyle(body);
    const mm = (n: number): number => (n * 96) / 25.4;
    const hr = body.querySelector('hr.pkc-section-break');
    return {
      width: body.getBoundingClientRect().width,
      paneWidth: pane.clientWidth,
      paperW: mm(297),
      padLeft: Number.parseFloat(cs.paddingLeft),
      pad30: mm(30),
      minHeight: Number.parseFloat(cs.minHeight),
      paperH: mm(210),
      bg: cs.backgroundColor,
      paneBg: getComputedStyle(pane).backgroundColor,
      hrStyle: hr === null ? null : getComputedStyle(hr).borderTopStyle,
      hrLabel: hr === null ? null : getComputedStyle(hr, '::after').content,
      paneOverflow: pane.scrollWidth - pane.clientWidth,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      columnsOn: pane.hasAttribute('data-pkc-columns-on'),
    };
  }, PANE);
  expect(Math.abs(sheet.padLeft - sheet.pad30), `紙の内側の余白が 30mm でない(${sheet.padLeft}px)`).toBeLessThan(1);
  expect(Math.abs(sheet.minHeight - sheet.paperH), '紙の高さが A4 横でない').toBeLessThan(1);
  // 幅は min(器, 297mm) ── 器が狭ければ器いっぱい、広ければ紙の幅
  expect(sheet.width).toBeLessThanOrEqual(Math.min(sheet.paneWidth, sheet.paperW) + 1);
  expect(sheet.width, '紙のシートが細すぎる').toBeGreaterThan(Math.min(sheet.paneWidth, sheet.paperW) - 40);
  expect(sheet.bg, '紙の地と作業台の地が同じ').not.toBe(sheet.paneBg);
  expect(sheet.hrStyle).toBe('dashed');
  expect(sheet.hrLabel).toBe('"改ページ"');
  expect(sheet.paneOverflow, '器が横に溢れている').toBeLessThanOrEqual(0);
  expect(sheet.docOverflow, 'ページが横に溢れている').toBeLessThanOrEqual(0);
  expect(sheet.columnsOn, '印刷レイアウト表示で横送りの段組みが掛かっている').toBe(false);

  // 印刷のときは紙枠も「改ページ」の字も出ない(改ページは従来どおり)
  await page.emulateMedia({ media: 'print' });
  const printed = await page.evaluate((paneSel) => {
    const body = document.querySelector<HTMLElement>(`${paneSel} [data-pkc-field="detail-body"]`)!;
    const hr = body.querySelector('hr.pkc-section-break')!;
    return {
      shadow: getComputedStyle(body).boxShadow,
      label: getComputedStyle(hr, '::after').content,
      breakAfter: getComputedStyle(hr).breakAfter,
    };
  }, PANE);
  await page.emulateMedia({ media: 'screen' });
  expect(printed.shadow).toBe('none');
  expect(printed.label === 'none' || printed.label === 'normal', `印刷に「改ページ」の字が出る(${printed.label})`).toBe(true);
  expect(printed.breakAfter).toBe('page');

  // ④ すべてアプリの設定に戻す → 前書きから 4 つのキーが消える。印刷レイアウト表示も切れる(双方向)
  await clickReal(page, `${LAYOUT} [data-pkc-action="reset-note-layout"]`);
  await expect(page.locator(PANE)).not.toHaveAttribute('data-pkc-page-format', /.*/);
  await expect.poll(() => paperCss(page)).toBe('@page{size:A4 portrait}');
  await expect(page.locator(`${LAYOUT} [data-pkc-action="reset-note-layout"]`)).toBeDisabled();
  await clickReal(page, `${LAYOUT} [data-pkc-action="toggle-print-layout"]`);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => document.documentElement.hasAttribute('data-pkc-print-layout'))).toBe(false);
  const after = await sourceOf(page);
  expect(after).not.toMatch(/page_(format|margin|columns|font)/);
  expect(after.startsWith('---'), '空の前書きの囲みが残っている').toBe(false);
  expect(after).toBe('最初の段落。\n\n+++\n\n改ページの後の段落。\n');

  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

test('印刷レイアウト表示: スマホの幅では紙の幅に固定せず、横に溢れない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.addInitScript(() => localStorage.setItem('pkc3.print-layout', '1'));
  await gotoApp(page);
  await dismissAnnounce(page);
  await makeNote(page, '段落。\n\n+++\n\n次の段落。\n');
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-pkc-print-layout'))).toBe('1');
  const m = await page.evaluate((paneSel) => {
    const pane = document.querySelector<HTMLElement>(paneSel)!;
    const body = pane.querySelector<HTMLElement>('[data-pkc-field="detail-body"]')!;
    return {
      bodyW: body.getBoundingClientRect().width,
      paneW: pane.clientWidth,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, PANE);
  expect(m.bodyW).toBeLessThanOrEqual(m.paneW + 1);
  expect(m.docOverflow, 'スマホの幅で横に溢れている').toBeLessThanOrEqual(0);
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 ノートの段組み(page_columns)は通常表示では段組みに、印刷レイアウト表示では紙の中の縦流しになる(設定の画面からも切り替えられる)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 2200, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  // アプリの段組みは 1 段のまま(既定)── 段組みになるのはノートの指定による
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-pkc-read-columns'))).toBe('1');
  await makeNote(page, `---\npage_columns: 2\n---\n${'段組みで読む段落です。'.repeat(80)}\n`);
  await expect(page.locator(PANE)).toHaveAttribute('data-pkc-note-columns', '2');
  await expect(page.locator(PANE), 'ノートの段組みの指定が効いていない').toHaveAttribute('data-pkc-columns-on', '');

  // 設定の画面の「印刷レイアウト表示」で入れる
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const box = page.locator('[data-pkc-field="print-layout"]');
  await expect(box).not.toBeChecked();
  await box.check();
  expect(await page.evaluate(() => localStorage.getItem('pkc3.print-layout'))).toBe('1');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(page.locator(PANE)).toHaveAttribute('data-pkc-sheet-cols', '2');
  await expect(page.locator(PANE), '印刷レイアウト表示で横送りの段組みが残っている').not.toHaveAttribute('data-pkc-columns-on', /.*/);
  const cols = await page.evaluate((paneSel) => {
    const body = document.querySelector<HTMLElement>(`${paneSel} [data-pkc-field="detail-body"]`)!;
    return { count: getComputedStyle(body).columnCount, overflow: body.scrollWidth - body.clientWidth };
  }, PANE);
  expect(cols.count).toBe('2');
  expect(cols.overflow, '紙の中で横に溢れている').toBeLessThanOrEqual(1);
  await expect(page.locator(`${LAYOUT} [data-pkc-action="toggle-print-layout"]`)).toHaveAttribute('aria-pressed', 'true');

  // 設定の画面で切る → 横送りの段組みに戻る(双方向)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(box).toBeChecked();
  await box.uncheck();
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(page.locator(PANE)).toHaveAttribute('data-pkc-columns-on', '');
  await expect(page.locator(PANE)).not.toHaveAttribute('data-pkc-sheet-cols', /.*/);
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});
