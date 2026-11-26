import { test, expect, type Page, type Locator } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, dismissAnnounce } from './helpers';

/**
 * 🔴 **ブロック単位のリッチ編集**(v4.0 Phase 1 / PR-05・PR-06。設定「編集の仕方」= リッチ編集)の実ブラウザ検証。
 *
 * 1. 設定「編集の仕方」のプルダウンから「リッチ編集(記号を隠して編集)」を選び、ノートを開く
 * 2. 段落を押す → 記号の無い `contenteditable` が開く → 打つ + 帯で太字・ハイライト・文字色 → ブロックの外を押して確定
 *    → 原文が `**…**` / `==…==` / `:…:#…:` のプレーンな PKC-Markdown で保存され、**コード・`:::format` は 1 バイトも変わらない**
 *    (PR-06)文字色を当てた直後の `Ctrl+Z` で当てる前へ戻り、`Ctrl+Y` で当て直せる
 * 3. コード・`:::format` のブロックを押すと、自動で原文の `<textarea>` が開く
 * 4. セルの「原文」で `<textarea>` に切り替わる(打った内容を持って行く)。(PR-06)`Alt+M` でリッチ → 原文 → リッチを往復できる
 * 5.(PR-06)空の段落で `/` → 見出し 2 を挿入、続けて `/code` でコードブロックを挿入 → 原文へ正しく保存される
 * 6. 既定(live)では今までどおり `<textarea>` が開く
 * ⚠ 起動は 2 回だけ(`scripts/smoke-budget.mjs`)── 設定の切替から挿入までは 1 本目の道中に載せる。
 *   既定(live)は保存値が違うので別の起動が要る。
 *
 * 🔑 押し方は実マウス(`clickReal` = mousedown → mouseup → click)── 帯のボタンがセルから焦点を奪わないこと
 *   (奪うとセルが確定して閉じ、書き込む先が消える)まで含めて見る。
 */

const BAR = '[data-pkc-region="format-bar"]';
const MENU = '[data-pkc-region="context-menu"]';
const LIVE = '[data-pkc-region="editor-live"]';
const CELL = '[data-pkc-field="rich-cell"]';
const ROW = '[data-pkc-field="row-source"]';
const RED = '#e03131';

const DOC = [
  '# 題',
  '',
  '書き換える段落',
  '',
  '```js',
  'const  x = 1;  // 空白も残す',
  '```',
  '',
  ':::format{align=center}',
  '中央の段落',
  ':::',
].join('\n');

/** 🔴 設定画面の「編集の仕方」のプルダウンで「リッチ編集」を選ぶ(本物の選択欄 ── dead control を出さない)。 */
async function chooseRich(page: Page): Promise<void> {
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const select = page.locator('[data-pkc-field="editor-mode-select"]');
  await expect(select).toBeVisible();
  await expect(select.locator('option[value="rich"]')).toHaveText(/リッチ編集\(記号を隠して編集\)/);
  await select.selectOption('rich');
  await expect(select).toHaveValue('rich');
}

/** セルの中の字を選ぶ(`contenteditable` の選択)。 */
async function selectInCell(cell: Locator, needle: string): Promise<void> {
  await cell.evaluate((el, n) => {
    (el as HTMLElement).focus();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t !== null; t = walker.nextNode()) {
      const i = (t.nodeValue ?? '').indexOf(n);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + n.length);
      const sel = getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    throw new Error(`${n} がセルに無い`);
  }, needle);
}

/** 本文の全部を「全文を編集」で読む(読んだら Escape で閉じる ── 何も変えない)。 */
async function readWholeBody(page: Page): Promise<string> {
  await clickReal(page, `[data-pkc-region="detail"] [data-pkc-field="edit-all"]`);
  const ta = page.locator(`${LIVE} ${ROW}`);
  await expect(ta).toBeVisible();
  const v = await ta.inputValue();
  await page.keyboard.press('Escape');
  await expect(page.locator(`${LIVE} ${ROW}`)).toHaveCount(0);
  return v;
}

/** 空のノートに原文を入れて確定する(書き足す行 → 「原文」→ 入れる → Tab)。 */
async function seed(page: Page, rich: boolean): Promise<void> {
  await createEntry(page, 'text');
  const live = page.locator(LIVE);
  await expect(live).toBeVisible();
  await clickReal(page, LIVE);
  if (rich) {
    // 空のノートの書き足す行もリッチのセルで開く ── 原文へ切り替えて Markdown を流し込む
    await expect(live.locator(CELL)).toBeVisible();
    await page.keyboard.press('Alt+M');
  }
  const row = live.locator(ROW);
  await expect(row).toBeVisible();
  await row.fill(DOC);
  await page.keyboard.press('Tab');
  await expect(live.locator(ROW)).toHaveCount(0);
  await expect(live.locator('pre')).toBeVisible();
}

