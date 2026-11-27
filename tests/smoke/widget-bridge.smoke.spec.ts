/**
 * smoke: ノートに埋め込んだ HTML のウィジェット(v4.0 Phase 2 / PR-07、ビジョン 5-A)。
 *
 * まっさらな起動から 1 本の道中で見る(起動 1 つ ── `scripts/smoke-budget.mjs`):
 * 1. ` ```html id="counter" ` のカウンターを押して 0 → 2
 * 2. 再読み込みしても 2 のまま(箱の 1 行目の同期 `localStorage.getItem` が前回の値を返す)
 * 3. 同じノートの無関係な段落を編集しても 2 のまま / 配色を暗くしても箱を読み直さずに `--pkc-fg` と `data-pkc-tone` が変わる
 * 4. 「状態を初期化」→ 確認 → 0 に戻る
 * 5. `id=` の無い ` ```html ` は今までどおり描かれ、`localStorage` にウィジェットの鍵を書かない
 *
 * PR-08(ビジョン 5-B)── 同じ起動の道中の続きに載せる(起動を増やさない):
 * 6. 書式バー「その他 ▾ → HTML ツール」から「カウンター・進捗トラッカー」を入れ、値を変えて「ノートへ保存」
 *    → 本文に ` ```json widget-state="tracker" ` が書かれる
 * 7. 端末のウィジェットの保存を空にして再読み込み → 本文の状態ブロックから値が戻る
 * 8. 「状態を初期化」→ 端末の保存も本文のブロックも消え、再読み込みしても戻らない
 * 9. 表のあるノートに「ノート内テーブル集計」を入れる → `readTables()` で読んだ行数と合計が出る
 *
 * #2090(v4.1 Phase 1 / PR-2)── これも同じ起動の続き(起動を増やさない):
 * 11. HTML ファイルを添付 → 添付の画面の「ウィジェット記法をコピー」の字(` ```html asset:鍵 id="…" `)を本文へ
 *     → ノートの中でウィジェットとして動く(sandbox は allow-scripts のみ)→ 0 → 2 → 再読み込みしても 2
 * 12. 「HTML で保存」→ `.html` がダウンロードされ、中身に保存した状態が入る
 * 13. 🔴 落とした単体の HTML を、PKC3 の無いページとして開く → エラー 0・2 の続きから動き、`pkcWidget` が待たずに空を返す
 *     ⚠ 新しいページの文書として読み込む(`setContent`)── アプリの起動を足さない(`scripts/smoke-budget.mjs`)。
 *       この文書はブラウザの保存を使えない(opaque)ので、その場限りの保存へ落ちる側を見る。
 *       `file://` で開いてブラウザの保存に残る側は、単体の純関数の test と PR の手元の確認で見る。
 */
import { test, expect, type Frame, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  answerAppDialog,
  bootedHere,
  clickBarMoreItem,
  clickReal,
  collectPageErrors,
  createEntry,
  gotoApp,
  useSplitEditor,
  writesLanded,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const COUNTER =
  '<button id="inc">+1</button> <span id="val"></span>\n' +
  '<script>\n' +
  "var n = Number(localStorage.getItem('count') || '0');\n" +
  "window.__booted = window.__booted || Math.random();\n" +
  "document.getElementById('val').textContent = String(n);\n" +
  "document.getElementById('inc').onclick = function () { n += 1; localStorage.setItem('count', String(n)); document.getElementById('val').textContent = String(n); };\n" +
  '</script>';

const PLAIN =
  '<p id="plain">ふつうの枠</p>\n' +
  "<script>try { localStorage.setItem('x', '1'); document.getElementById('plain').setAttribute('data-wrote', 'yes'); } catch (e) { document.getElementById('plain').setAttribute('data-wrote', 'no'); }</script>";

const BODY = (para: string): string =>
  `${para}\n\n\`\`\`html id="counter"\n${COUNTER}\n\`\`\`\n\n\`\`\`html\n${PLAIN}\n\`\`\`\n`;

const widgetFrame = (page: Page): ReturnType<Page['locator']> =>
  page.locator('[data-pkc-field="detail-body"] iframe.pkc-widget-frame');

async function frameOf(page: Page): Promise<Frame> {
  const el = await widgetFrame(page).elementHandle();
  const f = await el!.contentFrame();
  expect(f, 'ウィジェットの箱の中身が無い').not.toBeNull();
  return f!;
}

async function valueIs(page: Page, v: string): Promise<void> {
  await expect
    .poll(async () => {
      const f = await frameOf(page);
      return f.locator('#val').textContent().catch(() => null);
    }, { timeout: 10_000 })
    .toBe(v);
}

const widgetKeys = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith('pkc3.widget.')) out.push(k);
    }
    return out.sort();
  });

