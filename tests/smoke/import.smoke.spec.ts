/**
 * smoke #5(P6b): PKC2 単一 HTML の取込 end-to-end。
 *
 * unit では届かないものを 1 本で見る:
 * - 実 file picker(常設 hidden input)→ binder 配線
 * - 実ブラウザの DecompressionStream で gzip+base64 添付が復号される
 * - 書いた bytes が**実 IDB** に入り、preview が blob: で**実際に描画**される
 * - 取り込んだ entry が sqlite 経由の再読込で sidebar に現れる
 */
import { test, expect } from '@playwright/test';
import { gzipSync } from 'node:zlib';
import { gotoApp, collectPageErrors, clickReal } from './helpers';

// 1x1 PNG(67 bytes)
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** PKC2 の単一 HTML export と同じ骨格(slot id + `<\/script` 退避)。 */
function pkc2Html(): string {
  const container = {
    meta: { container_id: 'c-old', title: '旧コンテナ', entry_order: ['n1', 'a1'] },
    entries: [
      { lid: 'n1', title: '旧ノート', archetype: 'text', body: '# 旧ノート\n本文\n' },
      {
        lid: 'a1',
        title: 'dot.png',
        archetype: 'attachment',
        body: JSON.stringify({
          name: 'dot.png',
          mime: 'image/png',
          size: PNG_1X1.length,
          asset_key: 'old-asset-key',
        }),
      },
    ],
    relations: [],
    // PKC2 の既定 export は gzip+base64
    assets: { 'old-asset-key': gzipSync(PNG_1X1).toString('base64') },
  };
  const payload = {
    container,
    export_meta: { mode: 'full', mutability: 'editable', asset_encoding: 'gzip+base64' },
  };
  const data = JSON.stringify(payload).replace(/<\/script>/gi, '<\\/script>');
  return `<!doctype html><html><head><meta charset="utf-8">
    <script id="pkc-meta" type="application/json">{"app":"pkc2","schema":1}</script>
  </head><body>
    <script id="pkc-data" type="application/json">${data}</script>
  </body></html>`;
}

const FILE = () => ({
  name: 'container.html',
  mimeType: 'text/html',
  buffer: Buffer.from(pkc2Html(), 'utf-8'),
});

test('PKC2 HTML 取込 → entry 出現 → gzip 添付が blob: で描画される', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ⚠ **ボタンを実際に押す**経路を通す(review mutation M21): hidden input へ
  // 直接 setInputFiles すると、ボタン → picker の導線が壊れていても緑になる
  const chooser = page.waitForEvent('filechooser');
  await clickReal(page, '[data-pkc-action="import-pkc2"]');
  await (await chooser).setFiles(FILE());

  // 再読込(sqlite から引き直し)を経て 2 件が sidebar に現れる
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('旧ノート'); // meta.entry_order の順

  // 添付 entry を開くと、復号済み bytes が IDB から lend されて実描画される
  await clickReal(page, '[data-pkc-entry="a1"]'); // 衝突が無いので lid は保たれる
  const img = page.locator('[data-pkc-field="attachment-media"]');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('src', /^blob:/);
  expect((await img.boundingBox())!.height).toBeGreaterThan(0);

  // ── 取り込んだ asset は「参照されている」と実 sqlite 走査で判定される ──
  // (旧 key のまま body に残っていたら、ここで未参照として現れる)
  const dialogMsg = new Promise<string>((resolve) => {
    page.once('dialog', (d) => {
      resolve(d.message());
      void d.accept();
    });
  });
  await clickReal(page, '[data-pkc-action="purge-orphan-assets"]');
  expect(await dialogMsg).toContain('未参照の添付データはありません');

  // ── 同じファイルをもう一度取り込む(review mutation M23 / M24 / H-2)──
  // 既存 lid・既存 relation id・entryOrder のどれか 1 つでも見ていなければ、
  // ここで 1 部目が**上書きされて消える**(4 件にならない)
  await page.setInputFiles('[data-pkc-field="import-input"]', FILE());
  await expect(rows).toHaveCount(4);
  const orders = await page.locator('[data-pkc-entry]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-pkc-entry')),
  );
  expect(new Set(orders).size).toBe(4); // lid が再採番されている(重複なし)

  expect(errors).toEqual([]);
});
