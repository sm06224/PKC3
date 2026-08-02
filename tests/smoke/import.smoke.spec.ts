/**
 * smoke #5: PKC2 の取込 end-to-end(単一 HTML / .pkc2.zip / batch bundle の 3 経路)。
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
import { readFileSync } from 'node:fs';
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

/** PKC2 の writer と同じ ZIP を組む(store 固定 / UTF-8 flag / 本物の CRC)。 */
function zipOf(files: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf-8');
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
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

  return zipOf(files);
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

/** 内側の `.text.zip` を 1 個組む(PKC2 の単体 export と同じ構造)。 */
function textBundle(lid: string, title: string, body: string, withAsset: boolean): Buffer {
  const assets = withAsset ? { 'ast-shared': { name: 'dot.png', mime: 'image/png' } } : {};
  const files = [
    {
      name: 'manifest.json',
      data: Buffer.from(
        JSON.stringify({
          format: 'pkc2-text-bundle',
          version: 1,
          source_lid: lid,
          source_title: title,
          body_length: body.length,
          asset_count: withAsset ? 1 : 0,
          missing_asset_count: 0,
          missing_asset_keys: [],
          assets,
          compacted: false,
        }),
      ),
    },
    { name: 'body.md', data: Buffer.from(body, 'utf-8') },
    ...(withAsset ? [{ name: 'assets/ast-shared.png', data: PNG_1X1 }] : []),
  ];
  return zipOf(files);
}

/**
 * `pkc2-mixed-container-bundle`(ZIP-in-ZIP)。
 * 🔑 **同じ添付を 2 ノートが参照している**形を作る ── PKC2 は内側 ZIP それぞれに
 * 同じバイナリを丸ごと複製するので、取込側で畳まないと添付が 2 本になる。
 */
function batchZip(): Buffer {
  const a = textBundle('n1', 'ノート A', '# A\n![図](asset:ast-shared)\n', true);
  const b = textBundle('n2', 'ノート B', '# B\nこちらも ![図](asset:ast-shared)\n', true);
  return zipOf([
    {
      name: 'manifest.json',
      data: Buffer.from(
        JSON.stringify({
          format: 'pkc2-mixed-container-bundle',
          version: 1,
          exported_at: '2026-07-31T00:00:00.000Z',
          source_cid: 'c-batch',
          source_title: '旧コンテナ',
          text_count: 2,
          textlog_count: 0,
          compact: false,
          entries: [
            { lid: 'n1', title: 'ノート A', archetype: 'text', filename: 'a-20260731.text.zip', body_length: 3, asset_count: 1, missing_asset_count: 0 },
            { lid: 'n2', title: 'ノート B', archetype: 'text', filename: 'b-20260731.text.zip', body_length: 3, asset_count: 1, missing_asset_count: 0 },
          ],
        }),
      ),
    },
    { name: 'a-20260731.text.zip', data: a },
    { name: 'b-20260731.text.zip', data: b },
  ]);
}

test('batch bundle 取込 → 内側 ZIP が再入され、共有添付が 1 本に畳まれる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: 'container-20260731.zip',
    mimeType: 'application/zip',
    buffer: batchZip(),
  });

  // 本体 2 件 + attachment 1 件 = 3(attachment が 2 件なら畳めていない)
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows).toHaveCount(3);

  // 🔑 内側 ZIP の view から流した bytes が実 IDB に入り、実描画される。
  // 内側 entry を**外側の Blob から**読んでいたらここで壊れる(段④の中核)
  await clickReal(page, '[data-pkc-entry="n1"]');
  await expectImageRendered(page, '[data-pkc-field="detail-body"] img');
  await clickReal(page, '[data-pkc-entry="n2"]');
  await expectImageRendered(page, '[data-pkc-field="detail-body"] img');

  expect(errors).toEqual([]);
});

