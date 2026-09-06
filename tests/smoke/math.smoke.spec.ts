import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

/**
 * 🔴 **数式が本当に数式の形で出る**(#707。user 裁定 2026-09-06「入れる」)。
 *
 * 🔴 **かつてここには「unit では原理的に届かない」と書いてあったが、嘘だった**
 *   (着地前レビュー 2026-09-06)。⚠ `setMathWorkerSpawn` は test のために
 *   開けてある口で、**誰も使っていなかっただけ**である ── CLAUDE.md §2
 *   「worker は node で動く。『worker の中だから unit では届かない』は誤り」。
 *   いまは `tests/adapter/math-hydrate.test.ts` が配線を見る
 *   (順番 / 塊の印 / 失敗したら打った字が残る / `prune()` の窓)。
 * 🔑 **ここでしか分からないのは 1 つだけ**:**本当に数式の形に組めるか**
 *   (KaTeX の実物と、書体が当たっているか)。
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
  // ⚠ **待つ**(着地前レビュー L5)── `status` は読み込みが終わって初めて立つので、
  //    遅い回で 0 を読みうる。⚠ 歯は在る(woff2 が届かなければ `error` になり 0 のまま)
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            [...document.fonts].filter(
              (f) => f.family.startsWith('KaTeX') && f.status === 'loaded',
            ).length,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **書き間違えた式**(#707。user 裁定 2026-09-06 =「打った字 + 式が読めません」)。
 * ⚠ **本物の KaTeX でしか見られない** ── 偽のワーカーでは「何が読めない式か」を
 *   決められない(unit の台はこちらが答えを決めてしまう)。
 */
test('🔴 書き間違えた式は、打った字が残って理由が出る (#707)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('壊れた式 $E = mc^^2$ と、正しい式 $a+b$。\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const body = page.locator('[data-pkc-region="detail"] .pkc-md-rendered').first();
  // ⚠ 対照群を先に待つ ── 正しい式が組めていなければ、以下は判定になっていない
  await expect(body.locator('.katex')).toHaveCount(1, { timeout: 15_000 });

  const broken = body.locator('[data-pkc-math-state="failed"]');
  await expect(broken, '壊れた式に失敗の印が付いていない').toHaveCount(1);
  await expect(broken, '打った字が残っていない').toContainText('$E = mc^^2$');
  await expect(broken.locator('.pkc-math-error'), '理由が画面に出ていない').toHaveText(
    '式が読めません',
  );
  // 🔴 **英語のエラーを画面に出さない**(属性にだけ残す)
  expect(await broken.textContent(), 'KaTeX の英語のエラーが画面に出ている').not.toContain(
    'KaTeX',
  );
  expect(
    await broken.getAttribute('data-pkc-math-error'),
    '理由が属性に残っていない(報告の材料が消える)',
  ).toBeTruthy();

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **書式パネルの「数式」**(#707。user 裁定 2026-09-06)。
 * ⚠ 直す前は「数式が書ける」と知る道が**起動時のお知らせ 1 回**か
 *   ヘルプの下のほうだけだった ── 表・図・コードブロックには押す所が在るのに、
 *   数式だけ無いという非対称だった。
 */
test('🔴 書式パネルの「数式」を押すと $$ の囲みが入る (#707)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  const editor = page.locator('[data-pkc-field="editor-body"]');
  await editor.fill('前の行\n');
  await editor.click();
  await page.keyboard.press('Control+End');
  await clickReal(page, '[data-pkc-format="math"]');
  const text = await editor.inputValue();
  expect(text, '$$ の囲みが入っていない').toContain('$$\n\n$$');
  // ⚠ **打ち始められる所に caret が来る**(囲みの中)── 来ないと、押した直後に
  //    どこへ打てばよいか分からない
  const at = await editor.evaluate((el) => (el as HTMLTextAreaElement).selectionStart);
  expect(text.slice(0, at), 'カーソルが囲みの中に来ていない').toMatch(/\$\$\n$/);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
