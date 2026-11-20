/**
 * 🔴 **紙の配色・色ラベル・色で絞る札**(#1982 段 4)。実ブラウザでだけ見える 3 つ:
 *
 * ① 紙の配色を選ぶと、本当に画面の地(`body` の背景)が**トークンの色**になる(宣言だけでなく描画の結果)
 * ② 右クリック → 「色ラベルを付ける…」→ 色 で、行の**先頭のセルに左端の線**(`box-shadow`)が出て、外すと消える
 * ③ 絞り込みのボタンの列の色の札で、その色のノートだけが並ぶ。もう一度押す / 「色の絞りを外す」で全部戻る
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, dismissAnnounce, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const MENU = '[data-pkc-region="context-menu"]';
const ROWS = '[data-pkc-region="filer-table"] tbody tr[data-pkc-entry]';

async function addNote(page: Page, text: string): Promise<void> {
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(text + '\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
}

test('🔴 紙の配色を選ぶと、地の色がトークンのとおりになる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.addInitScript(() => localStorage.setItem('pkc3.theme', 'paper'));
  await gotoApp(page);
  await dismissAnnounce(page);
  const r = await page.evaluate(() => {
    const root = document.documentElement;
    const probe = document.createElement('div');
    probe.style.background = getComputedStyle(root).getPropertyValue('--bg');
    document.body.append(probe);
    const want = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      theme: root.getAttribute('data-pkc-theme'),
      tone: root.getAttribute('data-pkc-tone'),
      body: getComputedStyle(document.body).backgroundColor,
      want,
    };
  });
  expect(r.theme).toBe('paper');
  expect(r.tone).toBe('light');
  expect(r.body).toBe(r.want);
  expect(r.want, '紙の机の色(#e9e6df)').toBe('rgb(233, 230, 223)');
  expect(errors).toEqual([]);
});

test('🔴 色ラベルを付ける → 行の左端に線 → 色で絞る → 外す', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await dismissAnnounce(page);
  await addNote(page, '一つ目のノート');
  await addNote(page, '二つ目のノート');
  await expect(page.locator(ROWS)).toHaveCount(2);

  const first = page.locator(ROWS).first();
  const lid = (await first.getAttribute('data-pkc-entry'))!;
  const target = page.locator(`${ROWS}[data-pkc-entry="${lid}"]`);
  await expect(target.locator('td').first(), '前提: 付ける前は線が無い').not.toHaveCSS('box-shadow', /rgb/);

  // 右クリック → 色ラベルを付ける… → 青(5)
  await target.click({ button: 'right' });
  await expect(page.locator(MENU)).toBeVisible();
  await page.locator(`${MENU} [data-pkc-action="note-label-set"]`).click();
  const pick = page.locator(`${MENU} [data-pkc-action="note-label-pick"][data-pkc-note-label-value="5"]`);
  await expect(pick, '色の一覧が出ていない').toBeVisible();
  await pick.click();

  await expect(target, '行に色ラベルの印が付かない').toHaveAttribute('data-pkc-note-label', '5');
  const want = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--note-5)';
    document.body.append(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  });
  const shadow = await target.locator('td').first().evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadow, `先頭のセルの左端の線が --note-5(${want})でない`).toContain(want);

  // 🔴 storage へ届いている(読み直しても残る)── 画面の写しだけが動いて保存されていない、を許さない
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator(`${ROWS}[data-pkc-entry="${lid}"]`), '読み直すと色ラベルが消えた').toHaveAttribute('data-pkc-note-label', '5');

  // 絞り込みのボタンの列に、使っている色の札が出る
  const chip = page.locator('[data-pkc-region="kind-bar"] [data-pkc-action="toggle-label-filter"]');
  await expect(chip).toHaveCount(1);
  await chip.click();
  await expect(page.locator(ROWS), '色で絞っても行が減らない').toHaveCount(1);
  await expect(page.locator(ROWS).first()).toHaveAttribute('data-pkc-entry', lid);
  await page.locator('[data-pkc-action="clear-label-filter"]').click();
  await expect(page.locator(ROWS), '絞りを外しても全部が戻らない').toHaveCount(2);

  // 外す(右クリックの「色ラベルを外す」)── 付けられるなら外せる
  await target.click({ button: 'right' });
  await page.locator(`${MENU} [data-pkc-action="note-label-clear"]`).click();
  await expect(target, '色ラベルが外れない').not.toHaveAttribute('data-pkc-note-label', /.+/);
  await expect(chip, '外したあとも色の札が残る').toHaveCount(0);
  expect(errors).toEqual([]);
});
