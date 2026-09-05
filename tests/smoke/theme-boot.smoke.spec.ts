import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers';

/**
 * 🔴 **OS がダークの端末で、最初に白い画面が出ない**(#718)。
 *
 * ## 何が起きていたか
 *
 * 配色を当てるのはアプリ本体(`main.ts` の `applyTheme(…, initialTheme())`)で、
 * それは module script なので **CSS を読み終えた後**に走る ── その間の 1 フレームは
 * `tokens.css` の素の `:root`(= ライト)で描かれるので、暗い部屋の user には
 * **起動のたびに白が瞬く**。
 *
 * ## 観測点(なぜ「最後の配色」を見ないか)
 *
 * ⚠ **最後に付いている配色を見ても、この主張は 1 ミリも検めていない** ── inline script を
 *   丸ごと消しても `main.ts` が同じ `dark` を当てるので、**直す前も後も緑**である
 *   (CLAUDE.md §1「挙動を変えたのに test が前も後も通るなら、それは守っていない」)。
 * 🔑 だから見るのは**時期**である:**`<body>` が生えた時点で、もう配色が付いているか**。
 *   inline script は `<head>` で走るので必ず先、`main.ts` は module なので必ず後になる。
 * ⚠ `data-pkc-theme` の**変化**を数えるのではなく、`<body>` の出現を待って**そのとき
 *   の値**を採る ── 変化を数えると、`main.ts` が同じ値を当て直した回で区別が付かない。
 */
test('🔴 OS がダークなら、body が生える前に配色が当たっている', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w['__pkcThemeAtBody'] = null;
      /**
       * 🔴 **見張る相手は `document` である**(実測 2026-09-05)。
       *
       * ⚠ init script が走る時点では **`document.documentElement` が `null`** ──
       *   パーサはまだ `<html>` を作っていない。`observe(document.documentElement, …)` と
       *   書くとその場で例外になり、⚠ **観測点が丸ごと死んだまま `null` が残る**
       *   (= 「直っていない」と読める。CLAUDE.md §4「対照群が届かない回」の顔)。
       * 🔑 `document` なら必ず在るので、`subtree` で `<html>` / `<body>` の挿入まで拾う。
       */
      const obs = new MutationObserver(() => {
        if (document.body === null) return;
        w['__pkcThemeAtBody'] = document.documentElement.getAttribute('data-pkc-theme');
        obs.disconnect();
      });
      obs.observe(document, { childList: true, subtree: true });
    });
    await gotoApp(page);

    // 🔴 本題 ── 枠より先に配色が当たっている
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>)['__pkcThemeAtBody']),
      'body が生えた時点で配色が当たっていない(起動の一瞬だけ白くなる)',
    ).toBe('dark');

    /**
     * 🔑 **対照群** ── 観測点が死んでいない(= 器がちゃんと起動した)ことを見る。
     * ⚠ これが無いと、`__pkcThemeAtBody` が `null` の回を「直っていない」と読むのか
     *   「そもそも読み込めていない」と読むのか区別できない。
     */
    await expect(page.locator('html')).toHaveAttribute('data-pkc-theme', 'dark');
    // 枠の色も地の色に揃う(固定の `#0f172a` のままではない)
    const meta = await page
      .locator('meta[name="theme-color"]')
      .getAttribute('content', { timeout: 10_000 });
    expect(meta?.toLowerCase(), '枠の色がダークの地の色になっていない').toBe('#14171a');
  } finally {
    await context.close();
  }
});
