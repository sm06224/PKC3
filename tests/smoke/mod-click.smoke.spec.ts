import { test, expect, type Page } from '@playwright/test';
import {
  gotoApp,
  clickReal,
  modClickReal,
  altClickReal,
  createEntry,
  collectPageErrors,
} from './helpers';

/**
 * 🔴 **読む面と 1 面の「押し方」の割当**(#495。user 裁定 2026-08-27)。
 *
 * > 「見出しを押したら編集とかは、**Ctrl+クリックで、その地点から編集**にすれば
 * > 良いと思う。**見出しにこだわる必要はない**」
 * > 「センターペインの**追記位置指定は Alt+クリック**にしましょう、さっき指定した
 * > **Ctrl+クリックをデフォのその場からの編集 IN 導線**に変更してください」
 *
 * | 押し方 | 何が起きるか |
 * |---|---|
 * | **Ctrl(⌘)+クリック** | その地点から編集に入る / 1 面ではその塊が原文になる |
 * | **Alt+クリック** | 追記の入り先を、押した所の節にする |
 * | 素のクリック | 読むだけ(**編集に入らない**) |
 *
 * 🔴 **unit では原理的に届かない層**:
 * ① **本物の修飾キー付きクリック** ── 合成 event では `keyboard.down` を経ずに
 *    `ctrlKey` を立てられるので、「実機で本当にその修飾キーが載るか」は見ていない
 * ② **`<select>` が実際に切り替わって見えるか** ── 入り先の正本はその `<select>`
 *    なので、値が変わらなければ**押しても入り先は動いていない**
 * ③ 🔴 **追記が本当にその節へ入るか**(端から端まで)── `<select>` の値が
 *    変わっただけでは「入り先が変わった」とは言えない
 */

/**
 * 見出しの本文。⚠ 節の中の段落を押し分けるので、**節ごとに違う字**にする。
 *
 * 🔴 **比べる 2 つは「同格の兄弟」にする**(1 稿目はここを外して落ちた)。
 * ⚠ `resolveAppendAt` は**深い見出しを自分の節の中身として跨ぐ**ので、
 *   `# 議事録` の節は**文書の末尾まで**である ── h1 と h2 で比べると
 *   「その節の末尾」と「文書の末尾」が**同じ場所**になり、入り先が効いて
 *   いなくても通ってしまう(= 空振り)。だから **h2 を 2 つ**並べる。
 */
const DOC = '# 議事録\n\n## 出席\n\n3 名でした。\n\n## 決定事項\n\nA を採用する。';

/** ノートを 1 件作り、`DOC` を入れて**読む面**まで出す。 */
async function makeNote(page: Page): Promise<void> {
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live).toBeVisible();
  // ⚠ 空のノートの入口は**余白の素クリック**のまま(塞ぐと 1 文字も打てない)
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await live.locator('[data-pkc-field="row-source"]').fill(DOC);
  await page.keyboard.press('Tab');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"] h2')).toHaveText([
    '出席',
    '決定事項',
  ]);
}

