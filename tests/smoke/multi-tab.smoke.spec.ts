/**
 * smoke(#177): 多重タブ ── 2 枚目のタブが本体経由で同じアプリを開く。
 *
 * unit(store-proxy.test.ts)は fake channel で protocol を守る。ここで守るのは
 * **実物の合成**: 実 Chromium の Web Locks(lease)+ BroadcastChannel + OPFS
 * SAHPool worker が、2 つの page で実際に噛み合うこと。
 *
 * ⚠ 2 つの page は**同じ context**で開く(Web Locks / BroadcastChannel / OPFS は
 *   origin + profile 単位 ── context を分けると別世界になり、何も検証しない)。
 */
import { test, expect, type Page } from '@playwright/test';
import { answerAppDialog, gotoApp, collectPageErrors, clickReal, createEntry, useSplitEditor, useListBrowse } from './helpers';

// 🔑 #240 段⑤ で左の列の既定は**フォルダ**になった ── この file は一覧の行を
// 掴むので、一覧タブで開く仕込みを入れる(既定の顔は organize.smoke が守る)。
test.beforeEach(async ({ page }) => {
  await useListBrowse(page);
});

test('2 枚目のタブが本体経由で開き、別ノートは編集でき、同じノートは断られる', async ({
  page,
  context,
}) => {
  const errorsA = collectPageErrors(page);
  await useSplitEditor(page);
  await gotoApp(page);

  // タブ A(本体): ノートを 1 件作って保存
  await createEntry(page, 'text');
  const taA = page.locator('[data-pkc-field="editor-body"]');
  await taA.click();
  await page.keyboard.type('# タブA のノート');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toContainText('タブA のノート');

  // タブ B(follower): 同じアプリが**待機画面ではなく**開く
  const pageB: Page = await context.newPage();
  const errorsB = collectPageErrors(pageB);
  await useSplitEditor(pageB);
  await gotoApp(pageB);
  // 常設バッジ = 本体経由の印
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText(
    '保存は本体タブ経由',
  );
  // A で作ったノートが B の一覧に見える(boot 時の読取が proxy 越しに通った)
  const rowB = pageB.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rowB).toHaveCount(1);

  // B: 同じノートを A が編集中 → B の編集は断られる
  await clickReal(page, '[data-pkc-action="start-edit"]'); // A が編集に入る
  await expect(page.locator('[data-pkc-field="editor-body"]')).toBeVisible();
  await rowB.first().click();
  await clickReal(pageB, '[data-pkc-action="start-edit"]');
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText(
    '別のタブかウィンドウで編集中',
  );
  await expect(pageB.locator('[data-pkc-field="editor-body"]')).toHaveCount(0);

  // A が保存 → B で編集できるようになる(ロック解放が渡る)
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();
  await clickReal(pageB, '[data-pkc-action="start-edit"]');
  const taB = pageB.locator('[data-pkc-field="editor-body"]');
  await expect(taB).toBeVisible();

  // B: 本文を書いて保存(書込が proxy 越しに通る)→ A の画面に反映される
  await taB.fill('# タブB が書いた');
  await clickReal(pageB, '[data-pkc-action="commit-edit"]');
  await expect(pageB.locator('[data-pkc-field="detail-body"] h1')).toContainText(
    'タブB が書いた',
  );
  // A は 'changed' → 一覧の取り直し → REQUEST_BODY で本文も追従する
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toContainText(
    'タブB が書いた',
    { timeout: 10_000 },
  );

  // B: 新規作成も follower から通る(別ノートの並行編集)
  await createEntry(pageB, 'text');
  await pageB.locator('[data-pkc-field="editor-body"]').fill('# 2 件目');
  await clickReal(pageB, '[data-pkc-action="commit-edit"]');
  await expect(rowB).toHaveCount(2);
  await expect(
    page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]'),
  ).toHaveCount(2, { timeout: 10_000 });

  expect(errorsA).toEqual([]);
  expect(errorsB).toEqual([]);
});

