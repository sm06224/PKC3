import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 🔴 **追記欄の「入り先」は、見出しの長さで押す物を動かさない**(#496。
 * user 報告 2026-08-27)。
 *
 * > センターペイン下部の追記I/Fは**選択リストが見出しサイズに合わせて横幅を変える**
 * > ため使えない。**見出し選択リストはテキストボックスの上に置いて**欲しい。
 *
 * ## ⚠ 直す前に測った(issue の指示「思い込みで直さない」)
 *
 * `app.css` に `[data-pkc-field='append-target']` の規則は **1 つも無かった**ので、
 * `<select>` は UA 既定の内容依存幅(いちばん長い option の幅)になる。しかも
 * `append-form` は `display: flex` の**横 1 列**で `<select>` が**先頭**に居るため:
 *
 * - 見出しが長いノートを開くと `<select>` が広がる
 * - 隣の `append-input`(`flex: 1`)が縮み、「追記」「元に戻す」が**右へ動く**
 *
 * = **ノートを変えるたびに押す物の位置が変わる**(user の「使えない」)。
 *
 * ## 🔴 unit では原理的に届かない
 *
 * 幅も上下も `boundingBox()` の話で、CSS を持たない happy-dom では**全部 0** である。
 * ここが唯一の門になる。
 */

/** 追記欄が出るまで(= ノートを作って本文を入れて、読む面へ戻る)。 */
async function makeNote(page: Page, body: string): Promise<void> {
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live).toBeVisible();
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill(body);
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="append-target"]')).toBeVisible();
}

/** 短い見出しの本文 / 長い見出しの本文。⚠ **段の数と件数は揃える**(差を字の長さだけにする)。 */
const SHORT = '# 一\n\n本文です。\n\n## 二\n\n本文です。';
const LONG =
  '# ' +
  'とても長い見出しの字がここに延々と並びます'.repeat(2) +
  '\n\n本文です。\n\n## ' +
  'こちらも同じくらい長い見出しの字がここに延々と並びます'.repeat(2) +
  '\n\n本文です。';