test('id= の在る html のウィジェットは状態を保ち、配色に追従し、初期化できる / id= の無い枠は何も保存しない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(BODY('はじめの段落'));
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await writesLanded(page);

  // 1. カウンターを 0 → 2
  await expect(widgetFrame(page)).toHaveCount(1);
  await valueIs(page, '0');
  const reset = page.locator('[data-pkc-field="widget-reset"]');
  await expect(reset).toHaveText('状態を初期化');
  await expect(reset, '保存が無いのに「状態を初期化」が押せる').toBeDisabled();
  const f0 = await frameOf(page);
  await f0.locator('#inc').click();
  await f0.locator('#inc').click();
  await valueIs(page, '2');
  await expect(reset, '保存したのに「状態を初期化」が押せない').toBeEnabled();
  const keys = await widgetKeys(page);
  expect(keys, '保存の鍵が 1 つでない').toHaveLength(1);
  expect(keys[0]).toMatch(/^pkc3\.widget\.[^.]+\.counter\.count$/);

  // 5(先に見る). id= の無い枠は描かれ、localStorage には書けない(状態を持たない)
  const plainFrame = page.locator('[data-pkc-field="detail-body"] iframe[data-pkc-html-render-id]:not(.pkc-widget-frame)');
  await expect(plainFrame).toHaveCount(1);
  const pf = await (await plainFrame.elementHandle())!.contentFrame();
  await expect(pf!.locator('#plain')).toHaveText('ふつうの枠');
  await expect(pf!.locator('#plain')).toHaveAttribute('data-wrote', 'no');
  expect(await widgetKeys(page), 'id= の無い枠が鍵を書いた').toEqual(keys);
  // 箱の隔離は変わらない
  expect(await widgetFrame(page).getAttribute('sandbox')).toBe('allow-scripts');
  expect(await plainFrame.getAttribute('sandbox')).toBe('allow-scripts');

  // 2. 再読み込みしても 2 のまま
  await page.reload();
  await bootedHere(page);
  if ((await widgetFrame(page).count()) === 0) {
    // 選択が戻らない起動なら、一覧から開き直す(user と同じ手順)
    await clickReal(page, page.locator('[data-pkc-region="sidebar"] [data-pkc-action="select-entry"]').first());
  }
  await valueIs(page, '2');

  // 3a. 同じノートの無関係な段落を編集しても 2 のまま
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill(BODY('書き換えた段落'));
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await writesLanded(page);
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('書き換えた段落');
  await valueIs(page, '2');

  // 3b. 配色を暗くしても箱は読み直さず、変数と tone が変わる
  const fr = await frameOf(page);
  const booted = await fr.evaluate(() => (window as unknown as { __booted: number }).__booted);
  await page.evaluate(() => {
    (document.querySelector('[data-pkc-field="detail-body"] iframe.pkc-widget-frame') as HTMLElement).setAttribute('data-smoke-mark', '1');
  });
  const lightFg = await fr.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pkc-fg').trim());
  const parentDark = await page.evaluate(() => {
    document.documentElement.setAttribute('data-pkc-theme', 'dark');
    document.documentElement.setAttribute('data-pkc-tone', 'dark');
    return getComputedStyle(document.documentElement).getPropertyValue('--fg').trim();
  });
  await expect.poll(() => fr.evaluate(() => document.documentElement.getAttribute('data-pkc-tone'))).toBe('dark');
  const darkFg = await fr.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pkc-fg').trim());
  expect(darkFg, '箱の --pkc-fg が親の --fg と一致しない').toBe(parentDark);
  expect(darkFg, '暗くしても --pkc-fg が変わらない').not.toBe(lightFg);
  // 文字の色も --pkc-fg に従う
  const bodyColor = await fr.evaluate(() => getComputedStyle(document.body).color);
  expect(bodyColor).not.toBe('rgb(34, 34, 34)');
  // 読み直していない(箱の中の値も、親の側の要素も同じ)
  expect(await fr.evaluate(() => (window as unknown as { __booted: number }).__booted)).toBe(booted);
  await expect(page.locator('[data-pkc-field="detail-body"] iframe.pkc-widget-frame[data-smoke-mark="1"]')).toHaveCount(1);
  await valueIs(page, '2');

  // 4. 「状態を初期化」→ 確認 → 0
  await clickReal(page, reset);
  await answerAppDialog(page, 'ok');
  await valueIs(page, '0');
  expect(await widgetKeys(page), '初期化しても鍵が残った').toEqual([]);
  await expect(reset).toBeDisabled();

  // ── PR-08 ── 6〜9 は同じ起動の続き(起動を増やさない)
  await prOEight(page);

  // ── #2090 ── 11〜13 は同じ起動の続き(起動を増やさない)
  await assetWidget(page);

  expect(errors).toEqual([]);
});

