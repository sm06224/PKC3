import { test, expect, type Page } from '@playwright/test';
import { gotoApp, dismissAnnounce, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

/**
 * 🔴 **パンくず(アドレスバー)のパス直接入力**(#1982 A4)。
 *
 * unit では原理的に届かない層だけをここで見る:
 * 1. 実マウスで**枠の何も無い所**を押す(段のボタンではなく枠の余白に当たるか)
 * 2. 実 Chromium の `<input list>` / 焦点 / Esc / blur
 * 3. 実際の起動で、保存・面の組み直しを挟んでも打ちかけの字が残ること
 */

const FRAME = '[data-pkc-region="filer-breadcrumb"] [data-pkc-field="crumb-path"]';
const INPUT = '[data-pkc-field="crumb-input"]';
const CRUMB = '[data-pkc-region="filer-breadcrumb"]';
const SEG = `${CRUMB} [data-pkc-field="crumb-seg"]`;
const ROW = '[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="folder"]';

async function makeFolder(page: Page, title: string): Promise<void> {
  await createEntry(page, 'folder');
  const t = page.locator('[data-pkc-field="editor-title"]');
  if (await t.count()) await t.fill(title);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
}

/** 一覧のフォルダの行(題名)を 2 回押して中へ入る。 */
async function enter(page: Page, title: string): Promise<void> {
  await page.locator(ROW, { hasText: title }).first().dblclick();
  await expect(page.locator(SEG).last()).toHaveText(title);
}

/** 枠の何も無い所(右端の余白)を実マウスで押す。 */
async function clickEmptyOfBar(page: Page): Promise<void> {
  const b = await page.locator(FRAME).boundingBox();
  if (b === null) throw new Error('アドレスバーが見えない');
  await page.mouse.click(b.x + b.width - 3, b.y + b.height / 2);
}

const crumbTexts = (page: Page) => page.locator(SEG).allTextContents();

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useSplitEditor(page);
  await gotoApp(page);
});

