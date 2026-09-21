import { test, expect } from '@playwright/test';
import { answerAppDialog, clickReal, collectPageErrors, createEntry, gotoApp } from './helpers';

/**
 * 🔴 **何も選んでいない = コレクションを選んでいる**(#1017 段④a)。
 *
 * `docs/development/ui-total-design-2026-09.md` §3.1 / §4.3 の裁定
 * (user 裁定 2026-09-20 6 巡目「コレクションの操作は右の列に出す」)の実体。
 *
 * ## unit(happy-dom)では届かない層(ここで見る分だけ)
 *
 * - **実物の器の組み替え**(shape が `empty` ⇄ `entry` を跨ぐ)が、実 DOM で
 *   本当に押せる形のまま切り替わるか(`tests/adapter/collection-pane.test.ts` は
 *   同じ主張を happy-dom で見ているが、**実際に画面へ描かれて押せる**ことまでは
 *   保証しない)
 * - **押した結果が例外を出さずに終わる**(`export-structure` の 0 件時の枝)
 * - 🔴 **「整理案を適用」の `hidden` 付け外しが実ブラウザで本当に効くか**
 *   (#1017 段④b。「構成をコピー」の隣へ移した ── happy-dom は `hidden` の
 *   描画反映までは保証しない)
 *
 * 🔴 **戻り道が画面に無い**(#1032)── ノートを 1 件でも選ぶと、その選択を外す口が
 *   1 つも無い(「選択を解除」が外すのは選択した行だけで、開いているノートには
 *   触らない)。⑤ が「消す」で戻っているのはそのためで、**それ以外の道は
 *   読み込み直すことだけ**である(`tests/smoke/helpers.ts` の `gotoCollectionPane`)。
 *
 * ⚠ **やらなかったこと**: 「構成をコピー」の**成功**(clipboard に非 0 件の内容が
 *   入る)経路は、この spec では見ていない ── そのためには「ノートが 1 件以上
 *   在るのに、何も選んでいない」状態が要るが、実際の UI にはそこへ至る単純な
 *   動線が無い(作成は必ず選択する / 取り込みも最後の 1 件を開く / 削除は
 *   残りが 1 件でも見えていればそちらが後継として選ばれる)。無理に
 *   `toggle-kind-filter` で絞って作ると、この spec 本来の主張(コレクション面の
 *   出し入れ)から離れた前提を増やすので見送った。
 */
test('🔴 何も選んでいないときの右の列に、コレクションの件数と書き出しが出る', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  const pane = page.locator('[data-pkc-field="collection-pane"]');
  await expect(pane, '何も選んでいないときの面が無い').toBeVisible();

  // ① 件数(0 件から始まる ── entryMetas を worker を叩かずに数えるだけ)
  const info = pane.locator('[data-pkc-field="collection-info"]');
  await expect(info).toContainText('ノート 0 件');
  await expect(info).toContainText('添付 0 件');
  await expect(info).toContainText('フォルダ 0 件');

  // ② 4 つの書き出しが、実際に見えて押せる形で在る(畳まれていない)
  //    ⚠ 見える説明(`title` の 1 行)まで見る ── 押した後どうなるか読めること
  const actions = ['export-html', 'export-portable', 'export-markdown', 'export-structure'];
  for (const action of actions) {
    const btn = pane.locator(`[data-pkc-action="${action}"]`);
    await expect(btn, `${action} が見えていない`).toBeVisible();
    const note = pane.locator(`[data-pkc-field="${action}-note"]`);
    await expect(note, `${action} の見える説明が無い`).toBeVisible();
  }
  await expect(pane.locator('details'), '畳まれている').toHaveCount(0);

  /**
   * 🔴 **「整理案を適用」は貼り付け欄が押したときだけ出る**(#1017 段④b)。
   *
   * 🔑 **新しい起動は足さない** ── この spec が既に持っている「何も選んでいない」
   *   状態(起動直後)を使う(smoke-budget)。実データでの「当てると本当に移る」は
   *   `tests/adapter/plan-apply.test.ts`(unit)が見る ── ここでは
   *   **実ブラウザでしか確かめられない層**(`hidden` の付け外しが実際に効くか /
   *   `<details>` を使っていないか)だけを見る。
   */
  const toggle = pane.locator('[data-pkc-action="toggle-plan-apply"]');
  await expect(toggle, '「整理案を適用」が見えていない').toBeVisible();
  const planBox = pane.locator('[data-pkc-field="plan-apply-box"]');
  await expect(planBox, '貼り付け欄が既定で隠れていない').toBeHidden();
  await clickReal(page, '[data-pkc-field="collection-pane"] [data-pkc-action="toggle-plan-apply"]');
  await expect(planBox, '押しても貼り付け欄が開かない').toBeVisible();
  const planInput = page.locator('[data-pkc-field="plan-input"]');
  await expect(planInput, '整理案の貼り付け欄が見えていない').toBeVisible();
  const planApplyBtn = page.locator('[data-pkc-field="plan-apply"]');
  await expect(planApplyBtn, '貼る前から押せる(dead click)').toBeDisabled();

  // ③ 押した結果を観測する(0 件のときの断り)── 例外を出さずに終わる
  await clickReal(page, '[data-pkc-field="collection-pane"] [data-pkc-action="export-structure"]');

  // ④ ノートを 1 件選ぶと、右の列がそのノートの情報に変わる(双方向の片側)
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(pane, '選んだのにコレクション面が残っている').toHaveCount(0);
  await expect(page.locator('[data-pkc-field="inspector-title"]')).toBeVisible();

  // ⑤ 選択を外す(このノートを消す)と、コレクション面へ戻る(双方向のもう片側)
  await clickReal(page, '[data-pkc-action="delete-entry"]');
  await answerAppDialog(page, 'ok');
  await expect(
    page.locator('[data-pkc-field="collection-pane"]'),
    'コレクション面へ戻っていない',
  ).toBeVisible();

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
