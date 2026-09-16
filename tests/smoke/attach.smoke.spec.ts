/**
 * smoke #4(P4a): 添付取込(実 file picker input)→ entry 出現 → preview が
 * 「実際に画面に出る」+ Blob 直 put 経路の end-to-end(実 IDB + 実 sqlite meta)。
 */
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { answerAppDialog, gotoApp, collectPageErrors, clickReal, expectImageRendered, createEntry, useSplitEditor, useListBrowse, expectMainGapUnderBudget } from './helpers';
// ⚠ 段⑤(xlsx を SQL で調べる)の bytes は Node 側でこの 1 本から組む(#854 段③)。
import { buildXlsx } from '../features/xlsx-fixture';
import { buildParquet } from '../features/parquet-fixture';

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


/**
 * 🔴 **その場で zip を組む**(#818)── store 方式(圧縮なし)+ CRC。
 *
 * ⚠ 出来合いの fixture を repo に置かない ── 何が入っているかが**この file から
 *   読めない**と、落ちたときに「zip が悪いのか実装が悪いのか」が分からない。
 * 🔑 `zip-reader` は CRC を照合するので、**正しい CRC を書く**のが要点である。
 */
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_T[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function makeZip(files: readonly { name: string; data: Buffer }[]): Buffer {
  const body: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6); // 名前は UTF-8
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    body.push(lh, name, f.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(body), cd, eocd]);
}

/**
 * 🔴 **裁定 A の当のふるまいを、実ブラウザで 1 度通す**(user 裁定 2026-09-02、#666)。
 *
 * > 「読んでいたノートの本文に入る」
 *
 * ⚠ **unit では届かない**(#666 の着地前レビュー 8)── `attach-intake.test.ts` は
 *   `REQUEST_APPEND` という **event** までしか見ていない。「本文に入った」は
 *   ①効果層が disk へ書き ②画面が読み直して ③絵として描く、の 3 段を経るので、
 *   event を見るだけでは **1 度も本文に届いていなくても緑**になる。
 * 🔑 だから見るのは **user が見る所** ── 開いたままのノートの本文に、
 *   その画像が**描かれている**こと。
 */
test('🔴 ノートを開いたまま添付すると、そのノートの本文に絵が入る (#666)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('買い物メモ');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.click();
  await page.keyboard.type('# 買い物メモ');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  // ⚠ **前提** ── ここが開いていなければ、以降は何も見ていない
  await expect(
    page.locator('[data-pkc-field="detail-title"]').first(),
    '台の前提: ノートが開いていない',
  ).toHaveText('買い物メモ');

  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'ねこ.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });

  // ① 🔴 **画面ごと持っていかれない** ── 読んでいたノートが開いたまま
  await expect(
    page.locator('[data-pkc-field="detail-title"]').first(),
    '画面が添付へ移った(#666 の症状そのもの)',
  ).toHaveText('買い物メモ', { timeout: 15_000 });

  // ② 🔴 **本文に絵が入る** ── 参照が hydrate されて実際に描かれる
  await expectImageRendered(page, '[data-pkc-region="detail"] img[data-pkc-asset-key]');

  // ③ ⚠ 何が起きたかを言う(黙って終わらない)
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '入れたことを言っていない',
  ).toContainText('「ねこ.png」を本文のいちばん下に入れました');

  // ⚠ 対照群 ── 添付そのものは 1 件できている(ノートと合わせて 2 行)
  await expect(page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]')).toHaveCount(2);

  /**
   * ── ⑤ 🔴 **zip の中を見て、選んだ物だけ取り出す**(#818 段②③)。
   *
   * ⚠ **新しい起動を足さない**(#820 の規律)── この物語の続きとして測る。
   * 🔴 ここでしか見えないのは 3 つ:①**zip の添付にだけ「中を見る」が出る**
   *   (対照群 = さっきの png には出ない)②**実体を読んで中央ディレクトリが引ける**
   *   ③**取り出した物が本当に添付になる**。
   */
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: '書庫.zip',
    mimeType: 'application/zip',
    buffer: makeZip([
      { name: '写真/海.jpg', data: Buffer.from('umi') },
      { name: '写真/山.jpg', data: Buffer.from('yama') },
      { name: 'readme.txt', data: Buffer.from('hello') },
      /**
       * ⚠ **重い 1 件を混ぜる**(#818 の残件)── 取り出しは CRC を舐めるので、
       *   小さい物だけでは「固まらない」を**測ったことにならない**
       *   (fixture のゼロ件次元 ── CLAUDE.md §2)。
       */
      { name: '大きい.bin', data: Buffer.alloc(8 * 1024 * 1024, 7) },
    ]),
  });
  await expect(page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]')).toHaveCount(3);
  // ⚠ **対照群** ── 画像の添付には出ない(押せるのに必ず失敗する口を作らない)
  await clickReal(page, '[data-pkc-region="entry-list"] [data-pkc-entry]:has-text("ねこ.png")');
  await expect(
    page.locator('[data-pkc-action="browse-archive"]'),
    '画像の添付にも「中を見る」が出ている',
  ).toHaveCount(0);

  await clickReal(page, '[data-pkc-region="entry-list"] [data-pkc-entry]:has-text("書庫.zip")');
  /**
   * 🔴 **既定は「別の窓」**(#826。user 指摘 2026-09-09「**別窓にはできないの？**」)。
   *
   * ⚠ **ここでしか見えない**:`window.open` は **user の操作の続き**でしか通らないので、
   *   「目録を読んでから開く」形にすると**本物のブラウザだけで塞がれる**。
   *   unit の作り物の窓では、その順番は再現できない(§2 未実行の経路)。
   */
  const [win] = await Promise.all([
    page.context().waitForEvent('page'),
    clickReal(page, '[data-pkc-action="browse-archive"]'),
  ]);
  const rows = win.locator('[data-pkc-field="archive-window-row"]');
  await expect(rows.first(), '別の窓に一覧が出ない').toBeVisible();
  // 階層が出ている(フォルダは末尾の `/`)
  await expect(win.locator('body')).toContainText('写真/');
  await expect(win.locator('body')).toContainText('readme.txt');
  // ⚠ **本文が退いていない**(その場の器と違うのはここ ── 見ながら選べる)
  await expect(
    page.locator('[data-pkc-region="app-dialog"]'),
    '別の窓で開いたのに、この画面の器も出ている',
  ).toHaveCount(0);
  const winOk = win.locator('[data-pkc-field="archive-window-ok"]');
  // 🔴 フォルダを押すと、その下の 2 件が入る
  await rows.nth(0).click();
  await expect(winOk, 'フォルダの下の件数が字に出ていない').toHaveText('選んだ 2 件を取り出す');
  // ⚠ 重い 1 件も混ぜる(下の「固まらない」を測るため)
  await win.locator('[data-pkc-field="archive-window-row"]', { hasText: '大きい.bin' }).click();
  await expect(winOk).toHaveText('選んだ 3 件を取り出す');

  /**
   * 🔴 **取り出しでメインが固まらない**(#818 の残件。user 指示 2026-08-03
   * 「重い処理はワーカーへ」)。
   *
   * ⚠ **絶対値の閾値にしない** ── 何もしていない間の欠測を**同じ計器**で先に採り、
   *   そこからの増分で見る(`大きい添付を貼っても…` と同じ規律。閾値上げで
   *   flake を隠さないため)。
   * 🔑 取り出しは `Blob.stream()` を舐めながら CRC を取る作りなので、
   *   **塊ごとに手が空く**はずである ── ここはその**後条件**である。
   */
  const base = await page.evaluate(async () => {
    const gaps: number[] = [];
    let last = performance.now();
    const hb = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }, 4);
    await new Promise<void>((r) => setTimeout(r, 500));
    clearInterval(hb);
    gaps.sort((a, b) => b - a);
    return { max: Math.round(gaps[0] ?? 0), ticks: gaps.length, top: gaps.slice(0, 5).map((n) => Math.round(n)) };
  });
  // ⚠ **下の `expectMainGapUnderBudget` も同じことを見るが、ここは残す** ──
  //    対照群が死んでいるなら、**20 秒かかる取り出しを始める前に**落としたい
  expect(base.ticks, '対照群の心拍が取れていない(比べる相手が無い)').toBeGreaterThan(5);
  await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __hb: number };
    w.__gaps = [];
    let last = performance.now();
    w.__hb = window.setInterval(() => {
      const now = performance.now();
      w.__gaps.push(now - last);
      last = now;
    }, 4);
  });
  await winOk.click();
  // ⚠ **選んだら窓は閉じる**(取り出した後も選び手が残らない)
  await expect
    .poll(() => win.isClosed(), { message: '選んだのに別の窓が残っている' })
    .toBe(true);
  // 🔴 取り出した物が添付になる(ノート + png + zip + 3 = 6 行)
  await expect(
    page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]'),
    '取り出した物が添付になっていない',
  ).toHaveCount(6, { timeout: 20_000 });
  const load = await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __hb: number };
    clearInterval(w.__hb);
    const g = [...w.__gaps].sort((a, b) => b - a);
    return { max: Math.round(g[0] ?? 0), ticks: g.length, top: g.slice(0, 5).map((n) => Math.round(n)) };
  });
  // 🔑 **値は毎回 log に残る**(#878 ①)── 門も予算も `expectMainGapUnderBudget` が正本
  expectMainGapUnderBudget('取り出し', {
    maxGap: load.max,
    base: base.max,
    ticks: load.ticks,
    baseTicks: base.ticks,
    top: load.top,
    baseTop: base.top,
  });
  await expect(page.locator('[data-pkc-region="entry-list"]')).toContainText('海.jpg');
  await expect(page.locator('[data-pkc-region="entry-list"]')).toContainText('山.jpg');

  /**
   * ── ⑥ 🔴 **「この画面」を選ぶと、今までどおりその場の器で開く**(#826)。
   *
   * ⚠ **新しい起動を足さない**(#820 の規律)── 同じ物語の続きで、
   *   保存を書き換えてもう 1 度押すだけ(`currentOpenPlace` は押すたびに読む)。
   * 🔑 **その場の器を消していないこと**の後条件でもある ── ポップアップを
   *   止めている user は、ここしか通らない。
   */
  await page.evaluate(() => localStorage.setItem('pkc3.open-place', 'here'));
  await clickReal(page, '[data-pkc-region="entry-list"] [data-pkc-entry]:has-text("書庫.zip")');
  await clickReal(page, '[data-pkc-action="browse-archive"]');
  const box = page.locator('[data-pkc-region="app-dialog"]');
  await expect(box, 'この画面を選んだのに器が出ない').toBeVisible();
  await expect(box).toContainText('写真/');
  await clickReal(page, '[data-pkc-field="dialog-cancel"]');
  await expect(box).toBeHidden();

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **編集中に添付しても断らず、預かって、編集を終えると本文に入る**(#668 B)。
 *
 * ⚠ 直す前は「編集を終了してから添付してください」と断り、user はファイルを
 *   選び直すことになった。録音・画面録画は編集中に終わっても預かるのに、隣の
 *   「添付」だけが断っていた。
 * 🔑 見るのは user が見る所 ── 押した直後の帯(預かりました)と、編集を終えた後の
 *   本文(絵が描かれている)。⚠ 預かりの仕掛けは unit(`attach-intake.test.ts` の B)
 *   が見るが、**編集を終える操作 → 錠が解けて流れる**は実物の効果層でしか通らない。
 */
test('🔴 編集中に添付しても断らず、編集を終えると本文に入る (#668 B)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('会議メモ');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.click();
  await page.keyboard.type('# 会議メモ');

  // ⚠ **編集中のまま**添付を渡す(ここで断られるのが直す前の症状)
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'ねこ.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });
  const status = page.locator('[data-pkc-region="status"]');
  await expect(status, '預かったことを言っていない').toContainText('「ねこ.png」を預かりました');
  await expect(status, '断っている(直す前の症状)').not.toContainText('編集を終了してから');
  // 預かっている間、打っていた本文は無傷
  await expect(ta).toHaveValue('# 会議メモ');

  await clickReal(page, '[data-pkc-action="commit-edit"]');
  // 編集を終えると、そのノートは開いたままで、本文に絵が入る
  await expect(
    page.locator('[data-pkc-field="detail-title"]').first(),
    '画面が添付へ移った',
  ).toHaveText('会議メモ', { timeout: 15_000 });
  await expectImageRendered(page, '[data-pkc-region="detail"] img[data-pkc-asset-key]');
  await expect(status, '入れたことを言っていない').toContainText('「ねこ.png」を本文のいちばん下に入れました');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('添付取込 → entry 出現 → image preview が可視高さを持つ', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // 常設 hidden input に直接ファイルを渡す(picker ダイアログの代替)
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });

  // sidebar に添付 entry が生え、選択されている
  const row = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(row).toHaveCount(1);
  await expect(row.first()).toContainText('dot.png');

  // preview の img が blob: URL で実際に描画される(lend 経路)
  await expectImageRendered(page, '[data-pkc-field="attachment-media"]');

  // ダウンロード導線の可視 + クリック可能(占有チェック込み)
  await clickReal(page, '[data-pkc-action="download-asset"]');

  // ── P4b: 本文 markdown の asset: 参照が実描画される(placeholder → hydrate)──
  // 添付に割り当てられた key を DL ボタンから読み、text note の本文で参照する
  const assetKey = await page
    .locator('[data-pkc-action="download-asset"]')
    .first()
    .getAttribute('data-pkc-asset-key');
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.click();
  await page.keyboard.type(`![点](asset:${assetKey})\n\n[点をDL](asset:${assetKey})`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await expectImageRendered(page, 'img[data-pkc-asset-key]'); // hydrator が実際に差した
  // DL link も実クリック可能(href 無し ── ナビゲーションを起こさない)
  await clickReal(page, 'a[data-pkc-action="download-asset"]');
  expect(page.url()).not.toContain('asset:'); // asset: へ遷移していない

  // ── P4b: 「添付の整理」(orphan GC)の end-to-end 配線 ──
  // この asset は attachment frontmatter と本文 asset: の両方から参照されて
  // いるので、実 sqlite 走査の結果は「未参照なし」が正(scan が実際に走った証拠)
  // ⚠ #239 でこの操作は設定の中(書き出しと片づけ)へ移った ── 先に開く
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await clickReal(page, '[data-pkc-action="purge-orphan-assets"]');
  expect(await answerAppDialog(page, 'ok')).toContain('未参照の添付データはありません');

  expect(errors).toEqual([]);
});

