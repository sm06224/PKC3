import { test, expect } from '@playwright/test';
import { collectPageErrors, createEntry, gotoApp, useListBrowse, useSplitEditor } from './helpers';

/**
 * 🔴 **その場で計算**(#764。user 裁定 2026-09-06「PKC2 と同じで」)。
 *
 * 🔴 **unit では原理的に届かない層が 1 つある**:
 *   答えを差し込んだあと、**ブラウザが自分で改行を入れる**ところ。
 *   実装は `preventDefault` を**しない**ので、改行は既定の動作に委ねている ──
 *   happy-dom は `keydown` で字を入れないから、**そこは 1 度も走らない**。
 *   ⚠ ここが壊れると「答えは出るが改行しない」「改行が答えの**前**に入る」
 *   という、user がいちばん困る形になる(打ち続けられない)。
 *
 * 🔑 だから見るのは **user が見る所** ── 打ち終えた欄の字そのものである。
 */
test.beforeEach(async ({ page }) => {
  await useListBrowse(page);
  await useSplitEditor(page);
});

test('🔴 `=` まで打って Enter を押すと、答えが出て次の行へ進む (#764)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.click();

  await page.keyboard.type('請求は 1200*1.1=');
  await page.keyboard.press('Enter');
  // ⚠ 答えの**後ろ**に改行が入る(前に入ると、答えが次の行へ落ちる)
  await expect(ta).toHaveValue('請求は 1200*1.1=1320\n');

  // 🔑 そのまま打ち続けられる(caret が答えの後ろの新しい行に在る)
  await page.keyboard.type('内訳');
  await expect(ta).toHaveValue('請求は 1200*1.1=1320\n内訳');

  /**
   * 🔴 **打ち込まれた答えは `Ctrl`+`Z` で戻せる**(マニュアルに書いた約束)。
   *
   * ⚠ **`setRangeText` では戻せなかった**(2026-09-07 実測)── 6 回押しても
   *   `請求は 1200*1.1=1320` で止まり、**自分で打った字にすら戻れなかった**
   *   (取り消しの履歴ごと切れる)。`insertText`(`execCommand`)に替えて解けた。
   * 🔴 **この差は本物のブラウザにしか無い** ── happy-dom に取り消しの履歴は無く、
   *   しかも `execCommand` が無いので unit は**必ず fallback を通る**(CLAUDE.md §2)。
   * ⚠ 押す回数は固定しない ── 打った字の取り消しの粒度はブラウザが決める。
   *   見るのは「**答えが消えて、打った字が残る所へ戻れる**」ことである。
   */
  const seen: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Control+z');
    seen.push(await ta.inputValue());
  }
  expect(seen, `取り消しで打った字へ戻れない: ${JSON.stringify(seen)}`).toContain(
    '請求は 1200*1.1=',
  );

  expect(errors, errors.join('\n')).toHaveLength(0);
});

/**
 * 🔴 **引用の行でも取り消せる**(#765 を #764 の中で直した)。
 *
 * ⚠ 引用の継ぎ足しは長らく `setRangeText` で書いており、**取り消しの履歴ごと
 *   切っていた** ── 実測(2026-09-07)では `> ひきよう` で `Enter` を押すと、
 *   以後 `Ctrl`+`Z` を 8 回押しても 1 文字も戻らなかった。
 * 🔴 この PR は「出た答えは `Ctrl`+`Z` で戻せます」と**お知らせとマニュアルで
 *   約束する**ので、引用の行だけ嘘になるのを許さない。
 * 🔴 **unit では原理的に見えない** ── happy-dom に取り消しの履歴は無い。
 */
test('🔴 引用の行で計算しても、取り消しで打った字へ戻れる (#764 / #765)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.click();

  await page.keyboard.type('> 1200*1.1=');
  await page.keyboard.press('Enter');
  // ⚠ 計算が入り、そのうえで引用が継ぎ足される(2 つの仕掛けが同じ Enter に乗る)
  await expect(ta).toHaveValue('> 1200*1.1=1320\n> ');

  const seen: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Control+z');
    seen.push(await ta.inputValue());
  }
  expect(seen, `引用の行で取り消しが効かない: ${JSON.stringify(seen)}`).toContain(
    '> 1200*1.1=',
  );

  expect(errors, errors.join('\n')).toHaveLength(0);
});

test('⚠ 式でない `=` では、ただ改行するだけ (#764)', async ({ page }) => {
  // 🔑 対照群 ── これが無いと「常に何か足す」実装でも上の test が通ってしまう
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.click();

  await page.keyboard.type('締切=');
  await page.keyboard.press('Enter');
  await expect(ta).toHaveValue('締切=\n');

  expect(errors, errors.join('\n')).toHaveLength(0);
});
