import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, createEntry, gotoApp, useSplitEditor } from './helpers';

/**
 * 🔴 **ノートへのリンクを、書きながら入れる**(#427 段②)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * 1. 🔴 **caret が実機で戻るか** ── `<dialog>` は焦点を借りて返すが、
 *    **選択位置までは返さない**。⚠ happy-dom は `showModal()` でも選択を保つので、
 *    **unit は緑のまま出荷される** ── `insert-date` が 2026-08-23 にこれで
 *    「日付が本文の先頭に入る」を実機で踏んだ(CLAUDE.md §5「環境差」)
 * 2. **開いた直後に打てるか**(焦点が探す欄に在るか)
 * 3. **入れたリンクが本当に押せる**(貼った字が記法として成立している)
 */
test('🔴 題名で選ぶと caret の位置にリンクが入り、押すと相手が開く (#427 段②)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // ⚠ `addInitScript` なので **`gotoApp` より前**に呼ぶ(呼ぶ順を間違えると効かない)
  await useSplitEditor(page);
  await gotoApp(page);

  // 相手になるノートを作る
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('先週の議事録');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // 書く側のノート
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('今日の会議');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  /**
   * 🔴 **caret を「途中」に置く**(末尾ではない)。
   *
   * ⚠ 末尾に置くと**弱い観測点**になる ── caret を見失った実装は
   *   たいてい先頭か末尾へ落ちるので、**末尾は壊れた側と当たりが同じ**である。
   *   途中に置けば、先頭へ落ちても末尾へ落ちても**どちらも見分けられる**。
   * ⚠ `insert-date` が 2026-08-23 に実機で踏んだのは「本文の先頭に入る」──
   *   `<dialog>` は焦点を借りて返すが、**選択位置までは返さない**。
   */
  await ta.fill('まえBBうしろ');
  await ta.click();
  await page.keyboard.press('End');
  // 「うしろ」(3 文字)ぶん戻す ── caret は「まえBB|うしろ」に在る
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowLeft');

  await clickReal(page, '[data-pkc-action="insert-entry-link"]');
  const filter = page.locator('[data-pkc-field="entry-pick-filter"]');
  await expect(filter, '開いた直後に探す欄へ焦点が無い').toBeFocused();

  // 絞る ── 書いている側(今日の会議)は候補に出ない
  await page.keyboard.type('議事');
  const rows = page.locator('[data-pkc-field="entry-pick-row"]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('先週の議事録');

  await page.keyboard.press('Enter');
  await expect(page.locator('[data-pkc-region="app-dialog"]')).toBeHidden();

  /**
   * 🔴 **caret の位置に入ったか** ── 先頭に入っていたら `つづき:` の前に
   *   来るので、前方一致で見分けられる。
   *
   * ⚠ **待って読む**(`expect.poll`)。器が閉じるのと本文へ挿すのは**別の回**で
   *   起きる ── 選んだ答えは `Promise` で返ってくるので、`toBeHidden()` が
   *   通った瞬間にはまだ挿さっていないことがある(手元で 3 回に 1 回落ちた)。
   * ⚠ **待つ形にしないと、殺しているのが主張なのか競走なのか分からない**
   *   ── 1 回だけ読む形は「まだ挿さっていない」でも落ちるので、
   *   **どの変異も KILLED に見える**。実際 `setSelectionRange` を外す変異は、
   *   待つ形にした瞬間 `SURVIVED` になった ── ⚠ **前の KILLED は競走による
   *   偽の当たり**だった(CLAUDE.md §3「NOT-APPLIED を合格と読まない」の裏返しで、
   *   **KILLED も理由を確かめないと信じられない**)。
   *
   * 🔴 **その `setSelectionRange` は、この面では等価である**(2026-08-26 実測)。
   *   ⚠ Chromium はこの器を閉じるとき **textarea の選択位置を戻す**ので、
   *   控えた `at` を入れ直しても同じ所になる。
   * 🔑 **観測点が死んでいるのではない** ── `setSelectionRange(0, 0)` に変える
   *   変異は **KILLED** なので、この it は caret の位置を**見えている**。
   * ⚠ それでも行を残すのは、`insert-date` が 2026-08-23 に**実機で
   *   「本文の先頭に入る」を踏んでいる**からである(器も焦点の経路も違う)。
   *   ⚠ これは「効いているから残す」ではなく「**安いので残す**」であり、
   *   CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れるのを見る」に
   *   従って**壊れないことを見たうえで**そう書いている。
   */
  await expect
    .poll(() => ta.inputValue(), { message: 'caret の位置にリンクが入っていない' })
    .toMatch(/^まえBB\[先週の議事録\]\(entry:[^)]+\)うしろ$/);

  await clickReal(page, '[data-pkc-action="commit-edit"]');

  /**
   * ③ 貼った字が**記法として成立している**(押すと相手が開く)。
   * ⚠ 見るのは `data-pkc-action="navigate-entry-ref"` ── ただの `<a>` だと、
   *   **アプリ内リンクとして焼かれていなくても**当たってしまう
   *   (`body-links.smoke` と同じ観測点に揃えた)。
   */
  const link = page.locator('[data-pkc-field="detail-body"] [data-pkc-action="navigate-entry-ref"]');
  await expect(link, '貼ったリンクが押せる形になっていない').toHaveCount(1);
  await expect(link).toContainText('先週の議事録');
  const urlBefore = page.url();
  await clickReal(page, '[data-pkc-field="detail-body"] [data-pkc-action="navigate-entry-ref"]');
  await expect(
    page.locator('[data-pkc-field="detail-title"]'),
    '押しても相手のノートが開かない',
  ).toContainText('先週の議事録');
  // ⚠ 未知スキームへ遷移していない(`entry:` は アプリが受ける)
  expect(page.url(), 'ブラウザが未知スキームへ遷移した').toBe(urlBefore);

  expect(errors, `page error: ${errors.join(' / ')}`).toHaveLength(0);
});