/**
 * P8 段㉓: 🔴 **添付でメインスレッドを止めない**。
 *
 * > user 実機報告 2026-08-04「添付とかでメインスレッドブロックするのは気になるね」
 *
 * 🔴 直す前は `identifyAsset` を**メインで**呼んでいた。実測(心拍 4ms の
 * 最大欠測。同じビルドで `?pkc-asset-inline` の有無だけを変えた A/B、32MB):
 * ```
 *   ワーカー   10 / 14 ms
 *   メイン     500 / 726 ms
 * ```
 * ⚠ **どの呼び出しが止めているかは主張しない** ── 遊んでいるページで
 *   `blob.arrayBuffer()` / `crypto.subtle.digest` を単体で測るとどちらも
 *   止まらない。止まるのは添付の実経路だけである。
 *
 * ⚠ **観測点は「ワーカーを使ったか」ではなく「メインが止まったか」**。
 *   配線を見るだけだと、ワーカーに投げる前に bytes を作る実装で素通りする。
 * ⚠ 心拍の欠測で測る ── `PerformanceObserver('longtask')` は 50ms 未満を
 *   落とすので、直した後の 6〜9ms が観測できず「0 本」で自明に通ってしまう。
 */
test('🔴 大きい添付を貼ってもメインスレッドが固まらない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  const SIZE_MB = 32;
  const m = await page.evaluate(async (sizeMb) => {
    // ⚠ bytes の生成は**計測の外**(計器自身のコストを混ぜない ── 段⑮ で
    //    playwright のファイル注入を app の freeze と読み違えた前例がある)
    const bytes = new Uint8Array(sizeMb * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i & 0xff;
    const file = new File([bytes], `big-${sizeMb}.bin`, { type: 'application/octet-stream' });

    /**
     * 🔴 **心拍は使い回す**(2026-09-09)── 同じ測り方で「何もしていない間」も測り、
     * **対照群**にする(CLAUDE.md 計測規律「対照群は『何もしない』ではなく
     * 『測りたい操作以外を全部同じにしたもの』」)。
     */
    const beat = (): {
      stop: () => { max: number; ticks: number; top: number[] };
    } => {
      const gaps: number[] = [];
      let last = performance.now();
      const hb = setInterval(() => {
        const now = performance.now();
        gaps.push(now - last);
        last = now;
      }, 4);
      return {
        stop: () => {
          clearInterval(hb);
          gaps.sort((a, b) => b - a);
          return {
            max: Math.round(gaps[0] ?? 0),
            ticks: gaps.length,
            // 🔑 上位 5 件(#878)── 1 点だと「外れ値 1 個」と「裾ごと持ち上がった」が見分けられない
            top: gaps.slice(0, 5).map((n) => Math.round(n)),
          };
        },
      };
    };

    // ⚠ **対照群 ── 何もしていない間の欠測**。この箱がどれだけ忙しいかを、
    //    測りたい操作と**同じ計器**で先に採る
    const idle = beat();
    await new Promise<void>((r) => setTimeout(r, 800));
    const base = idle.stop();

    const run = beat();
    const rows = (): number =>
      document.querySelectorAll('[data-pkc-region="entry-list"] [data-pkc-entry]').length;
    const before = rows();
    const input = document.querySelector<HTMLInputElement>('[data-pkc-field="attach-input"]')!;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // ⚠ **増えたこと**を待つ(在ることを待つと前の entry で即満たされる)
    await new Promise<void>((res) => {
      const tick = setInterval(() => {
        if (rows() > before) {
          clearInterval(tick);
          res();
        }
      }, 10);
      setTimeout(() => {
        clearInterval(tick);
        res();
      }, 60000);
    });
    const load = run.stop();
    return {
      added: rows() - before,
      maxGap: load.max,
      ticks: load.ticks,
      base: base.max,
      baseTicks: base.ticks,
      top: load.top,
      baseTop: base.top,
    };
  }, SIZE_MB);

  // ① 🔴 **実際に添付された**(空振り防止 ── 何も起きなければ当然止まらない)
  expect(m.added, '添付が作られていない(この次元を測れていない)').toBe(1);
  /**
   * ②③ 🔴 **心拍が回っていた + メインが止まっていない**(どちらも
   * `expectMainGapUnderBudget` が見る ── 測った値は**毎回 log に残る**。#878 ①)。
   *
   * ⚠ ここは長らく `< 80` の**絶対値**だった。2026-09-09 に smoke を 4 本並べたら
   *   **112ms** で落ちた ── 4 つのブラウザが 4 コアを分け合うので、
   *   **何もしていなくてもメインは 100ms 級で降ろされる**。
   * 🔴 だが閾値を上げるのは「flake を閾値上げで隠す」ことである(この test 自身が
   *   そう戒めていた)。🔑 正しい直しは**同じ計器で採った対照群と比べる**こと ──
   *   箱が静かなら `base` は 10ms 級なので門は実質 90ms のまま、
   *   箱が忙しければ床が上がるぶんだけ門も上がる。
   * ⚠ 守る力は落ちない:壊れたときのメインは **500〜726ms**(ワーカーは 10〜14ms)
   *   なので、床が 100ms 級に上がっても**余裕をもって落ちる**。
   */
  expectMainGapUnderBudget('大きい添付を貼る', m);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **PDF は読める大きさで出る + 別窓でも出る**(2026-08-15、user 報告
 * 「PDF ビューアが動作しない / 窓内と別窓の両方を PKC2 を真似して実装してください」)。
 *
 * ⚠ **観測点は「PDF が描けたか」にしてはいけない** ── 内蔵 PDF ビューアは
 * フル chromium にしか無く、**CI の PR gate(`chromium_headless_shell`)は持たない**
 * (実測: 直接ナビゲートするとダウンロードが始まり、埋め込んでも子フレームが立たない)。
 * 🔑 **実寸なら両方で同じ値が出る**ので、そちらを観測点にする
 * (CLAUDE.md §5「観測点を環境差に強い側へ寄せる」)。
 *
 * ⚠ 直す前の実測は **302 × 152**(器は 925 × 626 空いていた)。
 */
// 自作の最小 PDF(605 bytes・1 ページ・依存なしで手組み)
const PDF_MIN = Buffer.from(
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUg' +
    'L1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAg' +
    'UiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMg' +
    'NCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA2MSA+PgpzdHJlYW0KQlQgL0YxIDE0IFRmIDIwIDE1MCBUZCAoUEtD' +
    'MyBQREYgdmlld2VyIHByb2JlIEFMUEhBLTQyKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQg' +
    'L1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYg' +
    'CjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAw' +
    'MDAgbiAKMDAwMDAwMDM1MiAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQyMgol' +
    'JUVPRgo=',
  'base64',
);

test('🔴 PDF の添付は器いっぱいに出て、別の窓でも開ける', async ({ page }) => {
  const errors = collectPageErrors(page);
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: '見積.pdf',
    mimeType: 'application/pdf',
    buffer: PDF_MIN,
  });
  const media = page.locator('[data-pkc-field="attachment-media"]');
  await expect(media).toHaveAttribute('type', 'application/pdf');

  const m = await media.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const pane = el.closest('[data-pkc-region="detail"]')?.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      w: Math.round(r.width),
      h: Math.round(r.height),
      paneW: Math.round(pane?.width ?? 0),
      data: (el.getAttribute('data') ?? '').slice(0, 5),
    };
  });
  expect(m.tag).toBe('object');
  expect(m.data, 'blob: で渡していない').toBe('blob:');
  // ① 🔴 切手大でない。⚠ 直す前は 152px だった
  expect(m.h, `PDF の高さが ${m.h}px しかない(読めない)`).toBeGreaterThan(400);
  // ② 🔴 器の幅を使い切っている(既定の 300px で止まっていない)
  expect(m.paneW, '前提: 器の幅が取れていない').toBeGreaterThan(600);
  expect(m.w, `器は ${m.paneW}px あるのに PDF は ${m.w}px`).toBeGreaterThan(m.paneW * 0.9);
  // ③ 埋め込みに失敗してダウンロードへ落ちていない
  expect(downloads, 'PDF が画面に出ずダウンロードされた').toEqual([]);

  // ── 別窓 ────────────────────────────────────────────────
  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 10_000 }),
    clickReal(page, '[data-pkc-action="view-asset"]'),
  ]);
  await popup.waitForSelector('[data-pkc-field="asset-window-pdf"]', { timeout: 5000 });
  const shown = await popup.evaluate(() => {
    const o = document.querySelector('[data-pkc-field="asset-window-pdf"]');
    return {
      title: document.title,
      type: o?.getAttribute('type') ?? null,
      data: (o?.getAttribute('data') ?? '').slice(0, 5),
      // 🔑 窓いっぱいか(user 報告の症状は「小さい」だった)
      h: Math.round(o?.getBoundingClientRect().height ?? 0),
      innerH: window.innerHeight,
    };
  });
  // 🔑 題名が**添付の名前**になっている(blob の UUID ではない ── PKC2 はそうなる)
  expect(shown.title, '別窓の題名が添付の名前でない').toBe('見積.pdf');
  expect(shown.type).toBe('application/pdf');
  expect(shown.data).toBe('blob:');
  expect(shown.h, '別窓の PDF が窓いっぱいでない').toBeGreaterThan(shown.innerH * 0.9);
  await popup.close();

  expect(errors).toEqual([]);
});

/**
 * 🔴 **配った単一 HTML でも PDF がその場で出る**(2026-08-15)。
 *
 * ⚠ **片側を直したら、対称の反対側を疑う** ── アプリの画面を器いっぱいに直したが、
 * 書き出し側は**画像だけ inline で、PDF はダウンロードリンク**のままだった
 * (面ごとに違う見え方にしない、が repo の原則)。
 * ⚠ 配った HTML は **`file://` で開く**ので、アプリの CSS も blob の作り方も別経路。
 * だから**実際に落として開いて測る**(既存の書き出し smoke と同じ型)。
 */
test('🔴 配った HTML でも PDF が読める大きさで出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: '見積.pdf',
    mimeType: 'application/pdf',
    buffer: PDF_MIN,
  });
  await expect(page.locator('[data-pkc-field="attachment-media"]')).toHaveAttribute(
    'type',
    'application/pdf',
  );

  const dl = page.waitForEvent('download');
  // ⚠ #239 でこの操作は設定の中(書き出しと片づけ)へ移った ── 先に開く
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await clickReal(page, '[data-pkc-action="export-html"]');
  const file = join(tmpdir(), `pkc3-pdf-${process.pid}.html`);
  await (await dl).saveAs(file);

  const viewer = await page.context().newPage();
  await viewer.goto(`file://${file}`);
  await expect(viewer.locator('#body')).toBeVisible();
  const m = await viewer.evaluate(() => {
    const o = document.querySelector('object[type="application/pdf"]');
    if (!o) return null;
    const r = o.getBoundingClientRect();
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      data: (o.getAttribute('data') ?? '').slice(0, 5),
      // 出せないブラウザ向けの導線が**中に**在る(空白を残さない)
      fallback: o.querySelector('a[download]') !== null,
      innerW: window.innerWidth,
    };
  });
  expect(m, '配った HTML に PDF の埋め込みが無い(ダウンロードリンクのまま)').not.toBeNull();
  expect(m!.data, 'blob: で渡していない').toBe('blob:');
  expect(m!.h, `配った HTML の PDF が ${m!.h}px しかない`).toBeGreaterThan(400);
  expect(m!.w, '幅を使い切っていない').toBeGreaterThan(m!.innerW * 0.5);
  expect(m!.fallback, '出せないときの導線が中に無い').toBe(true);
  await viewer.close();
  expect(errors).toEqual([]);
});

/**
 * 🔴 **画像の別窓も end-to-end で守る**(2026-08-15、着地前レビューで判明)。
 *
 * ⚠ `view-image` → `view-asset` の rename で、**画像側だけ end-to-end の守り手を
 * 失っていた** ── mime→kind の写像は `main.ts` に在り、そこは**どの test からも
 * 実行されない**(原文を読む test しか無い)。別窓の unit は `kind` を引数で受け、
 * popup の smoke は PDF の 1 本だけだったので、写像を `'pdf'` 固定に変える変異が
 * **全 test 緑のまま通り、画像の別窓が空の枠になる**(実際に変異試験で生き延びた)。
 */
test('🔴 画像の別の窓は img で開く(PDF の箱にならない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });
  await expect(page.locator('[data-pkc-action="view-asset"]')).toBeVisible();
  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 10_000 }),
    clickReal(page, '[data-pkc-action="view-asset"]'),
  ]);
  // ⚠ **組み上がるのを待ってから見る** ── popup の event は `about:blank` が
  //    できた時点で飛ぶので、即 evaluate すると中身が揃っていない(flake の元)
  await popup.waitForSelector('[data-pkc-field="asset-window-image"]', { timeout: 5000 });
  const shown = await popup.evaluate(() => ({
    img: document.querySelector('[data-pkc-field="asset-window-image"]') !== null,
    pdf: document.querySelector('[data-pkc-field="asset-window-pdf"]') !== null,
    title: document.title,
  }));
  expect(shown.pdf, '画像なのに PDF の箱で開いた(空の枠になる)').toBe(false);
  expect(shown.img, '画像が入っていない').toBe(true);
  expect(shown.title).toBe('dot.png');
  /**
   * 🔴 **添付の窓にも拡大縮小が出る**(#527 の残り、2026-08-28)。
   * ⚠ 開いた直後は**今までどおり収めて**出す(#192 からの見え方を変えない)。
   *   ⚠ ここを実寸で開くと、大きな写真は**隅しか見えない**。
   */
  expect(
    await popup.evaluate(() => document.body.getAttribute('data-pkc-fit')),
    '添付の窓が収めて開いていない(見え方が変わった)',
  ).toBe('contain');
  await popup.locator('[data-pkc-field="asset-window-zoom"] button', { hasText: '実寸' }).click();
  expect(
    await popup.evaluate(() => document.body.getAttribute('data-pkc-fit')),
    '添付の窓を実寸にできない(押しても何も起きない)',
  ).toBeNull();
  await popup.close();
  expect(errors).toEqual([]);
});

/**
 * 🔴 **本文に貼った画像も、押すと別窓で大きく見られる**(#527、2026-08-28)。
 *
 * ⚠ 先に着地したのは**図(mermaid)だけ**で、user の頼みは
 * 「対象は画像だけでなく**レンダリング結果全部**」だった ── 本文の画像は
 * **押しても何も起きなかった**。
 *
 * ## 🔑 unit では原理的に見られない 3 つ
 *
 * 1. **別窓が本当に開くか**(happy-dom に窓は無い)
 * 2. 🔴 **掴み送りが本当に送るか** ── 送りはブラウザの組版そのものなので、
 *    happy-dom では「代入した値が読める」以上のことが言えない
 * 3. **実寸が「縮む前の大きさ」か**(本文の画像は器の幅に合わせて縮めてある)
 */