/** 本文(読む面で開いているノート)の原文を、編集の欄から読む。 */
async function sourceOf(page: Page): Promise<string> {
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  const v = await ta.inputValue();
  await clickReal(page, '[data-pkc-action="cancel-edit"]');
  await expect(ta).toBeHidden();
  return v;
}

/** 書式バー「その他 ▾ → HTML ツール」から 1 つ選んで入れる(欄の末尾に)。 */
async function insertTool(page: Page, label: string): Promise<void> {
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.focus();
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await clickBarMoreItem(page, '[data-pkc-action="insert-widget-template"]');
  const rows = page.locator('[data-pkc-field="pick-widget-template"]');
  await expect(rows, 'HTML ツールの一覧が 6 行出ていない').toHaveCount(6);
  await clickReal(page, rows.filter({ hasText: label }).first());
  await expect(page.locator('[data-pkc-region="app-dialog"]')).toBeHidden();
}

const trackerFrame = (page: Page): ReturnType<Page['locator']> =>
  page.locator('[data-pkc-field="detail-body"] [data-pkc-widget-id="tracker"] iframe.pkc-widget-frame');

async function trackerValue(page: Page): Promise<string | null> {
  const el = await trackerFrame(page).elementHandle();
  if (el === null) return null;
  const f = await el.contentFrame();
  return f === null ? null : f.locator('#val').textContent().catch(() => null);
}

async function reopen(page: Page): Promise<void> {
  await page.reload();
  await bootedHere(page);
  if ((await page.locator('[data-pkc-field="detail-body"] [data-pkc-widget-id]').count()) === 0) {
    await clickReal(page, page.locator('[data-pkc-region="sidebar"] [data-pkc-action="select-entry"]').first());
  }
}

