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
 *
 * #2090 ②(v4.1 Phase 1 / PR-3)── 同じ起動の続き(起動を増やさない):
 * 14. 外部の script と `fetch` を使う HTML を添付してウィジェットにする → 既定は CSP で止まり、案内帯が出る
 *     (`sandbox="allow-scripts"` のみ)。外部は `page.route` の偽の CDN / API で受ける ── 許可したら**実際に読めた**ことを見る
 * 15. 案内帯の「権限を開く」→ 2 つとも許可 → 即置き直され、案内帯が消え、script が読めて通信が返る(sandbox は不変)
 * 16. システムの「許可」→「添付 HTML ウィジェットの追加権限」に出る →「許可を取り消す」→ ノートへ戻ると再び止まる
 *
 * #2097(v4.1 Phase 1 / PR-4)── 同じ起動の続き(起動を増やさない):
 * 17. `id=` の無い直書きの ```html の中で、素の `<a download href="blob:…">` を押す → 自動では保存されず確認バーが出る
 *     (sandbox は allow-scripts のみ)→「PC へ保存」で実際に .csv がダウンロードされ、中身が一致する
 * 18. `pkcWidget.requestDownload` →「このノートへ添付」→ 添付ノートができ、本文にリンクが入る
 * 19. 要注意の拡張子(report.html)は確認バーに注意が出る →「やめる」で cancel が返る
 * 20. `pkcWidget.requestFile` →「PC から選ぶ」(ファイル選択)で渡した CSV を箱の中で読める
 * 21. `pkcWidget.requestFile` →「このノートの添付から選ぶ」で 18 の添付を選ぶ → 箱の中で読める
 * ⚠ 確認バーのボタンは出した直後(0.4 秒)押せない(すり替え対策)── 押せるようになるのを待ってから実クリックする。
 *
 * #2097 / #2098(v4.1 Phase 2 / PR-5)── 同じ起動の続き(起動を増やさない):
 * 22. ここまでのノートを全部「閲覧用 HTML」で書き出し、PKC3 の無いページとして開く(`blob:` の文書 ── 起動を足さない)
 * 23. 表のノートの「ノート内テーブル集計」が、書き出した HTML の中でも `readTables()` で同じ行数・合計を出す
 *     / 箱は allow-scripts のみ / `getTheme()` に開いた先の配色が届き、OS を暗くすると箱を読み直さずに dark へ変わる
 * 24. 入出力のノートで素の `<a download>` → 確認バー(自動では保存しない)→「PC へ保存」で .csv がダウンロードされる
 *     /「このノートへ添付」は出ない(閲覧用 HTML は読むだけ)
 * 25. `requestFile` →「このノートの添付から選ぶ」→ 同じノートの添付(18 の memo.csv)だけが並び、箱の中で読める
 * 26. 確認バーを出したまま別のノートへ移る → 確認バーが消え、箱へ答えが返る / 添付のウィジェット(asset: + id=)も箱になる
 *     / 閲覧用 HTML のページのエラーは 0
 * 27. 配布パッケージ(#2098 後半)を書き出す → `.pkc3-site.zip` の中に、ノート 1 件 1 ファイル・counter-tool のツール
 *     (厳格な CSP・箱の名乗りが iframe と同じ)・memo.csv の生ファイルと data/asset-*.js が在り、シェルの箱は allow-scripts だけ
 */
import { test, expect, type Frame, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZipDirectory, readZipEntry } from '../../src/features/import/zip-reader';
import {
  answerAppDialog,
  bootedHere,
  clickBarMoreItem,
  clickReal,
  collectPageErrors,
  clickExportMenuItem,
  createEntry,
  gotoApp,
  gotoCollectionPane,
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
  // ⚠ 1 起動の道中に #2090 ②(権限の往復: 添付・許可・設定画面で取り消し・再読み込み)を相乗りさせたので 30 秒枠を超える
  //   (起動を増やさない代わりに道中が延びた ── `attach.smoke.spec.ts` の `test.setTimeout(120_000)` が前例)
  test.setTimeout(120_000);
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

  // ── #2097 ── 17〜21 は同じ起動の続き(起動を増やさない。⚠ SW を外す `widgetPermissions` より前に置く)
  await widgetFileIo(page);

  // ── #2097 / #2098 ── 22〜26 は同じ起動の続き(書き出した閲覧用 HTML を blob: の文書で開く ── 起動を増やさない)
  await exportedViewerWidgets(page);

  // ── #2098 後半 ── 27 は同じ起動の続き(配布パッケージを書き出し、zip の中身を確かめる ── 起動を増やさない)
  await exportedSitePackage(page);

  // ── #2090 ② ── 14〜16 は同じ起動の続き(起動を増やさない)
  await widgetPermissions(page);

  /**
   * ⚠ 14・16 で**意図して止めた** CSP の記録(偽の CDN / API への遮断)だけを除く ── 名指しで絞る(他のエラーは 0 件のまま)。
   * 🔑 止めた記録が**在ること**も見る(既定と取り消し後の 2 回 × script / 通信)── 0 なら「止まった」の主張が空振りしている。
   */
  const intended = errors.filter((e) => e.includes('pkc3-smoke.test') && e.includes('Content Security Policy'));
  expect(intended.filter((e) => e.includes('cdn.pkc3-smoke.test')).length, '既定・取り消し後に script を止めていない').toBeGreaterThanOrEqual(2);
  expect(intended.filter((e) => e.includes('api.pkc3-smoke.test')).length, '既定・取り消し後に通信を止めていない').toBeGreaterThanOrEqual(2);
  expect(errors.filter((e) => !intended.includes(e))).toEqual([]);
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
  // バーの 4 つ(保存・初期化・HTML で保存・権限 ── 権限は添付の HTML だけ。#2090 ②)
  const box = page.locator('[data-pkc-field="detail-body"] [data-pkc-widget-asset]');
  await expect(box.locator('[data-pkc-field="widget-bar"] button')).toHaveText(['ノートへ保存', '状態を初期化', 'HTML で保存', '権限']);

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

/** ファイルの入出力の道具(#2097)。⚠ `id=` の無い直書きの ```html に置く(全部の箱が対象であることを見る)。 */
const IO_TOOL =
  '<button id="dl">a で保存</button> <button id="dl2">API で保存</button> <button id="risk">要注意</button> <button id="up">読む</button>\n' +
  '<p id="res">-</p><pre id="out">-</pre>\n' +
  '<script>\n' +
  "function $(i){return document.getElementById(i);}\n" +
  "$('dl').onclick=function(){var b=new Blob(['名前,値\\nA,1\\n'],{type:'text/csv'});var a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='out.csv';document.body.appendChild(a);a.click();a.remove();$('res').textContent='clicked';};\n" +
  "$('dl2').onclick=function(){pkcWidget.requestDownload({name:'memo.csv',mime:'text/csv',data:'x,y\\n1,2\\n'}).then(function(r){$('res').textContent=r.action;});};\n" +
  "$('risk').onclick=function(){pkcWidget.requestDownload({name:'report.html',mime:'text/html',data:'<p>r</p>'}).then(function(r){$('res').textContent='risk:'+r.action;});};\n" +
  "$('up').onclick=function(){pkcWidget.requestFile({accept:'.csv'}).then(function(r){$('out').textContent=r.ok?r.files[0].name+'|'+new TextDecoder().decode(r.files[0].data):'NG:'+(r.reason||'');});};\n" +
  '</script>';

