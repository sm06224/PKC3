/**
 * 🔴 **「今日」を押すと、その日のノートが開く**(#348、user 裁定 2026-08-23)。
 *
 * ⚠ unit は**規則と繋がり**を見る。ここが見るのは **user が実際に押せるか**である
 * ── happy-dom では「要素が在る」ことまでしか分からず、
 * **覆われていないか / 押せるか**は実ブラウザにしか無い。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, collectPageErrors } from './helpers';

test('🔴 「今日」を押すと今日の日付のノートが開き、2 度目でも増えない', async ({ page }) => {
  /**
   * 🔴 **例外を 1 度も見ていなかった**(#713、2026-09-05)。
   * ⚠ この spec はアプリを開いて 2 度押すのに、`pageerror` も `console.error` も
   *   拾っていなかった ── **本文の作成が例外で落ちても、行が 1 件なら緑**である。
   * 🔑 `collectPageErrors` は落ちた Promise も拾う(Chromium は unhandled rejection を
   *   `pageerror` として上げる ── 2026-09-05 に実測)。
   */
  const errors = collectPageErrors(page);
  await gotoApp(page);

  const today = await page.evaluate(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });

  await clickReal(page, '[data-pkc-bar-tile][data-pkc-action="open-today"]');
  // ⚠ 作成の直後は**編集に入る** ── 題名は編集の面に出る
  const title = page.locator('[data-pkc-field="editor-title"], [data-pkc-field="detail-title"]');
  await expect(title.first(), '今日の日付のノートが開いていない').toHaveValue(
    new RegExp(today),
  );
  /**
   * 🔴 **作った直後のカーソルは本文**(題名は日付のまま)(#1087 流れ 29 Q1。Gemini 裁定 = #1163 への依頼 29)。
   * ⚠ 他の作り方(「ノートを作る」)は今までどおり題名に当たる ── 「今日」だけが本文。
   */
  // ⚠ ライブエディタの行は描き終えてから焦点を取る(実測: 押した直後は body、100ms 以内に行の入力欄)── 待って見る
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (el === null) return 'なし';
          if (el.matches('[data-pkc-field="editor-title"]')) return '題名';
          const editable =
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLInputElement ||
            el.isContentEditable;
          return editable && el.closest('[data-pkc-region="detail"]') !== null ? '本文' : 'その他';
        }),
      { message: 'カーソルが本文の編集欄に入らない(題名ではなく本文であるべき)' },
    )
    .toBe('本文');

  // 編集を確定してから、もう一度押す
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-bar-tile][data-pkc-action="open-today"]');
  // 🔴 既にある日は、カーソルが本文の下の追記欄に入る
  await expect(page.locator('[data-pkc-field="append-input"]'), 'カーソルが追記欄に無い').toBeFocused();

  // 🔴 キー(Alt+T)でも同じ ── 焦点を外してから押しても、追記欄へ戻る(#1087 流れ 29 Q2)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Alt+t');
  await expect(page.locator('[data-pkc-field="append-input"]'), 'Alt+T で追記欄に入らない').toBeFocused();

  /**
   * 🔴 **2 度目で増えない**(その日の入れ物は 1 つ)。
   * ⚠ 一覧の**その題名の行**を数える ── 全件を数えると、他の理由で増えた分に
   *   救われて空振りする。
   */
  const rows = page.locator(`[data-pkc-entry]`, { hasText: today });
  await expect(rows, '押すたびに増えている').toHaveCount(1);

  /**
   * 🔴 #1640 項 1: ▼ から「今日」の種類を選べ、選んだ種類を覚える(戻す道もある)。
   * 既に今日のノートが在るので、種類を変えても行は増えない(在る日は種類を問わず開く)。
   */
  const menuItems = '[data-pkc-region="create-menu"] [data-pkc-action="open-today-as"]';
  await clickReal(page, '[data-pkc-action="toggle-create-menu"]');
  await expect(page.locator(menuItems), '種類つきの「今日」が 2 つ並んでいない').toHaveCount(2);
  await clickReal(page, `${menuItems}[data-pkc-archetype="textlog"]`);
  expect(await page.evaluate(() => localStorage.getItem('pkc3.today-kind')), '選んだ種類を覚えていない').toBe('textlog');
  await expect(rows, '種類を選んだら行が増えた').toHaveCount(1);
  await clickReal(page, '[data-pkc-action="toggle-create-menu"]');
  await clickReal(page, `${menuItems}[data-pkc-archetype="text"]`);
  expect(await page.evaluate(() => localStorage.getItem('pkc3.today-kind')), 'ノートへ戻せない').toBe('text');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
