/**
 * 🔴 **file の型は「含まれる型の積」── 実ブラウザで、末尾が本当に付くか**(#1017 段④b)。
 *
 * ⚠ ここで見るのは **unit では届かない層だけ**:
 * 1. **本物の `<a download>` から、本物の末尾が落ちるか**(unit は `deps.download`
 *   を差し替えて見ているので、実際の `downloadBlob` 経路(`URL.createObjectURL` +
 *   `<a>` クリック)は 1 度も通っていない)
 * 2. **左下のバックアップと、右の情報ペインのバックアップ(このノート)が
 *   同じアプリの中で別の末尾を落とすこと**(押し口の取り違えを実物で見る)
 *
 * ⚠ **保存領域に問題があるときの自動フォールバック(`.pkc3-part.zip`)は
 *   ここで作らない** ── 壊れた DB を実ブラウザで作るのはコストが高く、
 *   `tests/adapter/export-archive.test.ts` が unit で `looksCorrupt` の分岐を
 *   決定的に確かめている(層をまたいで同じことを 2 度見ない)。
 *
 * 🔑 **ファイル名は `suggestedFilename()` で見る**。この spec のノートは
 *   ASCII だけの題名にする ── headless Chromium は非 ASCII の `<a download>`
 *   名を丸ごと `"download"` に捨てる(CLAUDE.md §4)ので、和名では観測点として
 *   使えない。
 */
import { test, expect } from '@playwright/test';
import {
  clickReal,
  collectPageErrors,
  createEntry,
  gotoApp,
  useSplitEditor,
} from './helpers';

// ⚠ `editor-body`(欄で編集)は既定の live 編集では出ない ── split へ切り替える
// (`useSplitEditor` は `page.goto` の前に効かせる必要があるので `gotoApp` の前に呼ぶ)
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

test('🔴 左下の「バックアップ」は .pkc3-full.zip、情報ペインの「バックアップ(このノート)」は .pkc3-notes.zip (#1017 段④b)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', 'Report');
  await page.fill('[data-pkc-field="editor-body"]', '本文。');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  // ① 左下の「バックアップ」(コレクション全体) → .pkc3-full.zip
  const [full] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickReal(page, '[data-pkc-region="collection-bar"] [data-pkc-action="export-archive"]'),
  ]);
  expect(full.suggestedFilename(), '左下のバックアップの末尾が .pkc3-full.zip ではない').toMatch(
    /\.pkc3-full\.zip$/,
  );

  // ② 情報ペインの「バックアップ(このノート)」 → .pkc3-notes.zip
  //   ⚠ **①と別の末尾であること**が本題(取り違えの検出)── ここが無いと、
  //   両方のボタンが同じ末尾を落としていても①だけで緑になる
  const [notes] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickReal(page, '[data-pkc-region="inspector"] [data-pkc-action="export-entry"]'),
  ]);
  expect(
    notes.suggestedFilename(),
    '情報ペインのバックアップ(このノート)の末尾が .pkc3-notes.zip ではない',
  ).toMatch(/\.pkc3-notes\.zip$/);
  // ⚠ 対照群 ── ①と②は取り違えていない(同じ末尾になっていない)
  expect(notes.suggestedFilename(), '①と②が同じ末尾を落としている(押し口の取り違え)').not.toBe(
    full.suggestedFilename(),
  );

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
