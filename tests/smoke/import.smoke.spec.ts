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
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  await clickReal(page, '[data-pkc-action="import-file"]');
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

/**
 * ZIP の中央ディレクトリからファイル名を読む(**アプリの reader を使わない**)。
 * 自前 writer の出力を自前 reader で読んで「一致した」と言うだけでは、
 * 両方が同じように間違っている場合を捕まえられない ── 外から読む目を 1 つ持つ。
 */
function zipNames(buf: Buffer): string[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('EOCD が見つかりません');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央ディレクトリの署名が不正');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

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

/**
 * ノート本文(1 行だけ差し替わる長文)。**長さが要る** ── 短いと
 * `encodeReverse` が「パッチ > 全文」と判断して全行が `kind: 'full'` になり、
 * 逆向きパッチの経路が 1 度も走らない。
 */
const NOTE_BODY = (marker: string): string =>
  [
    '# ZIP',
    marker,
    'HTML のコメントは <!-- で始まり、<script src="x"> も書ける',
    ...Array.from({ length: 40 }, (_, i) => `共通の行 ${i}: 変わらない内容がここに続く`),
  ].join('\n') + '\n';

/** PKC2 の package writer と同じ形の ZIP を node 側で組む(store / 本物の CRC)。 */
function pkc2Zip(): Buffer {
  const container = {
    meta: { container_id: 'c-zip', title: 'バックアップ' },
    entries: [
      {
        lid: 'z1',
        title: 'ZIP のノート',
        archetype: 'text',
        // 🔴 `<!--` → `<script` の並びは script data トークナイザを double escaped
        // 状態へ入れる ── 退避が `</script` だけだと**書き出した HTML が丸ごと真っ白**
        // になる(実 Chromium でしか観測できない。happy-dom は破綻を再現しない)
        //
        // ⚠ **本文を長くしてある**(P6e)。短いと逆向きパッチが全文より大きくなり、
        // 鎖の全行が `kind: 'full'` で保存される ── つまり**パッチ経路を 1 度も
        // 通らない fixture** になり、復元の decode が検証されない
        // (「fixture のゼロ件の次元は測っていない次元」)
        body: NOTE_BODY('本文'),
      },
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
    // 2 世代ぶん ── 鎖が 2 段になり、decode が「tip → 版 2 → 版 1」と回る
    revisions: [
      { id: 'rv1', entry_lid: 'z1', created_at: '2026-07-01T00:00:00Z', snapshot: NOTE_BODY('古い本文') },
      { id: 'rv2', entry_lid: 'z1', created_at: '2026-07-02T00:00:00Z', snapshot: NOTE_BODY('中くらいの本文') },
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
  await expect(page.locator('[data-pkc-rev-order]')).toHaveCount(2);

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

test('🔴 P7 段②: 素の md を取り込む ── 宣言(file_handlers)と導線が一致する', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ⚠ **manifest が宣言する拡張子をピッカーでも選べる**こと。ここが欠けると
  // `file_handlers` で `.md` を宣言しているのに、アプリからは選べない
  const accept = await page
    .locator('[data-pkc-field="import-input"]')
    .getAttribute('accept');
  expect(accept).toContain('.md');
  expect(accept).toContain('.markdown');
  // md は複数選択できる(1 件ずつ entry になる)
  expect(
    await page.locator('[data-pkc-field="import-input"]').getAttribute('multiple'),
  ).not.toBeNull();

  // ⚠ **ボタンを実際に押す**経路を通す(hidden input へ直接入れると導線の断線を見逃す)
  const chooser = page.waitForEvent('filechooser');
  await clickReal(page, '[data-pkc-action="import-file"]');
  // ⚠ MIME は **空**で渡す ── OS のピッカーは `.md` に MIME を付けないことが多い。
  // ここを text/markdown で埋めると「MIME で振り分ける」実装でも緑になる
  await (await chooser).setFiles([
    { name: '会議メモ.md', mimeType: '', buffer: Buffer.from('# 会議メモ\n\n決めたこと\n', 'utf-8') },
    {
      name: 'frontmatter.markdown',
      mimeType: '',
      buffer: Buffer.from('---\ntitle: 正本\nnested:\n  a: 1\n---\n本文\n', 'utf-8'),
    },
  ]);

  // 実 sqlite からの再読込を経て 2 件が sidebar に現れる
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows).toHaveCount(2);
  await expect(rows.locator('[data-pkc-field="title"]')).toHaveText(['会議メモ', '正本']);

  // 🔴 **本文が原文のまま**入っている(frontmatter を再構築していない)。
  // editor を開いて textarea の値そのものを見る ── rendered だけ見ると
  // frontmatter は表示されないので、消えていても気づけない
  const secondLid = await rows.nth(1).getAttribute('data-pkc-entry');
  await clickReal(page, `[data-pkc-entry="${secondLid}"]`);
  await clickReal(page, '[data-pkc-action="start-edit"]');
  await expect(page.locator('[data-pkc-field="editor-body"]')).toHaveValue(
    '---\ntitle: 正本\nnested:\n  a: 1\n---\n本文\n',
  );

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

  // 🔴 **履歴も戻る**(P6e)。ここは実 sqlite の逆向きパッチを通る唯一の検証 ──
  // 鎖の decode は worker の中にしかないので、unit では届かない。
  // ⚠ 見るのは件数ではなく**本文**。件数だけだと「別の状態列が入った」を見逃す
  const restoredNote = rows.filter({ hasText: 'ZIP のノート' }).last();
  await clickReal(page, '[data-pkc-region="entry-list"] [data-pkc-entry]:nth-child(3)');
  await expect(restoredNote).toBeVisible();
  await clickReal(page, '[data-pkc-action="show-history"]');
  await expect(page.locator('[data-pkc-rev-order]')).toHaveCount(2);
  // ⚠ 件数だけでは「別の状態列が入った」を見逃す ── **本文**まで見る。
  // 一番古い版を開いて、元の一番古い本文が戻ることを確かめる
  await clickReal(page, '[data-pkc-rev-order]:last-child [data-pkc-rev-id]');
  await expect(page.locator('[data-pkc-region="detail"]')).toContainText('古い本文');

  expect(errors).toEqual([]);
});

test('🔴 このノートを書き出す ── 消す前の導線が実際に働く', async ({ page }) => {
  // user 指示 2026-08-02:「そういうのは削除じゃなくて**アーカイブエクスポートの
  // 導線**を用意すればいいのでは?」── 削除の隣にあり、押すと 1 件ぶんの
  // `.pkc3.zip` が落ち、**そのまま取り込み直せる**ところまでを見る
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await page.evaluate(() => {
    const orig = HTMLAnchorElement.prototype.click;
    (window as unknown as { __n: string[] }).__n = [];
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      (window as unknown as { __n: string[] }).__n.push(`${this.download}|${this.isConnected}`);
      return orig.call(this);
    };
  });

  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: 'backup.pkc2.zip',
    mimeType: 'application/zip',
    buffer: pkc2Zip(),
  });
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows).toHaveCount(2);

  // 履歴を持つノートを開く ── 書き出しは履歴ごと出る
  await clickReal(page, '[data-pkc-entry="z1"]');
  const dl = page.waitForEvent('download');
  await clickReal(page, '[data-pkc-action="export-entry"]');
  const download = await dl;
  // ファイル名は**ノートの題名**(コンテナ名ではない)
  // ⚠ ファイル名は `download.suggestedFilename()` では見ない ── **この headless
  // Chromium は非 ASCII の download 名を丸ごと捨てて "download" にする**
  // (実測: ASCII は通り、日本語は全部 "download")。実データの題名はほぼ日本語なので、
  // ここで assert すると「環境の性質」を「アプリの不具合」と読み違える。
  // アプリが制御しているのは `<a download>` の値なので、そこを直接見る
  const anchorNames = await page.evaluate(
    () => (window as unknown as { __n?: string[] }).__n ?? [],
  );
  expect(anchorNames).toHaveLength(1);
  // 題名は**ノートのもの**(コンテナ名 "PKC3" ではない)
  expect(anchorNames[0]).toMatch(/^ZIP-のノート-\d{8}\.pkc3\.zip\|true$/);

  const path = await download.path();
  const names = zipNames(readFileSync(path!));
  expect(names).toContain('container.json');

  // 🔴 取り込み直すと **1 件だけ**増える(他のノートが混ざっていない)
  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: 'one.pkc3.zip',
    mimeType: 'application/zip',
    buffer: readFileSync(path!),
  });
  await expect(rows).toHaveCount(3);

  // 履歴も一緒に戻っている
  await clickReal(page, '[data-pkc-region="entry-list"] [data-pkc-entry]:last-child');
  await clickReal(page, '[data-pkc-action="show-history"]');
  await expect(page.locator('[data-pkc-rev-order]')).toHaveCount(2);

  expect(errors).toEqual([]);
});

