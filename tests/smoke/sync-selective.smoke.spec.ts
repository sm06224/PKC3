import { test, expect, type Page } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp, openExportMenu } from './helpers';
import { readDiffZip, type DiffFile } from '../../src/features/sync/diff-file';
import { SELECTIVE_EMPTY_TEXT } from '../../src/features/sync/selective-view';

/**
 * 🔴 **選択同期(#2066 段 5-B)── 実ブラウザで、設定 → 右クリック → 一覧の印・情報ペイン → 差分ファイル → 全体へ戻す**。
 *
 * 観測点:
 * - 設定の「同期の範囲」の押した状態・件数の要約(画面の字)
 * - 一覧の行の `data-pkc-sync-scope` と印(DB → 写し → 描画まで通った後)
 * - 書き出した差分ファイルの中身(`readDiffZip` で読む ── zip の圧縮に左右されない)
 * 対照群: 選ぶ前・全体へ戻した後に印が 0 件であること、私的なメモに印が付かないこと。
 */
const ROW = '[data-pkc-region="filer-table"] tbody tr';
const SEG = '[data-pkc-region="filer-breadcrumb"] [data-pkc-field="crumb-seg"]';
const MENU = '[data-pkc-region="context-menu"]';

async function titled(page: Page, kind: 'folder' | 'text', title: string): Promise<void> {
  await createEntry(page, kind);
  const t = page.locator('[data-pkc-field="editor-title"]');
  if (await t.count()) await t.fill(title);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator(ROW, { hasText: title }).first()).toBeVisible();
}

const row = (page: Page, title: string) => page.locator(ROW, { hasText: title }).first();
const scopeOf = (page: Page, title: string) => row(page, title).getAttribute('data-pkc-sync-scope');

async function rightClickRow(page: Page, title: string, action: string): Promise<void> {
  const b = await row(page, title).boundingBox();
  if (b === null) throw new Error(`一覧に「${title}」の行が見えない`);
  await page.mouse.click(b.x + 20, b.y + b.height / 2, { button: 'right' });
  await expect(page.locator(MENU)).toBeVisible();
  await clickReal(page, `${MENU} [data-pkc-action="${action}"]`);
}

async function exportDiff(page: Page): Promise<DiffFile> {
  // 何も選んでいない右の列の「書き出す ▾」(コレクション)から
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-pkc-region="inspector"] [data-pkc-action="open-collection-export-menu"]')).toBeVisible();
  const menu = await openExportMenu(page, 'collection');
  await expect(menu.locator('[data-pkc-action="export-sync-diff-all"]')).toBeVisible();
  const dl = page.waitForEvent('download');
  await clickReal(page, `${MENU} [data-pkc-action="export-sync-diff-all"]`);
  const file = await dl;
  const chunks: Buffer[] = [];
  for await (const c of await file.createReadStream()) chunks.push(Buffer.from(c));
  return readDiffZip(new Blob([Buffer.concat(chunks)]));
}

