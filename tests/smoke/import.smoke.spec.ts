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
import { test, expect, type Page } from '@playwright/test';
import { gzipSync, crc32 } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerAppDialog, gotoApp, collectPageErrors, clickReal, expectImageRendered, useSplitEditor, useListBrowse } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useListBrowse(page);
  await useSplitEditor(page);
});

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

/** フォルダの行へ入る(#240 段① で 2 クリックになった)。 */
async function enterFolderRow(page: Page, selector: string): Promise<void> {
  /**
   * ⚠ **`locator.dblclick()` を使う**(`page.mouse.dblclick` ではなく)。
   * 座標を先に採る書き方は、**採ってから押すまでの間に表が組み直されると**
   * 2 回のクリックが別のノードに落ちて `dblclick` が出ない
   * (再描画で node が差し替わるのは正常 ── `helpers.ts` の `withRerenderRetry` と同じ話)。
   * locator 側は「安定するまで待ってから押す」ので、その窓が消える。
   */
  await page.locator(selector).first().dblclick();
}

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

  // 🔴 P8 段⑮: 添付の**展開とハッシュはワーカーがやった**
  //    (user 指示 2026-08-03 不可侵「基本的に重い処理はワーカーにしてください」)。
  //    ⚠ 観測点は「画像が出た」ではない ── 同期経路に落ちても画像は出るので、
  //    **どこで処理されたか**を見る。設定のジョブ表に `asset` の車線が立つ
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(
    page.locator('[data-pkc-lane="asset"]'),
    '添付の展開がメインスレッドで走っている(ワーカーへ出ていない)',
  ).toHaveCount(1);
  // ⚠ 「車線が在る」で止めない ── **実際に処理した件数**まで見る
  //    (spawn しただけで 1 件も流れていない実装が通ってしまう)
  await expect(page.locator('[data-pkc-lane="asset"] td').nth(4)).not.toHaveText('0');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');

  // ── 取り込んだ asset は「参照されている」と実 sqlite 走査で判定される ──
  // (旧 key のまま body に残っていたら、ここで未参照として現れる)
  // ⚠ #239 でこの操作は設定の中(書き出しと片づけ)へ移った ── 先に開く
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await clickReal(page, '[data-pkc-action="purge-orphan-assets"]');
  expect(await answerAppDialog(page, 'ok')).toContain('未参照の添付データはありません');

  // ── 同じファイルをもう一度取り込む(review mutation M23 / M24 / H-2)──
  // 既存 lid・既存 relation id・entryOrder のどれか 1 つでも見ていなければ、
  // ここで 1 部目が**上書きされて消える**(4 件にならない)
  await page.setInputFiles('[data-pkc-field="import-input"]', FILE());
  /**
   * 🔴 **落ちたとき、理由が分かる形にする**(2026-08-25)。
   *
   * ## ⚠ 私はここで 1 度間違えた ── その記録
   *
   * CI で落ちたとき「**2 度目の取り込みが 5 秒で終わっていない**」と読んで
   * **待ちを 20 秒へ伸ばした**。⚠ しかし**次の走りも同じ所で落ちた**:
   *
   * ```
   * Expected: 4  Received: 2  Timeout: 20000ms
   * 44 x locator resolved to 2 elements
   * ```
   *
   * 🔑 **20 秒・44 回 poll して、ずっと 2 のまま**である ── 増える途中ですらない。
   * ⚠ そして**最初の log も「14 回 poll して 2 件のまま」**だった。
   *   つまり**最初から「遅い」ではなかった**のに、待ちを伸ばした
   *   (CLAUDE.md「**flake に見える前にアプリを疑う**」を踏んだ)。
   *
   * ## だから、待ちではなく**診断**を足す
   *
   * 手元では **14 走**(素の 6 + CPU を 2 倍に張った 4 + 別ブラウザ 4)**全部通る**。
   * ⚠ **再現しない原因を書いてはいけない**(CLAUDE.md §4)ので、機構は書かない。
   * 🔑 代わりに、落ちた回が**自分で理由を持ってくる**ようにする ──
   *   出ている lid / 画面の状態 / ジョブ表 / ページのエラーを添えて落ちる。
   *   ⚠ 次の赤が「2 だった」で終わらないことが、この形の目的である。
   */
  try {
    await expect(rows).toHaveCount(4);
  } catch (e) {
    const snap = await page.evaluate(() => ({
      entries: [...document.querySelectorAll('[data-pkc-region="entry-list"] [data-pkc-entry]')]
        .map((el) => el.getAttribute('data-pkc-entry')),
      status: (
        document.querySelector('[data-pkc-region="status"]')?.textContent ?? ''
      )
        .replace(/\s+/g, ' ')
        .slice(0, 200),
      lanes: [...document.querySelectorAll('[data-pkc-lane]')].map((l) =>
        (l.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120),
      ),
      dialogOpen: document.querySelectorAll('dialog[open]').length,
    }));
    throw new Error(
      `2 度目の取込で件数が増えていない。${JSON.stringify(snap)} / `
        + `pageErrors=${JSON.stringify(errors)}`,
      // ⚠ 元の失敗を**捨てない**(どこで落ちたかが消える)
      { cause: e },
    );
  }
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
    // ⚠ **描画 / 原文の切替を持つ fence を必ず 1 つ入れる**(F-1 で判明)。
    //    無いと「原文が二重に出ていないか」を測る術が無く、可搬 HTML の
    //    当該検査が丸ごと空振りする(fixture のゼロ件次元は測っていない次元)
    '',
    '```csv',
    '列A,列B',
    '1,2',
    '```',
    '',
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

  await clickReal(page, '[data-pkc-browse="filer"]');
  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');

  // 🔑 最上位は **root + 循環から救出された 1 件**(階層が効いていれば 7 件並ばない)。
  // 🔴 循環が切れていないと循環上の 2 件は root にも配下にも出ず**完全に消える**
  // ⚠ P9 段③ で **図案が題名の文字列から出た**(以前は '📁 仕事' と連結していたので、
  //    題名そのものが figure を含んでいた ── 絞り込みも読み上げもそれを題名として扱う)。
  //    ここは**題名だけ**を見て、フォルダの印は下で別に見る
  await expect(rows.locator('[data-pkc-field="title"]')).toHaveText(['仕事', '循環2']);
  // 種別は行の頭の図案が示す(P9 段③ で全種別に出すようにした)。
  // ⚠ **フォルダの印**を名指しで数える ── 「図案が 2 つ」だと、この fixture が
  //    たまたま 2 行ともフォルダなので、種別を取り違える変異が素通りする
  expect(
    await rows.locator('[data-pkc-field="title"] [data-pkc-chip="folder"] svg').count(),
    'フォルダの印が消えている',
  ).toBe(2);

  // root へ入る → 「2026」フォルダと「直下メモ」
  // ⚠ フォルダへ入るのは**2 クリック**(#240 段①)
  await enterFolderRow(page, '[data-pkc-region="filer-table"] tbody tr:first-child');
  await expect(rows).toHaveCount(2);
  await expect(rows.locator('[data-pkc-field="title"]')).toHaveText(['2026', '直下メモ']);

  // 「2026」へ入る → 空フォルダと議事録。
  // ⚠ lid は取込時に採番し直されるので **DOM から引く**(`:has-text` は
  // Playwright 専用セレクタで、実クリックの querySelector では使えない)
  // ⚠ タイトルで絞ると更新日の「2026-08-01」にも当たる ── archetype で引く
  const subLid = await page
    .locator('[data-pkc-region="filer-table"] tbody tr[data-pkc-archetype="folder"]')
    .getAttribute('data-pkc-entry');
  // ⚠ 一覧タブにも同じ lid の行が居る(隠れている)── **表の中**を押す
  // ⚠ 入るのは 2 クリック(#240 段①)
  await enterFolderRow(page, `[data-pkc-region="filer-table"] [data-pkc-entry="${subLid}"]`);
  await expect(rows.locator('[data-pkc-field="title"]')).toHaveText(['空フォルダ', '議事録']);

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

  // 🔴 **取り込んだノートが画面に出る**(2026-08-05、user 報告
  //    「開いたら何も起きずに終わる」)。直す前は一覧の末尾に足すだけで、
  //    中央は「左の一覧から選ぶと…」のまま、反応は左下 12px の「取込完了」だけだった。
  //    ⚠ 複数選んだら**最後の 1 件**を開く(user が最後に指した物)
  await expect(
    page.locator('[data-pkc-field="detail-body"]'),
    '取り込んだのに本文が出ない',
  ).toBeVisible();
  await expect(page.locator('[data-pkc-field="detail-title"]')).toHaveText('正本');
  await expect(rows.nth(1)).toHaveAttribute('data-pkc-selected', /.*/);

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
  // ⚠ #239 でこの操作は設定の中(書き出しと片づけ)へ移った ── 先に開く
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
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
  // ⚠ 1 文字一致では見ない ── 本文は markdown として描かれるので、typographer が
  //    `"x"` を丸引用符に変える(それは正しい)。危険なのは **`<` が飲み込まれる**ほうで、
  //    こちらは 1 個でも欠けたら本文が静かに消えている
  await expect(viewer.locator('#body')).toContainText('<script src=');
  expect(
    await viewer.locator('#body').evaluate((el) => (el.textContent ?? '').split('<').length - 1),
    '`<` が飲み込まれている(本文が静かに欠けている)',
  ).toBe(2);
  await expect(viewer.locator('script')).toHaveCount(2); // データ用 + 閲覧 UI

  // 🔴 **描かれている**(P8 段⑲)── かつては本文を丸ごと `<pre>` に入れていたので、
  //    見出しも箇条書きも記号のままだった
  expect(
    await viewer.locator('#body p, #body h1, #body h2, #body ul, #body ol').count(),
    '本文が markdown として描かれていない',
  ).toBeGreaterThan(0);

  // 添付を持つ entry へ切り替えると、base64 から復元した画像が**実際に描画**される
  await items.nth(1).click();
  const img = viewer.locator('#body img');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute('src', /^blob:/);
  await expect
    .poll(async () => viewer.locator('#body img').evaluate((el) =>
      (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0))
    .toBe(true);

  // ── 🔴 fence の「描画 / 原文」切替が閲覧側でも成立しているか。
  //    閲覧用 HTML には CSS-only トグルの規則が 1 行も無く、**両方出て**いた
  //    (表の下に原文、押しても効かないチェックボックス、紙では二重に刷る)。
  //    ⚠ CSS の効きは happy-dom では測れない ── ここが唯一の観測点
  await items.nth(0).click();
  const fenceSrc = viewer.locator('#body .pkc-render-source');
  expect(
    await fenceSrc.count(),
    'この fixture に描画/原文の fence が無い(切替を測っていない)',
  ).toBeGreaterThan(0);
  await expect(fenceSrc.first(), '描画の下に原文が出ている').toBeHidden();
  await expect(viewer.locator('#body .pkc-render-slot').first()).toBeVisible();
  // ⚠ **dead click にしない** ── 属性が変わるだけで見た目が変わらない状態を潰す
  await viewer.locator('#body .pkc-render-toggle').first().click({ force: true });
  await expect(fenceSrc.first(), '切替が効いていない(押しても原文が出ない)').toBeVisible();
  await expect(viewer.locator('#body .pkc-render-slot').first()).toBeHidden();
  await viewer.locator('#body .pkc-render-toggle').first().click({ force: true });
  await expect(fenceSrc.first()).toBeHidden();

  // ── F-1: 折りたたみ目次と印刷。⚠ `@media print` が**実際に効く**かは
  //    happy-dom では測れない ── ここが唯一の観測点なので実ブラウザで見る
  const headings = await viewer.locator('#body h1, #body h2, #body h3').count();
  expect(headings, 'この fixture に見出しが 1 個も無い(目次を測っていない)').toBeGreaterThan(0);
  await expect(viewer.locator('#toc li')).toHaveCount(headings);
  // 畳める(details であること自体が要件 ── JS を足さずに畳める)
  expect(
    await viewer.locator('#dtoc').evaluate((el) => el.tagName.toLowerCase()),
  ).toBe('details');
  // 目次の行を押すと本文の見出しへ移る(#body はスクロール箱の中)
  const before = await viewer.locator('main').evaluate((el) => el.scrollTop);
  await viewer.locator('#toc li').last().locator('button').click();
  expect(
    await viewer.locator('main').evaluate((el) => el.scrollTop),
    '目次から移動していない',
  ).not.toBe(before);

  await viewer.emulateMedia({ media: 'print' });
  const styleOf = async (sel: string, prop: string): Promise<string> =>
    viewer.locator(sel).evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
  // 🔴 **画面用の grid と 100vh をほどく**のが印刷の本題 ── ほどかないと
  //    main がスクロール箱のままで、1 ページ目だけ出て残りが切れる
  expect(await styleOf('body', 'display'), '印刷でも grid のまま').toBe('block');
  expect(await styleOf('main', 'overflow'), 'main がスクロール箱のまま').toBe('visible');
  expect(await styleOf('nav', 'display'), '紙に一覧が出てしまう').toBe('none');
  expect(await styleOf('#ptoc', 'display'), '紙に目次が出ない').not.toBe('none');
  // 🔴 紙に原文を二重に刷らない / 操作子を刷らない
  expect(await styleOf('#body .pkc-render-source', 'display'), '紙に原文が二重に出る').toBe('none');
  expect(await styleOf('#body .pkc-render-toggle', 'display'), '紙に操作子が刷られる').toBe('none');
  // 紙の目次は畳まれない(印刷の直前に open を立てる)
  await viewer.locator('#dtoc').evaluate((el) => {
    (el as HTMLDetailsElement).open = false;
  });
  await viewer.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  expect(await viewer.locator('#dtoc').evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);

  // ── 全体を印刷。
  // 🔴 **観測点は「印刷が始まる瞬間」**(`beforeprint`)であって、押した直後ではない。
  //    `window.print()` の振る舞いは **Chromium のビルドで違う**(2026-08-05 実測):
  //      `chrome`(手元の /opt/pw-browsers/chromium)  … `beforeprint` のみ発火
  //      `headless_shell`(**CI の playwright 既定**)  … `beforeprint` + `afterprint` を同期発火
  //    後者では**押して戻った時点で既に片付いている**(= 正しい動作)。
  //    「押した直後に組み上がっている」を assert した版は、手元だけ通って CI で落ちた。
  await viewer.emulateMedia({ media: 'screen' });
  await expect(viewer.locator('#all')).toBeHidden(); // 画面には出ていない
  await viewer.evaluate(() => {
    // ⚠ 閲覧側の listener は boot 時に付いているので、あとから足すこちらが後に走る
    //    = buildAll() の結果を見ることになる
    (window as unknown as { __snap?: unknown }).__snap = null;
    window.addEventListener('beforeprint', () => {
      (window as unknown as { __snap?: unknown }).__snap = {
        sections: document.querySelectorAll('#all section').length,
        dataPrint: document.body.getAttribute('data-print'),
        imgs: document.querySelectorAll('#all img').length,
      };
    });
  });
  await viewer.locator('#printall').click(); // 本物のクリック
  // ⚠ 印刷は**画像が載ってから**始まる(組んだ直後ではない)── poll で待つ
  await expect
    .poll(async () => viewer.evaluate(() => (window as unknown as { __snap?: unknown }).__snap !== null))
    .toBe(true);
  const snap = (await viewer.evaluate(
    () => (window as unknown as { __snap?: unknown }).__snap,
  )) as { sections: number; dataPrint: string | null; imgs: number } | null;
  expect(snap, '印刷が始まらなかった(beforeprint が来ていない)').not.toBeNull();
  // 🔴 空振り防止 ── この fixture には添付画像が在る。**画像が組まれている**ことを
  //    確かめないと、「画像が載るまで待つ」の検査そのものが何も測っていない
  expect(snap!.imgs, 'この fixture の全件に画像が 1 枚も無い').toBeGreaterThan(0);
  expect(snap!.sections, '印刷が始まる時点で全件が組み上がっていない').toBe(3); // 目次 + 2 件
  expect(snap!.dataPrint).toBe('all');

  // CSS は「その状態のときにどう出るか」。⚠ 紙では nav が消えてボタンを押せないので、
  //    状態は evaluate で作り直す(作るのは同じ buildAll ── ここで見たいのは CSS のほう)。
  //    ⚠ `window.print` は**呼ばれたことを数えるだけ**に差し替える ── 上のビルド差を
  //      持ち込まないため。呼ばれない実装に退化したらここで落ちる
  await viewer.evaluate(() => {
    const w = window as unknown as { __printed: number };
    w.__printed = 0;
    window.print = () => {
      w.__printed += 1;
    };
    document.getElementById('printall')!.click();
  });
  await expect
    .poll(async () => viewer.evaluate(() => (window as unknown as { __printed: number }).__printed))
    .toBe(1);
  await expect(viewer.locator('#all section')).toHaveCount(3);
  await expect(viewer.locator('#all'), '画面に紙用の全件が出てしまう').toBeHidden();
  await viewer.emulateMedia({ media: 'print' });
  expect(await styleOf('main', 'display'), '全体印刷で main が残っている').toBe('none');
  expect(await styleOf('#all', 'display'), '全体が紙に出ない').toBe('block');
  // 🔴 組んだものは**捨てる**(印刷後に常駐させない)
  await viewer.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(viewer.locator('#all section')).toHaveCount(0);
  await viewer.emulateMedia({ media: 'screen' });

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
  // ⚠ #239 でこの操作は設定の中(書き出しと片づけ)へ移った ── 先に開く
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
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