test('🔴 可搬 HTML: 書き出したファイルが**単体で開いて読める**', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // 添付つきの中身を作る(base64 の流し込みまで往復させる)
  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: 'backup.pkc2.zip',
    mimeType: 'application/zip',
    buffer: pkc2Zip(),
  });
  await expect(page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]')).toHaveCount(2);

  const dl = page.waitForEvent('download');
  await clickReal(page, '[data-pkc-action="export-html"]');
  const download = await dl;
  expect(download.suggestedFilename()).toMatch(/\.html$/);
  // ⚠ `download.path()` は**拡張子の無い**一時ファイルを指す ── `file://` で開くと
  // Chromium が HTML と判定せず、素のテキストとして表示される(= script が動かない)。
  // 実際に user が受け取るのは `.html` なので、`.html` として保存してから開く
  const file = join(tmpdir(), `pkc3-portable-${process.pid}.html`);
  await download.saveAs(file);

  // 🔴 **アプリではなく書き出したファイルそのものを開く** ── 単体で成立するか
  const viewer = await page.context().newPage();
  const viewerErrors = collectPageErrors(viewer);
  await viewer.goto(`file://${file}`);

  // 一覧が出て、最初の entry が自動で開く
  const items = viewer.locator('#list button');
  await expect(items).toHaveCount(2);
  await expect(viewer.locator('#title')).toHaveText('ZIP のノート');
  // 🔴 本文の `<!--` + `<script` を**素通りで**読めている = トークナイザが
  // 壊れていない。退避が足りないとページごと真っ白になり、ここへ到達しない
  await expect(viewer.locator('#body')).toContainText('本文');
  await expect(viewer.locator('#body')).toContainText('<script src="x">');
  await expect(viewer.locator('script')).toHaveCount(2); // データ用 + 閲覧 UI

  // 添付を持つ entry へ切り替えると、base64 から復元した画像が**実際に描画**される
  await items.nth(1).click();
  const img = viewer.locator('#body img');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute('src', /^blob:/);
  await expect
    .poll(async () => viewer.locator('#body img').evaluate((el) =>
      (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0))
    .toBe(true);

  expect(viewerErrors).toEqual([]);
  expect(errors).toEqual([]);
  await rm(file, { force: true });
});

