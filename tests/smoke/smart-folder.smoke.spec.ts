import { test, expect, type Page } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp, useSplitEditor } from './helpers';

/**
 * 🔴 **スマートフォルダ**(#421 段①。user 要望 2026-08-26)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * 1. **本当に worker が舐めている** ── unit の fake は「当たり」を作って返すだけで、
 *    実際に DB を走査して frontmatter を読むところは 1 度も通らない
 * 2. **実マウスの 2 クリック**で中へ入れるか(合成の `dblclick` は実機と違いうる)
 * 3. **開き直しても残る**(条件は本文に在るので、読み込み直しても効く)
 */

const ROWS = '[data-pkc-region="filer-table"] tbody tr';
const SMART_ROW = `${ROWS}[data-pkc-archetype="smart"]`;
const WHY = '[data-pkc-field="smart-why"]';

/** 題名と本文を持つノートを 1 件作る(⚠ 2 列の編集で入れる)。 */
async function makeNote(page: Page, title: string, body: string): Promise<void> {
  await createEntry(page, 'text');
  const t = page.locator('[data-pkc-field="editor-title"]');
  if (await t.count()) await t.fill(title);
  await page.locator('[data-pkc-field="editor-body"]').fill(body);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
}

test('🔴 条件を足すと、タグの付いたノートが場所を越えて集まる (#421)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  /**
   * ⚠ **2 列の編集で本文を入れる** ── 既定は 1 面のライブエディタで
   *   `editor-body` の欄は出ない(ここで見たいのは集める所であって編集の仕方ではない)。
   */
  await useSplitEditor(page);
  await gotoApp(page);

  // ① タグ付きのノートと、付いていないノートを作る
  await makeNote(page, '見積書', '---\ntags: [請求]\n---\n見積の中身\n');
  await makeNote(page, '買い物', '---\ntags: [家事]\n---\n牛乳\n');

  // ② スマートフォルダを作る
  await createEntry(page, 'smart');
  const title = page.locator('[data-pkc-field="editor-title"]');
  if (await title.count()) await title.fill('請求ぜんぶ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ③ フォルダの面で 2 回押して中へ入る(⚠ 1 回目は選ぶだけ)
  await expect(page.locator(SMART_ROW), 'スマートフォルダが一覧に出ていない').toHaveCount(1);
  await page.locator(SMART_ROW).first().dblclick();
  await expect(page.locator(WHY), '条件の帯が出ていない').toBeVisible();
  // 🔴 条件が空のうちは**何も集めない**(「全部」ではない)
  await expect(page.locator(WHY)).toContainText('条件を選んでください');
  await expect(page.locator(ROWS), '条件が無いのに集めている').toHaveCount(0);

  // ④ 条件を足す ── ここで初めて worker が本当に走査する
  await page.locator('[data-pkc-field="smart-cond"]').fill('請求');
  await clickReal(page, '[data-pkc-action="smart-cond-add"]');
  await expect(page.locator(ROWS), 'タグの付いたノートが集まっていない').toHaveCount(1);
  await expect(page.locator(ROWS).first()).toContainText('見積書');
  await expect(page.locator(WHY)).toContainText('1 件');

  /**
   * ⑤ 🔴 **開き直しても効く** ── 条件は本文に在るので、読み込み直しても残る
   *   (端末の保存に置いていたら、ここで消える)。
   */
  await page.reload();
  await page.locator(SMART_ROW).first().dblclick();
  await expect(page.locator(WHY), '条件が残っていない').toContainText('1 件');
  await expect(page.locator(ROWS)).toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 落とすと条件のタグが付き、「ここから外す」で外れる (#421)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await useSplitEditor(page);
  await gotoApp(page);

  await makeNote(page, '請求メモ', 'まだタグは無い\n');
  await createEntry(page, 'smart');
  const title = page.locator('[data-pkc-field="editor-title"]');
  if (await title.count()) await title.fill('請求ぜんぶ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // 条件を入れておく(中へ入って足す → 出る)
  await page.locator(SMART_ROW).first().dblclick();
  await page.locator('[data-pkc-field="smart-cond"]').fill('請求');
  await clickReal(page, '[data-pkc-action="smart-cond-add"]');
  /**
   * ⚠ **「条件」で見ない** ── 「条件を選んでください」にも含まれるので、
   *   条件が 1 つも入っていなくても通る(自分で書いた空振りだった)。
   *   🔑 **札が出たこと**で見る(条件が実際に本文へ書かれた証拠)。
   */
  await expect(
    page.locator('[data-pkc-region="smart-cond"]'),
    '条件が入っていない',
  ).toHaveCount(1);
  // ルートへ戻る(パンくずの左端)
  await clickReal(
    page,
    '[data-pkc-region="filer-breadcrumb"] [data-pkc-action="enter-folder"]',
  );
  await expect(page.locator(SMART_ROW)).toHaveCount(1);

  /**
   * 🔴 **落とすと条件のタグが本文に付く**(user 裁定 2026-08-26)。
   * ⚠ unit は `DataTransfer` を持たないので、**ここでしか通らない**層である。
   */
  // ⚠ **`page.dragAndDrop` を使う**(この repo の D&D smoke と同じ作法)──
  //    `locator.dragTo` は HTML5 の dataTransfer を組まないことがある
  await page.dragAndDrop(`${ROWS}[data-pkc-archetype="text"]`, SMART_ROW);

  // 中へ入ると、いま落としたノートが集まっている
  await page.locator(SMART_ROW).first().dblclick();
  await expect(page.locator(ROWS), '落としたのに集まっていない').toHaveCount(1);
  await expect(page.locator(ROWS).first()).toContainText('請求メモ');

  /**
   * 🔴 **置けるなら外せる**(user 指示 2026-08-23)── 選んで「ここから外す」。
   */
  await page.locator(ROWS).first().click();
  await clickReal(page, '[data-pkc-action="smart-evict"]');
  await expect(page.locator(ROWS), '外したのに残っている').toHaveCount(0);
  await expect(page.locator(WHY)).toContainText('0 件');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **文書側でタグを付け外ししたら、開いている入れ物がその場で変わる**
 * (user 要望 2026-08-26「文書側でタグつけしたら勝手にフォルダに落ちるもやってください」)。
 *
 * 🔴 **unit では届かない層**:まとめてタグを外す経路は **worker に集め直しを
 *   頼まない**(頼むと 100 件で 100 回の全件走査になる)。だから
 *   「行が消えること」は**画面が当たりの表から組み直されている**証拠であって、
 *   走査が返ってきた証拠ではない ── そこが本当に繋がっているかを実機で見る。
 */
test('🔴 中でタグを外すと、集め直しを待たずに行が消える (#421 / user 要望 2026-08-26)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await useSplitEditor(page);
  await gotoApp(page);

  await makeNote(page, '見積書', '---\ntags: [請求]\n---\n見積の中身\n');
  await makeNote(page, '請求書', '---\ntags: [請求]\n---\n請求の中身\n');

  await createEntry(page, 'smart');
  const title = page.locator('[data-pkc-field="editor-title"]');
  if (await title.count()) await title.fill('請求ぜんぶ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await page.locator(SMART_ROW).first().dblclick();
  await page.locator('[data-pkc-field="smart-cond"]').fill('請求');
  await clickReal(page, '[data-pkc-action="smart-cond-add"]');
  await expect(page.locator(ROWS), '2 件とも集まっていない').toHaveCount(2);

  // 2 件に印を付ける(実キーの修飾つきクリック)
  const rows = page.locator(ROWS);
  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('[data-pkc-field="filer-bulk"]')).toContainText('2 件');

  /**
   * 🔴 **「まとめてタグを外す」は集め直しを頼まない口である** ── ここで行が
   *   消えるなら、当たりの表がその場で組み直されている。
   */
  await page.locator('[data-pkc-field="bulk-tag"]').fill('請求');
  await clickReal(page, '[data-pkc-action="bulk-tag-remove"]');
  await expect(page.locator(ROWS), '外したのに行が残っている').toHaveCount(0);
  await expect(page.locator(WHY), '件数が古いまま').toContainText('0 件');

  /**
   * ⚠ **対照群** ── 画面だけの嘘ではなく、**本文が本当に変わっている**。
   *   開き直しても 0 件のままなら、走査もそう読んでいる。
   */
  await page.reload();
  await page.locator(SMART_ROW).first().dblclick();
  await expect(page.locator(WHY), '本文は変わっていなかった').toContainText('0 件');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **タグ以外の条件で絞る**(#421 段②)。
 *
 * 🔴 **unit では届かない層**:列の条件は **worker の SQL** が当てる ──
 *   unit の fake は「当たり」を作って返すだけなので、`WHERE archetype = ?` が
 *   本当に効いているかは**実物の sqlite** でしか分からない。
 *   そして `<select>` は **change** で来るので、実キーの操作でしか通らない。
 */
test('🔴 種類で絞ると、その種類だけが集まる (#421 段②)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await useSplitEditor(page);
  await gotoApp(page);

  await makeNote(page, 'ふつうのノート', 'ただの本文\n');
  // フォルダを 1 つ作る(種類が違うもの)
  await createEntry(page, 'folder');
  const ft = page.locator('[data-pkc-field="editor-title"]');
  if (await ft.count()) await ft.fill('はこ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await createEntry(page, 'smart');
  const title = page.locator('[data-pkc-field="editor-title"]');
  if (await title.count()) await title.fill('フォルダぜんぶ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await page.locator(SMART_ROW).first().dblclick();
  await expect(page.locator(WHY)).toContainText('条件を選んでください');

  // 🔴 種類を選ぶ(実キーの change)
  await page.locator('[data-pkc-field="smart-kind"]').selectOption('folder');
  await expect(page.locator(ROWS), 'フォルダだけが集まっていない').toHaveCount(1);
  await expect(page.locator(ROWS).first()).toContainText('はこ');

  /**
   * ⚠ **対照群** ── 種類を「ノート」に変えると、集まるものが入れ替わる
   *   (SQL が当たっている証拠。⚠ 件数だけ見ると、常に全部返っていても 1 件になりうる)。
   */
  await page.locator('[data-pkc-field="smart-kind"]').selectOption('text');
  await expect(page.locator(ROWS)).toHaveCount(1);
  await expect(page.locator(ROWS).first(), '種類を変えても中身が同じ').toContainText(
    'ふつうのノート',
  );

  // 🔑 開き直しても効く(条件は本文に在る)
  await page.reload();
  await page.locator(SMART_ROW).first().dblclick();
  await expect(page.locator('[data-pkc-field="smart-kind"]'), '条件が残っていない').toHaveValue(
    'text',
  );
  await expect(page.locator(ROWS)).toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **語で絞る**(#421 段③)。
 *
 * 🔴 **unit では届かない層が 2 つ**:
 *   ① 語を当てるのは **worker の SQL**(FTS5 の trigram / LIKE)── fake は
 *      「当たり」を作って返すだけなので、索引が本当に効いているかは実物でしか出ない
 *   ② 打つ欄は **`change`**(Enter / 欄から出る)で来る ── 実キーの操作でしか通らない。
 *      ⚠ 直前まで binder は `<select>` しか受けておらず、`<input>` から来た値を
 *      **`''`(= 条件を外す)へ落としていた** ── その取り違えはここでしか鳴らない。
 */
test('🔴 語で絞ると、その語があるノートだけが集まる (#421 段③)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await useSplitEditor(page);
  await gotoApp(page);

  await makeNote(page, '請求のひかえ', '請求書をまとめた本文です\n');
  await makeNote(page, '買い物のメモ', '牛乳と卵を買う\n');

  await createEntry(page, 'smart');
  const title = page.locator('[data-pkc-field="editor-title"]');
  if (await title.count()) await title.fill('請求まわり');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await page.locator(SMART_ROW).first().dblclick();
  await expect(page.locator(WHY)).toContainText('条件を選んでください');

  // 🔴 語を打って Enter(実キーの change)
  const word = page.locator('[data-pkc-field="smart-text"]');
  await word.fill('請求書');
  await word.press('Enter');
  await expect(page.locator(ROWS), '語で絞れていない').toHaveCount(1);
  await expect(page.locator(ROWS).first()).toContainText('請求のひかえ');

  /**
   * ⚠ **対照群** ── 別の語に変えると集まるものが入れ替わる。
   *   ⚠ 件数だけ見ると、**常に 1 件返す**実装でも通ってしまう。
   */
  await word.fill('牛乳');
  await word.press('Enter');
  await expect(page.locator(ROWS)).toHaveCount(1);
  await expect(page.locator(ROWS).first(), '語を変えても中身が同じ').toContainText(
    '買い物のメモ',
  );

  // 🔑 開き直しても効く(条件は本文に在る)
  await page.reload();
  await page.locator(SMART_ROW).first().dblclick();
  await expect(page.locator('[data-pkc-field="smart-text"]'), '条件が残っていない').toHaveValue(
    '牛乳',
  );
  await expect(page.locator(ROWS)).toHaveCount(1);

  // 🔴 **空にして Enter で外れる**(片道の操作を作らない)
  await page.locator('[data-pkc-field="smart-text"]').fill('');
  await page.locator('[data-pkc-field="smart-text"]').press('Enter');
  await expect(page.locator(WHY), '条件が外れていない').toContainText('条件を選んでください');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **チェック項目で絞る**(#421 段④)。
 *
 * 🔴 **unit では届かない層**:確定は **worker が候補の本文を丸ごと読んで**行う。
 *   unit の fake は「当たり」を作って返すだけなので、
 *   ①`task_total` で候補に縮める SQL ②丸ごと読む列と塊の切り替え
 *   が本当に効いているかは**実物の sqlite** でしか分からない。
 */
test('🔴 「未処理がある」で、やり残しのあるノートだけが集まる (#421 段④)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await useSplitEditor(page);
  await gotoApp(page);

  await makeNote(page, 'やりかけの仕事', '- [ ] まだ\n- [x] 済み\n');
  await makeNote(page, '片づいた仕事', '- [x] 済み\n- [x] 済み\n');
  await makeNote(page, 'ただのメモ', '項目はありません\n');

  await createEntry(page, 'smart');
  const title = page.locator('[data-pkc-field="editor-title"]');
  if (await title.count()) await title.fill('やり残し');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await page.locator(SMART_ROW).first().dblclick();
  await expect(page.locator(WHY)).toContainText('条件を選んでください');

  /**
   * 🔴 **選ぶのは「画面に出ている字」で**(実キーの change)。
   *
   * ⚠ 値(`'true'` / `'false'`)で選ぶと、**字と値の対応が入れ替わっても気づけない**
   *   ── user が読むのは字のほうなので、入れ替わると
   *   「未処理がある」を選んだのに**全部済んだノートが出る**(変異試験 N15)。
   * 🔑 CLAUDE.md「文言は『押した場所』と対で pin する」の、選択肢版である。
   */
  const openSel = page.locator('[data-pkc-field="smart-openTasks"]');
  await openSel.selectOption({ label: '未処理がある' });
  await expect(page.locator(ROWS), '未処理で絞れていない').toHaveCount(1);
  await expect(page.locator(ROWS).first()).toContainText('やりかけの仕事');

  /**
   * ⚠ **対照群** ── 「全部済んでいる」に変えると中身が入れ替わる。
   *   ⚠ 件数だけ見ると、**常に 1 件返す**実装でも通ってしまう。
   */
  await openSel.selectOption({ label: '全部済んでいる' });
  await expect(page.locator(ROWS).first(), '向きを変えても中身が同じ').toContainText(
    '片づいた仕事',
  );

  /**
   * 🔴 **「項目がある」と AND で効く** ── 「全部済んでいる」だけだと
   *   **項目が 1 つも無いノート**も当たる(未処理 0 件なので)。
   */
  await page.locator('[data-pkc-field="smart-tasks"]').selectOption({ label: '項目がある' });
  await expect(page.locator(ROWS), '項目の有無を見ていない').toHaveCount(1);
  await expect(page.locator(ROWS).first()).toContainText('片づいた仕事');

  // 🔑 開き直しても効く(条件は本文に在る)
  await page.reload();
  await page.locator(SMART_ROW).first().dblclick();
  await expect(
    page.locator('[data-pkc-field="smart-openTasks"]'),
    '条件が残っていない',
  ).toHaveValue('false');
  await expect(page.locator(ROWS)).toHaveCount(1);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