async function prOEight(page: Page): Promise<void> {
  // 6. 「HTML ツール」から「カウンター・進捗トラッカー」を入れる
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await insertTool(page, 'カウンター・進捗トラッカー');
  const inserted = await page.locator('[data-pkc-field="editor-body"]').inputValue();
  expect(inserted, '本文に ```html id="tracker" が入っていない').toContain('```html id="tracker"');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await writesLanded(page);
  await expect(trackerFrame(page)).toHaveCount(1);
  await expect.poll(() => trackerValue(page), { timeout: 10_000 }).toBe('0');
  const tf = await (await trackerFrame(page).elementHandle())!.contentFrame();
  await tf!.locator('#inc').click();
  await tf!.locator('#inc').click();
  await tf!.locator('#inc').click();
  await expect.poll(() => trackerValue(page)).toBe('3');
  const toolBar = page.locator('[data-pkc-field="detail-body"] [data-pkc-widget-id="tracker"]');
  const save = toolBar.locator('[data-pkc-field="widget-save"]');
  await expect(save).toHaveText('ノートへ保存');
  await expect(save, '保存したのに「ノートへ保存」が押せない').toBeEnabled();
  await clickReal(page, save);
  await expect(page.locator('body')).toContainText('ウィジェットの状態をノートに保存しました');
  await writesLanded(page);
  const saved = await sourceOf(page);
  expect(saved, '本文に状態ブロックが書かれていない').toMatch(/```json widget-state="tracker"\n\{[^`]*"value": "3"[^`]*\}\n```/);
  // 🔴 本体の囲みの直後に入る(本体より上・別の場所に生えない)
  expect(saved.indexOf('```json widget-state="tracker"')).toBeGreaterThan(saved.indexOf('```html id="tracker"'));

  // 7. 端末の保存を空にして再読み込み → 本文のブロックから 3 に戻る
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('pkc3.widget.')) localStorage.removeItem(k);
  });
  await reopen(page);
  await expect.poll(() => trackerValue(page), { timeout: 10_000 }).toBe('3');

  // 8. 「状態を初期化」→ 端末の保存も本文のブロックも消える。再読み込みしても戻らない
  const resetT = page.locator('[data-pkc-field="detail-body"] [data-pkc-widget-id="tracker"] [data-pkc-field="widget-reset"]');
  await expect(resetT).toBeEnabled();
  await clickReal(page, resetT);
  await expect(page.locator('[data-pkc-region="app-dialog"]')).toContainText('ノートに保存済みの状態ブロックも削除します');
  await answerAppDialog(page, 'ok');
  await expect.poll(() => trackerValue(page), { timeout: 10_000 }).toBe('0');
  await writesLanded(page);
  expect(await widgetKeys(page), '初期化しても端末の保存が残った').toEqual([]);
  await expect.poll(async () => (await sourceOf(page)).includes('widget-state="tracker"'), { timeout: 10_000 }).toBe(false);
  await reopen(page);
  await expect.poll(() => trackerValue(page), { timeout: 10_000 }).toBe('0');

  // 9. 表のあるノートに「ノート内テーブル集計」── 行数と合計が出る
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill('| 品目 | 金額 |\n|---|---|\n| 米 | 2000 |\n| 卵 | 300 |\n| 水 | 100 |\n\n```csv\nname,qty\na,1\nb,2\n```\n');
  await insertTool(page, 'ノート内テーブル集計');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await writesLanded(page);
  const sumFrame = page.locator('[data-pkc-field="detail-body"] [data-pkc-widget-id="table-summary"] iframe.pkc-widget-frame');
  await expect(sumFrame).toHaveCount(1);
  const sf = await (await sumFrame.elementHandle())!.contentFrame();
  await expect(sf!.locator('[data-table-index="0"]')).toContainText('表 1(markdown):3 行', { timeout: 10_000 });
  await expect(sf!.locator('[data-table-index="0"] [data-sum]')).toHaveAttribute('data-sum', '2400');
  await expect(sf!.locator('[data-table-index="1"]')).toContainText('表 2(csv):2 行');
  await expect(sf!.locator('[data-table-index="1"] [data-sum]')).toHaveAttribute('data-sum', '3');

  // 10. 🔴 同じノートに「表の検索・絞り込み」(v4.0 仕上げ PR-D)── 実物の readTables で表を読み、語で行が絞れる
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await insertTool(page, '表の検索・絞り込み');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await writesLanded(page);
  // ⚠ 枠は「見えたとき」に起動する(`widget-bridge.ts` の IntersectionObserver)── 本文の下にあるので見える所まで送る
  await page.locator('[data-pkc-field="detail-body"] [data-pkc-widget-id="table-filter"]').scrollIntoViewIfNeeded();
  const filterFrame = page.locator('[data-pkc-field="detail-body"] [data-pkc-widget-id="table-filter"] iframe.pkc-widget-frame');
  await expect(filterFrame).toHaveCount(1, { timeout: 10_000 });
  const ff = await (await filterFrame.elementHandle())!.contentFrame();
  await expect(ff!.locator('#count')).toHaveText('3 / 3 行', { timeout: 10_000 });
  await ff!.locator('#q').fill('米');
  await expect(ff!.locator('#count')).toHaveText('1 / 3 行');
  await expect(ff!.locator('#out mark')).toHaveText('米');
  await ff!.locator('#pick').selectOption('1');
  await expect(ff!.locator('#count')).toHaveText('0 / 2 行');
}

/** 添付する HTML(`id=` で状態を持つカウンター。⚠ 直書きの COUNTER と別の id 名で、保存の鍵を混ぜない)。 */
const TOOL_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>tool</title></head><body>' +
  '<button id="inc">+1</button> <span id="val"></span>' +
  '<script>' +
  "var n = Number(localStorage.getItem('count') || '0');" +
  "document.getElementById('val').textContent = String(n);" +
  "document.getElementById('inc').onclick = function () { n += 1; localStorage.setItem('count', String(n)); document.getElementById('val').textContent = String(n); };" +
  '</script></body></html>';

const assetFrame = (page: Page): ReturnType<Page['locator']> =>
  page.locator('[data-pkc-field="detail-body"] [data-pkc-widget-asset] iframe.pkc-widget-frame');

async function assetValue(page: Page): Promise<string | null> {
  const el = await assetFrame(page).elementHandle();
  if (el === null) return null;
  const f = await el.contentFrame();
  return f === null ? null : f.locator('#val').textContent().catch(() => null);
}

/** 一覧から題名でノートを開く(再読み込みのあと、どのノートが開くかに頼らない)。 */
async function openByTitle(page: Page, title: string): Promise<void> {
  const row = page.locator('[data-pkc-region="sidebar"] [data-pkc-action="select-entry"]').filter({ hasText: title }).first();
  await clickReal(page, row);
  await expect(page.locator('[data-pkc-field="detail-title"]').first()).toHaveText(title);
}

