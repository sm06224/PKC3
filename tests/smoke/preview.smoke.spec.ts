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

/**
 * P8 段⑩: **ジョブの可視化とログ**。
 *
 * > user 指示 2026-08-03「**ジョブスケジューラーは可視化機構とセットでお願いします /
 * > ログもみたい**」
 *
 * ⚠ 「画面が出る」で止めない ── **実際のジョブが数字とログに現れる**ことを見る。
 * 空の表を出すだけの実装でも「出た」は通ってしまう。
 */
test('🔴 設定にジョブの状態とログが出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // 何か仕事をさせる(プレビューを描かせる)
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('# 見出し\n\n本文\n');
  await expect(page.locator('[data-pkc-region="editor-preview"] h1')).toHaveText('見出し');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-view="settings"]');
  const lanes = page.locator('[data-pkc-field="job-lanes"] tbody tr');
  // ① 🔴 markdown のワーカーが行として出る
  await expect(lanes.filter({ hasText: 'markdown' })).toHaveCount(1);
  const row = lanes.filter({ hasText: 'markdown' }).first();
  // ② 🔴 **完了件数が 1 以上**(空の表を出しているだけではない)
  const done = await row.locator('td').nth(4).textContent();
  expect(Number(done), '完了したジョブが数えられていない').toBeGreaterThan(0);
  // ③ 中央値が出ている(所要時間を測っている)
  await expect(row.locator('td').nth(7)).not.toHaveText('—');

  // ④ 🔴 ログに実際の出来事が並ぶ
  const log = page.locator('[data-pkc-field="job-log"] li');
  await expect(log.first()).toBeVisible();
  await expect(page.locator('[data-pkc-field="job-log"] li[data-pkc-phase="done"]').first()).toContainText('markdown');
  await expect(page.locator('[data-pkc-field="job-log"] li[data-pkc-phase="spawn"]').first()).toBeVisible();

  // ⑤ ⚠ ログに**本文の中身**は出さない(文字数だけ)
  await expect(page.locator('[data-pkc-field="job-log"]')).not.toContainText('見出し');

  expect(errors).toEqual([]);
});

/**
 * P8 段⑩: 🔴 **打っても画面がガクガクしない**。
 *
 * > user 指示 2026-08-03「1 打鍵ではなく、3 秒周期で差分反映してください /
 * > **1 打鍵では、そんなことしたら、重たくなるし、レンダリングで画面がガクガクする**」
 *
 * 🔴 「ガクガク」を long task の数字で語ると外す(計器側のコストに埋もれる ──
 * 実際に埋もれた)。**user が見ているもの**を直接観測点にする:
 *  ① スクロール位置が飛ばない
 *  ② 触っていない図の `<img>` が**同じ実体のまま**残る(= 絵が消えて焼き直らない)
 * 丸ごと差し替える実装では、この 2 つが必ず壊れる。
 */
test('🔴 打ってもスクロールが飛ばず、触っていない図が消えない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await createEntry(page, 'text');

  const ta = page.locator('[data-pkc-field="editor-body"]');
  const preview = page.locator('[data-pkc-region="editor-preview"]');
  const filler = Array.from({ length: 60 }, (_, i) => `## 節 ${i}\n\n段落 ${i}。\n`).join('\n');
  await ta.fill('```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```\n\n' + filler);

  const host = preview.locator('[data-pkc-mermaid-src]');
  await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });
  await page.evaluate(() => {
    const img = document.querySelector(
      '[data-pkc-region="editor-preview"] [data-pkc-field="mermaid-image"]',
    );
    (img as HTMLElement & { __mark?: string }).__mark = 'same-element';
  });
  const srcBefore = await preview.locator('[data-pkc-field="mermaid-image"]').getAttribute('src');

  await preview.evaluate((el) => (el.scrollTop = 800));
  const scrollBefore = await preview.evaluate((el) => el.scrollTop);
  expect(scrollBefore, 'スクロールできていない(観測の前提が崩れている)').toBeGreaterThan(100);

  await ta.evaluate((el) => {
    const t = el as HTMLTextAreaElement;
    t.value += '\n\n末尾に足した段落。\n';
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(preview).toContainText('末尾に足した段落。', { timeout: 8000 });

  const scrollAfter = await preview.evaluate((el) => el.scrollTop);
  expect(Math.abs(scrollAfter - scrollBefore), 'スクロールが飛んだ').toBeLessThan(40);

  const stillSame = await page.evaluate(
    () =>
      (
        document.querySelector(
          '[data-pkc-region="editor-preview"] [data-pkc-field="mermaid-image"]',
        ) as (HTMLElement & { __mark?: string }) | null
      )?.__mark ?? null,
  );
  expect(stillSame, '触っていない図まで作り直した(絵が一度消える)').toBe('same-element');
  await expect(preview.locator('[data-pkc-field="mermaid-image"]')).toHaveAttribute(
    'src',
    srcBefore!,
  );

  expect(errors).toEqual([]);
});
