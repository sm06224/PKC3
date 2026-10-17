/**
 * 🔴 **参照元が実ブラウザで出て、押すと移れる**(#348、user 裁定 2026-08-23)。
 *
 * ⚠ unit は state の畳み方と器の組み方を見る。**ここが見るのは通し**である ──
 * 本文にリンクを書いて保存 → 相手を選ぶ → **worker が実際に引いてきて**、
 * 押すと移れるか。⚠ worker(sqlite)を通るのは実ブラウザだけである。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, modClickReal, collectPageErrors, createEntry, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

test('🔴 本文のリンクが「参照元」に出て、押すと移れる', async ({ page }) => {
  /**
   * 🔴 **例外を 1 度も見ていなかった**(#713、2026-09-05)。⚠ ここは worker(sqlite)を
   *   通す唯一の通し検査なのに、**その worker が投げても緑**だった ── 参照元が
   *   出てさえいれば通るので、裏で落ちた Promise は 1 つも記録されない。
   */
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ① 的になるノート
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  await ta.fill('的になるノート\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  /**
   * ⚠ **一覧の region へ絞って lid を採る**(CLAUDE.md §1)── `[data-pkc-entry]` を
   *   document 全体で数えると、情報ペインのボタンに満たされる(nightly を 13 晩
   *   赤にした形)。⚠ 既定の探し方は**ファイラ**なので、行が在るのは
   *   `filer-table` である(`entry-list` の region は在るが空 ── 実測)。
   */
  const lid = await page.evaluate(
    () =>
      document
        .querySelector('[data-pkc-region="filer-table"]')
        ?.querySelector('[data-pkc-entry]')
        ?.getAttribute('data-pkc-entry') ?? null,
  );
  expect(lid, '前提: 的の lid が取れない(この test は何も測っていない)').not.toBeNull();

  // ② 参照する側
  await createEntry(page, 'text');
  const ta2 = page.locator('[data-pkc-field="editor-body"]');
  await ta2.click();
  await ta2.fill(`ここから [的](entry:${lid}) を参照する\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ③ 的を選び直すと、参照元が出る
  await clickReal(page, `[data-pkc-entry="${lid}"]`);
  const box = page.locator('[data-pkc-field="inspector-backlinks"]');
  await expect(box, '参照元の行が無い').toBeVisible();
  const link = box.locator('[data-pkc-field="inspector-backlink"]');
  await expect(link, '参照元が出ていない(worker から届いていない)').toHaveCount(1);

  // ④ 押すと移れる(辿れないと、一覧しても行き止まり)
  await link.click();
  await expect(
    page.locator('[data-pkc-field="detail-body"]'),
    '押しても移れない',
  ).toContainText('参照する');

  /**
   * 🔴 **選んだまま、参照元の名前を変える / ゴミ箱へ移すと、「参照元」が追従する**(#1087)。
   *
   * ⚠ 上の道中の続きに載せる(新しく起動しない)。直す前は選択が動いたときしか引かなかったので、
   *   的を選んだまま参照元を改名しても、ゴミ箱へ移しても、情報ペインの「参照元」は古いまま残った。
   * 🔑 的(B)を選び直してから、**Ctrl+クリックで A の行に印だけ付けて**操作する(右クリック・普通のクリックは選択が A へ動くので使えない)。
   */
  await clickReal(page, `[data-pkc-entry="${lid}"]`);
  await expect(link, '前提: 的を選び直しても参照元が出ない').toHaveCount(1);
  const lidA = await link.getAttribute('data-pkc-entry');
  expect(lidA, '前提: 参照元の lid が取れない').not.toBeNull();
  const rowA = page.locator(`[data-pkc-region="filer-table"] [data-pkc-entry="${lidA}"]`);
  await expect(rowA, '前提: 参照元の行が一覧に無い').toHaveCount(1);

  /**
   * 🔴 **コードの囲み(```)の中に書いた `entry:<lid>` は、参照元に数えない**(#1087)。
   * ⚠ 上の道中の続きに載せる(新しく起動しない)。
   */
  await createEntry(page, 'text');
  const taC = page.locator('[data-pkc-field="editor-body"]');
  await taC.click();
  await taC.fill('書き方の例\n```\n[的](entry:' + lid + ')\n```\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, `[data-pkc-entry="${lid}"]`);
  await expect(link, '前提: 的を選び直しても参照元が出ない').toHaveCount(1);
  await expect(
    box.locator('[data-pkc-field="inspector-backlink"]'),
    'コードの囲みの中の entry: が参照元に出ている',
  ).toHaveCount(1);
  await expect(box, 'コードの囲みだけのノートが参照元に出ている').not.toContainText('書き方の例');

  // ① 改名 ── 的を選んだまま、参照元の行の名前が新しくなる
  //    (Ctrl+クリックは印だけ付けて選択を動かさない。F2 は印の付いた行の名前を打ち替える)
  await modClickReal(page, rowA);
  await page.keyboard.press('F2');
  const input = page.locator('[data-pkc-field="row-rename"]');
  await expect(input, '名前を変える欄が出ない').toBeVisible();
  await input.fill('改名後の参照元');
  await input.press('Enter');
  await expect(
    box.locator('[data-pkc-field="inspector-backlink"]'),
    '改名したのに「参照元」の名前が古いまま',
  ).toHaveText('改名後の参照元');
  await expect(
    page.locator('[data-pkc-region="inspector"]'),
    '前提: 的の選択が動いている(この検査は選択が動かない所を測る)',
  ).not.toContainText('改名後の参照元種類');

  // ② ゴミ箱 ── 的を選んだまま参照元を捨てると、「参照元」から消える
  await clickReal(page, '[data-pkc-action="delete-selected"]');
  await expect(
    box.locator('[data-pkc-field="inspector-backlink"]'),
    'ゴミ箱へ移したのに「参照元」に残っている',
  ).toHaveCount(0);

  /**
   * 🔴 **改名すると、ほかのノートの「題名と同じ字のリンク」も新しい題名になる**(#1648)/
   *    **消えたノートへのリンクの知らせに「ゴミ箱を開く」が付く**(#1648)/ 押すとゴミ箱が開く。
   * ⚠ 上の道中の続きに載せる(新しく起動しない)。直前の「ゴミ箱へ移す」で的は捨てられているので、
   *   新しい的(T)を作って「旧題」→「新題」と改名する。
   */
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('改名される的\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const lidT = await page
    .locator('[data-pkc-region="filer-table"] [data-pkc-entry]')
    .first()
    .getAttribute('data-pkc-entry');
  expect(lidT, '前提: 新しい的の lid が取れない').toBeTruthy();
  const rowB = page.locator(`[data-pkc-region="filer-table"] [data-pkc-entry="${lidT}"]`);
  const renameB = async (name: string): Promise<void> => {
    await modClickReal(page, rowB);
    await page.keyboard.press('F2');
    const inp = page.locator('[data-pkc-field="row-rename"]');
    await expect(inp, '的の名前を変える欄が出ない').toBeVisible();
    await inp.fill(name);
    await inp.press('Enter');
    await expect(inp).toBeHidden();
  };
  await renameB('旧題');
  await createEntry(page, 'text');
  const taD = page.locator('[data-pkc-field="editor-body"]');
  await taD.click();
  await taD.fill(`[旧題](entry:${lidT})\n\n[消えた](entry:${lidA})\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(
    page.locator('[data-pkc-field="detail-body"] [data-pkc-action="navigate-entry-ref"]').first(),
    '前提: 題名と同じ字のリンクが本文に出ていない',
  ).toHaveText('旧題');
  await renameB('新題');
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '改名したのに「リンクの字も更新しました」の知らせが出ない',
  ).toContainText('1 件のノートのリンクの字も更新しました');
  await expect(
    page.locator('[data-pkc-field="detail-body"] [data-pkc-action="navigate-entry-ref"]').first(),
    '開いている本文のリンクの字が新しい題名にならない',
  ).toHaveText('新題');
  // 消えたノート(A はゴミ箱)へのリンク ── 知らせの隣に「ゴミ箱を開く」が出て、押すとゴミ箱が開く
  await clickReal(
    page,
    '[data-pkc-field="detail-body"] [data-pkc-action="navigate-entry-ref"] >> nth=1',
  );
  const trashBtn = page.locator('[data-pkc-field="status-trash"]');
  await expect(trashBtn, '見つからないノートの知らせに「ゴミ箱を開く」が出ない').toBeVisible();
  await clickReal(page, trashBtn);
  await expect(
    page.locator('[data-pkc-action="hide-trash"]'),
    '「ゴミ箱を開く」を押してもゴミ箱が開かない',
  ).toBeVisible();

  /**
   * ⚠ ここまでの 2 つ(改名・ゴミ箱)は、`reduceWithHistory` の `REQUEST_BACKLINKS`(#1087)を外しても緑のまま
   *   (変異 SURVIVED を実測)── 題名は一覧(`entryMetas`)から読み、消えた分は `removeEntryFromState` が
   *   楽観で外すので、取り直しに頼らない。「元に戻す」は復元が選択を A へ動かすので、取り直しの分岐を通らない。
   *   🔑 取り直しだけが効く場面は、選択を動かさずにリンク元が増える経路(別窓の書込など)で、実ブラウザの単窓では作れない。
   */
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
