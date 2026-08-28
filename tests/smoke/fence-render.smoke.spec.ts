/**
 * smoke #3(P3-8): csv fence の表と html fence の sandbox iframe が
 * 「実際に画面に出る」(PKC2 で S4 の iframe 高さ 0 を踏んだ故障クラスの検品)。
 * ⚠ mermaid の実 render は 20s 級の待ちを持つため PR gate に入れない(nightly 検討)。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal, createEntry, useSplitEditor } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

test('csv 表と html sandbox iframe が可視高さを持つ', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  await page.keyboard.type(
    '```csv-render\n列A,列B\n1,2\n```\n\n```html\n<p style="height:120px">sandbox</p>\n```',
  );
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // csv: レンダリング面の table が可視
  const table = page.locator('[data-pkc-field="detail-body"] table').first();
  await expect(table).toBeVisible();
  expect((await table.boundingBox())!.height).toBeGreaterThan(0);

  // html: sandbox iframe が resize message で実高さを得る(srcdoc load 後)
  const iframe = page.locator('iframe[data-pkc-html-render-id]');
  await expect(iframe).toBeAttached();
  await expect
    .poll(
      async () => {
        const box = await iframe.boundingBox();
        return box?.height ?? 0;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThan(100); // 中身(120px)に追従した高さ ── height 0 の再演防止

  expect(errors).toEqual([]);
});

/**
 * 🔴 **`svg` の囲みが、実際に絵になる**(#528 段⑥、2026-08-28)。
 *
 * ⚠ **unit では箱の markup までしか見えない** ── 「箱に入った」と
 *   「ブラウザが絵を描いた」は別の主張である。SVG が字のまま出ていても、
 *   iframe が在れば unit は緑になる。
 * 🔑 観測点は **箱の中で `<svg>` が実際に版面を持ったこと**(幅と高さ)。
 * ⚠ **対照群を同じ it に置く** ── 同じ SVG を ` ```html ` に入れた箱と
 *   **同じ大きさ**になること。片方だけ見ると「svg だけ特別扱いされて
 *   別の描かれ方をした」を見抜けない。
 */
test('🔴 svg の囲みは、html と同じ箱で同じように絵になる(#528 段⑥)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="40"></svg>';
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  await page.keyboard.type('```svg\n' + SVG + '\n```\n\n```html\n' + SVG + '\n```');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const frames = page.locator('iframe[data-pkc-html-render-id]');
  await expect(frames).toHaveCount(2);

  // 🔴 箱の**中**で svg が版面を持ったか(字のまま出ていれば 0 になる)
  const sizes: Array<{ w: number; h: number }> = [];
  for (let i = 0; i < 2; i++) {
    const frame = page.frameLocator('iframe[data-pkc-html-render-id]').nth(i);
    const svg = frame.locator('svg');
    await expect(svg).toBeAttached({ timeout: 10_000 });
    const box = await svg.boundingBox();
    sizes.push({ w: box?.width ?? 0, h: box?.height ?? 0 });
  }
  expect(sizes[0]!.w, `svg の囲みで絵が版面を持たない: ${JSON.stringify(sizes[0])}`).toBeGreaterThan(
    0,
  );
  // 🔑 対照群 ── html の囲みと**同じ大きさ**(別の描かれ方をしていない)
  expect(sizes[0]).toEqual(sizes[1]);

  expect(errors, errors.join('\n')).toEqual([]);
});
