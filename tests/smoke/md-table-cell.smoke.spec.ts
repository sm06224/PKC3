/**
 * 🔴 **`|` で書いた表も、升を押してその場で打てる**(#708 段④)。
 *
 * > user の物語(#708): 表を書いたあとで「これは升を押して打ちたい」と思っても、
 * > 押せる升が在るのは csv の囲みだけで、markdown の表は原文を開くしかなかった。
 *
 * 🔑 **unit では届かない 3 つ**を実ブラウザで見る:
 * 1. **押した升に焦点が入るか**(happy-dom の `focus` は本物ではない)
 * 2. **`execCommand` の道が通るか**(happy-dom には無いので unit は必ず fallback)
 * 3. **確定した字が disk まで届き、開き直しても残るか**
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal, createEntry, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * ⚠ 升の中に `\|` を入れてある ── **この段でいちばん静かに壊れる形**である。
 *   逃がし直さずに書き戻すと、確定した瞬間に**列が増えて表がずれる**。
 */
const BODY = ['# 買い物', '', '| 品名 | 数 |', '|---|---|', '| りんご\\|青 | 3 |', '', '以上。'].join(
  '\n',
);

const CELL = '[data-pkc-field="detail-body"] [data-pkc-action="edit-cell"]';

test('🔴 markdown の表の升を押して打つと、本文に残る (#708 段④)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('買い物');
  await page.locator('[data-pkc-field="editor-body"]').fill(`${BODY}\n`);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const cells = page.locator(CELL);
  await expect(cells.first(), '升が押せる形で出ていない').toBeVisible({ timeout: 15_000 });
  // 🔑 前提 ── 見出し 2 + 中身 2 の **4 つだけ**(区切りの行には焼かれていない)
  await expect(cells, '押せる升の数が違う(区切りの行にも焼いた?)').toHaveCount(4);

  // ── 押すと、その升だけが入力欄になる(原文の欄は出ない = user の不満そのもの)
  await cells.nth(2).click();
  const input = page.locator('[data-pkc-field="cell-input"]');
  await expect(input, '押した升が入力欄にならない').toBeVisible();
  await expect(page.locator('[data-pkc-field="cell-input"]'), '欄が 2 つ以上出た').toHaveCount(1);
  await expect(page.locator('[data-pkc-field="editor-body"]'), '原文の欄が出た').toHaveCount(0);
  /**
   * 🔑 **欄に出るのは画面の字**(`りんご|青`)── 逃がした形(`りんご\\|青`)が出ると、
   *   確定するたびに `\\` が 1 本ずつ増えて原文が壊れる(着地前レビューが実測)。
   */
  await expect(input, '欄に原文の逃がしが見えている').toHaveValue('りんご|青');

  await page.keyboard.press('Control+a');
  await page.keyboard.type('みかん|橙');
  await page.keyboard.press('Enter');

  // ── 打った字が升に入り、**列は増えていない**
  await expect(cells.nth(2), '打った字が升に入っていない').toHaveText(/みかん\|橙/, {
    timeout: 10_000,
  });
  await expect(cells, '列が増えた(逃がし直していない)').toHaveCount(4);
  await expect(
    page.locator('[data-pkc-field="detail-body"]'),
    '表の外の字まで書き換えた',
  ).toContainText('以上。');

  /**
   * 🔴 **読み込み直しても残る**(disk まで届いた証拠)。
   * ⚠ 画面の字だけ見ると、本文に書かれていなくても緑になる。
   */
  await page.reload();
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(page.locator(CELL).nth(2), '読み直したら消えた').toHaveText(/みかん\|橙/, {
    timeout: 15_000,
  });
  await expect(page.locator(CELL), '読み直したら列が増えていた').toHaveCount(4);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **升を続けて 2 つ打てる**(#745)。
 *
 * > user の物語:5 列 3 行の表を上から埋める。A1 を押して打ち `Enter`、
 * > 続けて A2 を押して打っていると ── 数十ミリ秒後、その欄が**黙って消えて
 * > 表に戻る**。焦点は本文の外へ落ちるので、**そこから先に打った字が入らない**。
 *
 * ⚠ **打った字が消えるのではない**(2026-09-06 に実測して訂正した)── 欄が
 *   壊されるとき `blur` が撃たれるので、**そこまでに打った字は確定する**。
 *   変わるのは**続きが打てるかどうか**である。
 * 🔑 **unit では原理的に見えない** ── 欄を殺すのは `applyBlocks` の塊の差し替えで、
 *   それは実物の描画経路でしか走らない。だから smoke に置く。
 * ⚠ この物語は `csv` の表でも同じ(#418 から在る)。
 */
test('🔴 升を打った直後に隣の升を押しても、欄が消えない (#745)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('埋める');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const cells = page.locator(CELL);
  await expect(cells, '押せる升の数が違う').toHaveCount(6, { timeout: 15_000 });

  // ── 1 つ目の升に打って確定する
  /**
   * 🔴 **同じ tick で「確定 → 隣を押す → 打つ」を撃つ。**
   *
   * ⚠ `locator.click()` は**要素が落ち着くのを待つ**ので、待った回は書き戻しが
   *   先に届いてしまい、**この不具合をまたぐ**(1 稿目がまさにそれで緑だった)。
   * 🔑 だから user の手より速く撃つ ── 実測では、これでちょうど
   *   「欄が開いた直後に書き戻しが届く」窓に入る。
   */
  const opened = await page.evaluate(() => {
    const sel = '[data-pkc-field="detail-body"] [data-pkc-action="edit-cell"]';
    const q = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)];
    q()[2]!.click();
    const i1 = document.querySelector<HTMLInputElement>('[data-pkc-field="cell-input"]');
    if (i1 === null) return 'i1 が開かない';
    i1.value = 'あ';
    i1.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    q()[3]!.click();
    const i2 = document.querySelector<HTMLInputElement>('[data-pkc-field="cell-input"]');
    if (i2 === null) return 'i2 が開かない';
    // 🔑 **この欄そのものに印を付ける** ── 壊されて開き直されたなら印は消える
    i2.setAttribute('data-probe-mark', '1');
    i2.value = 'い';
    return 'ok';
  });
  expect(opened, '前提が崩れた(欄が開いていない)').toBe('ok');

  const input = page.locator('[data-pkc-field="cell-input"]');
  // ⚠ **書き戻しが届くまで待つ** ── 届いた後も打ち続けられることが #745 の主張
  await expect(cells.nth(2), '1 つ目の字が本文に入っていない').toHaveText('あ', {
    timeout: 15_000,
  });
  await expect(input, '書き戻しが届いた瞬間に欄が消えた(#745)').toBeVisible();
  await expect(input, '打ちかけの字が消えた(#745)').toHaveValue('い');
  /**
   * 🔑 **空振り防止** ── 欄が一度も壊されなかった回は、この検査は何も見ていない。
   * ⚠ 製品の側が変わって(書換が同期になる / 塊を留めるようになる)競合の窓に
   *   入らなくなったら、ここが鳴る。
   */
  await expect(input, '欄が壊されていない(競合の窓に入っていない)').not.toHaveAttribute(
    'data-probe-mark',
    '1',
  );

  /**
   * 🔴 **ここが決め手** ── 続きを打てるか。
   *
   * ⚠ 「欄が在る」「字が `い` である」だけでは**直っていなくても緑になる**:
   *   欄が壊されるとき `blur` が撃たれて `い` は確定するので、
   *   開き直さなくても**本文には `い` が入る**(実測 2026-09-06)。
   * 🔑 直っていない版は**焦点が本文の外(`BODY`)へ落ちる**ので、
   *   ここから打つ `ろは` が**どこにも入らない** ── それが user の実害である。
   */
  await page.keyboard.type('ろは');
  await page.keyboard.press('Enter');
  await expect(cells.nth(3), '欄が消えて、続きが打てなくなった(#745)').toHaveText('いろは', {
    timeout: 15_000,
  });

  // ── 開き直しても残る(disk まで届いている)
  await page.reload();
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(page.locator(CELL).nth(2), '開き直したら 1 つ目が消えた').toHaveText('あ', {
    timeout: 15_000,
  });
  await expect(page.locator(CELL).nth(3), '開き直したら 2 つ目が消えた').toHaveText('いろは');

  expect(errors, `ページで例外が出た: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **打っている途中で書き戻しが届いても、`Escape` は「やめる」のまま**(#745 の 2 巡目)。
 *
 * > 動線レビューの物語:A1 に打って `Enter`、すぐ A2 を押して「りんご」と打つ。
 * > 100ms 後に A1 の書き戻しが届く。ここで気を変えて `Escape` を押すと升は空に戻る
 * > ── **ところが数百ミリ秒後、「りんご」がひとりでに戻ってくる**。
 *
 * ⚠ 原因は、欄が壊されるとき `blur` が飛んで**打ちかけの字を確定していた**こと。
 * 🔑 マニュアルは「やめる ── `Escape`(押す前の字に戻ります)」と約束している ──
 *   その約束が、この直しがいちばん想定している流れ**でだけ**破れていた。
 * ⚠ そのうえ書込は履歴を伸ばさない形なので、**戻す道も無かった**。
 */
test('🔴 打っている途中で書き戻しが届いても、Escape で消した字は戻ってこない (#745)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('やめる');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const cells = page.locator(CELL);
  await expect(cells, '押せる升の数が違う').toHaveCount(6, { timeout: 15_000 });

  await page.evaluate(() => {
    const sel = '[data-pkc-field="detail-body"] [data-pkc-action="edit-cell"]';
    const q = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)];
    q()[2]!.click();
    const i1 = document.querySelector<HTMLInputElement>('[data-pkc-field="cell-input"]')!;
    i1.value = 'あ';
    i1.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    q()[3]!.click();
    document.querySelector<HTMLInputElement>('[data-pkc-field="cell-input"]')!.value = 'りんご';
  });

  // ⚠ **書き戻しが届くまで待つ**(= 欄が壊されて開き直される回に当てる)
  await expect(cells.nth(2), '前提が崩れた(書き戻しが届いていない)').toHaveText('あ', {
    timeout: 15_000,
  });

  // 🔴 ここで気を変えて `Escape`
  await page.keyboard.press('Escape');
  await expect(cells.nth(3), 'Escape で押す前の字に戻っていない').toHaveText('2');

  /**
   * 🔴 **戻ってこないこと**を見る ── ここが決め手である。
   * ⚠ 直す前は、この待ちの間に「りんご」がひとりでに現れた(実測)。
   */
  await page.waitForTimeout(2_500);
  await expect(cells.nth(3), 'やめたのに、打ちかけの字が戻ってきた (#745)').toHaveText('2');

  // ── 開き直しても戻らない(disk にも書かれていない)
  await page.reload();
  await page.locator('[data-pkc-region="filer-table"] tbody tr').first().click();
  await expect(page.locator(CELL).nth(3), 'disk に打ちかけの字が書かれていた').toHaveText('2', {
    timeout: 15_000,
  });

  expect(errors, `ページで例外が出た: ${errors.join(' / ')}`).toEqual([]);
});
