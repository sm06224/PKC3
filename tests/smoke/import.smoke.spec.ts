/**
 * smoke #5: PKC2 の取込 end-to-end(単一 HTML / .pkc2.zip の 2 経路)。
 *
 * unit では届かないものを見る:
 * - 実 file picker(常設 hidden input)→ binder 配線。**accept に .zip が無いと
 *   受理器が動いてもファイルを選べない**ので、accept 自体も assert する
 * - 実ブラウザの DecompressionStream / 自前 ZIP reader で bytes が復元される
 * - 書いた bytes が**実 IDB** に入り、preview が blob: で**実際に描画**される
 * - 取り込んだ entry と履歴が、実 sqlite 経由の再読込で画面に現れる
 */
import { test, expect } from '@playwright/test';
import { gzipSync, crc32 } from 'node:zlib';
import { gotoApp, collectPageErrors, clickReal, expectImageRendered } from './helpers';

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
  await expectImageRendered(page, '[data-pkc-field="attachment-media"]');

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

/** PKC2 の package writer と同じ形の ZIP を node 側で組む(store / 本物の CRC)。 */
function pkc2Zip(): Buffer {
  const container = {
    meta: { container_id: 'c-zip', title: 'バックアップ' },
    entries: [
      { lid: 'z1', title: 'ZIP のノート', archetype: 'text', body: '# ZIP\n本文\n' },
      {
        lid: 'z2',
        title: 'dot.png',
        archetype: 'attachment',
        body: JSON.stringify({
          name: 'dot.png',
          mime: 'image/png',
          size: PNG_1X1.length,
          asset_key: 'ast-zip',
        }),
      },
    ],
    relations: [],
    revisions: [
      { id: 'rv1', entry_lid: 'z1', created_at: '2026-07-01T00:00:00Z', snapshot: '# ZIP\n古い本文\n' },
    ],
    assets: {}, // PKC2 の writer は assets を空にして container.json を書く
  };
  const files: Array<{ name: string; data: Buffer }> = [
    {
      name: 'manifest.json',
      data: Buffer.from(
        JSON.stringify({
          format: 'pkc2-package',
          version: 1,
          exported_at: '2026-07-31T00:00:00.000Z',
          source_cid: 'c-zip',
          entry_count: 2,
          relation_count: 0,
          revision_count: 1,
          asset_count: 1,
        }),
      ),
    },
    { name: 'container.json', data: Buffer.from(JSON.stringify(container)) },
    { name: 'assets/ast-zip.bin', data: PNG_1X1 }, // 生バイナリ
  ];

  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf-8');
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 名(PKC2 の writer と同じ)
    lh.writeUInt16LE(0, 8); // store
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, f.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(f.data.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + f.data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cdBuf, eocd]);
}

test('.pkc2.zip 取込 → entry 出現 → 生バイナリ添付が blob: で描画される', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ⚠ accept に .zip が無いと、受理器が動いてもここでファイルを選べない
  const accept = await page
    .locator('[data-pkc-field="import-input"]')
    .getAttribute('accept');
  expect(accept).toContain('.zip');

  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: 'backup.pkc2.zip',
    mimeType: 'application/zip',
    buffer: pkc2Zip(),
  });

  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows).toHaveCount(2);

  // ZIP から直接流した bytes が実 IDB に入り、実描画される(base64 を経由しない)
  await clickReal(page, '[data-pkc-entry="z2"]');
  await expectImageRendered(page, '[data-pkc-field="attachment-media"]');

  // 履歴も HTML 経路と同じ鎖へ入っている(実 sqlite の逆パッチ経路を通る)
  await clickReal(page, '[data-pkc-entry="z1"]');
  await clickReal(page, '[data-pkc-action="show-history"]');
  await expect(page.locator('[data-pkc-rev-order]')).toHaveCount(1);

  expect(errors).toEqual([]);
});