test('🔴 本文に貼った画像を押すと、別窓で実寸で開き、掴んで送れる (#527)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 900, height: 700 });
  await gotoApp(page);

  /**
   * ⚠ **その場で作る**(fixture を repo に置かない)。⚠ **1×1 では測れない** ──
   *   この spec の主張は「縮む前の大きさで出る」「はみ出した所へ届く」なので、
   *   **器より大きくできる**絵が要る。
   */
  const made = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 600;
    c.height = 400;
    const g = c.getContext('2d')!;
    g.fillStyle = '#4477aa';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#ffffff';
    g.fillRect(20, 20, 120, 80);
    const blob: Blob = await new Promise((ok) => c.toBlob((b) => ok(b!), 'image/png')!);
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'しゃしん.png',
    mimeType: 'image/png',
    buffer: Buffer.from(made),
  });
  const assetKey = await page
    .locator('[data-pkc-action="download-asset"]')
    .first()
    .getAttribute('data-pkc-asset-key');
  expect(assetKey, '前提: 添付の鍵が取れていない').toBeTruthy();

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(`![しゃしん](asset:${assetKey})\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const img = page.locator('[data-pkc-field="detail-body"] img[data-pkc-asset-key]');
  await expect(img).toHaveAttribute('src', /^blob:/, { timeout: 10_000 });
  // ⚠ **押せることが画面に出ている**(印だけ付けても user は気づかない)
  expect(await img.getAttribute('title'), '押せることが画面に出ていない').toContain('別のウィンドウ');

  const [win] = await Promise.all([context.waitForEvent('page'), img.click()]);
  await win.waitForSelector('[data-pkc-field="asset-window-image"]', { timeout: 10_000 });
  const read = async () =>
    win.evaluate(() => {
      const i = document.querySelector('[data-pkc-field="asset-window-image"]') as HTMLImageElement;
      // ⚠ 送り手は body(この窓は html を hidden にしている)
      const box = document.body;
      return {
        natural: i.naturalWidth,
        shown: Math.round(i.getBoundingClientRect().width),
        fit: document.body.getAttribute('data-pkc-fit'),
        left: Math.round(box.scrollLeft),
        innerW: window.innerWidth,
      };
    });

  // ① 🔴 **実寸で出ている**(器に合わせて縮めていない)
  const first = await read();
  expect(first.natural, '別窓の絵が読めていない(この検査は何も見ていない)').toBe(600);
  expect(first.shown, `実寸で出ていない(実寸 ${first.natural} / 出ている ${first.shown})`).toBe(
    first.natural,
  );

  // ② 窓からはみ出すまで大きくする(掴み送りが要る状態を作る)
  const plus = win.locator('[data-pkc-field="asset-window-zoom"] button', { hasText: '＋' });
  for (let i = 0; i < 4; i += 1) await plus.click();
  const zoomed = await read();
  expect(
    zoomed.shown,
    `前提: 窓(${zoomed.innerW}px)からはみ出していない(送る余地が無い)`,
  ).toBeGreaterThan(zoomed.innerW);

  /**
   * ③ 🔴 **掴んで送れる**(#527「位置の掴み送り」)。
   * ⚠ 端の細い棒だけに頼らせない ── 拡大した絵は「見たい所へ寄せる」が主な操作。
   */
  await win.mouse.move(400, 300);
  await win.mouse.down();
  await win.mouse.move(250, 300, { steps: 5 });
  await win.mouse.up();
  const panned = await read();
  expect(panned.left, `掴んで動かしても送れない(${zoomed.left} → ${panned.left})`).toBeGreaterThan(
    zoomed.left,
  );

  /**
   * ④ 🔴 **収めるへ戻せる**(不可侵指示 2026-08-23「片道の操作を作らない」)。
   * ⚠ 戻れないと、大きくしすぎたら**窓を開き直す**しか道が無い。
   */
  await win.locator('[data-pkc-field="asset-window-zoom"] button', { hasText: '収める' }).click();
  const back = await read();
  expect(back.fit, '収めるへ戻れない').toBe('contain');
  expect(back.shown, `収めたのに窓(${back.innerW}px)からはみ出したまま`).toBeLessThanOrEqual(
    back.innerW,
  );
  await win.close();

  expect(errors).toEqual([]);
});

/**
 * 🔴 **大きな画像は、縮めるか聞く**(#412)。
 *
 * 🔴 **unit では原理的に届かない層**が 3 つ:
 *  ① `createImageBitmap` / `OffscreenCanvas` は happy-dom に**無い** ──
 *     実際に画素が縮むかは実ブラウザでしか見えない
 *  ② **ワーカーの中**で走る(アイドルで kill される)── 配線ごと通す
 *  ③ 縮めた結果が**本当に小さいか**は、再符号化してみないと分からない
 *     (純関数は「縮める狙い」しか持っていない)
 */
test('🔴 大きな画像は縮めるか聞き、断れば原寸のまま入る (#412)', async ({ page }) => {
  const errors = collectPageErrors(page);
  /**
   * ⚠ **既定の 30 秒では足りない**(1 稿目はここで時間切れになり、
   *   `setInputFiles` に辿り着く前に落ちた)── 660 万画素の生成 + JPEG 符号化
   *   + ワーカーでの再符号化が要る。
   */
  test.setTimeout(120_000);
  await gotoApp(page);

  /**
   * ⚠ **その場で作る**(fixture を repo に置かない)── ノイズを描かないと
   *   圧縮で潰れて 1.5MB を下回り、「聞く場面」にならない。
   * 🔑 画素は **`Uint32Array` で 1 回書き**(1 稿目は 1 画素につき 4 回書いて
   *   遅すぎた)。⚠ `data` は `Uint8ClampedArray` なので、buffer を借りて被せる。
   */
  const big = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 3000;
    c.height = 2200;
    const g = c.getContext('2d')!;
    const img = g.createImageData(c.width, c.height);
    const words = new Uint32Array(img.data.buffer);
    // ⚠ 隣り合う画素が相関しないよう、乗算で散らす(圧縮に効く)
    for (let i = 0; i < words.length; i += 1) words[i] = 0xff000000 | (i * 2654435761) >>> 8;
    g.putImageData(img, 0, 0);
    const blob: Blob = await new Promise((ok) => c.toBlob((b) => ok(b!), 'image/jpeg', 0.95)!);
    const buf = new Uint8Array(await blob.arrayBuffer());
    return { size: blob.size, bytes: Array.from(buf) };
  });
  // ⚠ **前提を assert する** ── 1.5MB を下回っていたら、以降は「聞かない」が正しく
  //   なってしまい、この spec は何も見ていないことになる
  expect(big.size, '作った画像が小さすぎて、聞く場面にならない').toBeGreaterThan(1_500_000);

  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'おおきな写真.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(big.bytes),
  });

  // ① 🔴 **聞かれる** ── 本当の数字が両方出る
  const dialog = page.locator('[data-pkc-region="app-dialog"]');
  await expect(dialog, '大きな画像なのに聞かれない').toBeVisible({ timeout: 30_000 });
  const body = page.locator('[data-pkc-field="dialog-body"]');
  await expect(body, '元の画素数が出ていない').toContainText('3000×2200');
  await expect(body, '戻せないことを言っていない').toContainText('戻りません');

  /**
   * ② **断る → 原寸のまま入る**。
   * 🔑 **本文に書かれた大きさ**で見る(添付の本文は `name / mime / size` を持つ)──
   *   「取り込まれた」だけでは、縮んだか原寸かが分からない。
   */
  await clickReal(page, '[data-pkc-field="dialog-cancel"]');
  await expect(dialog).toBeHidden();
  const rows = page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await expect(rows, '断ったら取り込まれなかった').toHaveCount(1);
  /**
   * 🔑 **user に見える字で測る**(`detail.ts:1951` が `2.4 MB` の形で出す)。
   * ⚠ 1 稿目は frontmatter の生の数字を探したが、**frontmatter は画面に出ない**
   *   ので 0 件だった ── 見ているつもりで何も見ていなかった(§4)。
   */
  const sizeOf = async (): Promise<number> => {
    const t = (await page.locator('[data-pkc-region="detail"]').textContent()) ?? '';
    const m = /([\d.]+)\s*(KB|MB)/.exec(t);
    expect(m, `大きさが画面に出ていない: ${t.slice(0, 120)}`).not.toBeNull();
    return Number(m![1]) * (m![2] === 'MB' ? 1024 * 1024 : 1024);
  };
  const keptSize = await sizeOf();
  expect(keptSize, '原寸で入っていない(本文に元の大きさが出ない)').toBeGreaterThan(1_500_000);

  /**
   * ③ 🔴 **受けたら本当に縮む** ── ここが本題である。
   * ⚠ ①②だけだと「聞くだけ聞いて、縮める処理は壊れていても緑」になる
   *   (CLAUDE.md §1 の空振り)。
   * ⚠ **同じ bytes は同じ key に落ちる**ので、2 枚目は別の画像にする必要は無い ──
   *   縮めたほうは**別の bytes** になるから、別の資産として入る。
   */
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'もう一枚.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(big.bytes),
  });
  await expect(dialog, '2 枚目で聞かれない').toBeVisible({ timeout: 30_000 });
  await clickReal(page, '[data-pkc-field="dialog-ok"]');
  await expect(dialog).toBeHidden();
  await expect(rows, '縮めたものが取り込まれていない').toHaveCount(2);
  /**
   * 🔴 **2 枚目を開いてから測る**(user 裁定 2026-09-02、#666 でここが変わった)。
   *
   * ⚠ 直す前は「取り込んだものが**勝手に開く**」ことに寄りかかっていた。いまは
   *   **読んでいたものが開いたまま**なので(1 枚目の添付が開いている)、開き直さずに
   *   測ると **1 枚目の大きさを 2 枚目のものとして読む** ── 数字は出るが、
   *   別の物を指している(CLAUDE.md §4「計器の名前が範囲より広い」と同じ形)。
   * 🔑 だから**中身の行そのもの**(`もう一枚.jpg — image/jpeg`)を待つ ──
   *   題名だけ待つと、本文が「読み込んでいます…」の間に測ってしまう。
   */
  await clickReal(page, '[data-pkc-region="entry-list"] [data-pkc-entry]:has-text("もう一枚.jpg")');
  await expect(
    page.locator('[data-pkc-region="detail"]'),
    '2 枚目の本文が出ない',
  ).toContainText('もう一枚.jpg — image/jpeg', { timeout: 15_000 });
  const shrunkSize = await sizeOf();
  expect(shrunkSize, '受けたのに縮んでいない').toBeLessThan(keptSize);
  // 🔑 **十分小さい**(採用の閾値 85% を満たしている)
  expect(shrunkSize, '縮み方が足りない(採らないはずのものを採っている)').toBeLessThan(
    keptSize * 0.85,
  );

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **囲みの中身を添付から取る**(#444 段①。user 裁定 2026-08-26
 * 「**HTML に限らずにフェンス内にアセットを呼び込むようにすればいいのでは?**」)。
 *
 * 🔑 **unit では届かない 2 つ**を実ブラウザで見る:
 * 1. **本当に IDB から字が読めるか** ── happy-dom の `Blob` は本物ではないし、
 *    unit の lender は差し替えた fake である
 * 2. **描かれた表が本当に画面に出るか**(高さを持つか)── 器のまま残っていても
 *    DOM 上は「置き換わった」ように見えることがある
 */
test('🔴 囲みの中身を添付から取る ── csv の添付が表になる(#444 段①)', async ({ page }) => {
  /**
   * 🔴 **既定の 30 秒では足りない**(#682 段④c で実測した)。
   *
   * ⚠ この筋書きは中に **`{ timeout: 60_000 }` を 2 か所**持っているが、
   *   `playwright.config.ts` の per-test は **30 秒**なので、
   *   **その 60 秒は原理的に使い切れない**(先に test ごと落ちる)。
   * 🔑 DuckDB は器(約 35MB)と拡張 3 つを読み込むので、実測で 30 秒に近づく ──
   *   同じ file の 837 行が既に `test.setTimeout(120_000)` を置いている(前例)。
   */
  test.setTimeout(180_000);
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'uriage.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('しなもの,かず\nりんご,120\nみかん,80\n', 'utf8'),
  });
  const assetKey = await page
    .locator('[data-pkc-action="download-asset"]')
    .first()
    .getAttribute('data-pkc-asset-key');
  expect(assetKey, '添付の鍵が取れない(この先は測れない)').toBeTruthy();

  /**
   * 🔴 **`.xlsx` も、この時点(まだノートを開いていない)で添付として取り込む**
   *   (段⑤ の下ごしらえ。#854 段③)。
   * ⚠ **他の添付と同じ、ノートを開く前**に済ませる(この筋書きを揃えるため)。
   *   🔑 2026-09-14 まではここに「後から添付すると `SELECT_ENTRY` が飛んで
   *   画面が detail へ戻される」と書いてあったが、**#906 で直っている** ──
   *   いまは SQL の面が残る(その動線は下の段⑤-b が pin する)。
   * 🔑 枚を **2 枚**にする ── 1 枚だと `xlsx_sheets`(目録)が作られない
   *   (`readXlsxBook` の「見分けるものが 2 つ以上あるときだけ足す」)。
   */
  const xlsxBytes = await buildXlsx([
    { name: '売上', rows: [['商品', '個数'], ['りんご', '5'], ['みかん', '3']] },
    { name: '経費', rows: [['費目', '金額'], ['交通費', '1000']] },
  ]);
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'uriage.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(xlsxBytes),
  });
  /**
   * 🔴 **1 件ずつ、取り込めたのを見てから次を渡す**(#682 段④c で踏んだ)。
   *
   * ⚠ `attachFiles` は**非同期**で、受け口(`binder.ts`)は読んだ直後に
   *   `el.value = ''` で入力欄を空にする ── 🔴 **待たずに次の file を渡すと、
   *   飛んでいる取り込みと重なって、後の 1 件が黙って消える**。
   * ⚠ 実測(2026-09-16、両ブラウザ同一):csv → xlsx → parquet と続けて渡したら、
   *   **3 件目の `.parquet` だけが添付にならなかった**(左の一覧は csv / xlsx の 2 件、
   *   状態の行は「uriage.xlsx を添付にしました」)。page error は **0 件**で、
   *   選び所で `.parquet` を探す所が 25 秒 retry して落ちた。
   * 🔑 だから**一覧に出たことを見てから**次へ進む(待ちを伸ばすのではなく、
   *   **起きたことを観測してから**進む)。
   */
  const sidebar = page.locator('[data-pkc-region="sidebar"]');
  await expect(sidebar, '.xlsx が添付として取り込まれていない').toContainText('uriage.xlsx');

  /**
   * 🔴 **`.parquet` も、ここで取り込む**(段⑤-c の下ごしらえ。#682 段④c)。
   * 🔑 bytes は `tests/features/parquet-fixture.ts` が**その場で組む**
   *   (`buildXlsx` と同じ向き ── 外から拾ってきた binary を repo へ置かない)。
   */
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'uriage.parquet',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(
      buildParquet([
        { name: 'id', type: 'int32', values: [1, 2, 3] },
        { name: 'shinamono', type: 'utf8', values: ['ringo', 'mikan', 'budou'] },
      ]),
    ),
  });
  await expect(sidebar, '.parquet が添付として取り込まれていない').toContainText('uriage.parquet');

  /**
   * 🔴 **`.json` も取り込む**(#682 段④c。着地前 smoke が
   *   「`.json` は実ブラウザで 1 度も通っていない」と指摘したので足した)。
   * ⚠ お知らせもマニュアルも `.json` を約束している ── **約束したものは通す**。
   * 🔑 中身はただの字なので、`buildParquet` のような組み立てが要らない。
   */
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'meisai.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify([
        { id: 1, shinamono: 'ringo' },
        { id: 2, shinamono: 'mikan' },
      ]),
      'utf8',
    ),
  });
  await expect(sidebar, '.json が添付として取り込まれていない').toContainText('meisai.json');

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.click();
  await page.keyboard.type('```csv asset:' + assetKey + '\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ① 器が表に置き換わり、**添付の字**が出る
  const table = page.locator('[data-pkc-field="detail-body"] table');
  await expect(table).toBeVisible({ timeout: 10_000 });
  await expect(table).toContainText('りんご');
  await expect(table).toContainText('120');
  // ② 器は消えている(二重に残さない)
  await expect(page.locator('[data-pkc-fence-asset-key]')).toHaveCount(0);
  // ③ 高さを持っている(0 だと「出ている」が嘘になる)
  const box = (await table.boundingBox())!;
  expect(box.height, '表の高さが無い').toBeGreaterThan(20);

  /**
   * ④ 🔴 **同じ添付は、SQL で調べる相手にもなる**(#854 段①)。動線:
   *   「.csv を添付として取り込む → SQL で調べる を開く → 選び所でその file を
   *   選ぶ → `SELECT * FROM csv` で中身が引ける」。
   * ⚠ この面は押しボタンを持たない(binder.ts「SQL の面も押しボタンを持たない」)
   *   ので、アドレスで開く(`view=sql` は `SEALED_VIEWS` に無い ── 開ける面)。
   *   同じ道具(`openViewPane`)が `dual` / `query` で使っているのと同じやり方。
   */
  await page.evaluate(() => {
    location.hash = '#pkc?view=sql';
  });
  const sqlPane = page.locator('[data-pkc-view-pane="sql"]');
  await expect(sqlPane, 'SQL の面が開かない').toBeVisible({ timeout: 15_000 });

  const source = page.locator('[data-pkc-field="sql-source"]');
  await expect(
    source.locator('option', { hasText: 'uriage.csv' }),
    '.sqlite の下に .csv が並んでいない',
  ).toHaveCount(1);
  await source.selectOption({ label: 'uriage.csv' });
  // ⚠ 開くのは非同期(worker が bytes を読んで表を作る)── 開き終わるまで待つ。
  //   ここを待たずに走らせると、まだ `guest === null` のうちに走って
  //   **「この PKC」を調べた答えが csv の答えの顔をして出る**(いちばん気づけない外し方)。
  const note = page.locator('[data-pkc-field="sql-note"]');
  await expect(note, '添付が開いたことが画面に出ない').toContainText('uriage.csv を調べています');

  /**
   * 🔴 **どのエンジンで引くかの選び所は、いつも出ている**(#682 段③c)。
   *
   * ⚠ **2026-09-16 に裏返した。** 段② までは「選べる物が 1 つなら選び所ごと隠す」で、
   *   この検査もそれを pin していた ── 🔴 user 報告「**duckdb の導線が無い**」の正体が
   *   その作りだったので、**常に出して、選べない側を薄い字にする**形へ変えた。
   * 🔑 **新しい起動は増やさない**(#820 の規律)── 既に csv を開いているこの道中で見る。
   * ⚠ unit(`sql-pane.test.ts`)は happy-dom なので「属性が立っているか」までしか
   *   言えない ── **実ブラウザで本当に見えるか**はここでしか分からない。
   */
  const engine = page.locator('[data-pkc-field="sql-engine"]');
  const duckOption = engine.locator('option[value="duckdb"]');
  await expect(engine, 'csv を選んだのに、エンジンの選び所が出ていない').toBeVisible();
  await expect(
    engine.locator('option'),
    'エンジンの選び所に 2 つ並んでいない(sqlite と DuckDB)',
  ).toHaveCount(2);
  // ⚠ **既定は今までの sqlite** ── ここが変わると、選ばない人の道が変わる
  await expect(engine, '既定が sqlite でない').toHaveValue('sqlite');
  /**
   * 🔴 **csv では、どちらも選べる**(薄い字が 1 つも無い)。
   * ⚠ これが**下の `.xlsx` の対照群**である ── 「薄い字が付いている」だけを見ると、
   *   **いつも薄くする**変異が生き延びる。
   */
  expect(
    await engine.locator('option').evaluateAll((os) =>
      os.filter((o) => (o as HTMLOptionElement).disabled).map((o) => o.getAttribute('value')),
    ),
    'csv なのに選べないエンジンがある',
  ).toEqual([]);

  /**
   * 🔴 **DuckDB を実ブラウザで起こし、同梱した拡張が本当に読み込まれているか見る**
   * (#682 段④b)。
   *
   * ## なぜここでしか言えないか
   *
   * 段④a の実測は **node** で回した(`duckdb-ext-probe.yml`)。⚠ ブラウザ側は
   * **worker + `registerFileBuffer` を通る別の経路**なので、node で通ったことは
   * 「ブラウザでも通る」を 1 つも保証しない。🔑 ここが**その唯一の観測点**である。
   *
   * ## 🔴 観測点を「読み込まれている物」そのものにする
   *
   * ⚠ 「parquet が読める」で見ると、**読める形式を受け口に足す段(④c)まで
   *   何も測れない**。🔑 だから engine 自身の目録(`duckdb_extensions()`)を引く ──
   *   これは user が打てる SQL なので、**製品の面をそのまま通る**。
   *
   * ## ⚠ 対照群を 2 つ置く
   *
   * ① **同梱していない拡張は読み込まれていない**(`httpfs` 等)── これが無いと、
   *   「全部 true を返す」実装でも緑になる
   * ② **外へは 1 件も飛んでいない** ── 拡張を読み込む口を足したので、
   *   **そこから外へ出ていない**ことを、この回の通信そのもので見る
   *
   * 🔑 **新しい起動は増やさない**(#820 の規律)── csv を開いているこの道中で見る。
   */
  const outward: string[] = [];
  const watchOutward = (req: { url: () => string }): void => {
    const u = req.url();
    if (!u.startsWith('http://localhost') && !u.startsWith('http://127.0.0.1')) outward.push(u);
  };
  page.on('request', watchOutward);
  try {
    await engine.selectOption('duckdb');
    await page.fill(
      '[data-pkc-field="sql-input"]',
      "SELECT extension_name FROM duckdb_extensions() WHERE loaded ORDER BY 1",
    );
    const openedAt = Date.now();
    await clickReal(page, '[data-pkc-action="run-sql"]');
    const duckTable = page.locator('[data-pkc-field="sql-table"]');
    /**
     * ⚠ 待ちが長いのは **35.9MB の wasm を取って組み上げるから**である
     *   (配信は同一オリジンの `vite preview`)。落ちた回に理由が読めるよう、
     *   下で**かかった時間**も出す。
     */
    await expect(duckTable, 'DuckDB が答えを返さない').toBeVisible({ timeout: 60_000 });
    const loaded = await duckTable.locator('tbody tr td:last-child').allTextContents();
    const tookMs = Date.now() - openedAt;

    // 🔴 同梱した 3 つが、3 つとも読み込まれている
    for (const want of ['json', 'parquet', 'sqlite_scanner']) {
      expect(loaded, `${want} が読み込まれていない(${tookMs}ms / ${loaded.join(',')})`).toContain(
        want,
      );
    }
    /**
     * ⚠ **対照群①** ── 同梱していない拡張は読み込まれていない。
     * 🔑 これが無いと、`duckdb_extensions()` の答えを**そのまま全部**拾う
     *   実装(= 何も確かめていない)でも緑になる。
     */
    for (const never of ['httpfs', 'spatial', 'excel']) {
      expect(loaded, `同梱していない ${never} が読み込まれている`).not.toContain(never);
    }
    // ⚠ **空振り防止** ── 目録そのものが空なら、上の `not.toContain` は常に真
    expect(loaded.length, '読み込まれている物が 1 つも出ていない(目録が空)').toBeGreaterThan(3);

    /**
     * 🔴 **対照群②** ── この間、外へは 1 件も飛んでいない。
     * ⚠ `extensions.duckdb.org` を名指しで見ない ── 名指しだと、**別の宛先**へ
     *   出た日に素通りする(#682 の柱は「勝手に外へ出ない」であって
     *   「あの CDN へ出ない」ではない)。
     */
    expect(outward, `外へ出ている: ${outward.join(' / ')}`).toEqual([]);
  } finally {
    page.off('request', watchOutward);
    // 🔑 **元へ戻す** ── この先の筋書きは sqlite の答えを見る(戻し忘れると全部化ける)
    await engine.selectOption('sqlite');
  }

  await page.fill('[data-pkc-field="sql-input"]', 'SELECT * FROM csv');

  /**
   * 🔴 **色と行番号の層が、欄とぴったり重なっている**(#918 段②c/②d)。
   *
   * ⚠ ここが**実ブラウザでしか見えない所**である ── happy-dom は大きさを 0 で返すので、
   *   unit は「同じ値が**書いてあるか**」までしか言えない。
   * ⚠ **折り返すほど長い 1 行**で見る ── 短い字だと 1 行ぶんで、
   *   ずれていても差が出ない(CLAUDE.md §2「その次元が非ゼロか」)。
   * 🔑 **新しい起動は増やさない**(#820 の規律)── この筋書きの続きで確かめる。
   *
   * ## 実測で見つけた欠陥 3 つ(どれもここで殺す)
   *
   * ① **器が欄より 6px 高かった** ── `<textarea>` の UA 既定は `inline-block` なので、
   *    素のまま器へ置くと descender ぶん器が高くなり、層が下へはみ出す
   *    (実測 3/3:欄 141px / 器 147px)。`display: block` で消える。
   * ② 🔴 **折り返しの数が食い違っていた** ── 格子の升は既定で `min-width: auto` を持ち、
   *    `overflow-wrap: break-word` は**最小幅に効かない**ので、空白の無い長い塊で
   *    **升の列が器の外まで育つ**(実測:器 800px に対し **3130px**)。
   *    欄は約 5.9 行、層は 3 行 ── **色が字とずれる**。`min-width: 0` で消える。
   * ③ **欄が 2px 転がっていた** ── `fitSqlInput` が `scrollHeight` をそのまま当てるが、
   *    欄は `border-box` なので**枠が中に食い込む**(段②b から在った)。
   *
   * 🔴 **1 稿目の観測点は②を見抜けなかった** ── `layer.scrollHeight` は中身ではなく
   *   **箱の高さ**を返すので、`ta` と近い数字が出て「揃っている」ように見えていた
   *   (CLAUDE.md §4「計器の名前が、見ている範囲より広い」)。
   * 🔑 だから比べるのは**折り返しの数**である ── それが「重なっている」の本体。
   */
  const longSql = `SELECT ${'x'.repeat(400)} FROM csv`;
  await page.fill('[data-pkc-field="sql-input"]', longSql);
  const fit = await page.evaluate(() => {
    const px = (v: string): number => Number.parseFloat(v) || 0;
    const ta = document.querySelector<HTMLTextAreaElement>('[data-pkc-field="sql-input"]')!;
    const wrap = document.querySelector<HTMLElement>('[data-pkc-field="sql-input-wrap"]')!;
    const cells = [
      ...document.querySelectorAll<HTMLElement>('[data-pkc-field="sql-line-code"]'),
    ];
    const cs = getComputedStyle(ta);
    const lineH = px(cs.lineHeight);
    // ⚠ 欄の中身の高さ = scrollHeight から**内側の余白**を引く(枠は含まれない)
    const taInner = ta.scrollHeight - px(cs.paddingTop) - px(cs.paddingBottom);
    const layerInner = cells.reduce((sum, el) => sum + el.offsetHeight, 0);
    return {
      lineH,
      taInner,
      layerInner,
      taLines: Math.round(taInner / lineH),
      layerLines: Math.round(layerInner / lineH),
      ta: ta.offsetHeight,
      wrap: wrap.offsetHeight,
      taScroll: ta.scrollHeight,
      taClient: ta.clientHeight,
      cells: cells.length,
    };
  });
  // ⚠ 空振り防止 ── そもそも折り返していること(1 行ぶんなら、ずれていても差が出ない)
  expect(fit.cells, '層に升が出ていない(この検査は空振り)').toBe(1);
  expect(fit.taLines, `欄が折り返していない(この検査は空振り): ${JSON.stringify(fit)}`,).toBeGreaterThanOrEqual(3);
  // 🔴 ①器が欄より高くない(`display: block` が無いと descender ぶん高くなる)
  expect(fit.wrap, `器が欄より高い(層が下へはみ出す): ${JSON.stringify(fit)}`).toBe(fit.ta);
  // 🔴 ②**折り返しの数が同じ** ── これが「色が字と重なっている」の本体である
  expect(fit.layerLines, `層と欄で折り返しの数が違う(色が字とずれる): ${JSON.stringify(fit)}`).toBe(
    fit.taLines,
  );
  // 🔴 ③欄が転がっていない(`fitSqlInput` が枠のぶんを足していないと 2px 足りない)
  expect(
    fit.taScroll - fit.taClient,
    `欄の高さが中身に足りていない: ${JSON.stringify(fit)}`,
  ).toBeLessThanOrEqual(1);

  await page.fill('[data-pkc-field="sql-input"]', 'SELECT * FROM csv');
  await clickReal(page, '[data-pkc-action="run-sql"]');

  const sqlTable = page.locator('[data-pkc-field="sql-table"]');
  await expect(sqlTable, '添付の csv から行が返らない').toBeVisible({ timeout: 10_000 });
  /**
   * 🔴 **前の答えの表を読まない**(2026-09-16 に CI で踏んだ)。
   *
   * ⚠ 直す前は `allTextContents()` で**一度だけ**読んでいた。上の DuckDB の筋書きを
   *   足すまでは、ここが**この spec で最初の問い合わせ**だったので
   *   `toBeVisible` が本物の待ちになっていた ── ところがいまは
   *   **前の答えの表が既に出ている**ので、その待ちは**素通りする**。
   * 🔴 実測(CI):`['extension_name']` を読んで落ちた。⚠ **手元では緑だった** ──
   *   CI のほうが速く、組み直しより先に読む順番になる(CLAUDE.md §5
   *   「物事が早く起きて、順番が入れ替わる」)。
   * 🔑 だから**待てる形で見る** ── `toHaveText` は再試行するので、
   *   「まだ組み直していない」と「そもそも違う」を取り違えない。
   */
  const th = sqlTable.locator('thead th');
  await expect(th.nth(0), '先頭の列が _note でない(前の答えの表を読んでいる)').toHaveText(
    '_note',
    { timeout: 10_000 },
  );
  await expect(th.nth(1), '2 列目が _lid でない').toHaveText('_lid');
  await expect(sqlTable.locator('tbody tr'), '行の数が合わない').toHaveCount(2);
  await expect(sqlTable).toContainText('りんご');
  await expect(sqlTable).toContainText('120');

  /**
   * 🔴 **つながり図から、押して SQL を組む**(#918 段⑤。裁定 2026-09-15 = この窓の中)。
   *
   * 動線:「**構造を見る を押す → 四角が出る → 表の名前を押す → 下の欄に SQL が入る →
   * 走らせると答えが出る**」。
   * ⚠ ここが**実ブラウザでしか言えない所**である ── 四角は `position: absolute` で
   *   置くので、happy-dom では**全部 0px の同じ場所**に積み上がり、
   *   「押せる所に在るか」を 1 つも見られない(unit は「字が在るか」までしか言えない)。
   * 🔑 **新しい起動は増やさない**(#820 の規律)── この筋書きの続きで確かめる。
   */
  await clickReal(page, '[data-pkc-action="sql-er-toggle"]');
  const erBox = page.locator('[data-pkc-field="sql-er-box"]');
  await expect(erBox, 'つながり図の四角が出ない').toHaveCount(1, { timeout: 15_000 });
  // ⚠ **大きさを持っている**ことまで見る(0px の箱は「出ている」と言えない)
  const erRect = (await erBox.first().boundingBox())!;
  expect(erRect.width, `四角に幅が無い: ${JSON.stringify(erRect)}`).toBeGreaterThan(80);
  expect(erRect.height, `四角に高さが無い: ${JSON.stringify(erRect)}`).toBeGreaterThan(30);

  // 🔑 欄を空にしてから押す ── 「空 + 表」が `select * from 表` になる道である
  await page.fill('[data-pkc-field="sql-input"]', '');
  await clickReal(page, '[data-pkc-field="sql-er-table"]');
  await expect(
    page.locator('[data-pkc-field="sql-input"]'),
    '図の表を押しても、打つ欄に SQL が入らない',
  ).toHaveValue('select * from csv');

  // ⚠ 組んだ字が**本当に走る**ところまで見る(組めただけでは「取得できた」と言えない)
  await clickReal(page, '[data-pkc-action="run-sql"]');
  await expect(sqlTable.locator('tbody tr'), '図から組んだ SQL で行が返らない').toHaveCount(2);

  // 🔴 畳めること ── 帰り道が無い面を作らない(#300)
  await clickReal(page, '[data-pkc-action="sql-er-toggle"]');
  await expect(erBox, 'もう一度押しても畳めない').toHaveCount(0);

  /**
   * ⑤ 🔴 **添付の `.xlsx` も、同じ選び所から SQL で調べられる**(#854 段③)。動線:
   *   「.xlsx を添付として取り込む(上で済ませた)→ 選び所で `.csv` の下に並ぶ →
   *   選ぶと『◯◯.xlsx を調べています』と出る → `xlsx_sheets` で
   *   **どの表がどの枚か**分かる → `sheet1` で 1 枚目の中身が引ける
   *   (`_note` / `_lid` / `_sheet` 付き)」。
   * ⚠ **新しい起動は増やさない**(#820 の規律)── ④ が開いた同じ SQL の面の
   *   道中に続ける(`gotoApp` / `page.goto` を足さない)。
   * ⚠ **ここで添付しない** ── ノートを開いた後に添付すると `SELECT_ENTRY` が
   *   飛んで aside 面(`sql`)から detail へ戻される(上の下ごしらえのコメント)。
   */
  await expect(
    source.locator('option', { hasText: 'uriage.xlsx' }),
    '.csv の下に .xlsx が並んでいない',
  ).toHaveCount(1);
  // 🔴 **`.xlsx` は `.csv` の下**(#854 段①②③、`paintSource` の並び順)
  const optionLabels = await source.locator('option').allTextContents();
  const csvIndex = optionLabels.indexOf('uriage.csv');
  const xlsxIndex = optionLabels.indexOf('uriage.xlsx');
  expect(csvIndex, '.csv が選び所に見つからない').toBeGreaterThanOrEqual(0);
  expect(xlsxIndex, '.xlsx が .csv より下(後ろ)に並んでいない').toBeGreaterThan(csvIndex);

  await source.selectOption({ label: 'uriage.xlsx' });
  await expect(note, '.xlsx が開いたことが画面に出ない').toContainText('uriage.xlsx を調べています');

  /**
   * 🔴 **`.xlsx` では DuckDB が薄い字になり、理由がその場に出る**(#682 段③c)。
   *
   * ⚠ **2026-09-16 に裏返した。** 段② までは「選び所そのものが消える」で、
   *   この行は `toBeHidden()` を pin していた ── いまは**消さずに薄くする**。
   * 🔑 薄くする理由は段② と同じ:DuckDB から `.xlsx` を読むには**外の拡張**が要る
   *   (設計 doc §4 と当たる)。⚠ ただし**消すと「無い」に見える**ので、
   *   `disabled` な `option` にして**なぜ選べないか**をその場に書く。
   * ⚠ ここが**上の csv の対照群**である ── 上で「薄い字が 0 件」を見ているので、
   *   **いつも薄くする / いつも薄くしない**のどちらの変異も、片方で落ちる。
   */
  await expect(engine, '.xlsx で選び所が消えている(= 導線が無い)').toBeVisible();
  expect(
    await duckOption.evaluate((o) => (o as HTMLOptionElement).disabled),
    '.xlsx なのに DuckDB を選ばせている',
  ).toBe(true);
  /**
   * 🔴 **理由の字は、相手に合わせて変わる**。
   * ⚠ 組み直す合図を「並ぶ数」で持つと、ノート(1 つ)→ `.xlsx`(1 つ)で数が動かず、
   *   **前の相手の理由が残る** ── そこを見る。
   */
  await expect(duckOption, '前の相手の理由が残っている').toContainText('のときだけ使えます');

  // 🔴 どの表がどの枚か ── 目録(`xlsx_sheets`)が引ける
  await page.fill('[data-pkc-field="sql-input"]', 'SELECT * FROM xlsx_sheets');
  await clickReal(page, '[data-pkc-action="run-sql"]');
  await expect(sqlTable, 'xlsx_sheets から行が返らない').toBeVisible({ timeout: 10_000 });
  const sheetHeaders = await sqlTable.locator('thead th').allTextContents();
  expect(sheetHeaders, 'xlsx_sheets の列名が違う').toEqual(['name', 'sheet', 'rows']);
  await expect(sqlTable.locator('tbody tr'), '枚の数が合わない').toHaveCount(2);
  await expect(sqlTable).toContainText('sheet1');
  await expect(sqlTable).toContainText('売上');
  await expect(sqlTable).toContainText('sheet2');
  await expect(sqlTable).toContainText('経費');

  // 🔴 1 枚目(sheet1)の中身が引け、`_note` / `_lid` / `_sheet` が付いている
  await page.fill('[data-pkc-field="sql-input"]', 'SELECT * FROM sheet1');
  await clickReal(page, '[data-pkc-action="run-sql"]');
  await expect(sqlTable, 'sheet1 から行が返らない').toBeVisible({ timeout: 10_000 });
  const xlsxHeaders = await sqlTable.locator('thead th').allTextContents();
  expect(xlsxHeaders.slice(0, 3), '先頭の列が _note / _lid / _sheet でない').toEqual([
    '_note',
    '_lid',
    '_sheet',
  ]);
  await expect(sqlTable.locator('tbody tr'), '行の数が合わない').toHaveCount(2);
  await expect(sqlTable).toContainText('りんご');
  // _sheet 列に本当の枚の名前(売上)が入っている
  await expect(sqlTable).toContainText('売上');

  /**
   * ⑤-a2 🔴 **図で、自分でキーどうしを繋ぐ**(#918 段⑤d-1。user 報告 2026-09-16)。
   *
   * ⚠ ここが**実ブラウザでしか言えない所**である ── 破線も、押した列の印も、
   *   線の札の置き場も、happy-dom では 1 つも測れない(四角が全部 0px に積み上がる)。
   * 🔑 **新しい起動は増やさない**(#820 の規律)── `.xlsx` を選んでいる
   *   この筋書きの続きで確かめる。
   * ⚠ **`.csv` ではできない** ── 表が 1 つしか無いので**繋ぐ相手が居ない**。
   *   だから枚が 2 つある `.xlsx` の所に置いてある(場所を選んだ理由を残す)。
   */
  await page.fill('[data-pkc-field="sql-input"]', '');
  await clickReal(page, '[data-pkc-action="sql-er-toggle"]');
  /**
   * 🔴 **待つ**(2026-09-16 に 1 稿目がここで落ちた)。⚠ 相手を替えた後に開くと
   *   `SQL_ER_TOGGLE` が `REQUEST_SQL_ER` を出して**worker と往復する** ── 即時に
   *   数えると **0** が返る(実測。落ちた回の a11y には、その直後に 3 箱が
   *   完成して写っていた)。🔑 この file の他の所と同じ**待つ assert** に揃える。
   * ⚠ **3 つ**である(`sheet1` / `sheet2` / 目録の `xlsx_sheets`)── 数を書くのは、
   *   「2 つ以上」だと**枚が 1 つに潰れた回**を見逃すからである。
   */
  await expect(erBox, '.xlsx で図の四角が 3 つ出ない').toHaveCount(3, { timeout: 15_000 });
  /**
   * 🔴 **宣言された線が 1 本も無い** ── これが user の困りごとの実体である
   *   (`.xlsx` に外部キーの宣言は書けない)。⚠ **前提として測る** ──
   *   ここが 0 でなければ、下の「自分で引いた線が 1 本」は別の物を数えている。
   */
  const anyChip = page.locator('[data-pkc-field="sql-er-link"]');
  await expect(anyChip, '.xlsx なのに宣言された線が出ている(前提が崩れている)').toHaveCount(0);

  await clickReal(page, '[data-pkc-action="sql-er-connect-toggle"]');
  const connectBtn = page.locator('[data-pkc-field="sql-er-connect"]');
  await expect(connectBtn, '「繋ぐ」が入にならない').toHaveAttribute('aria-pressed', 'true');

  // 1 つ目の四角の 1 列目 → 「ここから」の印が付く
  const colOf = (box: number) =>
    erBox.nth(box).locator('[data-pkc-field="sql-er-column"]').first();
  await clickReal(page, colOf(0));
  await expect(colOf(0), '押した列に「ここから」の印が付かない').toHaveAttribute('aria-pressed', 'true');
  // ⚠ **やめられる**(片道の操作を作らない)── もう一度押すと外れる
  await clickReal(page, colOf(0));
  await expect(colOf(0), 'もう一度押しても「ここから」が外れない').toHaveAttribute('aria-pressed', 'false');

  // 別の四角の列を押す → 線が引かれ、`join` が欄に足される
  await clickReal(page, colOf(0));
  await clickReal(page, colOf(1));
  const mineChip = page.locator('[data-pkc-action="sql-er-unlink"]');
  await expect(mineChip, '自分で引いた線の札が出ない').toHaveCount(1);
  await expect(
    page.locator('[data-pkc-field="sql-input"]'),
    '繋いだのに join が組まれない',
  ).toHaveValue(/join/i);
  // 🔴 **破線で出ている**(色だけに頼らない見分け)── 実ブラウザでしか測れない
  const dash = await page
    .locator('[data-pkc-field="sql-er-lines"] line[data-pkc-mine="true"]')
    .first()
    .evaluate((el) => getComputedStyle(el).strokeDasharray);
  expect(dash, `自分の線が破線になっていない: ${dash}`).not.toBe('none');

  // 🔴 **消せる** ── 置けるだけで外せない操作を作らない
  await clickReal(page, mineChip.first());
  await expect(mineChip, '自分で引いた線を押しても消えない').toHaveCount(0);

  /**
   * 🔴 **切に戻すと、列を押す意味が元へ戻る**(退行が無いこと)。
   * ⚠ ここが**いちばん大事な対照群**である ── 新しいモードを足したせいで、
   *   これまでの「押した列が取り出す列に足される」が死んでいないか。
   */
  await clickReal(page, '[data-pkc-action="sql-er-connect-toggle"]');
  await expect(connectBtn, '「繋ぐ」が切にならない').toHaveAttribute('aria-pressed', 'false');
  await page.fill('[data-pkc-field="sql-input"]', 'select * from sheet1');
  await clickReal(page, colOf(0));
  await expect(
    page.locator('[data-pkc-field="sql-input"]'),
    '繋ぐを切にしたのに、列を押しても取り出す列に足されない',
  ).not.toHaveValue('select * from sheet1');

  // 畳んで元へ戻す ── 以降の筋書きを汚さない
  await clickReal(page, '[data-pkc-action="sql-er-toggle"]');
  await expect(erBox, '図が畳めない').toHaveCount(0);

  /**
   * ⑤-c 🔴 **`.parquet` を、DuckDB で引く**(#682 段④c)。
   *
   * ## 🔑 ここでしか言えないこと
   *
   * ⚠ unit は「**どんな SQL の字を組んだか**」までしか言えない
   *   (`tests/duckdb-read-formats.test.ts` は node で engine に打たせるが、
   *   それも**ブラウザの経路ではない**)。
   * 🔴 **実ブラウザでしか言えないのは、この 3 つが 1 本に繋がること**:
   *   ①配った `parquet` 拡張が**同一オリジンから読み込める**
   *   ②IDB の添付 bytes が器へ差し込まれる
   *   ③外を塞いだ後に、写した表から行が返る
   * 🔑 **新しい起動は増やさない**(#820 の規律)── この筋書きの続きで確かめる。
   */
  /**
   * 🔴 **`.parquet` は選び所のいちばん下**(#682 段④c)── `.xlsx` より後ろに並ぶ。
   * ⚠ 「在る」と「その位置に在る」は別の主張である(上の `.xlsx` 対 `.csv` と同じ形)。
   */
  const labelsWithParquet = await source.locator('option').allTextContents();
  const idxXlsx = labelsWithParquet.indexOf('uriage.xlsx');
  const idxParquet = labelsWithParquet.indexOf('uriage.parquet');
  const idxJson = labelsWithParquet.indexOf('meisai.json');
  /**
   * ⚠ **基準の側も留める**(2026-09-16、着地前 smoke が指摘)。
   * 🔴 `idxXlsx` を検めないと、`.xlsx` が選び所から落ちた日に `-1` になり、
   *   下の「`.xlsx` より後ろ」は**上の行が既に言っていること**へ潰れて**恒真**になる
   *   (CLAUDE.md §1 の形)。上の `.xlsx` 対 `.csv` は基準の側を 2 通りで留めている。
   */
  expect(idxXlsx, '.xlsx が選び所から消えている(この比較の基準が無い)').toBeGreaterThanOrEqual(0);
  expect(idxParquet, '.parquet が選び所に見つからない').toBeGreaterThanOrEqual(0);
  expect(idxJson, '.json が選び所に見つからない').toBeGreaterThanOrEqual(0);
  expect(idxParquet, '.parquet が .xlsx より上(前)に並んでいる').toBeGreaterThan(idxXlsx);
  expect(idxJson, '.json が .xlsx より上(前)に並んでいる').toBeGreaterThan(idxXlsx);

  /**
   * 🔴 **見張りを付け直す**(2026-09-16、着地前 smoke が空振りを見つけた)。
   * ⚠ 上の DuckDB の筋書きは `finally` で `page.off('request', watchOutward)` している ──
   *   つまり**そのまま下で `outward` を見ても、1 件も増えようがない**(恒真の assert)。
   *   🔴 CLAUDE.md §1「代替物で満たせない条件にする」の、いちばん静かな形である。
   * 🔑 だから**この回ぶんを別に数える** ── 付け直して、走らせ終わってから外す。
   */
  const outwardDuck: string[] = [];
  /**
   * ⚠ **全部の数も控える** ── 「外へ 0 件」は、**見張りを付け忘れた版でも成り立つ**。
   * 🔑 だからこの回に**何か 1 件でも見えたこと**を、同じ見張りで数えて空振りを潰す。
   */
  let seenDuck = 0;
  const watchDuck = (req: { url: () => string }): void => {
    seenDuck += 1;
    const u = req.url();
    if (!u.startsWith('http://localhost') && !u.startsWith('http://127.0.0.1')) {
      outwardDuck.push(u);
    }
  };
  page.on('request', watchDuck);

  await source.selectOption({ label: 'uriage.parquet' });
  await expect(note, '.parquet が開いたことが画面に出ない').toContainText(
    'uriage.parquet を調べています',
  );
  /**
   * 🔴 **内蔵の sqlite が薄い字になる**(この形式では選べない)。
   * ⚠ ここが `.csv` / `.xlsx` の**対照群の裏返し**である ── 上の 2 つでは
   *   sqlite が選べ、DuckDB が薄かった。**薄くする側が入れ替わる**ことを見るので、
   *   「いつも薄い / いつも薄くない」のどちらの変異も落ちる。
   */
  await expect(engine, '.parquet で選び所が消えている').toBeVisible();
  await expect(engine, '.parquet なのに sqlite で引こうとしている').toHaveValue('duckdb');
  const liteOption = engine.locator('option[value="sqlite"]');
  expect(
    await liteOption.evaluate((o) => (o as HTMLOptionElement).disabled),
    '.parquet なのに内蔵の sqlite を選ばせている',
  ).toBe(true);
  await expect(liteOption, 'なぜ選べないかが書いていない').toContainText('DuckDB');

  /**
   * 🔴 **画面に出ている手本を、そのまま走らせる**(#682 段④c、着地前レビューの提案)。
   *
   * ⚠ 自分で字を打つと、**画面の案内と手本が嘘でも通ってしまう** ── 実際
   *   `sql-tip.ts` が `csv` を直書きしていて、`.parquet` を選ぶと
   *   **手本をそのまま打つと英語で断られる**状態だった(unit も smoke も鳴らなかった)。
   * 🔑 だから「画面に出ている字で本当に引けるか」を、ここで 1 本に繋ぐ。
   */
  const example = (await page.locator('[data-pkc-field="sql-example"]').textContent()) ?? '';
  expect(example, '手本が parquet の名前で書かれていない').toContain('FROM parquet');
  await page.fill('[data-pkc-field="sql-input"]', example.replace(/^例:\s*/u, ''));
  await clickReal(page, '[data-pkc-action="run-sql"]');
  /**
   * ⚠ **長めに待つ** ── 初回は器(約 35MB)と拡張 3 つを取りに行くので、
   *   `.csv` の回(既に器が起きている)より時間がかかる。
   */
  await expect(sqlTable, '.parquet から行が返らない').toBeVisible({ timeout: 60_000 });
  expect(
    await sqlTable.locator('thead th').allTextContents(),
    '相手の列を勝手に増やしている(parquet には _note / _lid を足さない)',
  ).toEqual(['id', 'shinamono']);
  await expect(sqlTable.locator('tbody tr'), '行の数が合わない').toHaveCount(3);
  await expect(sqlTable, 'parquet の中身が出ていない').toContainText('mikan');
  // ⚠ 断り文が表の代わりに出ていないこと(「出た」と「正しく出た」を分ける)
  await expect(page.locator('[data-pkc-field="sql-note"]'), '断り文が出ている').not.toContainText(
    'does not exist',
  );
  /**
   * ⑤-d 🔴 **`.json` も、同じ道で引ける**(#682 段④c)。
   *
   * ⚠ お知らせもマニュアルも `.json` / `.ndjson` / `.jsonl` を約束している ──
   *   ところが 3 稿目まで **smoke は `.parquet` しか通していなかった**
   *   (着地前 smoke が指摘)。🔑 約束したものは通す。
   * ⚠ **器は相手ごとに作り直す**(鍵が変わる)ので、ここでもう 1 度起こし直す ──
   *   ただし wasm も拡張も**もう取ってある**ので、待ちは短い。
   * 🔑 ここも**画面の手本をそのまま**走らせる(自分で字を打つと、案内が嘘でも通る)。
   */
  await source.selectOption({ label: 'meisai.json' });
  await expect(note, '.json が開いたことが画面に出ない').toContainText('meisai.json を調べています');
  await expect(engine, '.json なのに sqlite で引こうとしている').toHaveValue('duckdb');
  const jsonExample = (await page.locator('[data-pkc-field="sql-example"]').textContent()) ?? '';
  expect(jsonExample, '手本が json の名前で書かれていない').toContain('FROM json');
  await page.fill('[data-pkc-field="sql-input"]', jsonExample.replace(/^例:\s*/u, ''));
  await clickReal(page, '[data-pkc-action="run-sql"]');
  await expect(sqlTable, '.json から行が返らない').toBeVisible({ timeout: 60_000 });
  expect(
    await sqlTable.locator('thead th').allTextContents(),
    '相手の列を勝手に増やしている(json には _note / _lid を足さない)',
  ).toEqual(['id', 'shinamono']);
  await expect(sqlTable.locator('tbody tr'), '行の数が合わない').toHaveCount(2);
  await expect(sqlTable, 'json の中身が出ていない').toContainText('mikan');

  /**
   * ⚠ **外へ出ていない**(段② の柱)── localhost 以外への要求が 1 件も無いこと。
   * 🔑 **`.parquet` と `.json` の両方を通した後**に見る ── 器は相手ごとに
   *   作り直すので、2 形式ぶんの「起こし直し」が窓の中に入っている。
   * ⚠ **空振り防止** ── 見張りが本当に動いていたことを、同じ回の中で確かめる
   *   (`page.on` を付け忘れた版でも `[]` になるので、それだけでは何も言えない)。
   *   🔑 実測(2026-09-16、両ブラウザ一致):窓の中は **10 件**で、内訳は
   *   器 / worker / 拡張 3 つ ── どれも同一オリジンだった。
   */
  expect(seenDuck, '見張りが 1 件も数えていない(付け忘れ = この assert は空振り)').toBeGreaterThan(0);
  expect(outwardDuck, `DuckDB で引いたのに外へ出た: ${outwardDuck.join(' / ')}`).toEqual([]);
  page.off('request', watchDuck);

  // 🔑 図と構造の断りは `.parquet` へ戻して見る(同じ門なので 1 形式で足りる)
  await source.selectOption({ label: 'uriage.parquet' });
  await expect(note, '.parquet へ戻せていない').toContainText('uriage.parquet を調べています');

  /**
   * 🔴 **`.parquet` では「つながり図」も「構造をノートへ」も、理由を出して断る**
   *   (#682 段④c。⚠ 着地前 smoke が「この 2 つは実ブラウザで 1 度も通っていない」と
   *   指摘したので足した)。
   *
   * ⚠ 直す前は worker が **「取り込んだ .sqlite が開かれていません(先に選んでください)」**と
   *   返していた ── user は `.parquet` を選んだのに別の形式の話をされ、
   *   **いまやったばかりの操作をもう一度やれ**と言われる。
   * 🔑 **新しい起動は増やさない** ── この筋書きの続きで確かめる。
   */
  await clickReal(page, '[data-pkc-action="sql-er-toggle"]');
  const erHost = page.locator('[data-pkc-region="sql-er"]');
  await expect(erHost, '図に採れない理由が出ていない').toContainText('まだ出せません');
  await expect(erHost, '選んだばかりなのに「先に選んでください」と言っている').not.toContainText(
    '先に選んで',
  );
  // ⚠ 「採っています」のまま止まっていないこと(永久に空の図を作らない)
  await expect(erHost, '採っています、のまま止まっている').not.toContainText('採っています');
  await clickReal(page, '[data-pkc-action="sql-er-toggle"]');

  await clickReal(page, '[data-pkc-action="sql-schema-to-note"]');
  await expect(note, '「構造をノートへ」が .sqlite の話で断っている').toContainText(
    'まだ出せません',
  );
  await expect(note, '選んだばかりなのに「先に選んでください」と言っている').not.toContainText(
    '先に選んで',
  );

  /**
   * ⑤-b 🔴 **調べている最中にノートを押しても、SQL の面は残る**(#906。user 裁定 2026-09-14)。
   *
   * ⚠ 直す前は `SELECT_ENTRY` が `sql` を aside 面として畳んでいたので、
   *   一覧のノートを押した瞬間に **打ちかけの SQL も選び所も画面から消えていた**
   *   (「もう 1 つ入れて見比べよう」が、そのたびに最初からやり直しになる)。
   * 🔑 **新しい起動は増やさない** ── 段⑤ が開いたままの面で、そのまま押す。
   * ⚠ **対照群を同じ段に置く** ── 「面が残った」だけを見ると、
   *   **押しが 1 件も届いていない**回と区別が付かない(行に印が付くことまで見る)。
   */
  const sqlBefore = await page.inputValue('[data-pkc-field="sql-input"]');
  const sourceBefore = await source.inputValue();
  expect(sqlBefore, '打ちかけの字が空(この先は測れない)').not.toBe('');
  expect(sourceBefore, '相手を選んでいない(この先は測れない)').not.toBe('');
  // ⚠ **いま選ばれていない行**を押す ── 既に選ばれている行だと、下の「印が付く」が
  //   押す前から真で、**押しが届いていない回を見逃す**(対照群が空振りになる)
  const fresh = page
    .locator(
      '[data-pkc-region="sidebar"] [data-pkc-action="select-entry"][data-pkc-entry]:not([data-pkc-selected])',
    )
    .first();
  await expect(fresh, '選ばれていない行が一覧に無い(空振り)').toBeVisible();
  // 🔴 **lid で掴み直す** ── `:not([data-pkc-selected])` のまま待つと、印が付いた
  //   瞬間にこの locator は**別の行**を指す(押した行を見失う)
  const lid = await fresh.getAttribute('data-pkc-entry');
  expect(lid, '行から lid が読めない').toBeTruthy();
  const row = page.locator(`[data-pkc-region="sidebar"] [data-pkc-entry="${lid ?? ''}"]`).first();
  await clickReal(page, row);
  // 🔑 **押しが届いた証拠**(対照群)── 押した行に印が付く
  await expect(row, '押したのに行へ印が付かない ── 届いていない').toHaveAttribute(
    'data-pkc-selected',
    '',
  );
  // 🔴 本題:面が残り、打ちかけの字も選び所もそのまま
  await expect(sqlPane, 'ノートを押したら SQL の面が畳まれた(#906)').toBeVisible();
  expect(
    await page.inputValue('[data-pkc-field="sql-input"]'),
    '打ちかけの SQL が消えた',
  ).toBe(sqlBefore);
  expect(await source.inputValue(), '選んでいた相手が外れた').toBe(sourceBefore);

  /**
   * ⑥ ⚠ **対照群** ── 「この PKC のノート」へ戻すと、csv / xlsx の表はもう引けない
   *   (入れ物が別であること ── #854 段①ノート行「別窓の入れ物」の裏取り)。
   */
  await source.selectOption({ label: 'この PKC のノート' });
  await expect(source, '選び所が「この PKC」へ戻っていない').toHaveValue('');
  await page.fill('[data-pkc-field="sql-input"]', 'SELECT * FROM csv');
  await clickReal(page, '[data-pkc-action="run-sql"]');
  await expect(
    note,
    '「この PKC」に戻したのに csv の表がまだ引ける(入れ物が分かれていない)',
  ).toContainText('no such table');
  await expect(sqlTable, '対照群のはずが csv の表がまだ出ている').toHaveCount(0);

  /**
   * ⑦ 🔴 **手持ちのファイルも、同じ選び所から開ける**(#854 段②)。動線:
   *   「選び所で『手持ちのファイルを開く…』を選ぶ → **本物の file 選択が開く** →
   *   選んだ file が表になり、`SELECT * FROM csv` で中身が引ける」。
   *
   * ⚠ **`<input type=file>` の本物の挙動は unit では再現できない**
   *   (happy-dom は `.click()` でダイアログを開かない)── だから
   *   **ここが唯一この動線を通す検査**である。
   * 🔑 中身は**添付の csv とわざと別の物**にする ── 同じ字にすると、
   *   「開いたつもりで、さっきの添付をまだ調べている」と区別が付かない
   *   (§4「観測点が放っておいても変わるなら、変化は届いた証拠にならない」)。
   * ⚠ **新しい起動は増やしていない**(`scripts/smoke-budget.mjs` の予算に当たらない)
   *   ── 既に在る道中に足す、が #820 の作法である。
   */
  const chooser = page.waitForEvent('filechooser');
  await source.selectOption({ label: '手持ちのファイルを開く…' });
  await (
    await chooser
  ).setFiles({
    name: 'tebiki.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('しなもの,かず\nぶどう,300\n', 'utf8'),
  });
  await expect(
    note,
    '手持ちのファイルを開いたことが画面に出ない',
  ).toContainText('tebiki.csv を調べています');

  await page.fill('[data-pkc-field="sql-input"]', 'SELECT * FROM csv');
  await clickReal(page, '[data-pkc-action="run-sql"]');
  await expect(sqlTable, '手持ちのファイルから行が返らない').toBeVisible({ timeout: 10_000 });
  // 🔑 **さっきの添付ではなく、いま選んだ file を調べている**(字で見分ける)
  await expect(sqlTable, 'いま選んだ file の中身が出ていない').toContainText('ぶどう');
  await expect(
    sqlTable,
    'さっきの添付をまだ調べている(開いたつもりで差し替わっていない)',
  ).not.toContainText('りんご');
  await expect(sqlTable.locator('tbody tr'), '行の数が合わない').toHaveCount(1);

  /**
   * ⑧ 🔴 **打つ欄の鍵盤**(#918 段②a)── 前に打った字(`↑` `↓`)と字下げ(`Tab`)。
   *
   * 🔴 **ここが唯一この動線を通す検査である。**
   * ⚠ `Tab` の字下げは `insertText` = `document.execCommand('insertText')` を通るが、
   *   **happy-dom に `execCommand` は無い**ので unit は**必ず控えの手splice を通る**
   *   (CLAUDE.md §2「本命の分岐を unit は 1 度も通らない」)── つまり
   *   **本物の `execCommand` 側は、ここでしか走らない**。
   * ⚠ `Esc` で焦点が本当に外れるかも、実ブラウザでしか言えない。
   * 🔑 **新しい起動は増やしていない**(#820 の規律)── ⑦ が開いたままの
   *   同じ SQL の面の道中に続ける(`gotoApp` / `page.goto` を足さない)。
   *
   * ⚠ ここまでに**走らせた字**(= 履歴に積まれた字。新しい順。**全 8 件**):
   *   1. `SELECT * FROM csv`(⑥/⑦。⚠ ⑦ は直前と同じなので積まれない)
   *   2. 🔴 `FROM json SELECT * LIMIT 20`(⑤-d。#682 段④c)
   *   3. 🔴 `FROM parquet SELECT * LIMIT 20`(⑤-c。#682 段④c)
   *   4. `SELECT * FROM sheet1`(⑤)
   *   5. `SELECT * FROM xlsx_sheets`(⑤)
   *   6. `select * from csv`(⑤-a2。図の表を押して組んだ字 ── **小文字なので別扱い**)
   *   7. `SELECT * FROM csv`(④)
   *   8. `SELECT extension_name FROM duckdb_extensions() …`(段④b の筋書き)
   *
   * 🔴 **この帳簿は、上の筋書きへ 1 つ足すたびに古くなる**(2026-09-16 に 2 度踏んだ)。
   * ⚠ 1 度目:⑤-c を足したのに 2 番目の期待値を直さず落ちた。
   * ⚠ 2 度目:帳簿を直したつもりで **5 件しか並べず**、実際の画面は **7 件**だった ──
   *   🔴 **総数を留めていなかったので、誰も鳴らなかった**
   *   (`'前に打った字(1 / '` は `1 / 99` でも通る)。着地前 smoke が数えて見つけた。
   * 🔑 だから**総数まで留める** ── 筋書きへ 1 本足した人は、ここで落ちて
   *   **帳簿を直す所が分かる**。
   */
  const input = page.locator('[data-pkc-field="sql-input"]');
  // 🔑 **打ちかけの字**を置く ── 走らせない(履歴には積まれない字である)
  const draft = 'SELECT 2 -- うちかけ';
  await input.fill(draft);
  await input.focus();

  /**
   * 🔴 **いま何番目を見ているかが、欄の下に出る**(user 裁定 2026-09-14)。
   * ⚠ 直す前は**画面が 1 バイトも動かなかった** ── 「これ以上前が無い」のか
   *   「鍵が効いていない」のか、user に区別が付かなかった。
   * ⚠ **押す前は出ていない**ことを先に見る ── 常に出ていたら、下の assert は空振りである。
   */
  const histNote = page.locator('[data-pkc-field="sql-history-note"]');
  await expect(histNote, '押していないのに合図が出ている').toBeHidden();

  // 🔴 1 行目で ↑ → いちばん新しい「走らせた字」が戻る
  await page.keyboard.press('ArrowUp');
  await expect(input, '↑ で前に走らせた字が戻らない').toHaveValue('SELECT * FROM csv');
  /**
   * 🔴 **総数まで留める**(#682 段④c の 2 稿目で、ここが緩くて帳簿がずれた)。
   * ⚠ `'前に打った字(1 / '` で切ると、**何件でも通る** ── 上の帳簿が嘘になっても
   *   誰も鳴らない(CLAUDE.md §1「代替物で満たせない条件にする」)。
   */
  await expect(histNote, 'いま何番目かが出ていない(数が合わなければ上の帳簿を直す)').toContainText(
    '前に打った字(1 / 8)',
  );
  /**
   * 🔴 **2 度目の ↑ は、いま「2 番目に新しい字」である**(#682 段④c で 1 つ増えた)。
   * ⚠ 期待値を書き換えるとき、**上の帳簿も一緒に直す** ── 帳簿と assert が
   *   別々に古くなると、次に足した人はここで落ちても**どこを直すのか分からない**。
   * 🔑 ⑤-d(`.json` を画面の例文で走らせる)がいちばん新しいので、いまは json の字。
   *   ⚠ この名指しは「**足した筋書きが本当に履歴へ積まれた**」の観測点でもある。
   */
  await page.keyboard.press('ArrowUp');
  await expect(input, '2 度目の ↑ でさらに前へ遡らない(⑤-d の字が履歴に積まれていない)').toHaveValue(
    'FROM json SELECT * LIMIT 20',
  );
  // 🔴 ↓ で新しいほうへ戻る
  await page.keyboard.press('ArrowDown');
  await expect(input, '↓ で新しいほうへ戻らない').toHaveValue('SELECT * FROM csv');
  // 🔴 いちばん新しい所からさらに ↓ → **打ちかけだった字**に帰る(消えていない)
  await page.keyboard.press('ArrowDown');
  await expect(input, '打ちかけだった字に帰らない(打った字が消えた)').toHaveValue(draft);
  await expect(histNote, '打ちかけへ帰ったことを言っていない').toHaveText(
    '打ちかけの字を見ています',
  );

  // 🔴 Tab で字下げ(空白 2 つ)が**本当に入る**(⚠ execCommand 側はここでしか走らない)
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  await expect(input, 'Tab で字下げが入らない').toHaveValue(draft + '  ');
  // ⚠ 焦点は**まだこの欄に在る**(Tab で飛んでいない)
  expect(
    await page.evaluate(
      () => document.activeElement?.getAttribute('data-pkc-field') ?? '',
    ),
    'Tab で欄から飛ばされた(字下げにならない)',
  ).toBe('sql-input');

  /**
   * 🔴 **押し所からも呼び戻せる**(user 裁定 2026-09-14「履歴ボタンを 1 つ足す」)。
   * ⚠ スマホ / タブレットには `↑` が**無い** ── ここが唯一の入口である。
   * ⚠ **同じ 1 回の押しで開いて閉じる**罠(`MENU_OPENERS` の載せ忘れ)を、
   *   実ブラウザで踏むのはここだけ ── unit は `click()` を直に撃つので、
   *   document 側の「外を押したら畳む」聞き手を通らない経路もありうる。
   */
  const histBtn = page.locator('[data-pkc-field="sql-history"]');
  await expect(histBtn, '憶えているのに押せない').toBeEnabled();
  await clickReal(page, '[data-pkc-field="sql-history"]');
  const histMenu = page.locator('[data-pkc-region="context-menu"]');
  await expect(histMenu, '履歴の一覧が出ない(押した 1 回で閉じている)').toBeVisible();
  // 🔑 新しい順 ── 先頭はいちばん最後に走らせた字
  await expect(histMenu.locator('button').first(), '新しい順に並んでいない').toHaveText(
    'SELECT * FROM csv',
  );
  await clickReal(page, histMenu.locator('button').first());
  await expect(input, '選んだ字が欄に入らない').toHaveValue('SELECT * FROM csv');
  await expect(histMenu, '選んでも一覧が畳まれない').toHaveCount(0);
  // ⚠ 打ちかけの字は控えられている ── ↓ で帰れる(片道の操作を作らない)
  await input.focus();
  await page.keyboard.press('ArrowDown');
  await expect(input, '押し所から選んだ後、打ちかけへ帰れない').toHaveValue(draft + '  ');

  // 🔴 Esc で**この欄から出る**(鍵盤だけで使う人の逃げ道)
  await page.keyboard.press('Escape');
  expect(
    await page.evaluate(
      () => document.activeElement?.getAttribute('data-pkc-field') ?? '',
    ),
    'Esc を押しても欄から出ていない(閉じ込めている)',
  ).not.toBe('sql-input');
  // ⚠ 出ただけで、打った字は消えていない
  await expect(input, 'Esc で打った字まで消えた').toHaveValue(draft + '  ');

  /**
   * ⑨ 🔴 **打った行数に合わせて伸びる**(#918 段②b。user 裁定 2026-09-14)。
   *
   * 🔴 **ここでしか測れない** ── happy-dom は `scrollHeight` に **0** を返すので、
   *   unit は「高さを当てない」側の枝しか通らない(CLAUDE.md §2)。
   * 🔑 1 行の高さは**その場で実測する**(font も DPR も環境で変わるので、
   *   値を pin しない ── 見るのは**同じ回の中での差**だけ)。
   * ⚠ **新しい起動は増やしていない** ── ⑧ の続きである。
   */
  await input.fill('select 1');
  const h1 = (await input.boundingBox())!.height;
  const eight = Array.from({ length: 8 }, (_, i) => `select ${String(i)}`).join('\n');
  await input.fill(eight);
  const h8 = (await input.boundingBox())!.height;
  const lineH = (h8 - h1) / 7;
  // ⚠ **前提を assert する** ── 伸びていなければ「一致しない」ではなく「前提が崩れている」と読める
  expect(
    lineH,
    `1 行ぶん伸びていない(1 行 ${String(h1)}px → 8 行 ${String(h8)}px)`,
  ).toBeGreaterThan(8);

  // 🔴 **上限で止まる** ── 止まらないと、答えの表が画面から押し出される
  const many = Array.from({ length: 60 }, (_, i) => `select ${String(i)}`).join('\n');
  await input.fill(many);
  const h60 = (await input.boundingBox())!.height;
  const wouldBe = h1 + lineH * 59;
  expect(
    h60,
    `上限が効いていない(切らなければ ${String(Math.round(wouldBe))}px になる)`,
  ).toBeLessThan(wouldBe * 0.7);
  // ⚠ 上限に当たっても**打てなくならない**(欄自身が転がる)
  const scrolls = await input.evaluate(
    (el) => (el as HTMLTextAreaElement).scrollHeight > (el as HTMLTextAreaElement).clientHeight,
  );
  expect(scrolls, '上限で切られたのに、欄の中を転がせない(打った字が読めない)').toBe(true);

  /**
   * ⑩ 🔴 **答えを file へ書き出す**(#918 段④。user 要望「`copy to` 使えないし」)。
   *
   * 🔴 **ここでしか通らない** ── `downloadBlob` は `URL.createObjectURL` →
   *   `<a download>` → `click()` の 3 段で、unit はその 1 段目と 3 段目を**差し替える**。
   *   つまり**本物のブラウザが file を受け取る所**は、実ブラウザでしか走らない。
   * ⚠ **名前は見ない** ── この headless Chromium は**非 ASCII の `<a download>` 名を
   *   丸ごと捨てる**(CLAUDE.md §4)ので、`suggestedFilename()` は観測点にならない。
   *   🔑 見るのは**中身**である(そちらが本題でもある)。
   * ⚠ **新しい起動は増やしていない** ── ⑦ が開いたままの面の続きで、
   *   ⑦ の答え(`tebiki.csv` の 1 行)がそのまま出る。
   */
  const toFile = page.locator('[data-pkc-field="sql-to-file"]');
  await expect(toFile, '答えが出ているのに押せない').toBeEnabled();
  await clickReal(page, '[data-pkc-field="sql-to-file"]');
  const kinds = page.locator('[data-pkc-region="context-menu"]');
  await expect(kinds, '形の一覧が出ない(押した 1 回で閉じている)').toBeVisible();
  await expect(kinds.locator('button'), '形が 3 つ並んでいない').toHaveCount(3);
  const started = page.waitForEvent('download');
  await clickReal(page, kinds.locator('button').first());
  const got = await started;
  const where = await got.path();
  expect(where, 'file が落ちてこない').toBeTruthy();
  const text = await readFile(where, 'utf8');
  /**
   * 🔴 **落ちた file の先頭が BOM である**(動線レビュー 2026-09-14)。
   * ⚠ 無いと Windows の Excel が**その環境の既定の文字集合**で読むので、
   *   日本語の升が文字化けする ── ボタンには「表計算で開く」と書いてある。
   * 🔑 ここで見るのは**ブラウザが実際に書いた byte** ── unit は
   *   「返した字」までしか言えない(途中で落ちても気づけない)。
   */
  expect(text.charCodeAt(0), '落ちた csv の先頭に BOM が無い').toBe(0xfeff);
  // 🔑 1 行目は列の名前 ── 受け取った側が見出しを読める
  expect(text.split('\r\n')[0], '1 行目が列の名前でない').toContain('_note');
  // 🔑 ⑦ で引いた「手持ちのファイル」の中身がそのまま入っている
  expect(text, '答えの中身が入っていない').toContain('ぶどう');
  expect(text, '画面の字が file へ漏れている').not.toContain('(なし)');

  /**
   * ⑪ 🔴 **答えの表を「見えている分だけ」描く**(#918 段③。動線:
   *   「SQL の面を開く → select を打つ → 実行 → 答えの表が出る →
   *   表を下まで転がす → 上へ戻す」)。
   *
   * 🔴 **ここでしか測れない** ── 窓に入るかどうかは `offsetHeight` /
   *   `scrollTop` の実測に懸かっていて、happy-dom はどちらも **0** を返す
   *   (CLAUDE.md §2「本命の分岐を unit は 1 度も通らない」)。
   * ⚠ **新しい起動は増やしていない**(#820 の規律)── ⑩ が開いたままの
   *   同じ SQL の面の道中に続ける(`gotoApp` / `page.goto` を足さない)。
   */
  const fiveKSql =
    "with recursive s(i) as (select 1 union all select i+1 from s where i < 5000) select i, 'あ' || i as a, 'い' || i as b, i*2 as c from s";
  await page.fill('[data-pkc-field="sql-input"]', fiveKSql);
  await clickReal(page, '[data-pkc-action="run-sql"]');
  await expect(sqlTable, '5000 行の答えが返らない').toBeVisible({ timeout: 10_000 });
  await expect(
    page.locator('[data-pkc-field="sql-note"]'),
    '5000 行と画面が言わない',
  ).toContainText('5000 行');

  const sqlBody = page.locator('[data-pkc-field="sql-body"]');
  const drawnRows = sqlTable.locator(
    'tbody tr:not([data-pkc-field="sql-row-spacer"])',
  );

  // ① <tbody> の <tr> は 5000 本ではなく、窓に入る分だけ
  const topCount = await drawnRows.count();
  expect(topCount, '窓が 1 行も描かれていない(測れていない)').toBeGreaterThan(0);
  expect(topCount, '窓に入らず 5000 行が丸ごと描かれている').toBeLessThan(1000);
  // 上端では先頭の行(i=1)が見え、末尾の行(i=5000)はまだ見えていない
  await expect(sqlTable.locator('tbody')).toContainText('あ1');
  await expect(sqlTable.locator('tbody'), '転がる前から末尾の行が見えている').not.toContainText(
    'あ5000',
  );

  const widthsBefore = await sqlTable
    .locator('thead th')
    .evaluateAll((ths) => ths.map((th) => (th as HTMLElement).offsetWidth));

  // ② 下まで転がす → 末尾の行(5000)が見える
  await sqlBody.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(
    sqlTable.locator('tbody'),
    '下まで転がしても末尾の行(5000)が見えない',
  ).toContainText('あ5000', { timeout: 5_000 });
  const bottomCount = await drawnRows.count();
  expect(bottomCount, '下端で窓が 0 行になっている').toBeGreaterThan(0);
  expect(bottomCount, '下端でも 5000 行丸ごと描かれている').toBeLessThan(1000);

  /**
   * 🔴 **切られて見えなくなった字も、`title` には全文が入っている**
   *   (#918 段③。読める道を 1 つ残す)。⚠ ここ(下端・`あ5000` 等の 4〜5 桁行)は
   *   `table-layout: fixed` で列幅が固定された**後**なので、初期の幅より
   *   長い値が来て切られうる場所である。
   */
  const lastTitles = await sqlTable
    .locator('tbody td')
    .evaluateAll((tds) =>
      tds
        .filter((td) => (td as HTMLElement).getAttribute('title') !== null)
        .map((td) => ({ title: (td as HTMLElement).title, text: td.textContent ?? '' })),
    );
  expect(lastTitles.length, '升に title が 1 つも無い(読める道が無い)').toBeGreaterThan(0);
  for (const { title, text } of lastTitles) {
    expect(title, `title が全文でない(升の字「${text}」)`).toBe(text);
  }

  // ③ 転がしても列の幅は動かない(幅は転がる前に固定してある)
  const widthsAfter = await sqlTable
    .locator('thead th')
    .evaluateAll((ths) => ths.map((th) => (th as HTMLElement).offsetWidth));
  expect(widthsAfter, '転がしたら列の幅が動いた').toEqual(widthsBefore);

  // ④ 上へ戻すと、先頭の行(1)が戻る(片道の操作ではない)
  await sqlBody.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(
    sqlTable.locator('tbody'),
    '上へ戻しても先頭の行(1)が戻らない',
  ).toContainText('あ1', { timeout: 5_000 });
  await expect(
    sqlTable.locator('tbody'),
    '上へ戻ったのに末尾の行がまだ残っている',
  ).not.toContainText('あ5000');

  /**
   * ⑤ 🔴 **器が広がったら、窓も広げる**(#918 段③ その 3。着地前レビューが出した)。
   *
   * 🔴 **窓そのものを縦に伸ばす**のが肝である。
   * ⚠ 最初の稿は「打つ欄を伸ばして → 戻す」で作ったが、**それでは落ちない** ──
   *   戻した先が**元の大きさ**なので、そのときの窓は元から足りている
   *   (実際に変異を当てたら **SURVIVED** だった)。
   * 🔑 だから **1 度も無かった大きさ**にする ── 窓を縦 2 倍にすれば、
   *   描き直さない限り**必ず**下に白い帯が出る。
   * 🔑 ここは `ResizeObserver` の経路そのものである(state は 1 ミリも動かない ──
   *   `render()` も `scroll` も呼ばれない)。
   */
  const before = page.viewportSize()!;
  try {
    const rowH = (await drawnRows.first().boundingBox())!.height;
    expect(rowH, '行の高さが測れていない(以降の比較が無意味)').toBeGreaterThan(0);
    await page.setViewportSize({ width: before.width, height: before.height * 2 });
    // 🔑 転がさない ── 転がすと `scroll` が拾ってしまい、この経路を見ない
    await expect
      .poll(
        async () => {
          const n = await drawnRows.count();
          const h = await sqlBody.evaluate((el) => el.clientHeight);
          return n * rowH - h;
        },
        {
          message:
            '窓を広げたのに描く行が増えない ── 下に白い帯が残る' +
            '(`repaint()` が指紋の門より前に在るか / ResizeObserver を張っているか)',
          timeout: 5_000,
        },
      )
      .toBeGreaterThanOrEqual(-rowH);
  } finally {
    // ⚠ 次の段へ大きさを持ち越さない(この test はまだ続きうる)
    await page.setViewportSize(before);
  }

  expect(errors).toEqual([]);
});

