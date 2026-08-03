import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * P8 段③: 図は **PNG 1 枚**で置く。
 *
 * > user 指示 2026-08-03(不可侵)「mermaid 図のエクスポートをさせるとき以外は
 * > PNG ラスタをキャッシュして、GPU レンダリングで表示して欲しい」
 *
 * 🔴 PKC3 には**描く側が存在しなかった**(placeholder を出すだけで、依存も無し)。
 * ⚠ 観測点は「図が出た」ではなく「**何が DOM に置かれたか**」── SVG を置く実装でも
 * 「図が出た」は通ってしまう。
 */
test('🔴 図は PNG の img で置かれ、SVG を DOM に残さない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('図のノート');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('# 図\n\n```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```\n');

  // ① 編集中のプレビューにも出る(保存するまで図が見えない、を落とす)
  const inPreview = page.locator('[data-pkc-region="editor-preview"] [data-pkc-mermaid-src]');
  await expect(inPreview).toHaveAttribute('data-pkc-mermaid-state', 'ready', {
    timeout: 30000,
  });

  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const host = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });

  // ② 🔴 置かれているのは **img**。しかも中身は PNG
  const placed = await host.evaluate((h) => {
    const img = h.querySelector('img');
    return {
      tag: h.firstElementChild?.tagName ?? 'NONE',
      src: img?.getAttribute('src')?.slice(0, 5) ?? '',
      natural: img?.naturalWidth ?? 0,
    };
  });
  expect(placed.tag, 'img ではないものが置かれている').toBe('IMG');
  expect(placed.src, 'blob の ObjectURL ではない').toBe('blob:');
  expect(placed.natural, '画像が読めていない').toBeGreaterThan(0);

  // ③ 🔴 **SVG を DOM に残さない**(これが「スクロールが GPU に乗る」の実体)
  expect(await page.evaluate(() => document.querySelectorAll('svg').length)).toBe(0);

  // ④ 🔴 焼いた画素が表示幅以上(Retina でボケない ── 等倍で焼く実装を落とす)
  const sharp = await host.evaluate((h) => {
    const img = h.querySelector('img')!;
    return img.naturalWidth / Math.max(1, img.clientWidth) - window.devicePixelRatio;
  });
  expect(sharp, '表示幅に対して焼いた画素が足りない(ボケる)').toBeGreaterThan(-0.05);

  expect(errors).toEqual([]);
});

/**
 * P8 段⑦: **図を保存する**。
 *
 * 🔴 段③ の指示は「エクスポート**させるとき以外は** PNG」── つまり書き出しの導線が
 * 在る前提だったが、`renderToSvg()` は書かれたまま**呼び出し元が 0 件**だった。
 *
 * ⚠ 観測点を「ダウンロードが起きた」で止めない ── **中身がベクタか**まで見る。
 * PNG を落とす実装でもダウンロードは起きる(指示に反しているのに緑になる)。
 */
test('🔴 図を保存すると、画面の PNG ではなくベクタが落ちる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('図のノート');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const host = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });

  // ① 導線が**図の上に見えている**(hover しないと存在すら分からない、を落とす)。
  // 🔴 `toBeVisible()` **だけでは空振りする** ── playwright は bounding box と
  // `visibility` を見るが **opacity は見ない**ので、`opacity: 0` にする変異が
  // 生き残った(実測)。⚠ ポインタを外してから測る(直前の click が hover を
  // 残していると、hover 前提の実装でも通ってしまう ── 救い手が変わるだけ)
  const save = host.locator('[data-pkc-field="diagram-save"]');
  await page.mouse.move(0, 0);
  await expect(save).toBeVisible();
  const shown = await save.evaluate((el) => ({
    opacity: Number(getComputedStyle(el).opacity),
    bg: getComputedStyle(el).backgroundColor,
  }));
  expect(shown.opacity, 'hover しないと見えない導線になっている').toBeGreaterThan(0.2);
  // ⚠ 図の上に浮くので**地が透けてはいけない**(図の線と重なって文字が読めない)
  expect(shown.bg, '導線の地が透けている').not.toMatch(/,\s*0\)$/);

  // ② 🔴 押すと落ちてくる
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickReal(page, '[data-pkc-field="diagram-save"]'),
  ]);

  // ③ 🔴 **中身がベクタである**。⚠ ファイル名は観測点にしない ── この headless
  // Chromium は**非 ASCII の `<a download>` 名を丸ごと捨てて `"download"` にする**。
  // 名前は「図1」を含むので必ず捨てられる ── 名前の規則は unit
  // (`tests/adapter/export-diagram.test.ts`)が見ている
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf-8');
  expect(text.slice(0, 200), 'SVG ではない(PNG を落としている可能性)').toContain('<svg');
  // ④ 🔴 **その図**が落ちている(空の svg 枠でも `<svg` は通る)
  expect(text, '図の中身が入っていない').toContain('始め');
  expect(text, '図の中身が入っていない').toContain('終わり');

  // ⑤ 画面のほうは PNG のまま(書き出しのために SVG へ差し替わっていない)
  expect(await page.evaluate(() => document.querySelectorAll('svg').length)).toBe(0);

  expect(errors).toEqual([]);
});