test('本体タブを閉じると、2 枚目がその場で本体に昇格する(reload 無し・編集も生きたまま)', async ({
  page,
  context,
}) => {
  await useSplitEditor(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('# 引き継ぎ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const pageB = await context.newPage();
  const errorsB = collectPageErrors(pageB);
  await useSplitEditor(pageB);
  await gotoApp(pageB);
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText(
    '保存は本体タブ経由',
  );

  // B は**編集中のまま**本体の死を迎える(編集ロックの昇格引き継ぎを実路で踏む)
  const rowB = pageB.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await rowB.first().click();
  await clickReal(pageB, '[data-pkc-action="start-edit"]');
  const taB = pageB.locator('[data-pkc-field="editor-body"]');
  await expect(taB).toBeVisible();
  await taB.fill('# 昇格後の保存');

  await page.close(); // 本体の死 ── Web Locks が B へ lease を渡す
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText(
    'このタブが本体になりました',
    { timeout: 15_000 },
  );
  // 編集は昇格をまたいで生きている(reload していない証拠でもある)
  await expect(taB).toBeVisible();

  // タブ C: 新しい本体(B)に follower として繋がる(3 枚目 ── レビュー M-6 の pin)
  const pageC = await context.newPage();
  const errorsC = collectPageErrors(pageC);
  await useSplitEditor(pageC);
  await gotoApp(pageC);
  await expect(pageC.locator('[data-pkc-region="status"]')).toContainText(
    '保存は本体タブ経由',
  );
  // 🔴 B が編集中のノートは C から取れない(heldLocks が新台帳へ引き継がれている)
  const rowC = pageC.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rowC).toHaveCount(1);
  await rowC.first().click();
  await clickReal(pageC, '[data-pkc-action="start-edit"]');
  await expect(pageC.locator('[data-pkc-region="status"]')).toContainText(
    '別のタブかウィンドウで編集中',
  );

  // B が保存 → 🔴 昇格後の書込が C へ届く(localClient 包み + 名乗りの pin)
  await clickReal(pageB, '[data-pkc-action="commit-edit"]');
  await expect(pageB.locator('[data-pkc-field="detail-body"] h1')).toContainText(
    '昇格後の保存',
  );
  await expect(pageC.locator('[data-pkc-field="detail-body"] h1')).toContainText(
    '昇格後の保存',
    { timeout: 10_000 },
  );

  // C が作る → 🔴 昇格後の B に届く(B の changed 購読が新 host へ繋ぎ直されている pin)
  await createEntry(pageC, 'text');
  await pageC.locator('[data-pkc-field="editor-body"]').fill('# C の 2 件目');
  await clickReal(pageC, '[data-pkc-action="commit-edit"]');
  await expect(rowB).toHaveCount(2, { timeout: 10_000 });

  expect(errorsB).toEqual([]);
  expect(errorsC).toEqual([]);
});

/**
 * 🔴 **他のタブが編集中なら、整理を断る**(#253)。
 *
 * ⚠ 未参照 asset の走査は**保存済みの本文**しか見ないので、別のタブが編集中に
 * 貼った画像(bytes は在るが参照は未保存の欄の中)は「使っていない」に見える。
 * 直す前は、**タブ B から押した整理がそれを消していた**(自タブの `phase` しか
 * 見ていなかった)。
 *
 * 🔑 ここで守るのは**実物の合成** ── 実 BroadcastChannel 越しに holder が
 * 台帳を答え、follower がそれで断ること。unit(store-proxy / asset-gc)は
 * fake channel と純関数までしか届かない。
 */
test('🔴 タブ A が編集中は、タブ B からの「使っていない添付を消す」を断る(#253)', async ({
  page,
  context,
}) => {
  const errorsA = collectPageErrors(page);
  await useSplitEditor(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-action="start-edit"]')).toBeVisible();

  const pageB: Page = await context.newPage();
  const errorsB = collectPageErrors(pageB);
  await useSplitEditor(pageB);
  await gotoApp(pageB);
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText('保存は本体タブ経由');

  // 前提: **B だけ**なら整理は通る(この次元を測れている ── 常に断るのでは意味が無い)
  await clickReal(pageB, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await clickReal(pageB, '[data-pkc-action="purge-orphan-assets"]');
  // ⚠ 未参照が 0 件のときは**知らせるだけ**の形(ボタンは「閉じる」1 つ ── #299 段③)
  expect(await answerAppDialog(pageB, 'ok'), '前提: 誰も編集していないのに断られた').toContain(
    '未参照の添付データはありません',
  );

  // 🔴 A が編集に入る(= 編集ロックを握る)
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(page.locator('[data-pkc-field="editor-body"]')).toBeVisible();

  // B から整理 → **断られる**(⚠ 確認は出ない ── 走査の前で止まる)
  await clickReal(pageB, '[data-pkc-action="purge-orphan-assets"]');
  await expect(
    pageB.locator('[data-pkc-region="status"]'),
    '他のタブが編集中なのに断っていない',
  ).toContainText('他のタブで編集中です', { timeout: 10_000 });
  // ⚠ **確認まで進んでいない**(走査の前で止まる)── ダイアログが開いていないこと
  await expect(
    pageB.locator('[data-pkc-region="app-dialog"][open]'),
    '断るはずが確認まで進んだ',
  ).toHaveCount(0);

  expect(errorsA).toEqual([]);
  expect(errorsB).toEqual([]);
});
