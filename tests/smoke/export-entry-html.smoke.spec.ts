/**
 * 🔴 **1 ノートを「相手に渡せる 1 枚」で書き出す**(#491)。
 *
 * > user 報告 2026-08-27:「右クリックで気づきましたが、
 * > **書き出しに閲覧配布用HTMLがないのは残念**ですね」
 *
 * ⚠ 在ったのは**設定 → 書き出しと片づけ**の「閲覧用 HTML」だけで、それは
 *   **コレクション全部**を 1 枚にする物だった ── ノート 1 件を渡す口は
 *   **どこにも無かった**。
 *
 * 🔑 観測点は**落ちてきた file の中身**にする ── 「ダウンロードが始まった」だけを
 *   見ると、0 バイトでも空の HTML でも通る(`docx-export` と同じ作法)。
 * 🔴 **対照群を同じ test に置く** ── 隣の `書き出す`(`.pkc3.zip`)と**別の物**で
 *   あることを見る。置かないと「HTML の押し口が `.pkc3.zip` を落としている」
 *   (= 押した人にしか見えない取り違え)が緑のまま通る。
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  gotoApp,
  clickReal,
  createEntry,
  collectPageErrors,
  useSplitEditor,
  useListBrowse,
} from './helpers';

test.beforeEach(async ({ page }) => {
  // ⚠ 行の在り処と編集の道具は `context-menu.smoke.spec.ts` と同じにする
  //    (2 つ目の作法を作らない)
  await useListBrowse(page);
  await useSplitEditor(page);
});

/** ⚠ 2 件作る ── 1 件だけだと「全部書き出した」と見分けがつかない(空振り防止)。 */
const OTHER_TITLE = '渡さないほうのノート';
const OTHER_BODY = 'これは相手に渡らないはずの本文である。';

test('🔴 情報ペインの「閲覧用 HTML」で、そのノートだけの 1 枚が落ちてくる (#491)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ── 対照群になるノート(こちらは書き出さない)
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', OTHER_TITLE);
  await page.fill('[data-pkc-field="editor-body"]', OTHER_BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  // ── 渡すノート
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '配る資料');
  await page.fill(
    '[data-pkc-field="editor-body"]',
    ['# 配る見出し', '', 'ふつうの段落と **太字**。', '', '- 箇条書き'].join('\n'),
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickReal(page, '[data-pkc-region="inspector"] [data-pkc-action="export-entry-html"]'),
  ]);
  const path = await download.path();
  expect(path, 'file が落ちてきていない').not.toBeNull();
  const text = readFileSync(path!, 'utf-8');

  /**
   * 🔴 **`.pkc3.zip` ではないこと** ── 隣の `書き出す` と押し口を取り違えていない。
   * ⚠ zip は先頭 2 バイトが `PK` である。
   */
  expect(text.slice(0, 2), 'zip が落ちてきた(押し口を取り違えている)').not.toBe('PK');
  expect(text.slice(0, 200).toLowerCase(), 'HTML ではない').toContain('<!doctype html');
  expect(text.length, '空の HTML が落ちてきた').toBeGreaterThan(1000);

  // ── そのノートが入っている
  expect(text, '題名が入っていない').toContain('配る資料');
  expect(text, '見出しが入っていない').toContain('配る見出し');
  expect(text, '本文が入っていない').toContain('ふつうの段落と');

  /**
   * 🔴 **1 件だけであること**(#491 の「このノートを渡す」)。
   * ⚠ ここが無いと、`singleEntrySource` を通さずコレクション全部を出す実装でも
   *   上の assert は全部通る ── **絞り込みが効いていること**は別に見る。
   */
  expect(text, '渡さないはずのノートが入っている').not.toContain(OTHER_TITLE);
  expect(text, '渡さないはずの本文が入っている').not.toContain(OTHER_BODY);

  expect(errors, 'pageerror が出た').toEqual([]);
});

/**
 * 🔴 **右クリックからも出る**(#491)── user が気づいたのはこの経路である。
 *
 * ⚠ 字は `features/entry-actions.ts` が 1 か所で持つので、情報ペインと
 *   右クリックで**別の呼び名**になることはない ── ここで見るのは
 *   「**その口が右クリックにも並んでいる**」ことだけである。
 */
test('🔴 右クリックのメニューにも「閲覧用 HTML」が並ぶ (#491)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.fill('[data-pkc-field="editor-title"]', '配る資料');
  await page.fill('[data-pkc-field="editor-body"]', '本文。');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');

  const row = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').first();
  await expect(row, '行が出ていない').toBeVisible();
  await row.click({ button: 'right' });
  const item = page.locator(
    '[data-pkc-region="context-menu"] [data-pkc-action="export-entry-html"]',
  );
  await expect(item, '右クリックに「閲覧用 HTML」が無い').toBeVisible();
  // ⚠ **対照群** ── 隣の「書き出す」も並んでいる(メニューそのものが出ている証拠)
  await expect(
    page.locator('[data-pkc-region="context-menu"] [data-pkc-action="export-entry"]'),
    'メニューが出ていない(空振り)',
  ).toBeVisible();
  expect(await item.textContent(), '呼び名が字の正本と違う').toContain('閲覧用 HTML');

  expect(errors, 'pageerror が出た').toEqual([]);
});
