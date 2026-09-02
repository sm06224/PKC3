/**
 * smoke #4(P4a): 添付取込(実 file picker input)→ entry 出現 → preview が
 * 「実際に画面に出る」+ Blob 直 put 経路の end-to-end(実 IDB + 実 sqlite meta)。
 */
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { answerAppDialog, gotoApp, collectPageErrors, clickReal, expectImageRendered, createEntry, useSplitEditor, useListBrowse } from './helpers';

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

    const gaps: number[] = [];
    let last = performance.now();
    const hb = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }, 4);

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
    clearInterval(hb);
    gaps.sort((a, b) => b - a);
    return { added: rows() - before, maxGap: Math.round(gaps[0] ?? 0), ticks: gaps.length };
  }, SIZE_MB);

  // ① 🔴 **実際に添付された**(空振り防止 ── 何も起きなければ当然止まらない)
  expect(m.added, '添付が作られていない(この次元を測れていない)').toBe(1);
  // ② 心拍が回っていた(計器が死んでいたら最大欠測は 0 になる)
  expect(m.ticks, '心拍が取れていない').toBeGreaterThan(5);
  // ③ 🔴 メインが止まっていない。⚠ ワーカー 10〜14ms 対 メイン 500〜726ms なので
  //    80ms は「余裕をもって落ちる」閾値(flake を閾値上げで隠さないための余白)
  expect(m.maxGap, `メインスレッドが ${m.maxGap}ms 止まった`).toBeLessThan(80);

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