/** 🔴 **見つからない添付では理由が出る**(黙って器のままにしない)。 */
test('🔴 添付が無ければ、その場に理由が出る(#444 段①)', async ({ page }) => {
  await gotoApp(page);
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  await page.keyboard.type('```csv asset:ast-nosuchkey\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const err = page.locator('[data-pkc-fence-asset-error]');
  await expect(err).toBeVisible({ timeout: 10_000 });
  await expect(err).toContainText('見つかりません');
  // ⚠ 「中身は添付に在ります」のまま止まっていない(直っていることまで見る)
  await expect(page.locator('[data-pkc-fence-asset-pending]')).toHaveCount(0);
});

/**
 * 🔴 **添付から読んだ図も、器のまま残らない**(#444 段①)。
 *
 * ⚠ この file が 1 度踏んだ形である ── 差し替えた所で `hydrateFigures` を
 *   呼ばないと、**mermaid の器が空のまま**残る(「本文なら描けるのに、
 *   添付から読むと描けない」という一貫性の穴)。
 * 🔑 図は **PNG の `<img>` 1 枚**で出る(不可侵指示 2026-08-03)ので、
 *   そこまで見る。
 */
test('🔴 添付から読んだ mermaid が、絵として出る(#444 段①)', async ({ page }) => {
  await gotoApp(page);
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'zu.mmd',
    mimeType: 'text/plain',
    buffer: Buffer.from('graph TD;\n  A[はじめ] --> B[おわり];\n', 'utf8'),
  });
  const assetKey = await page
    .locator('[data-pkc-action="download-asset"]')
    .first()
    .getAttribute('data-pkc-asset-key');
  expect(assetKey, '添付の鍵が取れない(この先は測れない)').toBeTruthy();

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  await page.keyboard.type('```mermaid asset:' + assetKey + '\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // 🔴 器が残っていない = 差し替わった
  await expect(page.locator('[data-pkc-fence-asset-key]')).toHaveCount(0);
  // 🔴 そして**絵として**出ている(器が空のまま残っていない)
  await expectImageRendered(page, '[data-pkc-field="detail-body"] .pkc-mermaid-placeholder img');
});

