import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp, useSplitEditor } from './helpers';

/**
 * 🔴 **別の窓の変更と重なったとき、黙って上書きしない**(#178 / #300 段③、2026-08-22)。
 *
 * ## user から見た物語
 *
 * 本文を書いている。⚠ **その隣で、別窓の PKC が同じノートに日付を付ける**
 * (#300 段③ で組み込みアプリは既定で別窓になったので、これは特殊な使い方ではない)。
 * そのまま保存すると、日付は上書きされる ── **直す前はそのとき画面に何も出なかった**。
 * user から見えるのは「さっき付けた日付が消えた」だけで、
 * **戻せることを知る道が無い**。
 *
 * ⚠ **日付を付ける手は替わった**(#292 段⑤、2026-08-23)── 当時はカレンダーの
 *   日を押していたが、あの面は左の列のタブへ引っ越した。いまの口は
 *   **右の列(情報)の「日付を付ける」**である。⚠ 守る主張は 1 つも変わらない
 *   ── 見ているのは「別窓が disk を進めたときに黙らないか」であって、
 *   どの口から進めたかではない。
 *
 * ## 🔴 unit では原理的に届かない層だけをここで見る
 *
 * ⚠ これは **2 枚の窓が同じ DB を書く**話である ── happy-dom には
 * BroadcastChannel をまたぐ 2 つの文書も、本体タブの worker も無い。
 * だから ①**放送が本当に届くか** ②**編集中のタブがそれを受けるか**
 * ③**保存したときに理由が出るか** の 3 つを実物で通す。
 *
 * ⚠ 「上書きされた版が履歴に入るか」は**実物の worker**が
 * `tests/adapter/storage-worker.test.ts` で見ている ── ここでは重ねない
 * (同じ主張を 2 か所で見ると、片方を壊しても気づけない)。
 */
test('🔴 別窓が同じノートを書いたら、保存時に理由が出る (#178)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await useSplitEditor(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ノートを 1 件作って保存(作った直後は選ばれている)
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  // 🔑 **窓 2 枚目**を、同じノートを指すディープリンクで開く(#300 段②)
  const link = await page.evaluate(() => location.href);
  const win = await context.newPage();
  await win.goto(link);
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  // ⚠ **前提** ── 2 枚目が同じノートを選んでいる。選べていないと、この窓は
  //    日付を付けられないので test が成り立たない
  await expect(
    win.locator('[data-pkc-action="set-entry-date"]'),
    '前提が崩れている(2 枚目がノートを選んでいない)',
  ).toBeVisible({ timeout: 15_000 });

  // 本体の窓へ戻って、本文の編集を始めて打鍵する
  // ⚠ 左の列は「アプリ」のままでよい ── 中央の面は本文のままである
  await page.bringToFront();
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await page.locator('[data-pkc-field="editor-body"]').fill('# 打鍵中の下書き');

  /**
   * 🔴 **別窓が同じノートに日付を付ける**(= disk が進む)。
   * ⚠ 日は**選ばない** ── 日付欄には開いた時点で今日が入っている(近道の
   *   いちばん多い答え)ので、そのまま入れれば実行日に依存せず進む。
   */
  await win.bringToFront();
  await clickReal(win, '[data-pkc-action="set-entry-date"]');
  await expect(win.locator('[data-pkc-field="pick-date"]')).toBeVisible({ timeout: 10_000 });
  await clickReal(win, '[data-pkc-field="dialog-ok"]');
  // ⚠ **入ったことを確かめてから先へ進む**(入っていなければ以降は判定不能)──
  //    「外す」が押せる = frontmatter に `date:` が在る、である
  await expect(
    win.locator('[data-pkc-action="clear-entry-date"]'),
    '別窓で日付が入っていない(この test の前提が崩れている)',
  ).toBeVisible({ timeout: 15_000 });

  /**
   * 🔴 **本体の窓で保存する** ── 打った字は残り、**理由が出る**。
   * ⚠ 観測点は**状態の行**へ絞る(root 全体で探すと、お知らせのカードの文言に
   *   満たされて常に真になる ── 2026-08-17 に踏んだ型)。
   */
  await page.bringToFront();
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '黙って上書きした(user は日付が消えたとしか見えない)',
  ).toContainText('別の窓の変更と重なりました', { timeout: 15_000 });
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '戻し方が書いていない',
  ).toContainText('履歴');

  // 🔑 打った字は捨てられていない(user の作業を守るのが last-write-wins の理由)
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toContainText('打鍵中の下書き');

  await win.close();
  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