test('🔴 リッチ編集: 段落を記号なしで編集し、帯の書式がプレーンな PKC-Markdown で保存され、ほかのブロックは 1 バイトも変わらない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await chooseRich(page);
  await seed(page, true);
  const live = page.locator(LIVE);

  // ③' 原本不変: 段落・見出しをセルで開いて何も変えずに閉じても、本文は 1 バイトも変わらない
  const before = await readWholeBody(page);
  expect(before).toBe(DOC);
  await clickReal(page, live.locator('p', { hasText: '書き換える段落' }));
  await expect(live.locator(CELL)).toBeVisible();
  await page.keyboard.press('Escape');
  await clickReal(page, live.locator('h1', { hasText: '題' }));
  await expect(live.locator(`h1${CELL}`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(live.locator(CELL)).toHaveCount(0);
  expect(await readWholeBody(page)).toBe(before);

  // ② 段落を押すとセル(記号の無い contenteditable)
  await clickReal(page, live.locator('p', { hasText: '書き換える段落' }));
  const cell = live.locator(CELL);
  await expect(cell).toBeVisible();
  await expect(cell).toHaveAttribute('contenteditable', 'true');
  await expect(cell).toHaveText('書き換える段落');
  await expect(live.locator(ROW)).toHaveCount(0);

  // 打つ(末尾へ)
  await cell.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
  });
  await page.keyboard.type('と追記');
  await expect(cell).toHaveText('書き換える段落と追記');

  // 帯: 太字・ハイライト・文字色(実マウス ── セルから焦点を奪わない)
  await selectInCell(cell, '書き換える');
  await clickReal(page, `${BAR} [data-pkc-format="bold"]`);
  await expect(live.locator(`${CELL} strong`)).toHaveText('書き換える');
  await selectInCell(live.locator(CELL), '段落');
  await clickReal(page, `${BAR} [data-pkc-format="highlight"]`);
  await expect(live.locator(`${CELL} mark`)).toHaveText('段落');
  await selectInCell(live.locator(CELL), '追記');
  await clickReal(page, `${BAR} [data-pkc-action="open-format-menu"][data-pkc-format-menu="color"]`);
  await expect(page.locator(MENU)).toBeVisible();
  await clickReal(page, `${MENU} [data-pkc-color="red"]`);
  await expect(page.locator(MENU)).toBeHidden();
  const red = live.locator(`${CELL} [data-pkc-rich-color="${RED}"]`);
  await expect(red, '一覧から選んだらセルが閉じた(書き込む先が消える)').toHaveText('追記');
  await expect(red).toHaveCSS('color', 'rgb(224, 49, 49)');

  // 🔴 (PR-06)書式を当てた直後の Ctrl+Z で当てる前へ戻り、Ctrl+Y で当て直せる(セルは閉じない)
  await page.keyboard.press('Control+z');
  await expect(live.locator(`${CELL} [data-pkc-rich-color]`), 'Ctrl+Z で文字色が戻らない').toHaveCount(0);
  await expect(live.locator(CELL)).toHaveText('書き換える段落と追記');
  await expect(live.locator(`${CELL} strong`)).toHaveText('書き換える');
  await page.keyboard.press('Control+y');
  await expect(live.locator(`${CELL} [data-pkc-rich-color="${RED}"]`), 'Ctrl+Y で文字色が戻らない').toHaveText('追記');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  await expect(live.locator(`${CELL} [data-pkc-rich-color="${RED}"]`), 'Ctrl+Shift+Z で文字色が戻らない').toHaveText('追記');

  // ブロックの外(見出し)を押して確定 ── 段落は描画に戻り、見出しがセルで開く
  await clickReal(page, live.locator('h1', { hasText: '題' }));
  await expect(live.locator(`h1${CELL}`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(live.locator(CELL)).toHaveCount(0);
  await expect(live.locator('p strong')).toHaveText('書き換える');
  await expect(live.locator('p mark')).toHaveText('段落');
  await expect(live.locator('p span.pkc-inline-mark')).toHaveText('追記');

  // 原文はプレーンな PKC-Markdown。コード・:::format は 1 バイトも変わらない
  const body = await readWholeBody(page);
  expect(body).toBe(DOC.replace('書き換える段落', `**書き換える**==段落==と:追記:${RED}:`));
  expect(body.split('\n').slice(4)).toEqual(DOC.split('\n').slice(4));

  // ③ コード・:::format は自動で原文の <textarea>
  await clickReal(page, live.locator('pre'));
  await expect(live.locator(ROW)).toBeVisible();
  await expect(live.locator(CELL)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(live.locator(ROW)).toHaveCount(0);
  await clickReal(page, live.locator('[data-pkc-align="center"]', { hasText: '中央の段落' }));
  await expect(live.locator(ROW)).toBeVisible();
  await expect(live.locator(CELL)).toHaveCount(0);
  await page.keyboard.press('Escape');

  // ④ 「原文」で <textarea> へ(打った内容を持って行く)
  await clickReal(page, live.locator('p', { hasText: '書き換える' }));
  await expect(live.locator(CELL)).toBeVisible();
  // caret を末尾へ(末尾は赤字の中 ── 打った字は同じ色の囲みに入る)
  await live.locator(CELL).evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
  });
  await page.keyboard.type('!');
  await clickReal(page, `${LIVE} [data-pkc-rich-source]`);
  const row = live.locator(ROW);
  await expect(row).toBeVisible();
  await expect(row).toHaveValue(`**書き換える**==段落==と:追記!:${RED}:`);
  await expect(live.locator(CELL)).toHaveCount(0);
  // 🔴 (PR-06)Alt+M で原文 → リッチへ戻せる(片道を作らない)。もう一度 Alt+M で原文へ
  await page.keyboard.press('Alt+m');
  await expect(live.locator(CELL), 'Alt+M で原文からリッチへ戻らない').toBeVisible();
  await expect(live.locator(ROW)).toHaveCount(0);
  await expect(live.locator(`${CELL} [data-pkc-rich-color="${RED}"]`)).toHaveText('追記!');
  await page.keyboard.press('Alt+m');
  await expect(live.locator(ROW)).toHaveValue(`**書き換える**==段落==と:追記!:${RED}:`);
  await expect(live.locator('[data-pkc-rich-back]'), '原文の欄の隣に「リッチ」ボタンが無い').toBeVisible();
  await clickReal(page, `${LIVE} [data-pkc-rich-back]`);
  await expect(live.locator(CELL)).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(live.locator(ROW)).toHaveCount(0);
  await expect(live.locator(CELL)).toHaveCount(0);
  const after = await readWholeBody(page);
  expect(after.split('\n').slice(4)).toEqual(DOC.split('\n').slice(4));

  // 🔴 (PR-06)空の段落で / → 一覧。Esc は一覧だけを閉じて / を残す。見出し 2 → 続けて /code でコードブロック
  await clickReal(page, live.locator('h1', { hasText: '題' }));
  await expect(live.locator(`h1${CELL}`)).toBeVisible();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const para = live.locator(CELL);
  await expect(para).toBeVisible();
  await expect(para).toHaveText('');
  const slashMenu = page.locator('[data-pkc-rich-insert-menu="slash"]');
  await page.keyboard.type('/');
  await expect(slashMenu, '/ で一覧が開かない').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(slashMenu).toHaveCount(0);
  await expect(live.locator(CELL), 'Esc でセルまで閉じた').toHaveText('/');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('/');
  await expect(slashMenu).toBeVisible();
  await page.keyboard.type('見出し');
  await expect(slashMenu.locator('button[role="menuitem"]')).toHaveText(['見出し 1', '見出し 2', '見出し 3']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(slashMenu.locator('[data-pkc-active]')).toHaveText('見出し 2');
  await page.keyboard.press('Enter');
  await expect(live.locator(`h2${CELL}`), '見出し 2 にならない').toBeVisible();
  await expect(live.locator(`h2${CELL}`)).toHaveText('');
  await page.keyboard.type('章');
  await page.keyboard.press('Enter');
  await expect(live.locator(CELL)).toHaveText('');
  await page.keyboard.type('/code');
  await expect(slashMenu.locator('button[role="menuitem"]')).toHaveText(['コードブロック']);
  await page.keyboard.press('Enter');
  const codeRow = live.locator(ROW);
  await expect(codeRow, 'コードブロックで原文の編集へ移らない').toHaveValue('```\n\n```');
  await page.keyboard.type('x = 1');
  await page.keyboard.press('Tab');
  await expect(live.locator(ROW)).toHaveCount(0);
  const inserted = await readWholeBody(page);
  expect(inserted.startsWith('# 題\n\n## 章\n\n```\nx = 1\n```\n\n**書き換える**')).toBe(true);
  expect(inserted.split('\n').slice(-7)).toEqual(DOC.split('\n').slice(4));

  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 既定(1 画面で編集(ライブ))では今までどおり原文の <textarea> が開く', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await dismissAnnounce(page);
  await seed(page, false);
  const live = page.locator(LIVE);
  await clickReal(page, live.locator('p', { hasText: '書き換える段落' }));
  await expect(live.locator(ROW)).toHaveValue('書き換える段落');
  await expect(page.locator(CELL)).toHaveCount(0);
  // 既定では「リッチ」ボタンも出ず、Alt+M でリッチにならない
  await expect(page.locator('[data-pkc-rich-back]')).toHaveCount(0);
  await page.keyboard.press('Alt+m');
  await expect(page.locator(CELL)).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});
