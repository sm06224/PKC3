import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors } from './helpers';

/**
 * 🔴 **`#pkc?view=…` で開くと、その面で立ち上がる**(#300 段②)。
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * ① **本物のアドレスから読めるか** ── unit は的を差し替えて通しているので、
 *    `location.hash` を実際に読む配線(`windowDeepLinkTarget`)は 1 度も走らない
 * ② **面が本当に見えているか** ── `hidden` の付け替えと CSS の噛み合いは
 *    happy-dom では読めない
 * ③ 🔴 **断片が実際に消えるか** ── `history.replaceState` の効きは実ブラウザにしかない。
 *    ⚠ ここが効かないと、更新の適用や昇格で読み直しが起きた瞬間に、
 *    user が見ていた場所からその面へ飛ばされる
 */
test('🔴 #pkc?view=calendar で開くと、カレンダーの面で立ち上がる (#300)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/#pkc?view=calendar');
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });

  // ② 面が見えていて、本文の面は畳まれている
  await expect(
    page.locator('[data-pkc-view-pane="calendar"]'),
    'ディープリンクで指した面が開いていない',
  ).toBeVisible();
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeHidden();

  /**
   * 🔴 **見ている間は断片が残る**(2026-08-22 に「読んだら消す」から翻した)。
   * ⚠ 消すと、マニュアルが案内している `Ctrl+D` が**素の URL**を拾い、
   *   「**成功した人だけがブックマークを作れない**」形になる。
   */
  expect(
    await page.evaluate(() => location.hash),
    '見ている間に断片が消えた(ブックマークが作れない)',
  ).toBe('#pkc?view=calendar');

  /**
   * 🔴 **読み直しても同じ面のまま**(user は更新しただけで、画面を替えていない)。
   * ⚠ ここは**初回訪問の分離のための読み直し**(#111)と同じ窓でもある ──
   *   断片を boot で消していた初稿は、その読み直しに食われて本文へ落ちていた。
   */
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(
    page.locator('[data-pkc-view-pane="calendar"]'),
    '読み直したら面が消えた',
  ).toBeVisible();

  /**
   * 🔴 **user が自分で離れたら、その瞬間に断片が消える。**
   * ⚠ 残ると、本文を読み始めた後の読み直しでこの面へ飛ばされる。
   */
  await clickReal(page, '[data-pkc-action="close-pane"]');
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeVisible();
  expect(
    await page.evaluate(() => location.hash),
    '離れても断片が残る ── 読み直しでこの面へ飛ばされる',
  ).toBe('');

  /**
   * 🔴 **履歴を積んでいない**(`replaceState` であること)。
   * ⚠ `pushState` だと「戻る」が**同一文書内の断片移動**になり、画面が
   *   1 ドットも動かない ── user は「戻るが壊れている」と読み、2 回押す。
   * ⚠ この機構を見ている test は、直前まで 1 件も無かった(着地前レビュー)。
   */
  await page.goBack();
  expect(
    new URL(page.url()).hash,
    '断片を history に積んだ(戻るで PKC から出られない)',
  ).toBe('');

  expect(errors, 'pageerror / console.error が出ている').toEqual([]);
});

/**
 * ⚠ **対照群** ── 断片が無ければ、今までどおり本文の面で立ち上がる。
 * これが無いと、上の spec は「常にカレンダーが開く」実装でも通る。
 */
test('⚠ 対照群 ── 断片が無ければ本文の面で立ち上がる (#300)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeVisible();
  await expect(page.locator('[data-pkc-view-pane="calendar"]')).toBeHidden();
  expect(errors, 'pageerror / console.error が出ている').toEqual([]);
});

/**
 * 🔴 **知らない面の名前は、黙って捨てず理由を出す**(実画面で読めること)。
 * ⚠ unit は文言を見ているが、**それが状態の行に届くか**は実ブラウザでしか見えない。
 */
test('🔴 知らない面の名前は、画面に理由が出る (#300)', async ({ page }) => {
  await page.goto('/#pkc?view=nosuchpane');
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('[data-pkc-view-pane="detail"]')).toBeVisible();
  const status = page.locator('[data-pkc-region="status"]');
  // 🔑 **打つ字が出ていること**(画面の呼び名を出すと、user は打てない字で書き直す)
  await expect(status, '知らない面を黙って捨てている').toContainText('calendar');
  await expect(status, '打てない字(画面の呼び名)を出している').not.toContainText('カレンダー');
  // ⚠ 使えない名前は残す意味が無いので、その場で消す(断り文が読み直しのたびに出ない)
  expect(await page.evaluate(() => location.hash), '使えない断片が残っている').toBe('');
});