test('🔴 入り先のリストは、見出しが長くなっても幅を変えない (#496)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  const target = page.locator('[data-pkc-field="append-target"]');
  const input = page.locator('[data-pkc-field="append-input"]');
  const send = page.locator('[data-pkc-action="append-entry"]');

  await makeNote(page, SHORT);
  const shortSel = (await target.boundingBox())!;
  const shortInput = (await input.boundingBox())!;
  const shortSend = (await send.boundingBox())!;

  await makeNote(page, LONG);
  /**
   * ⚠ **空振り防止** ── 長いほうの一覧に**本当に長い字が載っている**こと。
   * 載っていなければ(見出しを拾えていない等)、以下は「同じ幅の空 2 つ」を
   * 比べているだけになる。
   */
  await expect(target.locator('option').nth(1)).toHaveText(/とても長い見出し/);
  const longSel = (await target.boundingBox())!;
  const longInput = (await input.boundingBox())!;
  const longSend = (await send.boundingBox())!;

  // ① 🔴 リストの幅が変わらない(器に固定されている)
  expect(
    Math.abs(longSel.width - shortSel.width),
    `入り先のリストが見出しの長さで伸びた(${shortSel.width} → ${longSel.width})`,
  ).toBeLessThan(2);

  // ② 🔴 打つ欄と「追記」ボタンが動かない(押す物の位置が変わらない)
  expect(
    Math.abs(longInput.x - shortInput.x),
    `打つ欄が横へ動いた(${shortInput.x} → ${longInput.x})`,
  ).toBeLessThan(2);
  expect(
    Math.abs(longSend.x - shortSend.x),
    `「追記」が横へ動いた(${shortSend.x} → ${longSend.x})`,
  ).toBeLessThan(2);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **リストは打つ欄の「上」に置く**(user の指示そのもの)。
 *
 * ⚠ 「DOM で前に在る」ではなく**画面で上に在る**ことを見る ── `display: flex` の
 *   向きを横のままにすると DOM 順は同じでも**横に並んだまま**である。
 */
test('🔴 入り先のリストは、打つ欄の上に出る (#496)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeNote(page, SHORT);

  const sel = (await page.locator('[data-pkc-field="append-target"]').boundingBox())!;
  const input = (await page.locator('[data-pkc-field="append-input"]').boundingBox())!;
  expect(
    sel.y + sel.height,
    `リストが打つ欄の上に無い(list.bottom=${sel.y + sel.height} / input.top=${input.y})`,
  ).toBeLessThanOrEqual(input.y + 1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * ⚠ **見出しが 1 つも無いノートでは、リストごと畳む**(既存の作法を壊さない)。
 * 🔑 上の 2 本で「リストを別の行へ出す」ので、**その行が空のまま残らない**ことを見る
 *   ── 残ると、押す物が無い帯が 1 本増える(業務画面の作法に反する)。
 */
test('⚠ 見出しが無いノートでは、リストの行ごと畳む (#496)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill('見出しの無い本文です。');
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const input = page.locator('[data-pkc-field="append-input"]');
  await expect(input, '追記欄が出ていない').toBeVisible();
  await expect(
    page.locator('[data-pkc-field="append-target"]'),
    '選ぶ物が無いのにリストが出ている',
  ).toBeHidden();

  // 🔴 空の行が残っていない ── 打つ欄が追記欄の上端の近くに居る
  const region = (await page.locator('[data-pkc-region="append"]').boundingBox())!;
  const box = (await input.boundingBox())!;
  expect(
    box.y - region.y,
    `リストを畳んだのに、その行のぶんの隙間が残っている(${box.y - region.y}px)`,
  ).toBeLessThan(24);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **こちらが開いた追記欄は、送ったら元どおり畳む ── user の畳みの記録には書かない**
 * (#655 ①。user 裁定 2026-09-04 案 B)。
 *
 * ⚠ unit(`append-peek.test.ts`)は属性と localStorage を見る。ここで見るのは
 *   **欄が実際に見えなくなる / 見えるようになること**(`[data-pkc-hidden-panes~='append']`
 *   の `display: none` が実ブラウザで効くか)と、実ブラウザの localStorage に
 *   畳んだ記録がそのまま残ること。
 */
test('🔴 畳んだ追記欄を Alt+クリックで開いて送ると、元どおり畳まれる (#655 ①)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeNote(page, SHORT);

  const input = page.locator('[data-pkc-field="append-input"]');
  await clickReal(page, '[data-pkc-action="toggle-pane"][data-pkc-pane="append"]');
  await expect(input, '前提: 帯で畳めていない').toBeHidden();
  const folded = await page.evaluate(() => localStorage.getItem('pkc3.panes'));
  expect(folded, '前提: 畳みが記録に無い').toContain('append');

  await page.locator('[data-pkc-field="detail-body"] p').first().click({ modifiers: ['Alt'] });
  await expect(input, 'Alt+クリックで開いていない').toBeVisible();
  await input.fill('足した 1 行');
  await clickReal(page, '[data-pkc-action="append-entry"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('足した 1 行');

  // 🔴 送ったら畳み直す ── そして user の記録は 1 byte も変わっていない
  await expect(input, '送ったのに畳み直していない').toBeHidden();
  expect(
    await page.evaluate(() => localStorage.getItem('pkc3.panes')),
    '開いた / 畳み直したときに記録を書き換えた',
  ).toBe(folded);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **畳んでいても、編集中の出口(保存して解放 / 編集を破棄)は消えない**(#655 ④)。
 *
 * ⚠ unit は CSS を構文で読むだけ(`pane-visibility.test.ts`)。`:has()` が実ブラウザで
 *   効いて、**畳んだ器の中の出口が本当に見える / 打つ欄は出ない**のはここでしか見えない。
 */
test('🔴 追記欄を畳んでいても、編集中は「保存して解放 / 編集を破棄」だけが見える (#655 ④)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeNote(page, SHORT);

  const input = page.locator('[data-pkc-field="append-input"]');
  const region = page.locator('[data-pkc-region="append"]');
  await clickReal(page, '[data-pkc-action="toggle-pane"][data-pkc-pane="append"]');
  await expect(region, '前提: 帯で畳めていない').toBeHidden();

  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(page.locator('[data-pkc-region="editor-live"]')).toBeVisible();
  // 🔴 畳んでいても出口は見える ── 打つ欄は出ない
  const exit = region.locator('[data-pkc-action="commit-edit"]');
  await expect(exit, '畳んだせいで「保存して解放」が消えた').toBeVisible();
  await expect(region.locator('[data-pkc-action="cancel-edit"]'), '「編集を破棄」が消えた').toBeVisible();
  await expect(input, '編集中に打つ欄まで出た').toBeHidden();

  // 🔑 その出口で編集を終えられる ── 終えたら畳んだ状態に戻る(器ごと消える)
  await clickReal(page, '[data-pkc-region="append"] [data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-region="editor-live"]')).toBeHidden();
  await expect(region, '編集を終えたのに畳みに戻らない').toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('pkc3.panes')), '記録が動いた').toContain(
    'append',
  );

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