async function assetWidget(page: Page): Promise<void> {
  // 11. 新しいノートを作り、HTML ファイルを添付する
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('添付ツールのノート');
  await page.locator('[data-pkc-field="editor-body"]').fill('メモ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await writesLanded(page);
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'counter-tool.html',
    mimeType: 'text/html',
    buffer: Buffer.from(TOOL_HTML, 'utf8'),
  });
  await expect(page.locator('[data-pkc-region="sidebar"] [data-pkc-action="select-entry"]').filter({ hasText: 'counter-tool.html' })).toHaveCount(1, { timeout: 15_000 });
  await writesLanded(page);
  // 添付の画面の「ウィジェット記法をコピー」── 貼れる字は要素が持つ
  await openByTitle(page, 'counter-tool.html');
  const copyBtn = page.locator('[data-pkc-field="copy-widget-fence"]');
  await expect(copyBtn).toHaveText('ウィジェット記法をコピー');
  const fence = (await copyBtn.getAttribute('data-pkc-asset-ref')) ?? '';
  expect(fence, '記法の字が違う').toMatch(/^```html asset:\S+ id="counter-tool"\n```$/);
  // 対照群: 「参照をコピー」は今までどおりリンクの字
  expect(await page.locator('[data-pkc-field="copy-asset-ref"]').getAttribute('data-pkc-asset-ref')).toContain('](asset:');

  // 本文へ貼る
  await openByTitle(page, '添付ツールのノート');
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await page.locator('[data-pkc-field="editor-body"]').fill(`添付のツール\n\n${fence}\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await writesLanded(page);
  await expect(assetFrame(page), '添付の HTML がウィジェットにならない').toHaveCount(1, { timeout: 15_000 });
  expect(await assetFrame(page).getAttribute('sandbox')).toBe('allow-scripts');
  await expect.poll(() => assetValue(page), { timeout: 10_000 }).toBe('0');
  const af = await (await assetFrame(page).elementHandle())!.contentFrame();
  await af!.locator('#inc').click();
  await af!.locator('#inc').click();
  await expect.poll(() => assetValue(page)).toBe('2');
  const keys = await widgetKeys(page);
  expect(keys.some((k) => /\.counter-tool\.count$/.test(k)), '添付のウィジェットの保存の鍵が無い').toBe(true);
  // バーの 3 つ(保存・初期化・HTML で保存)
  const box = page.locator('[data-pkc-field="detail-body"] [data-pkc-widget-asset]');
  await expect(box.locator('[data-pkc-field="widget-bar"] button')).toHaveText(['ノートへ保存', '状態を初期化', 'HTML で保存']);

  // 再読み込みしても 2 のまま
  await page.reload();
  await bootedHere(page);
  await openByTitle(page, '添付ツールのノート');
  await expect.poll(() => assetValue(page), { timeout: 15_000 }).toBe('2');

  // 12. 「HTML で保存」→ ダウンロード
  const dir = await mkdtemp(join(tmpdir(), 'pkc3-widget-dl-'));
  try {
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      clickReal(page, box.locator('[data-pkc-field="widget-download"]')),
    ]);
    expect(dl.suggestedFilename()).toBe('counter-tool.html');
    const file = join(dir, 'counter-tool.html');
    await dl.saveAs(file);
    const text = await readFile(file, 'utf8');
    expect(text.startsWith('<!DOCTYPE html><html lang="ja" data-pkc-tone=')).toBe(true);
    expect(text, '保存した状態が入っていない').toContain('{"count":"2"}');
    expect(text).toContain("connect-src 'none'");

    // 13. 🔴 落とした単体の HTML を、PKC3 の無いページとして開く
    const p2 = await page.context().newPage();
    const errs: string[] = [];
    p2.on('pageerror', (e) => errs.push(String(e)));
    p2.on('console', (m) => {
      if (m.type() === 'error') errs.push(m.text());
    });
    await p2.setContent(text);
    await expect(p2.locator('#val'), '保存した状態の続きから始まらない').toHaveText('2');
    await p2.locator('#inc').click();
    await expect(p2.locator('#val')).toHaveText('3');
    // pkcWidget が使え、親が居なくてもノートの参照は待たずに空
    const ctx = await p2.evaluate(async () => {
      const w = (window as unknown as { pkcWidget: { id: string; readTables: () => Promise<unknown[]> } }).pkcWidget;
      const t0 = performance.now();
      const tables = await w.readTables();
      return { id: w.id, tables, ms: performance.now() - t0 };
    });
    expect(ctx.id).toBe('counter-tool');
    expect(ctx.tables).toEqual([]);
    expect(ctx.ms, 'ノートの参照が待たされた').toBeLessThan(1000);
    // 地の色が塗られている(透けていない)
    expect(await p2.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    expect(errs, '単体の HTML でエラーが出た').toEqual([]);
    await p2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