test('🔴 md ZIP: 落ちるものを言い、添付が**相対パス**で入る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: 'backup.pkc2.zip',
    mimeType: 'application/zip',
    buffer: pkc2Zip(),
  });
  await expect(page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]')).toHaveCount(2);

  const dl = page.waitForEvent('download');
  await clickReal(page, '[data-pkc-action="export-markdown"]');
  const download = await dl;
  expect(download.suggestedFilename()).toMatch(/\.md\.zip$/);

  // 🔴 **片道であること**が画面に出る(manifest を開かないと分からない形にしない)。
  // 取り込んだ container は履歴を 1 件持つので、その件数まで言えているか
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('片道');
  await expect(page.locator('[data-pkc-region="notices"]')).toContainText(
    '履歴を持つノート 1 件の履歴は落ちます',
  );

  // 実ブラウザが書いた ZIP を node 側で開く(自前 writer の出力を外から検品する)
  const file = join(tmpdir(), `pkc3-md-${process.pid}.zip`);
  await download.saveAs(file);
  const names = zipNames(readFileSync(file));
  expect(names).toContain('manifest.json');
  expect(names).toContain('ZIP のノート.md');
  // 添付は拡張子つきの相対パス ── これが無いと外の markdown ビューアで開けない
  expect(names.some((n) => /^assets\/.+\.png$/.test(n))).toBe(true);

  expect(errors).toEqual([]);
  await rm(file, { force: true });
});
