/**
 * smoke #1(P3-8): boot → 作成 → 打鍵 → 保存 → rendered が「画面に見える」。
 * happy-dom の e2e が保証しない層(実座標のクリック・可視高さ・pageerror 0)を検品。
 */
import { test, expect } from '@playwright/test';
import { clickInspectorMoreItem, gotoApp, collectPageErrors, clickReal, createEntry, useSplitEditor, openBrowse } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

test('boot → ノート作成 → 編集 → 保存が画面に反映される', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  /**
   * 🔴 **C4(#1038 台帳③ 段 D)── 編集中は画面いちばん下の行の先頭に「編集中」**
   * (設計 doc §1 P3 / §11 Q2 裁定 A)。⚠ happy-dom の unit(`status-line.test.ts`)は
   * `composeStatusLine` を直接見るだけで、`main.ts` の `paint` が本当に呼ばれて
   * 実物の DOM に届くかはここでしか分からない(main.ts はどの test からも
   * 実行されない ── CLAUDE.md §2)。
   */
  const statusText = page.locator('[data-pkc-field="status-text"]');
  await expect(statusText, '編集中の状態語が画面いちばん下に出ていない').toContainText('編集中');
  expect(
    (await statusText.textContent()) ?? '',
    '状態語が先頭に無い(見本 3「編集中 — …」の順)',
  ).toMatch(/^編集中/);
  /**
   * 🔴 **状態語は行の地の字より濃い**(#1038 台帳③ C4 の着地前レビュー。設計 doc §9)。
   * ⚠ 字だけ見ると、濃くする規則を消しても緑 ── 実ブラウザで**計算された見た目**を、
   *   同じ行の地の字(`--muted`)と比べる(対照群を同じ行に置く)。
   */
  const look = await page.evaluate(() => {
    const state = document.querySelector('[data-pkc-field="status-state"]');
    const line = document.querySelector('[data-pkc-region="status"]');
    if (state === null || line === null) return null;
    const a = getComputedStyle(state);
    return { weight: Number(a.fontWeight), color: a.color, lineColor: getComputedStyle(line).color };
  });
  expect(look, '状態語の器(status-state)が無い').not.toBeNull();
  expect(look!.weight, '状態語が太字でない(控えめな知らせと同じ重さ)').toBeGreaterThanOrEqual(700);
  expect(look!.color, '状態語が行の地の字と同じ色(濃くなっていない)').not.toBe(look!.lineColor);
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.click();
  await page.keyboard.type('# 視覚検品\n\n==ハイライト== 本文');

  await clickReal(page, '[data-pkc-action="commit-edit"]');
  // ⚠ 対照群 ── 保存して読んでいるだけになったら、状態語は消える
  await expect(statusText, '保存した後も「編集中」が残っている').not.toContainText('編集中');
  const h1 = page.locator('[data-pkc-field="detail-body"] h1');
  await expect(h1).toBeVisible();
  await expect(h1).toContainText('視覚検品');
  const box = await h1.boundingBox();
  expect(box!.height).toBeGreaterThan(0); // 「生成された」ではなく「画面に出ている」
  await expect(page.locator('[data-pkc-field="detail-body"] mark')).toBeVisible();

  // sidebar にも行が見えている(タイトルは既定命名)
  await expect(
    page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]'),
  ).toHaveCount(1);

  // ── P5b: 2 回目の編集 → 履歴 → 復元(前進変異)が画面に反映される ──
  await clickReal(page, '[data-pkc-action="start-edit"]');
  // 🔴 C4:状態語が戻る(保存で消え、次の編集開始でまた出ることを見る)
  await expect(statusText, '2 回目の編集で「編集中」が戻っていない').toContainText('編集中');
  // 🔴 #1982 段 3: 追記欄の下の帯は「編集中。保存・編集をやめるは、上のボタンから」の 1 行だけ。
  //   保存 / やめるのボタンは**上の帯(題名の隣)の 1 か所**で、下には置かない(同じ操作の入口を 2 つにしない)
  await expect(
    page.locator('[data-pkc-field="append-lock-reason"]'),
    '追記欄の断り文が「編集中。…上のボタンから」になっていない',
  ).toHaveText(/^編集中。保存・編集をやめるは、上のボタンから$/);
  await expect(
    page.locator('[data-pkc-field="append-lock"] button[data-pkc-action="commit-edit"]'),
    '追記欄に保存のボタンが戻っている(保存は上の 1 か所)',
  ).toHaveCount(0);
  await expect(
    page.locator('[data-pkc-field="append-lock"] button[data-pkc-action="cancel-edit"]'),
    '追記欄にやめるのボタンが戻っている(やめるは上の 1 か所)',
  ).toHaveCount(0);
  await expect(
    page.locator('[data-pkc-region="detail"] button[data-pkc-action="commit-edit"]'),
    '上の帯に保存が無い',
  ).toBeVisible();
  await expect(
    page.locator('[data-pkc-region="detail"] button[data-pkc-action="cancel-edit"]'),
    '上の帯にやめるが無い',
  ).toBeVisible();
  /**
   * 🔴 **下の理由は静かな 1 行**(折り返さない・帯を取らない)。
   * ⚠ 測るのは字の範囲(Range)の高さ ── 器の箱で測ると、余白で 1 行に見えてしまう。
   */
  const reasonLines = await page.evaluate(() => {
    const reason = document.querySelector('[data-pkc-field="append-lock-reason"]');
    if (reason === null) return null;
    const range = document.createRange();
    range.selectNodeContents(reason);
    const rects = range.getClientRects();
    return { lines: new Set([...rects].map((r) => Math.round(r.top))).size, height: range.getBoundingClientRect().height };
  });
  expect(reasonLines, '追記欄の理由が見つからない').not.toBeNull();
  expect(reasonLines!.lines, '下の理由が複数行に折り返している').toBe(1);
  await ta.fill('# 二稿');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toContainText('二稿');

  // 🔴 束 G1(台帳 #1852 / 依頼 229): 二稿を保存した後に題名だけ変える(F2)── 履歴の版は初稿の題名を持つ。
  //   履歴から戻すと「題名も戻した」と言い、「元に戻す」で題名も本文も戻す前へ帰る
  const titleRow = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]').first();
  const firstTitle = (await page.locator('[data-pkc-field="detail-title"]').textContent())?.trim() ?? '';
  expect(firstTitle, '前提: 初稿の題名が空').not.toBe('');
  await clickReal(page, titleRow);
  await page.keyboard.press('F2');
  const renameBox = page.locator('[data-pkc-field="row-rename"]');
  await expect(renameBox, '名前を変える欄が出ない').toBeVisible();
  await renameBox.fill('改名した二稿');
  await renameBox.press('Enter');
  await expect(titleRow, '改名できていない').toContainText('改名した二稿');

  await clickInspectorMoreItem(page, 'show-history');
  const panel = page.locator('[data-pkc-field="history-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('li')).toHaveCount(1); // 初稿(変更前)が 1 件
  await clickReal(page, '[data-pkc-action="restore-revision"]');
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toContainText('視覚検品');
  await expect(panel).toHaveCount(0); // 復元で panel は畳まれる
  // 🔴 戻した直後の「元に戻す」(依頼 68-1)を実ブラウザで押す(#1087)── 戻す前の本文(二稿)へ帰る。
  //   ⚠ この口は #1727 で「別のタブが編集中か」を問う形(非同期)になった ── 押して効くことをここで見る
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('前の版に戻しました');
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '題名も戻したと言っていない',
  ).toContainText(`題名も「${firstTitle}」に戻しました`);
  await expect(titleRow, '一覧の題名が初稿に戻っていない').toContainText(firstTitle);
  await clickReal(page, '[data-pkc-field="status-undo"]');
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toContainText('二稿');
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('戻す前の本文に戻しました');
  await expect(titleRow, '元に戻したのに題名が二稿のまま戻らない').toContainText('改名した二稿');

  // ── P5b: 削除 → ゴミ箱 → 復元(sidebar に戻る)──
  // 確認は出さない(#1087 流れ 29)── 押したらそのまま移る
  await clickInspectorMoreItem(page, 'delete-entry');
  await expect(
    page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]'),
  ).toHaveCount(0);

  await openBrowse(page, 'filer');
  await clickReal(page, '[data-pkc-region="rail"] [data-pkc-action="show-trash"]');
  const trash = page.locator('[data-pkc-region="filer-trash"]');
  await expect(trash.locator('li')).toHaveCount(1);
  await clickReal(page, '[data-pkc-action="restore-trash"]');
  // ⚠ 一覧は**別のタブ**にある(P8 段⑤)── 戻ってから数える
  await expect(
    page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]'),
  ).toHaveCount(1); // 復元で一覧に戻る
  // ⚠ ゴミ箱は**フォルダのタブへ戻ってから**数える ── 隠れている面は描き直されない
  // ので、一覧を出したまま数えると「前に描いた古い DOM」を見ることになる
  // (3 回に 2 回落ちる flake の正体。user が見る形で観測する)
  await openBrowse(page, 'filer');
  await expect(trash.locator('li')).toHaveCount(0);

  expect(errors).toEqual([]);
});