/**
 * P8 段⑬: 🔴 **図の色が配色に従う**。
 *
 * 🔴 直す前に測った(焼いた PNG の平均輝度。同じ図・同じ幅):
 * ```
 * light      231.1      dark    231.1      dracula 231.1
 * nord       231.1      terminal 231.1
 * ```
 * 鍵にテーマは入っていたので**焼き直しは走っていた**が、`mermaid.initialize()` に
 * 配色を渡していなかったので **絵が全部同じ** ── ダーク系 5 テーマで、暗い地に
 * 白い図が 1 枚だけ浮いていた。さらに配色を切り替えても `<img src>` が変わらず、
 * `docs/manual.md` の「配色を変えると焼き直します」は**両方向とも嘘**だった。
 *
 * ⚠ 観測点は **焼いた画素**。設定の中身は `tests/adapter/mermaid-palette.test.ts`
 * が見る ── 片端だけだと「設定は渡っているが絵は変わらない」を見逃す。
 */
test('🔴 配色を変えると図も焼き直り、暗い配色では図も暗い', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('図の色');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill('```mermaid\ngraph TD\n  A["始め"]-->B["終わり"]\n```\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const host = page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]');
  await expect(host).toHaveAttribute('data-pkc-mermaid-state', 'ready', { timeout: 30000 });
  const img = host.locator('img');

  /** 焼いた PNG の平均輝度(不透明な画素だけ)。 */
  const luma = (): Promise<number> =>
    img.evaluate(
      (el: HTMLImageElement) =>
        new Promise<number>((resolve) => {
          const go = (): void => {
            const c = document.createElement('canvas');
            c.width = el.naturalWidth;
            c.height = el.naturalHeight;
            const ctx = c.getContext('2d')!;
            ctx.drawImage(el, 0, 0);
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            let sum = 0;
            let n = 0;
            for (let i = 0; i < d.length; i += 4) {
              if (d[i + 3]! < 128) continue;
              n++;
              sum += (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
            }
            resolve(n === 0 ? -1 : sum / n);
          };
          if (el.complete && el.naturalWidth > 0) go();
          else el.onload = go;
        }),
    );

  const srcOf = (): Promise<string> => img.evaluate((el) => el.getAttribute('src') ?? '');

  const light = await luma();
  const lightSrc = await srcOf();
  expect(light, '明るい配色なのに図が暗い').toBeGreaterThan(140);

  // 🔴 設定から配色を変える(実際の導線)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await page.locator('[data-pkc-field="theme-select"]').selectOption('dark');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');

  // 焼き直しは非同期 ── src が変わるまで待つ(固定 sleep を積まない)
  await expect
    .poll(async () => (await srcOf()) !== lightSrc, { timeout: 30000 })
    .toBe(true);
  const dark = await luma();
  expect(dark, '暗い配色にしたのに図が明るいまま').toBeLessThan(120);

  // ⚠ **戻せる**ことも見る(片道だけ直っている実装を落とす)
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await page.locator('[data-pkc-field="theme-select"]').selectOption('light');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect.poll(async () => await luma(), { timeout: 30000 }).toBeGreaterThan(140);

  expect(errors).toEqual([]);
});
