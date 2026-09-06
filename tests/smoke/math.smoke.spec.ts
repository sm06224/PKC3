import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

/**
 * 🔴 **数式が本当に数式の形で出る**(#707。user 裁定 2026-09-06「入れる」)。
 *
 * ⚠ **unit では原理的に届かない** ── 描くのはワーカー(KaTeX)で、
 *   happy-dom に Worker は無い。「器が出る」ところまでは unit が見るが、
 *   **中身が数式になったか**はここでしか分からない。
 *
 * 観測点は 4 つ:
 * ① 行の中の `$…$` が `.katex` になる
 * ② 行頭の `$$` の塊が**中央寄せ**の形で出る
 * ③ 🔴 **金額と差し込みは数式にならない**(門が効いている)
 * ④ 🔴 **書体が本当に当たっている**(woff2 を 1 本だけ配る細工が効いている)
 */
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

test('🔴 数式が数式の形で出る / 金額と差し込みは字のまま (#707)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(
    [
      '行の中は $E = mc^2$ です。',
      '',
      '$$',
      '\\int_0^1 x^2 dx = \\frac{1}{3}',
      '$$',
      '',
      '料金は $100 です。${宛名} 様。',
      '',
    ].join('\n'),
  );
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const body = page.locator('[data-pkc-region="detail"] .pkc-md-rendered').first();
  // ① 行の中の数式が描かれる(⚠ ワーカー経由なので待つ)
  await expect(body.locator('.pkc-math[data-pkc-math-display="0"] .katex')).toHaveCount(1, {
    timeout: 15_000,
  });
  // ② 塊の数式も描かれる
  const block = body.locator('.pkc-math-display');
  await expect(block.locator('.katex')).toHaveCount(1);
  // ⚠ 空振り防止 ── 失敗の印が付いていないこと(付いていたら原文が残っているだけ)
  await expect(block).toHaveAttribute('data-pkc-math-state', 'done');

  /**
   * ② 塊は**中央寄せ**で出る(行の中のものは行に沿う)。
   * ⚠ `text-align` の字面ではなく**組んだ位置**で見る ── 規則が在っても
   *   詳細度で外れていれば中央には来ない。
   */
  const centered = await block.evaluate((el) => {
    const host = el.parentElement!;
    const r = el.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const k = el.querySelector('.katex')!.getBoundingClientRect();
    // 器の中で、式が左右どちらにも寄っていない(± 4px)
    return Math.abs(k.left - r.left - (r.right - k.right)) < 4 && h.width > 0;
  });
  expect(centered, '塊の数式が中央に来ていない').toBe(true);

  /**
   * ③ 🔴 **門が効いている** ── 金額と差し込みは数式にしない。
   * ⚠ ここが本命である(#707 の「覆る条件」に書いた当のもの)。
   */
  const plain = await body.evaluate((el) => el.textContent ?? '');
  expect(plain, '金額が消えた(数式として飲まれた)').toContain('料金は $100 です。');
  expect(plain, '差し込みの印が消えた(数式として飲まれた)').toContain('${宛名} 様。');
  const inMoneyLine = await body
    .locator('p', { hasText: '料金は' })
    .locator('.pkc-math')
    .count();
  expect(inMoneyLine, '金額の行に数式の器ができている').toBe(0);

  /**
   * ④ 🔴 **書体が当たっている**(`build/katex-woff2-plugin.ts` が woff2 だけ残す)。
   * ⚠ 「`.katex` が在る」だけでは、代替書体で崩れて出ていても緑になる ──
   *   ブラウザが**実際に読み込んだ書体**を数える。
   */
  const fonts = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.family.startsWith('KaTeX') && f.status === 'loaded').length,
  );
  expect(fonts, 'KaTeX の書体が 1 本も読み込まれていない(字が代替書体で崩れる)').toBeGreaterThan(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
