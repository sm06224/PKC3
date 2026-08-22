import { test, expect } from '@playwright/test';
import { collectPageErrors } from './helpers';

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

  // ③ 🔴 断片が消えている(読み直しても同じ面へ飛ばされない)
  expect(
    await page.evaluate(() => location.hash),
    '断片が残る ── 読み直しのたびにこの面へ飛ばされる',
  ).toBe('');

  /**
   * ⚠ **消えたことを「読み直して」確かめる** ── `location.hash` が空でも、
   *   別の口(`history.state` 等)に残っていれば意味が無い。
   *   🔑 実際に読み直して**本文の面で立ち上がる**ところまで見る。
   */
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(
    page.locator('[data-pkc-view-pane="detail"]'),
    '読み直したのにディープリンクの面へ戻った',
  ).toBeVisible();

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
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '知らない面を黙って捨てている',
  ).toContainText('ありません');
});
