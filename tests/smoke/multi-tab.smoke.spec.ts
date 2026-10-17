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
import { answerAppDialog, gotoApp, collectPageErrors, clickReal, createEntry, useSplitEditor } from './helpers';

test('2 枚目のタブが本体経由で開き、別ノートは編集でき、同じノートは断られる', async ({
  page,
  context,
}) => {
  const errorsA = collectPageErrors(page);
  await useSplitEditor(page);
  await page.clock.install(); // 本体のタブの時計だけ進められるように(下の「知らせ」の道中)。時は普通に流れる
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
    '保存はメインのタブ経由',
  );
  // A で作ったノートが B の一覧に見える(boot 時の読取が proxy 越しに通った)
  const rowB = pageB.locator('[data-pkc-region="filer-table"] [data-pkc-entry]');
  await expect(rowB).toHaveCount(1);

  // B: 同じノートを A が編集中 → B の編集は断られる
  await clickReal(page, '[data-pkc-action="start-edit"]'); // A が編集に入る
  await expect(page.locator('[data-pkc-field="editor-body"]')).toBeVisible();
  await rowB.first().click();
  await clickReal(pageB, '[data-pkc-action="start-edit"]');
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText(
    '別のタブまたはウィンドウで編集中',
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
    page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]'),
  ).toHaveCount(2, { timeout: 10_000 });

  /**
   * 🔴 **時刻つきの予定の知らせは、メインでないタブにも帯が出て、どちらで閉じても両方で消える**
   * (台帳 #1852 束 E2、#1163 の依頼 347。起動は増やさない ── この道中の続きで、もう開いている 2 枚を使う)。
   * ⚠ 直す前は帯が本体のタブにしか出ず、いま見ているタブ(B)には何も出なかった。
   * 🔑 次の分の予定を書き、「予定の知らせ」を入にする(鳴るのは入にした後の時刻から)。観測点は B の帯と、閉じた後の両方の帯。
   */
  const soon = new Date(Date.now() + 60_000); // 次の分。⚠ 実時間で待たない(30s の timeout は緩めない)── 本体のタブの時計だけ進める
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const soonDate = `${soon.getFullYear()}-${p2(soon.getMonth() + 1)}-${p2(soon.getDate())}`;
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(`- [ ] 打ち合わせ @${soonDate} ${p2(soon.getHours())}:${p2(soon.getMinutes())}`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await clickReal(page, '[data-pkc-field="alarm-enabled"]');
  await page.clock.runFor("01:30"); // 知らせの刻み(30 秒)を回す;
  const barA = page.locator('[data-pkc-region="alarm-bar"] [data-pkc-field="alarm-list"] > li');
  const barB = pageB.locator('[data-pkc-region="alarm-bar"] [data-pkc-field="alarm-list"] > li');
  await expect(barA, '本体のタブに知らせの帯が出ない(前提)').toHaveCount(1, { timeout: 10_000 });
  await expect(barB, 'メインでないタブに知らせの帯が出ない').toHaveCount(1, { timeout: 10_000 });
  await expect(barB).toContainText('打ち合わせ');
  // B で閉じると、本体(A)でも消える
  await clickReal(pageB, '[data-pkc-region="alarm-bar"] [data-pkc-action="dismiss-alarm"]');
  await expect(barB, 'B で閉じたのに B の帯が残る').toHaveCount(0);
  await expect(barA, 'B で閉じたのに本体の帯が残る').toHaveCount(0, { timeout: 10_000 });

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
    '保存はメインのタブ経由',
  );

  // B は**編集中のまま**本体の死を迎える(編集ロックの昇格引き継ぎを実路で踏む)
  const rowB = pageB.locator('[data-pkc-region="filer-table"] [data-pkc-entry]');
  await rowB.first().click();
  await clickReal(pageB, '[data-pkc-action="start-edit"]');
  const taB = pageB.locator('[data-pkc-field="editor-body"]');
  await expect(taB).toBeVisible();
  await taB.fill('# 昇格後の保存');

  await page.close(); // 本体の死 ── Web Locks が B へ lease を渡す
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText(
    'このタブがメインのタブになりました',
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
    '保存はメインのタブ経由',
  );
  // 🔴 B が編集中のノートは C から取れない(heldLocks が新台帳へ引き継がれている)
  const rowC = pageC.locator('[data-pkc-region="filer-table"] [data-pkc-entry]');
  await expect(rowC).toHaveCount(1);
  await rowC.first().click();
  await clickReal(pageC, '[data-pkc-action="start-edit"]');
  await expect(pageC.locator('[data-pkc-region="status"]')).toContainText(
    '別のタブまたはウィンドウで編集中',
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
test('🔴 タブ A が編集中は、タブ B からの「使われていない添付を消す」を断る(#253)', async ({
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
  await expect(pageB.locator('[data-pkc-region="status"]')).toContainText('保存はメインのタブ経由');

  // 前提: **B だけ**なら整理は通る(この次元を測れている ── 常に断るのでは意味が無い)
  await clickReal(pageB, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await clickReal(pageB, '[data-pkc-action="purge-orphan-assets"]');
  // ⚠ 未参照が 0 件のときは**知らせるだけ**の形(ボタンは「閉じる」1 つ ── #299 段③)
  expect(await answerAppDialog(pageB, 'ok'), '前提: 誰も編集していないのに断られた').toContain(
    'どのノートからも使われていない添付はありません',
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
