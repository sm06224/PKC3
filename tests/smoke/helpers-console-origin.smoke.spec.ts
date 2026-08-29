/**
 * 🔴 **赤が「どの面から出たか」を言うか**(#561、2026-08-29)。
 *
 * ⚠ `collectPageErrors` は **55 本の spec が使う計器**である ── 計器が壊れると
 *   「通った」という事実だけが残る(CLAUDE.md「検品する側も変異試験の対象」)。
 * 🔴 出た文脈:CI で `Error: <svg> attribute width: Expected length, "9…` が 1 度だけ
 *   落ちたが、赤の 1 行からは **アプリが壊れたのか、囲みの中身が書きかけだったのか**が
 *   区別できなかった。⚠ `page.on('console')` は**子 frame の分も上がる**ので、
 *   PKC3 のように html / svg を **sandbox の iframe(`srcdoc`)**で描くアプリでは、
 *   出所を書かない限り**箱の中とアプリ本体が同じ顔**になる。
 *
 * 🔑 ここで pin するのは 2 つ:
 *   ① 箱の中で出たエラーが **`about:srcdoc` と名乗る**
 *   ② ⚠ **対照群** ── 正しい絵なら **0 件**(計器が「常に何か出す」形になっていない)
 *
 * ⚠ ①は**わざと壊した属性**で起こす(打鍵の途中を狙わない)── 時間に依存させると、
 *   この spec 自身が間欠になる。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal, createEntry, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/** ⚠ `9px%` は長さとして読めない ── ブラウザが箱の中で console.error を出す。 */
const BROKEN = '<svg xmlns="http://www.w3.org/2000/svg" width="9px%" height="40"></svg>';
const SOUND = '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="40"></svg>';

async function writeSvg(page: import('@playwright/test').Page, svg: string): Promise<void> {
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  // ⚠ **一度に入れる**(打鍵の途中の書きかけを箱へ届けない ── #561 の本体)
  await ta.fill('```svg\n' + svg + '\n```');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  // 箱が実際に描くまで待つ(描かれなければ①の主張は空振りになる)
  await expect(page.locator('iframe[data-pkc-html-render-id]')).toHaveCount(1);
}

test('🔴 箱の中から出た console.error は about:srcdoc と名乗る (#561)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await writeSvg(page, BROKEN);

  await expect
    .poll(() => errors.length, { timeout: 5_000 })
    .toBeGreaterThan(0);
  const line = errors.join('\n');
  // ⚠ 前提 ── 拾ったのが**当のエラー**であること(別の赤で満たされていない)
  expect(line, `別のエラーで満たされている: ${line}`).toContain('attribute width');
  // 🔴 本題 ── **どの document から出たか**が読める
  expect(line, `出所が書かれていない: ${line}`).toContain(' @ about:srcdoc');
  // ⚠ 行番号 0 を付けない(「1 行目で起きた」と読めてしまう)
  expect(line).not.toContain('about:srcdoc:0');
});

test('🔴 対照群 ── 正しい絵なら 1 件も出ない(常に何か出す計器ではない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await writeSvg(page, SOUND);
  await page.waitForTimeout(500); // 遅れて来る分も拾う
  expect(errors, errors.join('\n')).toEqual([]);
});
