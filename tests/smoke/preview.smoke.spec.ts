import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * P8 段②: **書きながら見える**。
 *
 * > user 指摘 2026-08-03「プレビューとmermaidどこいった？」
 *
 * 🔴 PKC3 にはプレビューが**存在しなかった**(編集は素の textarea 1 枚)。
 * ⚠ 更新は state ではなく textarea の `input` で駆動する ── `render()` は
 * 編集中の同一 entry では早期 return する(カーソルと IME を壊さないため)ので、
 * **state 経由の test では通らない**。実際に打って確かめる。
 */
test('🔴 編集しながらプレビューが追いつく', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  const preview = page.locator('[data-pkc-region="editor-preview"]');
  await expect(preview).toBeVisible();

  // ① 原文とプレビューが**横に並ぶ**(縦に積まれていない)
  const a = (await ta.boundingBox())!;
  const b = (await preview.boundingBox())!;
  expect(a.x + a.width, 'プレビューが原文と重なっている').toBeLessThanOrEqual(b.x + 1);

  // ② 🔴 **打つと変わる**。markdown として解釈されている(生の記号が出ていない)
  await ta.fill('# 見出し\n\n- りんご\n- みかん\n');
  await expect(preview.locator('h1')).toHaveText('見出し');
  await expect(preview.locator('li')).toHaveCount(2);
  await expect(preview).not.toContainText('# 見出し');

  // ③ 続けて打つと**追いつく**(1 回目だけ描いて止まる実装を落とす)
  await ta.fill('## 別の見出し\n\n| 項目 | 値 |\n|---|---|\n| A | 1 |\n');
  await expect(preview.locator('h2')).toHaveText('別の見出し');
  await expect(preview.locator('table td')).toHaveCount(2);

  // ④ frontmatter は**プレビューに出さない**(本文だけを見せる)
  await ta.fill('---\ntitle: x\n---\n本文だけ\n');
  await expect(preview).not.toContainText('title: x');
  await expect(preview).toContainText('本文だけ');

  // ⑤ 保存して抜けても、閲覧側が同じものを出す
  // ⚠ 観測点は `detail-body` ── markdown 記法が無い本文は `<pre>` で出るので
  // `.pkc-md-rendered` を見ると**書き方によって落ちる**(実際に踏んだ)
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('本文だけ');
  await expect(page.locator('[data-pkc-field="detail-body"]')).not.toContainText('title: x');
  expect(errors).toEqual([]);
});

/**
 * P8 段⑨: **描いているのはワーカーである**。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください /
 * > ワーカーはしばらくつかわれないなら、キルと解放し…」
 *
 * 🔴 unit は偽 worker で機構を見ている。**本物が本当に読み込まれて使われたか**は
 * 実ブラウザでしか分からない ── ここを置かないと、`Worker` が使えない環境判定に
 * 落ちて**ずっと同期で描いていても全部緑**になる(そういう負け方を実際にする)。
 */
test('🔴 プレビューはワーカーが描いている(同期に落ちていない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ① 編集に入る**前**はワーカーを起こしていない(遅延起動)
  const before = await page.evaluate(() =>
    performance.getEntriesByType('resource').filter((e) => e.name.includes('markdown-worker'))
      .length,
  );
  expect(before, '使う前からワーカーを起こしている').toBe(0);

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.fill('# 見出し\n\n本文です\n');
  const preview = page.locator('[data-pkc-region="editor-preview"]');
  await expect(preview.locator('h1')).toHaveText('見出し');

  // ② 🔴 **本物のワーカーが読み込まれた**
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            performance
              .getEntriesByType('resource')
              .filter((e) => e.name.includes('markdown-worker')).length,
        ),
      { message: 'markdown worker が読み込まれていない(同期経路に落ちている)' },
    )
    .toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