const ioFrame = (page: Page): ReturnType<Page['locator']> => page.locator('[data-pkc-field="detail-body"] iframe.pkc-html-render');

async function ioText(page: Page, sel: string): Promise<string | null> {
  const el = await ioFrame(page).elementHandle();
  const f = el === null ? null : await el.contentFrame();
  return f === null ? null : f.locator(sel).textContent().catch(() => null);
}

async function ioClick(page: Page, sel: string): Promise<void> {
  const f = await (await ioFrame(page).elementHandle())!.contentFrame();
  await f!.locator(sel).click();
}

async function widgetFileIo(page: Page): Promise<void> {
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('入出力のノート');
  await page.locator('[data-pkc-field="editor-body"]').fill('入出力\n\n```html\n' + IO_TOOL + '\n```\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await writesLanded(page);
  await expect(ioFrame(page)).toHaveCount(1, { timeout: 15_000 });
  expect(await ioFrame(page).getAttribute('sandbox'), 'sandbox が緩んだ').toBe('allow-scripts');
  await expect.poll(() => ioText(page, '#res'), { timeout: 10_000 }).toBe('-');
  const bar = page.locator('[data-pkc-field="detail-body"] [data-pkc-field="widget-io-bar"]');
  const downloads: string[] = [];
  const onDl = (d: { suggestedFilename(): string }): void => {
    downloads.push(d.suggestedFilename());
  };
  page.on('download', onDl);
  const dir = await mkdtemp(join(tmpdir(), 'pkc3-widget-io-'));
  try {
    // 17. 素の <a download> → 確認バー(自動では保存しない)→「PC へ保存」
    await ioClick(page, '#dl');
    await expect.poll(() => ioText(page, '#res')).toBe('clicked');
    await expect(bar, '<a download> の救済で確認バーが出ない').toHaveCount(1, { timeout: 10_000 });
    await expect(bar).toContainText('「out.csv」');
    await page.waitForTimeout(500);
    expect(downloads, '押す前に保存された(ドライブバイ)').toEqual([]);
    expect(await ioFrame(page).getAttribute('sandbox')).toBe('allow-scripts');
    await expect(bar.locator('[data-pkc-field="widget-io-save"]'), '確認バーのボタンが押せるようにならない').toBeEnabled();
    const [dl] = await Promise.all([page.waitForEvent('download'), clickReal(page, bar.locator('[data-pkc-field="widget-io-save"]'))]);
    expect(dl.suggestedFilename()).toBe('out.csv');
    const file = join(dir, 'out.csv');
    await dl.saveAs(file);
    expect(await readFile(file, 'utf8')).toBe('名前,値\nA,1\n');
    await expect(bar).toHaveCount(0);

    // 18. requestDownload →「このノートへ添付」
    // 🔴 箱(iframe)に印を付けておき、添付の後も**同じ箱が生きている**かを見る(v4.1 仕上げ。PR #2108 の気づき)
    await ioFrame(page).evaluate((el) => {
      (el as unknown as { __pkcKeep?: number }).__pkcKeep = 1;
    });
    await ioClick(page, '#dl2');
    await expect(bar).toContainText('「memo.csv」', { timeout: 10_000 });
    await expect(bar.locator('[data-pkc-field="widget-io-attach"]')).toBeEnabled();
    await clickReal(page, bar.locator('[data-pkc-field="widget-io-attach"]'));
    await expect(
      page.locator('[data-pkc-region="sidebar"] [data-pkc-action="select-entry"]').filter({ hasText: 'memo.csv' }),
      '添付ノートができない',
    ).toHaveCount(1, { timeout: 15_000 });
    await writesLanded(page);
    await expect(page.locator('[data-pkc-field="detail-body"]'), '本文に添付のリンクが入らない').toContainText('memo.csv');
    await expect(bar).toHaveCount(0);
    /**
     * 🔴 **添付しても箱は作り直されない**(v4.1 仕上げ)。直す前は添付が選択を作った添付へ一瞬移して戻していたので、本文の塊が
     *   全部作り直され、箱も読み直されて中身(`#res`)が `-` に戻っていた。いまは本文へリンクの塊が差分で入るだけ ──
     *   同じ箱(印が残る)が、`attach` の答えを受け取って表示する。
     */
    await expect(ioFrame(page)).toHaveCount(1, { timeout: 15_000 });
    expect(
      await ioFrame(page).evaluate((el) => (el as unknown as { __pkcKeep?: number }).__pkcKeep),
      '添付で箱が作り直された(id の無いウィジェットの中身が消える)',
    ).toBe(1);
    await expect.poll(() => ioText(page, '#res'), { timeout: 10_000 }).toBe('attach');

    // 19. 要注意の拡張子 → 注意が出る →「やめる」
    await ioClick(page, '#risk');
    await expect(bar.locator('[data-pkc-field="widget-io-risk"]')).toContainText('スクリプトや実行コード', { timeout: 10_000 });
    await expect(bar.locator('[data-pkc-field="widget-io-cancel"]')).toBeEnabled();
    await clickReal(page, bar.locator('[data-pkc-field="widget-io-cancel"]'));
    await expect.poll(() => ioText(page, '#res')).toBe('risk:cancel');

    // 20. requestFile →「PC から選ぶ」
    await ioClick(page, '#up');
    await expect(bar).toContainText('対象: .csv', { timeout: 10_000 });
    await expect(bar.locator('[data-pkc-field="widget-io-pick-pc"]'), '確認バーのボタンが押せるようにならない').toBeEnabled();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      clickReal(page, bar.locator('[data-pkc-field="widget-io-pick-pc"]')),
    ]);
    await chooser.setFiles({ name: 'in.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n3,4\n', 'utf8') });
    await expect.poll(() => ioText(page, '#out'), { timeout: 10_000 }).toBe('in.csv|a,b\n3,4\n');
    await expect(bar).toHaveCount(0);

    // 21. requestFile →「このノートの添付から選ぶ」(18 で添付した memo.csv)
    await ioClick(page, '#up');
    const pickNote = bar.locator('[data-pkc-field="widget-io-pick-note"]');
    await expect(pickNote, 'このノートの添付が候補に出ない').toBeVisible({ timeout: 10_000 });
    await expect(pickNote).toBeEnabled();
    await clickReal(page, pickNote);
    const item = bar.locator('[data-pkc-field="widget-io-note-asset"]');
    await expect(item).toHaveCount(1);
    await item.check();
    await expect(bar.locator('[data-pkc-field="widget-io-note-give"]')).toBeEnabled();
    await clickReal(page, bar.locator('[data-pkc-field="widget-io-note-give"]'));
    await expect.poll(() => ioText(page, '#out'), { timeout: 10_000 }).toBe('memo.csv|x,y\n1,2\n');
    expect(downloads, '余計なダウンロードが起きた').toEqual(['out.csv']);
  } finally {
    page.off('download', onDl);
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 🔴 **書き出した閲覧用 HTML の中のウィジェット**(#2097 / #2098)── 本物の書き出しを、PKC3 の無いページとして開く。
 * ⚠ `blob:` の文書として読み込む(`goto` は起動の数に入る ── `scripts/smoke-budget.mjs`)。`file://` で直に開く側は PR の手元の確認で見る。
 */
async function exportedViewerWidgets(page: Page): Promise<void> {
  await gotoCollectionPane(page);
  const dlWait = page.waitForEvent('download', { timeout: 30_000 });
  await clickExportMenuItem(page, 'export-html');
  // ⚠ 外へ渡す書き出しの前の点検(18 で本文に入った添付のリンクを挙げる)──「このまま書き出す」
  expect(await answerAppDialog(page, 'ok', { timeout: 15_000 })).toContain('書き出す前に');
  const dl = await dlWait;
  const text = await readFile((await dl.path())!, 'utf8');
  expect(text.slice(0, 200).toLowerCase()).toContain('<!doctype html');
  expect(text, '確認バーの親が入っていない').toContain('__pkcWidgetBridgeSweep');

  const v = await page.context().newPage();
  const errs: string[] = [];
  v.on('pageerror', (e) => errs.push(String(e)));
  v.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text());
  });
  const dir = await mkdtemp(join(tmpdir(), 'pkc3-viewer-io-'));
  try {
    await v.emulateMedia({ colorScheme: 'light' });
    /**
     * ⚠ `setContent` を使わない ── この Chromium は、about:blank の最上位に `sandbox` 付きの `srcdoc` の iframe を置くと
     *   **ブラウザごと落ちる**(閲覧用 HTML の中身と無関係。`<iframe sandbox="allow-scripts" srcdoc="x">` 1 行で再現。
     *   http / file / blob の最上位では落ちない)。`blob:` へ移る(`goto` を使わない ── 起動の数に入らず、費用は setContent と同じ)。
     */
    await v.evaluate((h) => {
      location.href = URL.createObjectURL(new Blob([h], { type: 'text/html' }));
    }, text);
    await v.waitForURL(/^blob:/);
    await expect(v.locator('#pkc-body')).toBeVisible();
    /** 題名で開く(⚠ 題名の無いノートは本文の中身で探す)。 */
    const openWhere = async (pred: string): Promise<void> => {
      const i = await v.evaluate((p) => {
        const d = JSON.parse(document.getElementById('pkc-data')!.textContent!) as { entries: { title: string; html: string }[] };
        return d.entries.findIndex((e) => e.title === p || e.html.includes(p));
      }, pred);
      expect(i, `書き出しに「${pred}」のノートが無い`).toBeGreaterThanOrEqual(0);
      await v.locator('#pkc-list button').nth(i).click();
    };
    const frameIn = async (sel: string): Promise<Frame> => {
      const el = v.locator(`#pkc-body ${sel}`).first();
      await expect(el).toHaveCount(1, { timeout: 10_000 });
      expect(await el.getAttribute('sandbox'), '閲覧用 HTML で sandbox が緩んだ').toBe('allow-scripts');
      await el.scrollIntoViewIfNeeded();
      return (await (await el.elementHandle())!.contentFrame())!;
    };

    // 23. 表のノート ── 書き出した先でも readTables が同じノートの表を返す
    await openWhere('table-summary');
    const sf = await frameIn('iframe[srcdoc*="data-sum"]');
    await expect(sf.locator('[data-table-index="0"]'), '書き出した HTML で readTables が表を返さない').toContainText('表 1(markdown):3 行', {
      timeout: 10_000,
    });
    await expect(sf.locator('[data-table-index="0"] [data-sum]')).toHaveAttribute('data-sum', '2400');
    const theme = async (): Promise<{ tone: string | null; fg: string | null }> =>
      sf.evaluate(() => {
        const t = (window as unknown as { pkcWidget: { getTheme(): { tone: string | null; tokens: Record<string, string> } } }).pkcWidget.getTheme();
        return { tone: t.tone, fg: t.tokens['--pkc-fg'] ?? null };
      });
    await expect.poll(async () => (await theme()).tone, { timeout: 10_000 }).toBe('light');
    expect((await theme()).fg, '配色の変数が届いていない').toBeTruthy();
    const lightFg = (await theme()).fg;
    // OS を暗くする → 箱を読み直さずに dark へ(印を付けて、読み直されていないことを見る)
    await sf.evaluate(() => {
      (window as unknown as { __mark: number }).__mark = 1;
    });
    await v.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(async () => (await theme()).tone, { timeout: 10_000 }).toBe('dark');
    expect((await theme()).fg, '暗い配色の値に変わっていない').not.toBe(lightFg);
    expect(await sf.evaluate(() => (window as unknown as { __mark?: number }).__mark), '箱が読み直された').toBe(1);
    await v.emulateMedia({ colorScheme: 'light' });

    // 24. 入出力のノート ── 素の <a download> → 確認バー →「PC へ保存」
    await openWhere('入出力のノート');
    const io = await frameIn('iframe.pkc-html-render');
    const bar = v.locator('#pkc-body [data-pkc-field="widget-io-bar"]');
    const downloads: string[] = [];
    v.on('download', (d) => downloads.push(d.suggestedFilename()));
    await io.locator('#dl').click();
    await expect(bar, '閲覧用 HTML で確認バーが出ない').toHaveCount(1, { timeout: 10_000 });
    await expect(bar).toContainText('「out.csv」');
    await v.waitForTimeout(500);
    expect(downloads, '押す前に保存された(ドライブバイ)').toEqual([]);
    await expect(bar.locator('[data-pkc-field="widget-io-attach"]'), '閲覧用 HTML に「このノートへ添付」が出た').toHaveCount(0);
    await expect(bar.locator('[data-pkc-field="widget-io-save"]')).toBeEnabled();
    const [got] = await Promise.all([v.waitForEvent('download'), clickReal(v, bar.locator('[data-pkc-field="widget-io-save"]'))]);
    expect(got.suggestedFilename()).toBe('out.csv');
    const file = join(dir, 'out.csv');
    await got.saveAs(file);
    expect(await readFile(file, 'utf8')).toBe('名前,値\nA,1\n');
    await expect(bar).toHaveCount(0);

    // 25. requestFile →「このノートの添付から選ぶ」(同じノートの添付だけ)
    await io.locator('#up').click();
    const pickNote = bar.locator('[data-pkc-field="widget-io-pick-note"]');
    await expect(pickNote, 'このノートの添付が候補に出ない').toBeVisible({ timeout: 10_000 });
    await expect(pickNote).toBeEnabled();
    await clickReal(v, pickNote);
    const items = bar.locator('[data-pkc-field="widget-io-note-asset"]');
    await expect(items).toHaveCount(1);
    await expect(bar.locator('.pkc-widget-io-item')).toContainText('memo.csv');
    await items.check();
    await clickReal(v, bar.locator('[data-pkc-field="widget-io-note-give"]'));
    await expect.poll(() => io.locator('#out').textContent(), { timeout: 10_000 }).toBe('memo.csv|x,y\n1,2\n');
    await expect(bar).toHaveCount(0);

    // 26. 確認バーを出したまま別のノートへ移る → 消える(箱へは答えが返る)
    await io.locator('#dl2').click();
    await expect(bar).toHaveCount(1, { timeout: 10_000 });
    await openWhere('添付ツールのノート');
    await expect(v.locator('[data-pkc-field="widget-io-bar"]'), '別のノートへ移っても確認バーが残った').toHaveCount(0);
    // 添付のウィジェット(asset: + id=)も箱になり、pkcWidget の id が届く
    const af = await frameIn('iframe[data-pkc-widget-frame]');
    await expect.poll(() => af.evaluate(() => (window as unknown as { pkcWidget?: { id: string } }).pkcWidget?.id ?? null), { timeout: 10_000 }).toBe('counter-tool');
    await expect(af.locator('#val')).toHaveText(/^\d+$/);
    expect(downloads, '余計なダウンロードが起きた').toEqual(['out.csv']);
    expect(errs, '閲覧用 HTML でエラーが出た').toEqual([]);
  } finally {
    await v.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 🔴 **配布パッケージ(`.pkc3-site.zip`、#2098 後半)** ── 上の道中で作った「表のノート」「入出力のノート(memo.csv 添付)」
 * 「添付ツールのノート(counter-tool.html)」を、アプリの書き出しの道(点検 → 書き出し → ダウンロード)から本物の zip にして中身を確かめる。
 * ⚠ 展開して `file://` で開く検証(複数タブ・ツール・確認バー・添付の読み込み)は PR の手元の実展開の確認で見る
 *   (`goto` は起動の数に入り、`blob:` の文書からは相対パスの `data/*.js` を読めない)。
 */
async function exportedSitePackage(page: Page): Promise<void> {
  await gotoCollectionPane(page);
  const dlWait = page.waitForEvent('download', { timeout: 30_000 });
  await clickExportMenuItem(page, 'export-site');
  // ⚠ 外へ渡す書き出しなので、閲覧用 HTML と同じ点検が出る ──「このまま書き出す」
  expect(await answerAppDialog(page, 'ok', { timeout: 15_000 })).toContain('書き出す前に');
  const dl = await dlWait;
  // 27. 名前は二重拡張子で、中身は既存の zip の読み手で開ける
  expect(dl.suggestedFilename(), '配布パッケージの名前になっていない').toMatch(/\.pkc3-site\.zip$/);
  const zip = new Blob([await readFile((await dl.path())!)]);
  const dir = await readZipDirectory(zip);
  const text = async (name: string): Promise<string> => {
    const e = dir.find((x) => x.name === name);
    expect(e, `zip に ${name} が無い`).toBeDefined();
    return (await readZipEntry(zip, e!)).text();
  };
  const names = dir.map((e) => e.name);
  const w: Record<string, unknown> = {};
  new Function('window', await text('manifest.js'))(w);
  const m = w['__PKC_SITE_MANIFEST__'] as {
    notes: { i: number; title: string }[];
    tools: { name: string; path: string; frameId: string }[];
    assets: { name: string; path: string; inline?: string }[];
  };
  const titles = m.notes.map((n) => n.title);
  for (const t of ['添付ツールのノート', '入出力のノート', 'counter-tool.html', 'memo.csv']) {
    expect(titles, `配布パッケージに「${t}」が無い`).toContain(t);
  }
  // ノートは 1 件 1 ファイル(目録の件数と同じだけ在る)
  expect(names.filter((n) => /^data\/note-\d+\.js$/.test(n)).length).toBe(m.notes.length);
  // HTML の添付はツールとして同梱(厳格な CSP・箱の名乗りが index.html の iframe と同じ字)
  const tool = m.tools.find((t) => t.name === 'counter-tool');
  expect(tool, 'counter-tool.html がツールとして入っていない').toBeDefined();
  const toolHtml = await text(tool!.path);
  expect(toolHtml).toContain(tool!.frameId);
  expect(toolHtml).toContain("connect-src 'none'");
  // 添付は生ファイル。ウィジェットの在るノートの memo.csv だけ data/asset-*.js も作る
  const memo = m.assets.find((a) => a.name === 'memo.csv');
  expect(memo, 'memo.csv が入っていない').toBeDefined();
  expect(await text(memo!.path)).toBe('x,y\n1,2\n');
  expect(memo!.inline, 'ウィジェットのノートの添付に data/asset-*.js が無い').toMatch(/^data\/asset-\d+\.js$/);
  expect(names).toContain(memo!.inline!);
  // シェルの箱は allow-scripts だけ
  const index = await text('index.html');
  expect(index).toContain("f.setAttribute('sandbox','allow-scripts')");
  expect(index).not.toMatch(/allow-same-origin|allow-downloads/);
}

/** 外部の script と通信を使う道具(⚠ 宛先は `page.route` で受ける偽の CDN / API ── 外のネットワークへは出ない)。 */
const CDN = 'https://cdn.pkc3-smoke.test';
const API = 'https://api.pkc3-smoke.test';
/**
 * ⚠ script は**少し遅らせて差し込む**(`<script src>` を本文に直に書かない)── 解析中に即座に出る要求は、
 *   別のプロセスで動く箱に playwright が付く前に出て `route` を素通りすることがある(実測: 許可後も偽の CDN に
 *   1 度も当たらず本物のネットワークへ出た。後から出る `fetch` は当たった)。CSP の判定は同じ `script-src`。
 */
const PERM_TOOL_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>perm</title></head><body>' +
  '<p id="st">init</p><p id="net">-</p>' +
  '<script>' +
  'setTimeout(function () {' +
  "var s = document.createElement('script');" +
  `s.src = '${CDN}/lib.js';` +
  "s.onload = function () { document.getElementById('st').textContent = window.__pkcLib === 'ok' ? 'loaded' : 'blocked'; };" +
  "s.onerror = function () { document.getElementById('st').textContent = 'blocked'; };" +
  'document.head.appendChild(s);' +
  `fetch('${API}/ping').then(function (r) { return r.text(); })` +
  ".then(function (t) { document.getElementById('net').textContent = t; })" +
  ".catch(function () { document.getElementById('net').textContent = 'fail'; });" +
  '}, 300);' +
  '</script></body></html>';

const permFrame = (page: Page): ReturnType<Page['locator']> =>
  page.locator('[data-pkc-field="detail-body"] [data-pkc-widget-asset] iframe.pkc-widget-frame');

async function permState(page: Page): Promise<{ st: string | null; net: string | null }> {
  const el = await permFrame(page).elementHandle();
  const f = el === null ? null : await el.contentFrame();
  if (f === null) return { st: null, net: null };
  return {
    st: await f.locator('#st').textContent().catch(() => null),
    net: await f.locator('#net').textContent().catch(() => null),
  };
}

async function widgetPermissions(page: Page): Promise<void> {
  /**
   * ⚠ **この段だけ service worker を外す**(起動は増やさない ── 再読み込み 1 回)。
   * 本体の SW の管理下では、箱(`srcdoc` は親の SW を引き継ぐ)から出る no-cors の `<script src>` の要求が
   * playwright の `route` を通らず本物のネットワークへ出る(実測: 許可後に `ERR_TUNNEL_CONNECTION_FAILED` ──
   * CSP は通したが偽の CDN に当たらない。`external-images.smoke.spec.ts` の #264 段② の注記と同じ制約)。
   * 🔑 `fetch` は SW 下でも `route` に当たったが、script も「実際に読めた」を見るため SW を外す。
   *   SW の有無は CSP の判定に関係しない(箱の CSP は `srcdoc` の meta が決める)。⚠ この関数は道中の最後に置く。
   */
  await page.route('**/sw.js', (route) => route.abort());
  await page.evaluate(async () => {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  });
  await page.reload();
  await bootedHere(page);
  expect(await page.evaluate(() => navigator.serviceWorker.controller), 'SW が外れていない').toBeNull();

  const hits: string[] = [];
  await page.context().route(`${CDN}/**`, (route) => {
    hits.push('cdn');
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: "window.__pkcLib = 'ok';" });
  });
  await page.context().route(`${API}/**`, (route) => {
    hits.push('api');
    return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'pong' });
  });

  // 14. 道具を添付して、記法を本文へ貼る(⚠ 前のノートと同じ道 ── 記法は添付の画面の字を使う)
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('権限のノート');
  await page.locator('[data-pkc-field="editor-body"]').fill('メモ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await writesLanded(page);
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'perm-tool.html',
    mimeType: 'text/html',
    buffer: Buffer.from(PERM_TOOL_HTML, 'utf8'),
  });
  await expect(page.locator('[data-pkc-region="sidebar"] [data-pkc-action="select-entry"]').filter({ hasText: 'perm-tool.html' })).toHaveCount(1, { timeout: 15_000 });
  await writesLanded(page);
  await openByTitle(page, 'perm-tool.html');
  const fence = (await page.locator('[data-pkc-field="copy-widget-fence"]').getAttribute('data-pkc-asset-ref')) ?? '';
  expect(fence).toMatch(/^```html asset:ast-[0-9a-f]{64} id="perm-tool"\n```$/);
  const assetKey = /asset:(ast-[0-9a-f]{64})/.exec(fence)![1]!;
  await openByTitle(page, '権限のノート');
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await page.locator('[data-pkc-field="editor-body"]').fill(`権限の道具\n\n${fence}\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await writesLanded(page);

  const box = page.locator('[data-pkc-field="detail-body"] [data-pkc-widget-asset]');
  await expect(permFrame(page)).toHaveCount(1, { timeout: 15_000 });
  expect(await permFrame(page).getAttribute('sandbox')).toBe('allow-scripts');
  // 🔴 既定は止まる(script は読めず、通信は失敗)── 偽の CDN / API へ 1 度も届かない
  await expect.poll(() => permState(page), { timeout: 10_000 }).toEqual({ st: 'blocked', net: 'fail' });
  expect(hits, '既定で外へ出た').toEqual([]);
  const notice = box.locator('[data-pkc-field="widget-perm-notice"]');
  await expect(notice, '止めた案内帯が出ない').toBeVisible({ timeout: 10_000 });
  await expect(notice).toContainText('外部スクリプトの読み込み');
  await expect(notice).toContainText('外部への通信');
  const permBtn = box.locator('[data-pkc-field="widget-permissions"]');
  await expect(permBtn).toHaveText('権限');

  // 15. 「権限を開く」→ 2 つとも許可
  await clickReal(page, notice.locator('[data-pkc-field="widget-perm-notice-open"]'));
  const dialog = page.locator('[data-pkc-region="app-dialog"][open]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('サンドボックス隔離は維持され');
  await dialog.locator('input[data-pkc-check-id="external-scripts"]').check();
  await dialog.locator('input[data-pkc-check-id="network"]').check();
  await clickReal(page, '[data-pkc-field="dialog-ok"]');
  await expect.poll(() => permState(page), { timeout: 15_000 }).toEqual({ st: 'loaded', net: 'pong' });
  expect(await permFrame(page).getAttribute('sandbox'), '権限で sandbox が緩んだ').toBe('allow-scripts');
  await expect(notice, '許可して置き直しても案内帯が残る').toHaveCount(0);
  await expect(permBtn).toHaveText('権限 (2)');
  expect(hits).toContain('cdn');
  expect(hits).toContain('api');
  // 許可はこの端末の localStorage だけ(内容ハッシュの鍵)
  expect(
    await page.evaluate(() => localStorage.getItem('pkc3.widget-grants.network')),
  ).toBe(JSON.stringify([assetKey]));

  // 16. システムの「許可」から取り消す
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const region = page.locator('[data-pkc-region="settings-widget-permissions"]');
  const row = region.locator(`li[data-pkc-asset-key="${assetKey}"]`);
  await expect(row, '設定の一覧に出ない').toHaveCount(1, { timeout: 15_000 });
  await expect(row.locator('[data-pkc-field="widget-permission-badge"]')).toHaveText(['外部スクリプト・スタイルの読み込み', '外部への通信']);
  await clickReal(page, row.locator('[data-pkc-action="revoke-widget-permission"]'));
  await expect(row, '押しても一覧から消えない').toHaveCount(0, { timeout: 15_000 });
  await expect(region.locator('[data-pkc-field="widget-permissions-list"]')).toContainText('まだ追加権限を許可したウィジェットはありません');
  // ノートへ戻ると、再び止まる(双方向の往復が実ブラウザで完結する)
  // 一覧からノートを開き直す(⚠ 設定画面に「詳細へ戻る」の押し所は無い ── ノートを選べば読む画面へ戻る)
  await openByTitle(page, '権限のノート');
  hits.length = 0;
  await expect.poll(() => permState(page), { timeout: 15_000 }).toEqual({ st: 'blocked', net: 'fail' });
  expect(hits, '取り消した後も外へ出た').toEqual([]);
  await expect(permBtn).toHaveText('権限');
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await page.context().unroute(`${CDN}/**`);
  await page.context().unroute(`${API}/**`);
  await page.unroute('**/sw.js');
}
