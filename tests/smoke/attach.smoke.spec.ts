/**
 * smoke #4(P4a): 添付取込(実 file picker input)→ entry 出現 → preview が
 * 「実際に画面に出る」+ Blob 直 put 経路の end-to-end(実 IDB + 実 sqlite meta)。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal, expectImageRendered, createEntry, useSplitEditor } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
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
  const dialogMsg = new Promise<string>((resolve) => {
    page.once('dialog', (d) => {
      resolve(d.message());
      void d.accept();
    });
  });
  await clickReal(page, '[data-pkc-action="purge-orphan-assets"]');
  expect(await dialogMsg).toContain('未参照の添付データはありません');

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