test('注意が複数あるとき **全件**が画面に出る(1 行の status に埋もれない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // 3 つの内側 bundle がそれぞれ「実体の無い添付」を宣言している状態を作る
  const inner = (lid: string): Buffer =>
    zipOf([
      {
        name: 'manifest.json',
        data: Buffer.from(
          JSON.stringify({
            format: 'pkc2-text-bundle',
            version: 1,
            source_lid: lid,
            source_title: lid,
            assets: { [`ast-gone-${lid}`]: { name: 'x.png', mime: 'image/png' } },
            compacted: false,
          }),
        ),
      },
      { name: 'body.md', data: Buffer.from(`# ${lid}\n`, 'utf-8') },
    ]);
  const lids = ['n1', 'n2', 'n3'];
  const zip = zipOf([
    {
      name: 'manifest.json',
      data: Buffer.from(
        JSON.stringify({
          format: 'pkc2-texts-container-bundle',
          version: 1,
          entry_count: 3,
          entries: lids.map((lid) => ({ lid, title: lid, filename: `${lid}.text.zip` })),
        }),
      ),
    },
    ...lids.map((lid) => ({ name: `${lid}.text.zip`, data: inner(lid) })),
  ]);

  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: 'notes.zip',
    mimeType: 'application/zip',
    buffer: zip,
  });

  await expect(page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]')).toHaveCount(3);

  // 🔑 3 件とも出る。**1 件目だけ**なら段④ の「どのファイルか冠する」設計が空振り
  const notices = page.locator('[data-pkc-region="notices"] [data-pkc-notice]');
  await expect(notices).toHaveCount(3);
  for (const lid of lids) {
    await expect(notices.filter({ hasText: `${lid}.text.zip` })).toHaveCount(1);
  }

  // 閉じられる(画面を占有し続けない)
  await clickReal(page, '[data-pkc-action="dismiss-notices"]');
  await expect(notices).toHaveCount(0);

  expect(errors).toEqual([]);
});

/** 内側の `.text.zip`(PKC2 の単体 export と同じ構造)。 */
function innerText(lid: string, title: string): Buffer {
  return zipOf([
    {
      name: 'manifest.json',
      data: Buffer.from(
        JSON.stringify({
          format: 'pkc2-text-bundle',
          version: 1,
          source_lid: lid,
          source_title: title,
          assets: {},
          compacted: false,
        }),
      ),
    },
    { name: 'body.md', data: Buffer.from(`# ${title}\n`, 'utf-8') },
  ]);
}

/**
 * `pkc2-folder-export-bundle`。**親が先に来ない**並びで、循環も 1 つ入れる
 * (PKC2 の writer は循環を防いでいない ── 実際に来る形)。
 */
function folderExportZip(): Buffer {
  return zipOf([
    {
      name: 'manifest.json',
      data: Buffer.from(
        JSON.stringify({
          format: 'pkc2-folder-export-bundle',
          version: 1,
          source_folder_lid: 'root',
          source_folder_title: '仕事',
          scope: 'recursive',
          text_count: 2,
          textlog_count: 0,
          compact: false,
          entries: [
            { lid: 'n1', title: '議事録', archetype: 'text', filename: 'n1.text.zip', parent_folder_lid: 'sub' },
            { lid: 'n2', title: '直下メモ', archetype: 'text', filename: 'n2.text.zip', parent_folder_lid: 'root' },
          ],
          folders: [
            { lid: 'sub', title: '2026', parent_lid: 'root' }, // ⚠ 子が先
            { lid: 'root', title: '仕事', parent_lid: null },
            { lid: 'empty', title: '空フォルダ', parent_lid: 'sub' }, // 空でも作る
            // 🔴 **本物の循環**(cyc1 ⇄ cyc2)。PKC2 の writer は防いでいないので
            // 実際に来る。切れていないと循環上の 2 件が root に出ず配下ごと消える
            { lid: 'cyc1', title: '循環1', parent_lid: 'cyc2' },
            { lid: 'cyc2', title: '循環2', parent_lid: 'cyc1' },
          ],
        }),
      ),
    },
    { name: 'n1.text.zip', data: innerText('n1', '議事録') },
    { name: 'n2.text.zip', data: innerText('n2', '直下メモ') },
  ]);
}

