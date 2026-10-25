/**
 * 🔴 **#1038 の残り 7 場面の落差を埋めた動線を、実ブラウザで通す**(A1 / B1 / C1 / C2 / D1 / F1)。
 *
 * unit(happy-dom)では届かない層だけを見る:
 * - 本物の `<a download>` から落ちてきた **file の中身**(選んだ題名だけが在る / 取り込み直せる)
 * - 本物の `localStorage` を挟んだ **保存した検索の再読み込み後**
 * - 本物の CSS で **警告が危険色・太字**になっていること
 * - 本物の `beforeprint` で紙の頭に目次が **付き、刷り終えたら消える**こと
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  answerAppDialog,
  clickReal,
  collectPageErrors,
  createEntry,
  gotoApp,
  useSplitEditor,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});
// ⚠ worker の配信を書き換える test があるので、service worker の控えに邪魔されないようにする
test.use({ serviceWorkers: 'block' });

async function makeNote(page: import('@playwright/test').Page, title: string, body: string): Promise<void> {
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill(title);
  await page.locator('[data-pkc-field="editor-body"]').fill(body);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
}

test('🔴 選んだ N 件の書き出し / 保存した検索 / 件数 / 案内 / 印刷の目次 (#1038)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  // ⑤ 何も選んでいない中央に、ドロップで添付になる案内が出ている(ノートを作る前)
  await expect(page.locator('[data-pkc-field="detail-empty"]')).toContainText(
    'ファイルをこの画面へドロップすると、添付として入ります',
  );

  await makeNote(page, 'AlphaNote', '# Alpha見出し\n\n## Alpha小見出し\n\nalpha-body-unique');
  await makeNote(page, 'BetaNote', 'beta-body-unique');
  await makeNote(page, 'GammaNote', 'gamma-body-unique');
  const rows = page.locator('[data-pkc-region="filer-table"] tbody tr');
  await expect(rows).toHaveCount(3);

  // ④ 絞り込み中の行に「N 件」が出る(語を替えると件数も替わる)
  const filter = page.locator('[data-pkc-field="entry-filter"]');
  await filter.fill('Note');
  const count = page.locator('[data-pkc-field="filer-filter-count"]');
  await expect(count, '絞り込み中の件数が出ていない').toHaveText('3 件');
  await filter.fill('Alpha');
  await expect(count).toHaveText('1 件');
  await expect(page.locator('[data-pkc-field="filer-filter-word"]'), '語の要素の字が変わった').toHaveText(
    '絞り込み中: Alpha',
  );

  // ③ 保存した検索: 保存 → 別の絞り → 再適用 → 再読み込み後も残る → 削除
  const bar = page.locator('[data-pkc-region="saved-searches"]');
  await clickReal(page, '[data-pkc-region="saved-searches"] [data-pkc-action="save-search"]');
  await expect(
    bar.locator('[data-pkc-action="save-search"]'),
    '保存済みの絞りに保存ボタンが残っている',
  ).toHaveCount(0);
  await filter.fill('Beta');
  await expect(count).toHaveText('1 件');
  await clickReal(page, '[data-pkc-region="saved-searches"] summary');
  const apply = bar.locator('[data-pkc-action="apply-saved-search"]');
  await expect(apply).toHaveText('Alpha');
  await expect(apply, '別の絞りなのに押された状態').toHaveAttribute('aria-pressed', 'false');
  await clickReal(page, '[data-pkc-region="saved-searches"] [data-pkc-action="apply-saved-search"]');
  await expect(filter, '再適用で語が置き換わっていない').toHaveValue('Alpha');
  await expect(apply).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
  await expect(
    page.locator('[data-pkc-region="saved-searches"] [data-pkc-field="saved-search-list"] summary'),
    '再読み込み後に保存した検索が残っていない',
  ).toContainText('保存した検索(1)');
  await clickReal(page, '[data-pkc-region="saved-searches"] summary');
  await clickReal(page, '[data-pkc-region="saved-searches"] [data-pkc-action="delete-saved-search"]');
  await expect(page.locator('[data-pkc-region="saved-searches"] [data-pkc-action="apply-saved-search"]')).toHaveCount(0);
  await filter.fill('');
  await expect(rows).toHaveCount(3);

  // ⑦ 印刷の目次: 見出しのあるノートを開き、beforeprint で目次が付き、afterprint で消える
  await clickReal(page, '[data-pkc-region="filer-table"] tbody tr:has-text("AlphaNote")');
  await expect(page.locator('[data-pkc-field="detail-body"] h1')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  const toc = page.locator('[data-pkc-field="print-toc"]');
  await expect(toc, '刷る直前に目次が置かれていない').toHaveCount(1);
  await expect(toc.locator('li')).toHaveText(['Alpha見出し', 'Alpha小見出し']);
  // 画面では見せない(@media print だけが出す)
  expect(await toc.evaluate((el) => getComputedStyle(el).display), '画面に目次が出ている').toBe('none');
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(toc, '刷り終えても目次が残っている').toHaveCount(0);

  // ① 複数選んで「閲覧用 HTML(選んだ N 件)」→ 落ちてきた HTML に選んだ題名だけが在る
  const alpha = page.locator('[data-pkc-region="filer-table"] tbody tr:has-text("AlphaNote")');
  const gamma = page.locator('[data-pkc-region="filer-table"] tbody tr:has-text("GammaNote")');
  await alpha.click();
  await gamma.click({ modifiers: ['ControlOrMeta'] });
  const bulk = page.locator('[data-pkc-field="filer-bulk"]');
  await expect(bulk).toContainText('2 件');
  await expect(bulk.locator('[data-pkc-field="bulk-export-html"]')).toHaveText('閲覧用 HTML(選んだ 2 件)');
  const [htmlDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickReal(page, '[data-pkc-field="bulk-export-html"]'),
  ]);
  const html = readFileSync((await htmlDl.path())!, 'utf-8');
  expect(html.slice(0, 200).toLowerCase(), 'HTML ではない').toContain('<!doctype html');
  expect(html, '選んだ題名が入っていない').toContain('AlphaNote');
  expect(html).toContain('GammaNote');
  expect(html, '選んでいない題名が入っている').not.toContain('BetaNote');
  expect(html, '選んでいない本文が入っている').not.toContain('beta-body-unique');

  // ② 「選んだノートのバックアップ」→ .pkc3-notes.zip が落ち、取り込み直すと選んだ分だけ増える
  await page.evaluate(() => {
    const orig = HTMLAnchorElement.prototype.click;
    (window as unknown as { __n: string[] }).__n = [];
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      (window as unknown as { __n: string[] }).__n.push(this.download);
      return orig.call(this);
    };
  });
  const [zipDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickReal(page, '[data-pkc-field="bulk-export-archive"]'),
  ]);
  // ⚠ 日本語の名前は headless Chromium が "download" に捨てる ── アプリが付けた `<a download>` の値を見る
  const names = await page.evaluate(() => (window as unknown as { __n: string[] }).__n);
  expect(names, '落とした名前が 1 つではない').toHaveLength(1);
  expect(names[0], '末尾が .pkc3-notes.zip ではない').toMatch(/^選んだノート2件-\d{8}\.pkc3-notes\.zip$/);
  const zip = readFileSync((await zipDl.path())!);
  expect(zip.subarray(0, 2).toString(), 'zip ではない').toBe('PK');
  expect(zip.includes(Buffer.from('beta-body-unique')), '選んでいない本文が zip の素の字に入っている').toBe(false);
  await page.setInputFiles('[data-pkc-field="import-input"]', {
    name: 'selected.pkc3-notes.zip',
    mimeType: 'application/zip',
    buffer: zip,
  });
  expect(await answerAppDialog(page, 'ok')).toMatch(/ノート \d+ 件/);
  await expect(rows, '取り込み直すと選んだ 2 件だけが増える(3 + 2)').toHaveCount(5);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * ⑥ 保存領域が使えない状態の警告(D1)。
 *
 * 🔑 storage worker を包んで、起動の前に `getDirectory()` を落とす(= いつもの OPFS が取れない)。
 *   本物の退避経路(`fallbackReason` が立つ)を通すので、警告の字・色・隣のボタンは製品そのもの。
 * ⚠ OPFS の失敗は console.error を出すので、ここは `pageerror` だけを数える。
 */