test('🔴 選択同期: フォルダを同期対象にすると配下だけが印と差分に入り、外しても削除の記録は出ず、全体へ戻すと画面から消える (#2066 段 5-B)', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(() => localStorage.setItem('pkc3.sync', '1'));
  const page = await ctx.newPage();
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ── 台: 共有フォルダ(中に共有メモ)と、フォルダの外の私的なメモ
  await titled(page, 'folder', '共有フォルダ');
  await row(page, '共有フォルダ').dblclick();
  await expect(page.locator(SEG).last()).toHaveText('共有フォルダ');
  await titled(page, 'text', '共有メモ');
  await clickReal(page, `${SEG}:not([aria-current])`);
  await titled(page, 'text', '私的なメモ');

  // ── ① 設定: 同期がオンなので「同期の範囲」が出る。選択同期へ切り替え、関連の範囲を切り替える
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const sec = page.locator('[data-pkc-region="settings-sync-selective"]');
  await expect(sec).toBeVisible();
  await expect(sec.locator('[data-pkc-field="sync-selective-detail"]'), '全体のときに詳細が出た').toBeHidden();
  for (const t of ['共有フォルダ', '私的なメモ']) expect(await scopeOf(page, t), `選ぶ前に ${t} に印`).toBeNull();
  await clickReal(page, '[data-pkc-sync-scope-mode="selective"]');
  await expect(sec.locator('[data-pkc-field="sync-selective-detail"]')).toBeVisible();
  await expect(sec.locator('[data-pkc-field="sync-selective-summary"]')).toHaveText(SELECTIVE_EMPTY_TEXT);
  await expect(sec.locator('[data-pkc-sync-scope-related="1hop"]')).toHaveAttribute('aria-pressed', 'true');
  await clickReal(page, '[data-pkc-sync-scope-related="recursive"]');
  await expect(sec.locator('[data-pkc-sync-scope-related="recursive"]')).toHaveAttribute('aria-pressed', 'true');
  await clickReal(page, '[data-pkc-sync-scope-related="1hop"]');
  await expect(sec.locator('[data-pkc-sync-scope-related="1hop"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(sec.locator('[data-pkc-action="clear-sync-selection"]'), '0 件なのに一括解除が押せる').toBeDisabled();

  // ── ② フォルダを右クリックで同期対象にする → フォルダは直接指定、私的なメモは対象外
  await rightClickRow(page, '共有フォルダ', 'sync-select-entry');
  await expect(row(page, '共有フォルダ')).toHaveAttribute('data-pkc-sync-scope', 'direct');
  await expect(row(page, '共有フォルダ').locator('[data-pkc-field="sync-scope-mark"]')).toBeVisible();
  expect(await scopeOf(page, '私的なメモ'), '私的なメモに印が付いた').toBeNull();
  await expect(row(page, '私的なメモ').locator('[data-pkc-field="sync-scope-mark"]')).toHaveCount(0);
  // 行を押すと中央はノートに替わる ── 設定を開き直して要約を見る
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(sec.locator('[data-pkc-field="sync-selective-summary"]')).toHaveText('同期対象: 合計 2 件(直接指定 1 / フォルダ配下 1 / 関連 0 / 親フォルダ 0)');
  await expect(sec.locator('[data-pkc-action="clear-sync-selection"]')).toBeEnabled();
  // 配下のメモ(フォルダの中へ入って見る)と情報ペイン
  await row(page, '共有フォルダ').dblclick();
  await expect(row(page, '共有メモ')).toHaveAttribute('data-pkc-sync-scope', 'descendant');
  await clickReal(page, `${ROW}:has-text("共有メモ")`);
  const insp = page.locator('[data-pkc-region="inspector"] [data-pkc-field="inspector-sync-scope"]');
  await expect(insp.locator('[data-pkc-field="inspector-sync-scope-status"]')).toHaveText('同期対象(親フォルダ配下)');
  await expect(insp.locator('[data-pkc-field="inspector-sync-scope-via"]')).toHaveText('親フォルダ「共有フォルダ」が同期対象のため含まれます');
  await clickReal(page, `${SEG}:not([aria-current])`);
  await clickReal(page, `${ROW}:has-text("私的なメモ")`);
  await expect(insp.locator('[data-pkc-field="inspector-sync-scope-status"]')).toHaveText('同期対象外(この端末のみ)');

  // ── ③ 差分ファイル: 私的なメモは入らない(選択同期は version 3)
  const first = await exportDiff(page);
  const titles = first.container.notes.map((n) => n.title).sort();
  expect(titles, '同期対象のノートが入らない / 私的なメモが入った').toEqual(['共有フォルダ', '共有メモ']);
  expect(first.manifest.version).toBe(3);
  // 外しても削除の記録は出ない(本当に消したノートだけが伝わる)
  await rightClickRow(page, '共有フォルダ', 'sync-unselect-entry');
  await expect(row(page, '共有フォルダ')).not.toHaveAttribute('data-pkc-sync-scope', /.+/);
  const second = await exportDiff(page);
  expect(second.container.tombstones, '同期対象から外しただけなのに削除の記録が出た').toEqual([]);
  expect(second.container.notes.map((n) => n.title)).toEqual([]);

  // ── ④ もう一度付けてから「コレクション全体」へ戻すと、印・情報ペインの欄・メニュー項目がすべて消える
  await rightClickRow(page, '共有フォルダ', 'sync-select-entry');
  await expect(row(page, '共有フォルダ')).toHaveAttribute('data-pkc-sync-scope', 'direct');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await clickReal(page, '[data-pkc-sync-scope-mode="all"]');
  await expect(sec.locator('[data-pkc-field="sync-selective-detail"]')).toBeHidden();
  await expect(page.locator(`${ROW}[data-pkc-sync-scope]`), '全体へ戻したのに印が残った').toHaveCount(0);
  await expect(page.locator('[data-pkc-field="sync-scope-mark"]')).toHaveCount(0);
  await clickReal(page, `${ROW}:has-text("共有フォルダ")`);
  await expect(page.locator('[data-pkc-region="inspector"] [data-pkc-field="inspector-sync-scope"]')).toBeHidden();
  const b = await row(page, '共有フォルダ').boundingBox();
  if (b === null) throw new Error('行が見えない');
  await page.mouse.click(b.x + 20, b.y + b.height / 2, { button: 'right' });
  await expect(page.locator(MENU)).toBeVisible();
  await expect(page.locator(`${MENU} [data-pkc-action="sync-select-entry"]`)).toHaveCount(0);
  await expect(page.locator(`${MENU} [data-pkc-action="sync-unselect-entry"]`)).toHaveCount(0);
  await page.keyboard.press('Escape');

  // ── 同期をオフにすると「同期の範囲」は見出しごと隠れる(確認: オフにする → 同期の記録は残す)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(sec).toBeVisible();
  // 選択同期へ戻すと、直接指定(共有フォルダ)の印がまた出る ── この状態から同期をオフにする
  await clickReal(page, '[data-pkc-sync-scope-mode="selective"]');
  await expect(row(page, '共有フォルダ')).toHaveAttribute('data-pkc-sync-scope', 'direct');
  await clickReal(page, '[data-pkc-field="sync-enabled"]');
  await clickReal(page, '[data-pkc-field="dialog-ok"]');
  await expect(page.locator('[data-pkc-region="app-dialog"]')).toBeVisible();
  await clickReal(page, '[data-pkc-field="dialog-cancel"]');
  await expect(sec).toBeHidden();
  await expect(page.locator('[data-pkc-field="sync-selective-term"]')).toBeHidden();
  await expect(page.locator(`${ROW}[data-pkc-sync-scope]`), '同期をオフにしたのに印が残った').toHaveCount(0);
  await expect(page.locator('[data-pkc-field="sync-scope-mark"]')).toHaveCount(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
  await ctx.close();
});
