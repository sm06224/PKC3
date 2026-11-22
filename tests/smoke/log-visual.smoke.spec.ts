/**
 * 🔴 **ログの見た目の 3 段**(#2018 8)── 実ブラウザで、段差・字下げ・縦線・字の大きさが**本当に描かれている**かを見る。
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 日の行の地が `--surface-2`(段差)/ 入れ子の字が右へずれ、一段小さい / 縦線(背景の 2px の帯)が在る | 計算後の値と配置は実ブラウザでしか出ない |
 * | 🔴 印刷では 3 段の見た目を出さない(今までのふつうの見出し) | `@media` の切り替えは実ブラウザ |
 * | 🔴 明暗のテーマで目で確かめるためのスクリーンショット(入れ子 2 段)を残す | 人が見る物 |
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const BODY = '[data-pkc-region="detail"] [data-pkc-field="detail-body"]';

/** 字の始まりの x(塊の左 + 左の内側の余白)・字の大きさ・縦線(背景の帯)。 */
async function box(page: Page, text: string): Promise<{ x: number; fs: number; line: string }> {
  return page.locator(`${BODY} > p`, { hasText: text }).first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      x: el.getBoundingClientRect().left + Number.parseFloat(cs.paddingLeft),
      fs: Number.parseFloat(cs.fontSize),
      line: cs.backgroundImage,
    };
  });
}

test('🔴 ログの 3 段: 日の行は段差、親の時刻は控えめ、入れ子は字下げ + 一段小さい字 + 縦線(明暗のスクリーンショット) (#2018 8)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'textlog');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    [
      '## 2026-10-09 09:00:00',
      '朝の記録',
      '- 親の箇条',
      '```\n親のコード\n```',
      '### 2026-10-09 09:30:00',
      '追いログ一段',
      '- 追いの箇条',
      '```\n追いのコード\n```',
      '#### 2026-10-09 09:40:00',
      '追いログ二段',
      '## 2026-10-10 08:00:00',
      '翌朝の記録',
    ].join('\n\n'),
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const surface2 = await page.evaluate(() => {
    const i = document.createElement('i');
    i.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--surface-2');
    document.body.append(i);
    const c = getComputedStyle(i).backgroundColor;
    i.remove();
    return c;
  });
  const day = await page.locator(`${BODY} [data-pkc-log-day]`).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(day, '日の行に段差(--surface-2)が無い').toBe(surface2);

  const parent = await box(page, '朝の記録');
  const one = await box(page, '追いログ一段');
  const two = await box(page, '追いログ二段');
  expect(one.x, '入れ子 1 段が字下げされていない').toBeGreaterThan(parent.x);
  expect(two.x, '入れ子 2 段が 1 段より深くない').toBeGreaterThan(one.x);
  expect(one.fs, '入れ子の字が親より小さくない').toBeLessThan(parent.fs);
  expect(one.line, '入れ子に縦線が無い').toContain('gradient');
  expect(parent.line, '親の記録に縦線が付いた').toBe('none');
  // 🔴 縦線は見出しと中身で同じ x(1 本につながる)── 画素で見る: 入れ子 1 段の見出しと段落の左端の列に、同じ x の線が在る
  const lineX = (sel: string): Promise<number> =>
    page.locator(sel).first().evaluate((el) => {
      const cs = getComputedStyle(el);
      // 背景の位置の起点(枠の外側 / 内側)まで含めて、線が描かれる x を出す
      const origin = cs.backgroundOrigin === 'border-box' ? 0 : Number.parseFloat(cs.borderLeftWidth);
      return el.getBoundingClientRect().left + origin + Number.parseFloat(cs.backgroundPositionX);
    });
  expect(await lineX(`${BODY} > h3[data-pkc-log-depth]`), '見出しと中身で縦線の x がずれている').toBe(
    await lineX(`${BODY} > p[data-pkc-log-depth="1"]`),
  );

  // 🔴 入れ子の中の箇条書き・コードの余白を潰さない(着地前レビュー 🔴)── 箇条書きは印の置き場に字下げを足し、
  //    コードは自分の内側の余白のまま(親の記録の中の同じ塊と比べる)
  const pad = (sel: string, text: string): Promise<{ left: number; top: number }> =>
    page.locator(`${BODY} > ${sel}`, { hasText: text }).first().evaluate((el) => {
      const cs = getComputedStyle(el.matches('pre') ? el : (el.querySelector('pre') ?? el));
      return { left: Number.parseFloat(cs.paddingLeft), top: Number.parseFloat(cs.paddingTop) };
    });
  const ulParent = await pad('ul', '親の箇条');
  const ulNested = await pad('ul', '追いの箇条');
  expect(ulNested.left, '入れ子の箇条書きの印の置き場が潰れた(字下げを足していない)').toBeGreaterThan(ulParent.left);
  const preParent = await pad('*', '親のコード');
  const preNested = await pad('*', '追いのコード');
  expect(preNested.top, '入れ子のコードの内側の余白が潰れた').toBe(preParent.top);
  expect(preNested.left, '入れ子のコードの内側の余白が変わった').toBe(preParent.left);

  // 明暗のテーマで撮る(人が目で確かめる物)
  const shotDir = test.info().outputPath('');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-pkc-theme', t), theme);
    await page.locator(BODY).screenshot({ path: `${shotDir}/log-visual-${theme}.png` });
  }
  console.log(`log-visual screenshots: ${shotDir}`);

  // 🔴 紙は今までのふつうの見出し(3 段の見た目は画面だけ)
  await page.emulateMedia({ media: 'print' });
  const pOne = await box(page, '追いログ一段');
  expect(pOne.line, '紙に縦線が出た').toBe('none');
  expect(pOne.fs, '紙で入れ子の字が小さくなった').toBe((await box(page, '朝の記録')).fs);
  await page.emulateMedia({ media: 'screen' });

  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});