test('🔴 読む面: Ctrl+クリックで、その行から編集に入る(素のクリックでは入らない)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeNote(page);

  const body = page.locator('[data-pkc-field="detail-body"]');
  const under = body.locator('p', { hasText: 'A を採用する。' });

  // ① 対照群 ── 素のクリックでは編集に入らない(browse-first の裁定を変えない)
  await clickReal(page, under);
  await expect(
    page.locator('[data-pkc-region="editor-live"]'),
    '素のクリックで編集に入った',
  ).toHaveCount(0);

  // ② 🔴 Ctrl+クリック ── 編集に入り、**押した塊がそのまま原文の欄**で開く
  await modClickReal(page, under);
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live, '編集に入っていない').toBeVisible();
  await expect(
    live.locator('[data-pkc-field="row-source"]'),
    '押した行が開いていない(別の行 / どこも開いていない)',
  ).toHaveValue('A を採用する。');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 読む面: Alt+クリックで、追記の入り先がその節になる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeNote(page);

  const body = page.locator('[data-pkc-field="detail-body"]');
  const target = page.locator('[data-pkc-field="append-target"]');
  await expect(target, '追記の入り先が出ていない').toBeVisible();
  // ⚠ 既定は「末尾」(これまでと同じ)── ここが動くことがこの test の主張である
  await expect(target).toHaveValue('');

  // ① 🔴 「決定事項」の節の中を Alt+クリック → その節が選ばれる
  await altClickReal(page, body.locator('p', { hasText: 'A を採用する。' }));
  await expect(target, '入り先が変わっていない').not.toHaveValue('');
  // ⚠ 見えている字で確かめる ── 印(slug)は user に見えない
  await expect(target.locator('option:checked')).toHaveText(/決定事項/);
  /**
   * 🔴 **押した人に届いているか**を、状態の行で見る(`main.ts` の `showStatus`)。
   * ⚠ **面へスコープする** ── root 全体の字で探すと、お知らせのカードや
   *   マニュアルの見出しに満たされて**常に真**になる(CLAUDE.md §1)。
   * ⚠ `main.ts` は原文を読む test しか持たない層なので、**配線が届いたことは
   *   ここでしか見えない**。
   */
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('決定事項');

  // ② 対照群 ── 上の節を押せば、そちらへ移る(1 つに固まっていない)
  await altClickReal(page, body.locator('p', { hasText: '3 名でした。' }));
  await expect(target.locator('option:checked')).toHaveText(/出席/);

  // ③ 🔴 端から端まで ── 選び直して追記すると、**その節の末尾**に入る
  await altClickReal(page, body.locator('p', { hasText: 'A を採用する。' }));
  await page.locator('[data-pkc-field="append-input"]').fill('B も採用する。');
  await clickReal(page, '[data-pkc-action="append-entry"]');
  await expect(body, '追記が本文に届いていない').toContainText('B も採用する。');
  /**
   * 🔴 **入った場所**を見る ── 「末尾」なら文書のいちばん下に来る。
   * ⚠ 「決定事項」は文書の最後の節なので、ここだけでは末尾と見分けが付かない
   *   ── だから**前の節を選んだときと比べる**(下の ④)。
   */
  const paras = body.locator('p');
  await expect(paras.last()).toHaveText('B も採用する。');

  // ④ 🔴 前の節を選んで追記すると、**そちらの末尾**(= 文書の途中)に入る
  await altClickReal(page, body.locator('p', { hasText: '3 名でした。' }));
  await page.locator('[data-pkc-field="append-input"]').fill('欠席は 1 名。');
  await clickReal(page, '[data-pkc-action="append-entry"]');
  await expect(body).toContainText('欠席は 1 名。');
  await expect(
    paras.last(),
    '前の節を選んだのに文書の末尾へ入った(入り先が効いていない)',
  ).toHaveText('B も採用する。');
  // 「3 名でした。」の直後に来ている(その節の中に入った)
  await expect(paras.nth(1)).toHaveText('欠席は 1 名。');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 1 面: 素のクリックでは塊が開かない(Ctrl+クリックで開く)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await makeNote(page);

  // 読む面から編集へ(⚠ 押した行を持ち込まない口 = ふつうの「編集」)
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live).toBeVisible();
  await expect(live.locator('[data-pkc-field="row-source"]')).toHaveCount(0);

  const para = live.locator('p', { hasText: 'A を採用する。' });

  // ① 🔴 素のクリック ── 開かない(読む・選ぶ・畳むに返した)
  await clickReal(page, para);
  await expect(
    live.locator('[data-pkc-field="row-source"]'),
    '素のクリックで塊が開いた',
  ).toHaveCount(0);

  // ② 対照群 ── Ctrl+クリックなら開く
  await modClickReal(page, para);
  await expect(live.locator('[data-pkc-field="row-source"]')).toHaveValue('A を採用する。');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