test('🔴 空きを押してパスを打つと移動でき、Esc / 外れで元へ戻る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await makeFolder(page, '資料');
  await enter(page, '資料');
  await makeFolder(page, '下');
  await enter(page, '下');
  expect(await crumbTexts(page)).toEqual(['ルート', '資料', '下']);

  // 段のボタンは今までどおり(押すとその段へ入る。入力にはならない)
  await clickReal(page, `${SEG}[data-pkc-entry]:not([aria-current])`);
  await expect(page.locator(INPUT)).toHaveCount(0);
  await expect(page.locator(SEG).last()).toHaveText('資料');
  await enter(page, '下');

  // 🔴 段のボタンの上で押して、枠の余白へ動かして離しても、入力は開かない(click は共通の祖先の枠に落ちる)
  {
    const seg = await page.locator(`${SEG}[data-pkc-entry]:not([aria-current])`).first().boundingBox();
    const fr = await page.locator(FRAME).boundingBox();
    if (seg === null || fr === null) throw new Error('パンくずが見えない');
    await page.mouse.move(seg.x + seg.width / 2, seg.y + seg.height / 2);
    await page.mouse.down();
    await page.mouse.move(fr.x + fr.width - 3, fr.y + fr.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator(INPUT)).toHaveCount(0);
    expect(await crumbTexts(page)).toEqual(['ルート', '資料', '下']);
  }
  // 💡 枠は role と aria-label を持つ
  await expect(page.locator(FRAME)).toHaveAttribute('role', 'group');
  await expect(page.locator(FRAME)).toHaveAttribute('aria-label', /パンくず/);

  // ① 空きを押すと現在地の道の字が入った入力になる(段のボタンは外れる)
  await clickEmptyOfBar(page);
  const input = page.locator(INPUT);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('ルート/資料/下');
  await expect(page.locator(SEG)).toHaveCount(0);
  // 候補にルートと全フォルダが並ぶ
  const opts = await page.locator(`${CRUMB} datalist option`).evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(opts).toEqual(expect.arrayContaining(['ルート', 'ルート/資料', 'ルート/資料/下']));

  // ② Esc で元のパンくず(段のボタンも戻る)。移動はしていない
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  expect(await crumbTexts(page)).toEqual(['ルート', '資料', '下']);

  // ③ 打って Enter ── ルートへ(「ルート」)
  await clickEmptyOfBar(page);
  await input.fill(' ルート ');
  await page.keyboard.press('Enter');
  await expect(input).toHaveCount(0);
  expect(await crumbTexts(page)).toEqual(['ルート']);

  // ④ 入れ子の道の字で一気に入る(「ルート/」は省いてよい・末尾の / も許す)
  await clickEmptyOfBar(page);
  await input.fill('資料/下/');
  await page.keyboard.press('Enter');
  await expect(input).toHaveCount(0);
  expect(await crumbTexts(page)).toEqual(['ルート', '資料', '下']);

  // ⑤ 見つからない道は入らず、入力は開いたまま(理由は既存の知らせに出る)
  await clickEmptyOfBar(page);
  await input.fill('ルート/無い');
  await page.keyboard.press('Enter');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('ルート/無い');
  await expect(page.locator('[data-pkc-field="status-text"]')).toContainText('見つかりません');

  // ⑥ 打ち直しても字と焦点が残る
  await input.fill('ルート/資');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('ルート/資');

  // ⑥-2 打っている最中に別の操作で一覧が描き直されても(焦点を動かさない押し方)、打ちかけの字と焦点が残る
  const barBefore = await page.locator(CRUMB).elementHandle();
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-pkc-action="toggle-filer-flatten"]')!.click();
  });
  await expect.poll(() => barBefore!.evaluate((n) => n.isConnected)).toBe(false); // 空振り防止: 実際に組み直された
  await expect(input).toHaveValue('ルート/資');
  await expect(input).toBeFocused();
  // ⑥-3 入力中に枠の余白を押しても、開き直さず(打ちかけの字が残る)焦点は入力に残る
  await clickEmptyOfBar(page);
  await expect(input).toHaveValue('ルート/資');
  await expect(input).toBeFocused();

  // ⑥-4 スマホ幅(狭い窓)でも入力欄は横にはみ出さない
  await page.setViewportSize({ width: 390, height: 844 });
  await dismissAnnounce(page);
  // (スマホ用画面ではパンくずは一覧のページに居る。窓の幅が変わる再描画で入力は閉じてよい ── 狭い窓で開き直して測る)
  const toList = page.locator('[data-pkc-action="phone-page"][data-pkc-page="list"]');
  if ((await toList.count()) > 0 && (await page.locator(FRAME).isHidden())) await clickReal(page, toList.first());
  await expect(page.locator(FRAME)).toBeVisible();
  await clickEmptyOfBar(page);
  await expect(input).toBeVisible();
  const vw = 390;
  const ib = await input.boundingBox();
  const fb = await page.locator(FRAME).boundingBox();
  expect(ib, '入力欄が見える').not.toBeNull();
  expect(ib!.x).toBeGreaterThanOrEqual(0);
  expect(ib!.x + ib!.width, '入力欄の右端が窓に収まる').toBeLessThanOrEqual(vw + 0.5);
  expect(fb!.x + fb!.width, '枠の右端が窓に収まる').toBeLessThanOrEqual(vw + 0.5);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(input).toBeFocused();

  // ⑦ 外を押すと元へ戻る(blur)
  await page.mouse.click(5, 880);
  await expect(input).toHaveCount(0);
  expect(await crumbTexts(page)).toEqual(['ルート', '資料', '下']);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 同名のフォルダはあいまい一致で入らず、候補を選ぶと入れる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await makeFolder(page, '同名');
  await makeFolder(page, '同名');
  await expect(page.locator(ROW)).toHaveCount(2);

  await clickEmptyOfBar(page);
  const input = page.locator(INPUT);
  await input.fill('ルート/同名');
  await page.keyboard.press('Enter');
  // 入っていない(まだルート)・入力は開いたまま・理由が出る
  await expect(input).toBeVisible();
  await expect(page.locator(ROW)).toHaveCount(2);
  await expect(page.locator('[data-pkc-field="status-text"]')).toContainText('同名');

  // 候補は見分けが付く(同名 1 番目 / 2 番目)
  const opts = (
    await page.locator(`${CRUMB} datalist option`).evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))
  ).filter((v) => v.includes('同名 '));
  expect(opts).toHaveLength(2);
  expect(new Set(opts).size).toBe(2);

  // 候補を選ぶ(= 候補の字を入れて Enter)と、その 1 つへ入る
  await input.fill(opts[1]!);
  await page.keyboard.press('Enter');
  await expect(input).toHaveCount(0);
  expect(await crumbTexts(page)).toEqual(['ルート', '同名']);
  await expect(page.locator(SEG).last()).toHaveAttribute('aria-current', 'location');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