test('folder-export 取込 → filer で階層が実際にたどれる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: 'folder-shigoto-20260731.folder-export.zip',
    mimeType: 'application/zip',
    buffer: folderExportZip(),
  });

  // folder 5 件 + 本体 2 件
  await expect(page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]')).toHaveCount(7);

  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="filer"]');
  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');

  // 🔑 最上位は **root + 循環から救出された 1 件**(階層が効いていれば 7 件並ばない)。
  // 🔴 循環が切れていないと循環上の 2 件は root にも配下にも出ず**完全に消える**
  await expect(rows.locator('[data-pkc-field="title"]')).toHaveText(['📁 仕事', '📁 循環2']);

  // root へ入る → 「2026」フォルダと「直下メモ」
  await clickReal(page, '[data-pkc-region="filer-table"] tbody tr:first-child');
  await expect(rows).toHaveCount(2);
  await expect(rows.locator('[data-pkc-field="title"]')).toHaveText(['📁 2026', '直下メモ']);

  // 「2026」へ入る → 空フォルダと議事録。
  // ⚠ lid は取込時に採番し直されるので **DOM から引く**(`:has-text` は
  // Playwright 専用セレクタで、実クリックの querySelector では使えない)
  // ⚠ タイトルで絞ると更新日の「2026-08-01」にも当たる ── archetype で引く
  const subLid = await page
    .locator('[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="folder"]')
    .getAttribute('data-pkc-entry');
  await clickReal(page, `[data-pkc-entry="${subLid}"]`);
  await expect(rows.locator('[data-pkc-field="title"]')).toHaveText(['📁 空フォルダ', '議事録']);

  expect(errors).toEqual([]);
});

test('段⑥: `.entry.zip` の base64 添付が実 IDB で画像として描画される', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // 🔴 PKC2 の writer が実際に吐いたファイル。`assets/<key>` は **base64 テキスト**で、
  // 復号せずに保存すると「開けないのに壊れて見えない」添付になる
  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: 'attachment.entry.zip',
    mimeType: 'application/zip',
    buffer: readFileSync(`${process.cwd()}/tests/fixtures/pkc2/attachment.entry.zip`),
  });

  await expect(page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]')).toHaveCount(1);
  await clickReal(page, '[data-pkc-region="entry-list"] [data-pkc-entry]');
  // 実ブラウザが画像として decode できる = base64 が正しく復号されている
  await expectImageRendered(page, '[data-pkc-field="attachment-media"]');

  expect(errors).toEqual([]);
});

test('🔴 バックアップ: 書き出して → 取り込み直すと中身が戻る(round-trip)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // まず PKC2 から取り込んで中身を作る(添付つき = bytes まで往復させる)
  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: 'backup.pkc2.zip',
    mimeType: 'application/zip',
    buffer: pkc2Zip(),
  });
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows).toHaveCount(2);

  // 📤 書き出す(実ブラウザの Blob → <a download> 経路を通す)
  const dl = page.waitForEvent('download');
  await clickReal(page, '[data-pkc-action="export-archive"]');
  const download = await dl;
  expect(download.suggestedFilename()).toMatch(/\.pkc3\.zip$/);
  const path = await download.path();
  expect(path).not.toBeNull();

  // 🔴 取り込み直す ── **自分の書出しを自分で読み戻せる**ことがバックアップの条件
  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: 'restored.pkc3.zip',
    mimeType: 'application/zip',
    buffer: readFileSync(path!),
  });

  // 同じ内容がもう 1 組入る(取込は常に追加 ── 上書きしない)
  await expect(rows).toHaveCount(4);
  // 添付も戻っている(content addressing なので blob は 1 本のまま)
  const restored = rows.filter({ hasText: 'dot.png' });
  await expect(restored).toHaveCount(2);
  await clickReal(page, '[data-pkc-region="entry-list"] [data-pkc-entry]:last-child');
  await expectImageRendered(page, '[data-pkc-field="attachment-media"]');

  expect(errors).toEqual([]);
});
