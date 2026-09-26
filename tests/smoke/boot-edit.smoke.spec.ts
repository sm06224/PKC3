/**
 * smoke #1(P3-8): boot → 作成 → 打鍵 → 保存 → rendered が「画面に見える」。
 * happy-dom の e2e が保証しない層(実座標のクリック・可視高さ・pageerror 0)を検品。
 */
import { test, expect } from '@playwright/test';
import { answerAppDialog, gotoApp, collectPageErrors, clickReal, createEntry, useSplitEditor, useListBrowse } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useListBrowse(page);
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
    page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]'),
  ).toHaveCount(1);

  // ── P5b: 2 回目の編集 → 履歴 → 復元(前進変異)が画面に反映される ──
  await clickReal(page, '[data-pkc-action="start-edit"]');
  // 🔴 C4:状態語が戻る(保存で消え、次の編集開始でまた出ることを見る)
  await expect(statusText, '2 回目の編集で「編集中」が戻っていない').toContainText('編集中');
  // 🔴 C4:追記欄の断り文も「編集中」の 1 語(§1 P3 test②「同じ定数と等値」)。
  //   保存 / キャンセルの出口はそのまま残っていることも見る(出口を削っていない)。
  await expect(
    page.locator('[data-pkc-field="append-lock-reason"]'),
    '追記欄の断り文が「編集中」の 1 語になっていない',
  ).toHaveText('編集中');
  await expect(
    page.locator('[data-pkc-field="append-lock"] button[data-pkc-action="commit-edit"]'),
    '追記欄に保存の出口が無い',
  ).toBeVisible();
  await expect(
    page.locator('[data-pkc-field="append-lock"] button[data-pkc-action="cancel-edit"]'),
    '追記欄にキャンセルの出口が無い',
  ).toBeVisible();
  /**
   * 🔴 **出口は「編集中」のすぐ隣に在る**(#1038 台帳③ C4 の着地前レビュー)。
   * ⚠ 1 稿目は理由の字が残りの幅を全部吸い(`flex: 1`)、1 語になった後ろに帯の半分近い
   *   空白が出て、保存が右端へ離れていた。🔑 字の右端と保存の左端の間を実寸で測る。
   * ⚠ **測るのは字の範囲(Range)であって、器の箱ではない** ── `flex: 1` の器は保存の
   *   直前まで伸びるので、箱の右端で測ると 1 稿目の形でも「隣」に見える(変異試験で
   *   `flex: 1` へ戻しても緑だった)。
   */
  const gap = await page.evaluate(() => {
    const reason = document.querySelector('[data-pkc-field="append-lock-reason"]');
    const save = document.querySelector('[data-pkc-field="append-lock"] button[data-pkc-action="commit-edit"]');
    if (reason === null || save === null) return null;
    const range = document.createRange();
    range.selectNodeContents(reason);
    const r = range.getBoundingClientRect();
    const b = save.getBoundingClientRect();
    return { gap: b.left - r.right, sameRow: Math.abs(b.top - r.top) < r.height + b.height };
  });
  expect(gap, '追記欄の理由か保存が見つからない').not.toBeNull();
  expect(gap!.sameRow, '前提: 理由と保存が同じ行に並んでいない').toBe(true);
  expect(gap!.gap, `「編集中」と保存の間が空きすぎている(${gap!.gap}px)`).toBeLessThan(24);
  await ta.fill('# 二稿');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toContainText('二稿');

  await clickReal(page, '[data-pkc-action="show-history"]');
  const panel = page.locator('[data-pkc-field="history-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('li')).toHaveCount(1); // 初稿(変更前)が 1 件
  await clickReal(page, '[data-pkc-action="restore-revision"]');
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toContainText('視覚検品');
  await expect(panel).toHaveCount(0); // 復元で panel は畳まれる

  // ── P5b: 削除 → ゴミ箱 → 復元(sidebar に戻る)──
  // 確認は**アプリの中**の口を押す(#299 段② ── native は 1 度も開かない)
  await clickReal(page, '[data-pkc-action="delete-entry"]');
  await answerAppDialog(page, 'ok');
  await expect(
    page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]'),
  ).toHaveCount(0);

  await clickReal(page, '[data-pkc-browse="filer"]');
  await clickReal(page, '[data-pkc-action="show-trash"]');
  const trash = page.locator('[data-pkc-region="filer-trash"]');
  await expect(trash.locator('li')).toHaveCount(1);
  await clickReal(page, '[data-pkc-action="restore-trash"]');
  // ⚠ 一覧は**別のタブ**にある(P8 段⑤)── 戻ってから数える
  await clickReal(page, '[data-pkc-browse="list"]');
  await expect(
    page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]'),
  ).toHaveCount(1); // 復元で一覧に戻る
  // ⚠ ゴミ箱は**フォルダのタブへ戻ってから**数える ── 隠れている面は描き直されない
  // ので、一覧を出したまま数えると「前に描いた古い DOM」を見ることになる
  // (3 回に 2 回落ちる flake の正体。user が見る形で観測する)
  await clickReal(page, '[data-pkc-browse="filer"]');
  await expect(trash.locator('li')).toHaveCount(0);

  expect(errors).toEqual([]);
});