/**
 * 🔴 **添付の HTML が、いつもの箱で描かれる**(#444 段①)。
 *
 * > user 裁定 2026-08-26「**PKC 内にすでに存在する HTML なら問題ないのでは?**」
 *
 * 🔑 見るのは「**同じ箱に入る**」こと ── 本文に書いた HTML と同じく
 *   `sandbox="allow-scripts"`(`allow-same-origin` は付けない)の iframe になる。
 * ⚠ 箱の中は同一オリジンではないので中身は覗かない ── **`srcdoc` に入った字**で見る
 *   (親の DOM から読める唯一の観測点)。
 */
test('🔴 添付の HTML が、本文に書いたのと同じ箱で描かれる(#444 段①)', async ({ page }) => {
  // ⚠ この test の後半で添付を横に留める(#848)── 狭いと自動で畳むので窓を広く取る
  //   (`split-frames.smoke.spec.ts` と同じ作法。`gotoApp` の前に決める)
  await page.setViewportSize({ width: 1600, height: 900 });
  await gotoApp(page);
  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'card.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<p id="pkc-mark">添付から来た字</p>', 'utf8'),
  });
  const assetKey = await page
    .locator('[data-pkc-action="download-asset"]')
    .first()
    .getAttribute('data-pkc-asset-key');
  expect(assetKey, '添付の鍵が取れない(この先は測れない)').toBeTruthy();

  /**
   * 🔴 **留めた枠でも添付の設定を触れる**(#848 の実ブラウザ確認)。
   *
   * ⚠ ここに新しい `gotoApp` は足していない ── 上の HTML 添付を作る journey の
   *   途中から続ける(`scripts/smoke-budget.mjs` の門)。
   *
   * 🔑 本文を右クリックして「スタックに載せる」を出すには
   *   `[data-pkc-field="detail-body"]` が要る(`entry-actions.ts` の
   *   `BODY_MENU_ACTIONS`)。添付は**説明が空だと持たない**
   *   (`renderAttachment` ── `description.trim() !== ''` の中でしか描かない)ので、
   *   ここで 1 行だけ足す。⚠ **frontmatter は 1 バイトも書き換えない** ──
   *   textarea の現在値をそのまま読み、末尾に段落を足すだけ。
   */
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const attachEditor = page.locator('[data-pkc-field="editor-body"]');
  const attachRawBefore = await attachEditor.inputValue();
  await attachEditor.fill(`${attachRawBefore}\n\n留めて確かめる用の説明。`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(
    page.locator('[data-pkc-field="detail-body"] p'),
    '添付に足した説明が描かれていない(この先は測れない)',
  ).toContainText('留めて確かめる用の説明');

  // 本文(説明)を右クリック →「このノートをスタックに載せる」で横に留める
  // (`split-frames.smoke.spec.ts` と同じ導線 ── 行ではなく本文から留める)
  await page.locator('[data-pkc-field="detail-body"] p').first().click({ button: 'right' });
  const menu = page.locator('[data-pkc-region="context-menu"]');
  await expect(menu, '本文で右クリックしてもメニューが出ない').toBeVisible();
  await menu.locator('button[data-pkc-action="pin-split"]').click();
  await expect(page.locator('[data-pkc-split-lid]')).toHaveCount(1);
  // ⚠ 以後の 5 つの操作は**この枠の中でだけ**行う ── field 名は主の枠と同じ字なので、
  //   区別できるのはこの region による scope だけである
  const pinned = page.locator('[data-pkc-region="split-frame"][data-pkc-split-lid]');

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').click();
  await page.keyboard.type('```html asset:' + assetKey + '\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const box = page.locator('[data-pkc-field="detail-body"] iframe[data-pkc-html-render-id]');
  await expect(box).toBeAttached({ timeout: 10_000 });
  // 🔴 **同じ箱**である(`allow-same-origin` を持たない)
  expect(await box.getAttribute('sandbox')).toBe('allow-scripts');
  // 🔴 添付の字が箱に入っている
  expect(await box.getAttribute('srcdoc')).toContain('添付から来た字');
  await expect(page.locator('[data-pkc-fence-asset-key]')).toHaveCount(0);

  /**
   * 🔴 **ここからが #848 の確認**(留めた枠 → 主の枠は別のノート → 5 つの設定)。
   *
   * 🔑 対照群 ── 押す前に、主の枠(いま開いているテキストのノート)の生の本文を控える。
   *   `[data-pkc-field="editor-body"]` は主・留めた枠のどちらでも同じ field 名なので、
   *   ここは**編集に入っているのが主の枠だけ**(留めた枠は編集に入らない)という前提で読む。
   */
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const mainBodyBefore = await page.locator('[data-pkc-field="editor-body"]').inputValue();
  await clickReal(page, '[data-pkc-action="cancel-edit"]');
  await expect(box, '編集から戻った後、主の枠の描画が前提と違う').toBeAttached({ timeout: 10_000 });

  // ① アプリとして登録 ── 主はテキストのノートなので、この口は留めた枠にしか無い
  const register = pinned.locator('[data-pkc-field="app-register"]');
  await expect(register, '留めた枠に登録の口が出ていない').toHaveCount(1);
  await register.check();
  const group = pinned.locator('[data-pkc-field="app-group"]');
  await expect(group, '登録すると出るはずの設定欄が出ていない').toBeVisible();

  // ② グループ
  await group.fill('留めた枠の道具');
  await group.blur();

  // ③ アイコン(欄に直に打つ)
  const iconField = pinned.locator('[data-pkc-field="app-icon"]');
  await iconField.fill('📌');
  await iconField.blur();

  // ④ 絵の一覧(押すと欄にも同じ字が反映される ── `launcher.smoke.spec.ts` と同じ観測点)
  const iconBtn = pinned.locator('[data-pkc-action="pick-app-icon"][data-pkc-icon-name="calendar"]');
  await iconBtn.click();
  await expect(iconBtn, '選んだ絵が留めた枠に残っていない').toHaveAttribute('aria-pressed', 'true');
  await expect(iconField).toHaveValue('calendar');

  // ⑤ 名前
  const rename = pinned.locator('[data-pkc-field="attachment-rename"]');
  await rename.fill('留めた枠から改名した添付');
  await rename.blur();

  /**
   * 🔴 対照群 ── 主の枠(いま開いている別のノート)は 1 バイトも変わっていない。
   * ⚠ 上の 5 つがどれか 1 つでも `selectedLid`(主の枠)へ撃っていれば、
   *   ここで frontmatter が増えて食い違う(#848 が塞いだ事故そのもの)。
   */
  await clickReal(page, '[data-pkc-action="start-edit"]');
  const mainBodyAfter = await page.locator('[data-pkc-field="editor-body"]').inputValue();
  expect(mainBodyAfter, '主の枠のノートが、留めた枠の操作で書き換わった').toBe(mainBodyBefore);
  await clickReal(page, '[data-pkc-action="cancel-edit"]');
});

