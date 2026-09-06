import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

// ⚠ 既定は live ── この test は**読む面**の主(「編集」)を見るので、
//    保存して読む面へ戻れる split で組む(live の顔は unit と別の spec が守る)。
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * 🔴 **その面の「主の操作」だけ、地と字が反転して見える**(#722 P2-10。
 * user 裁定 2026-09-06 = 案 A)。
 *
 * ⚠ **unit では原理的に届かない** ── happy-dom は CSS を組まないので、印
 * (`data-pkc-primary`)が付いているかしか見られない。**本当に濃く見えるか**は
 * ここでしか分からない。⚠ しかも規則は**詳細度で外れやすい**
 * (`button:hover:not(:disabled)` は `button[data-pkc-primary]` より強い)ので、
 * **乗せたときも濃いまま**を見る。
 *
 * 観測点は 3 つ:
 * ① 主のボタンの地が、**普通のボタンの字の色**と同じ(= 対を入れ替えている)
 * ② 主のボタンの字が、**普通のボタンの地の色**と同じ
 * ③ 🔴 **乗せても濃いまま**(詳細度の罠を落とす)
 * ⚠ 空振り防止:同じ面の普通のボタンの地と**違う**ことを見る(同じなら反転していない)。
 */
test('🔴 主の操作だけ地と字が反転して見える (#722 P2-10)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('本文です。\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  /**
   * 🔴 **鼠を退かしてから測る**(変異試験 M5 が SURVIVED で教えた)。
   * ⚠ `clickReal` の直後は**押した場所に鼠が残る**ので、帯が描き直されると
   *   新しい「編集」が**乗せられた状態**で出る ── そこで測ると、
   *   `:hover` の規則が当たった値を「素の見え方」として読んでしまう。
   *   実際、素の規則から `color` を消す変異が**smoke を素通りした**
   *   (hover 側の `color` に救われていた ── CLAUDE.md §1「救い手が変わっただけ」)。
   */
  await page.mouse.move(0, 0);

  const paint = async (sel: string): Promise<{ bg: string; fg: string }> =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      if (el === null) throw new Error(`前提が崩れている: ${s} が無い`);
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, fg: cs.color };
    }, sel);

  // 読む面の主 =「編集」
  const primary = await paint('[data-pkc-region="detail"] button[data-pkc-primary]');
  // 同じ面の普通のボタン(コピーの帯)
  const plain = await paint(
    '[data-pkc-region="detail"] button[data-pkc-action="copy-note-md"]',
  );

  // ⚠ 空振り防止 ── 反転していなければ、以下の 2 つは自明に成り立つ
  expect(primary.bg, `主のボタンの地が普通のボタンと同じ(${primary.bg})── 濃くなっていない`).not.toBe(
    plain.bg,
  );
  // ① 主の地 = 普通の字 / ② 主の字 = 普通の地
  expect(primary.bg, `地が入れ替わっていない(主 ${primary.bg} / 普通の字 ${plain.fg})`).toBe(plain.fg);
  expect(primary.fg, `字が入れ替わっていない(主 ${primary.fg} / 普通の地 ${plain.bg})`).toBe(plain.bg);

  // ③ 🔴 乗せても濃いまま(`button:hover` のほうが詳細度が高い ── 書き足さないと外れる)
  await page.locator('[data-pkc-region="detail"] button[data-pkc-primary]').hover();
  const hovered = await paint('[data-pkc-region="detail"] button[data-pkc-primary]');
  expect(hovered.bg, `乗せたら地が普通のボタンへ戻った(${hovered.bg})`).toBe(primary.bg);

  /**
   * 🔴 **1 面に 1 つだけ**。⚠ 左の列の「+ ノート」と中央で **2 つ**が上限
   * (面が別なら別々に 1 つずつ)。
   */
  const counts = await page.evaluate(() =>
    ['sidebar', 'detail', 'append', 'inspector'].map((r) => ({
      r,
      n: document.querySelectorAll(`[data-pkc-region="${r}"] button[data-pkc-primary]`).length,
    })),
  );
  for (const { r, n } of counts) {
    expect(n, `面 ${r} に主の操作が ${n} 個ある(1 つを超えると段が消える)`).toBeLessThanOrEqual(1);
  }
  expect(
    counts.filter((c) => c.n === 1).map((c) => c.r).sort(),
    '主の操作が出ている面が想定と違う',
  ).toEqual(['detail', 'sidebar']);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