test('🔴 保存領域が使えない警告が危険色・太字になり、隣のボタンで .pkc3-full.zip が落ちる (#1038 D1)', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  // 🔑 storage worker の先頭で `getDirectory()` を落とす(= いつもの OPFS が取れない)。URL も `import.meta.url` も
  //   そのままなので、起動の経路は製品そのもの(blob で包むと起動しなかった)
  await page.route('**/assets/storage-worker-*.js', async (route) => {
    const res = await route.fetch();
    await route.fulfill({
      response: res,
      body:
        'StorageManager.prototype.getDirectory = () => Promise.reject(new DOMException("forced", "InvalidStateError"));\n' +
        (await res.text()),
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  const warn = page.locator('[data-pkc-region="status"] [data-pkc-field="status-warning"]');
  await expect(warn, '保存領域が取れなかったのに警告が出ていない(前提: 退避経路を通れていない)').toContainText(
    '保存領域が使えません',
  );
  const look = await warn.evaluate((el) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--danger)';
    document.body.append(probe);
    const danger = getComputedStyle(probe).color;
    probe.remove();
    const cs = getComputedStyle(el);
    return { color: cs.color, danger, weight: Number(cs.fontWeight) };
  });
  expect(look.color, '警告が危険色になっていない').toBe(look.danger);
  expect(look.weight, '警告が太字になっていない').toBeGreaterThanOrEqual(700);

  // 空のコレクションは書き出せない(「書き出せるノートが 1 件もありません」)── 書いたものがある状態で押す
  await makeNote(page, 'MemoryNote', 'memory-body');
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickReal(page, '[data-pkc-field="status-backup"]'),
  ]);
  expect(dl.suggestedFilename(), '隣のボタンのバックアップの末尾が .pkc3-full.zip ではない').toMatch(
    /\.pkc3-full\.zip$/,
  );
  expect(pageErrors, `page error: ${pageErrors.join(' / ')}`).toEqual([]);
});
