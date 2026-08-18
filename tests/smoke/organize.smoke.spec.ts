import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 整理の面(#240 段①〜⑤。user 指示 2026-08-17
 * 「フォルダ表示メインに / ダブルクリックで開く / 複数選択・範囲選択・D&D /
 * まとめて消せない」)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * 1. **実マウスの 2 クリック** ── happy-dom の合成 `dblclick` は「本当に 2 回押した」
 *    ことを保証しない(1 クリック目の副作用と順序が実機と違いうる)
 * 2. **実 HTML5 ドラッグ&ドロップ** ── happy-dom に `DataTransfer` が無いので、
 *    unit は掴む・落とすを 1 度も通れない
 * 3. **最初に出る面**(既定がフォルダになったこと)を、実際の起動で見る
 */

/** 実マウスで 2 回押す(⚠ `dispatchEvent` ではなく本物の click 列)。 */
async function doubleClickReal(page: Page, selector: string): Promise<void> {
  /**
   * ⚠ **`locator.dblclick()` を使う**(`page.mouse.dblclick` ではなく)。
   * 座標を先に採る書き方は、**採ってから押すまでの間に表が組み直されると**
   * 2 回のクリックが別のノードに落ちて `dblclick` が出ない
   * (再描画で node が差し替わるのは正常 ── `helpers.ts` の `withRerenderRetry` と同じ話)。
   * locator 側は「安定するまで待ってから押す」ので、その窓が消える。
   */
  await page.locator(selector).first().dblclick();
}

async function makeFolder(page: Page, title: string): Promise<void> {
  await createEntry(page, 'folder');
  const t = page.locator('[data-pkc-field="editor-title"]');
  if (await t.count()) await t.fill(title);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
}

test('🔴 最初はフォルダの面で開き、2 クリックで中へ入る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ① 既定はフォルダ(user 指示 2026-08-17)── タブと中身が一致していること
  await expect(page.locator('[data-pkc-browse="filer"][data-pkc-active]')).toHaveCount(1);
  await expect(page.locator('[data-pkc-region="filer-table"]')).toBeVisible();

  await makeFolder(page, 'はこ');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await expect(rows).toHaveCount(2);

  // ② 🔴 1 クリックでは**入らない**(選ぶだけ)── 逆向きだけ見ると、
  //    「1 クリックでも入る」実装が素通りする(doc §5 の注意)
  const folderRow = '[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="folder"]';
  const noteRow = '[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="text"]';
  await clickReal(page, folderRow);
  await expect(rows, '1 クリックで入ってしまった').toHaveCount(2);

  /**
   * ③ 2 クリックで入る。
   * ⚠ **間に別の行を押して「連続」を切る** ── 押さないと、②の 1 クリックと
   *   ③の 1 打目が**続けて押した 2 回**に数えられる(閾値 500ms)。実 user も
   *   同じで、それは仕様どおりだが、ここで見たいのは「2 打で入る」ことである。
   */
  await clickReal(page, noteRow);
  await doubleClickReal(page, folderRow);
  await expect(page.locator('[data-pkc-region="filer-breadcrumb"]')).toContainText('はこ');
  await expect(rows, 'フォルダに入れていない').toHaveCount(0);

  // ④ パンくずのルートで戻る(⚠ 開いているノートは閉じない)
  await clickReal(page, '[data-pkc-region="filer-breadcrumb"] button');
  await expect(rows).toHaveCount(2);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 まとめて選んで、まとめてゴミ箱へ入る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  for (let i = 0; i < 3; i += 1) {
    await createEntry(page, 'text');
    await clickReal(page, '[data-pkc-action="commit-edit"]');
  }
  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await expect(rows).toHaveCount(3);

  // ① 実キーの修飾つきクリックで印が増える
  await rows.nth(0).click();
  await rows.nth(2).click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('[data-pkc-region="filer-table"] tbody tr[data-pkc-marked]')).toHaveCount(
    2,
  );
  // ② 2 件以上で帯が出る
  const bulk = page.locator('[data-pkc-field="filer-bulk"]');
  await expect(bulk).toBeVisible();
  await expect(bulk).toContainText('2 件');

  /**
   * ③ 範囲選択(Shift)は**見えている並び**で採る ── 起点は最後に押した行。
   * ⚠ **どの行に印が付いたか**で見る(件数だけ見ると、範囲選択が完全な no-op でも
   *   前後とも 2 件のまま通る ── 着地前レビューの指摘)。
   */
  await rows.nth(1).click({ modifiers: ['Shift'] });
  const marked = page.locator('[data-pkc-region="filer-table"] tbody tr[data-pkc-marked]');
  await expect(marked).toHaveCount(2);
  // 起点 = 3 行目(直前に Ctrl で押した)→ 2 行目まで = 2 件目と 3 件目
  await expect(marked.first()).toHaveAttribute('data-pkc-archetype', 'text');
  await expect(
    rows.nth(0),
    '範囲の外(1 行目)にまで印が残っている',
  ).not.toHaveAttribute('data-pkc-marked', '');

  /**
   * ④ まとめてゴミ箱へ。
   * ⚠ **`confirm` は自分で受ける** ── playwright の既定は**却下**なので、
   *   受けないと「押したのに何も起きない」を**製品の不具合と読み違える**
   *   (1 稿目で実際にそう読みかけた)。`boot-edit.smoke.spec.ts` と同じ作法。
   */
  const asked = new Promise<string>((resolve) => {
    page.once('dialog', (d) => {
      resolve(d.message());
      void d.accept();
    });
  });
  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: ['ControlOrMeta'] });
  await clickReal(page, '[data-pkc-action="delete-selected"]');
  // ⚠ 件数を**確認の文言でも**見る(1 件ずつ n 回聞く実装に戻ったら落ちる)
  expect(await asked, '確認が件数で聞いていない').toContain('2 件');
  await expect(rows, 'まとめて消えていない').toHaveCount(1);

  // ⑤ 🔴 **戻せる**(ゴミ箱へ入っただけ)
  await clickReal(page, '[data-pkc-action="show-trash"]');
  await expect(page.locator('[data-pkc-region="filer-trash"]')).toContainText('件');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 掴んでフォルダに落とすと入り、パンくずに落とすと出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeFolder(page, 'はこ');
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await expect(rows).toHaveCount(2);
  const folderRow = '[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="folder"]';
  const noteRow = '[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="text"]';

  // ① 掴んでフォルダへ落とす ── **実 HTML5 D&D**(unit は DataTransfer を持てない)
  await page.dragAndDrop(noteRow, folderRow);
  // 落とした先へ付いていく(`move-entry` と同じ規則)── 中に 1 件
  await expect(page.locator('[data-pkc-region="filer-breadcrumb"]')).toContainText('はこ');
  await expect(rows, 'フォルダへ入っていない').toHaveCount(1);

  // ② パンくず(ルート)へ落として出す
  await page.dragAndDrop(noteRow, '[data-pkc-region="filer-breadcrumb"] button');
  await expect(rows, 'ルートへ出せていない').toHaveCount(2);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