/**
 * 🔴 **書き出したファイルにも中身が入る**(#444 段②)。
 *
 * 🔑 **unit では届かない所を見る** ── ここで測るのは
 *   「**配ったファイルを単体で開いたときに、添付の中身が読めるか**」である。
 *   unit は書き出しの中の文字列までしか見られないが、user が受け取るのは
 *   **アプリも IDB も無い環境で開いた 1 枚**である(hydrator は居ない)。
 * ⚠ 対照群を同じ test に置く ── 器のままなら「中身は添付に在ります」が出る。
 */
test('🔴 書き出した HTML を単体で開いても、囲みの中身が入っている(#444 段②)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await page.setInputFiles('[data-pkc-field="attach-input"]', {
    name: 'uriage.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('しなもの,かず\nりんご,120\nみかん,80\n', 'utf8'),
  });
  const assetKey = await page
    .locator('[data-pkc-action="download-asset"]')
    .first()
    .getAttribute('data-pkc-asset-key');
  expect(assetKey, '添付の鍵が取れない(この先は測れない)').toBeTruthy();

  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await expect(ta).toBeVisible();
  await ta.click();
  await page.keyboard.type('```csv asset:' + assetKey + '\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  // ⚠ 前提 ── 画面では表になっている(ここが崩れたら以降は何も測れない)
  await expect(page.locator('[data-pkc-field="detail-body"] table')).toBeVisible({
    timeout: 10_000,
  });

  // ⚠ 配った 1 枚は**1 件ずつ**見せるので、どのノートを開くかを名前で決める
  //    ── 添付そのものもノートなので、既定で開くのは csv のほうである
  const noteTitle = (await page.locator('[data-pkc-field="detail-title"]').innerText()).trim();
  expect(noteTitle, '書いたノートの題名が読めない(この先は測れない)').not.toBe('');

  const dl = page.waitForEvent('download');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await clickReal(page, '[data-pkc-action="export-html"]');
  const file = join(tmpdir(), `pkc3-fence-asset-${process.pid}.html`);
  await (await dl).saveAs(file);

  // ── アプリも IDB も無い所で開く(user が受け取るのはこの 1 枚である)
  const viewer = await page.context().newPage();
  await viewer.goto(`file://${file}`);
  await viewer.locator('nav button', { hasText: noteTitle }).first().click();
  const table = viewer.locator('#body table');
  await expect(table, '配った 1 枚に表が入っていない').toBeVisible({ timeout: 10_000 });
  await expect(table).toContainText('りんご');
  await expect(table).toContainText('120');
  // 🔑 対照群 ── 焼き込めていなければ、この字が残る
  await expect(viewer.locator('#body')).not.toContainText('中身は添付');
  const box = (await table.boundingBox())!;
  expect(box.height, '配った表の高さが無い').toBeGreaterThan(20);
  await viewer.close();

  expect(errors).toEqual([]);
});
