import { test, expect } from '@playwright/test';
import { clickReal, collectPageErrors, gotoApp } from './helpers';

/**
 * #1087 台帳④の残り(左の一覧は、見えている行だけを組む)と、#1455 の後半(PC のフォルダとの同期)。
 * 🔴 unit では原理的に届かない層だけ ── 実レイアウト(スクロールの長さ・見えている所に行が在るか)と、
 *   OPFS の本物の `FileSystemDirectoryHandle` への読み書き。
 */
const ROW = '[data-pkc-region="filer-table"] tbody [data-pkc-entry]';
const HOST = '[data-pkc-region="browse-host"]';

const mdFiles = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `n${String(i + 1).padStart(4, '0')}.md`,
    mimeType: 'text/markdown',
    buffer: Buffer.from(`# n${String(i + 1).padStart(4, '0')}\n\n本文 ${i + 1}`),
  }));

test('🔴 3,000 件の左の一覧: 組む行は数百行以内・スクロールの長さは全件ぶん・見える所には行が在る・End/↑ で届く', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await page.setInputFiles('[data-pkc-field="import-input"]', mdFiles(3000));
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('取り込み完了: 3000 件', { timeout: 25_000 });
  await expect(page.locator(ROW).first()).toBeVisible();

  // ① 全件を組んでいない(⚠ 窓は hidden="until-found" に対応するブラウザだけ ── 対応しなければ全部組む作りに戻るので、まずそれを確かめる)
  expect(await page.evaluate(() => 'onbeforematch' in document.documentElement), 'until-found に対応していない').toBe(true);
  await expect(page.locator('tbody[data-pkc-chunk-empty] > tr[data-pkc-chunk-find]').first()).toHaveAttribute('hidden', 'until-found');
  const mounted = await page.locator(ROW).count();
  expect(mounted, '行が 1 つも組まれていない').toBeGreaterThan(0);
  expect(mounted, '全件を組んでいる(見えている行だけにならない)').toBeLessThanOrEqual(400);

  // ② スクロールの長さは全件ぶん(1 行 26px)── 組んでいない塊が空の枠で長さを保っている
  const span = await page.evaluate((host) => {
    const el = document.querySelector(host) as HTMLElement;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }, HOST);
  expect(span.scrollHeight, 'スクロールの長さが全件ぶんに足りない').toBeGreaterThan(3000 * 26 * 0.95);

  // ③ 中ほどへ送ると、見えている位置に行が実在する(空の枠のまま見えていない)
  await page.evaluate(({ host, top }) => ((document.querySelector(host) as HTMLElement).scrollTop = top), {
    host: HOST,
    top: 40000,
  });
  await expect
    .poll(async () =>
      page.evaluate((host) => {
        const el = document.querySelector(host) as HTMLElement;
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit?.closest('[data-pkc-region="filer-table"] [data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null;
      }, HOST),
    )
    .not.toBeNull();
  expect(await page.locator(ROW).count()).toBeLessThanOrEqual(400);

  // ④ 戻すと先頭が再び組まれる
  await page.evaluate((host) => ((document.querySelector(host) as HTMLElement).scrollTop = 0), HOST);
  await expect(page.locator(`${ROW}[data-pkc-entry]`).first()).toBeVisible();

  // ⑤ キー: 1 行目を押して End → 最後の行へ焦点が届き、見える所にある。↑ で 1 つ前へ
  await clickReal(page, ROW);
  await page.keyboard.press('End');
  await expect
    .poll(async () => page.evaluate(() => document.activeElement?.closest('[data-pkc-entry]')?.getAttribute('data-pkc-entry') ?? null))
    .not.toBeNull();
  const last = await page.evaluate(() => document.activeElement?.closest('[data-pkc-entry]')?.querySelector('[data-pkc-field="title"]')?.textContent ?? '');
  expect(last).toContain('n3000');
  const box = await page.locator(`${ROW}[data-pkc-marked]`).first().boundingBox();
  const hostBox = await page.locator(HOST).boundingBox();
  expect(box, '末尾の行が組まれていない').not.toBeNull();
  expect(box!.y + box!.height, '末尾の行が見える所に無い').toBeLessThanOrEqual(hostBox!.y + hostBox!.height + 1);
  expect(box!.y, '末尾の行が見える所に無い').toBeGreaterThanOrEqual(hostBox!.y - 1);
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(async () => page.evaluate(() => document.activeElement?.closest('[data-pkc-entry]')?.querySelector('[data-pkc-field="title"]')?.textContent ?? ''))
    .toContain('n2999');

  // ⑦ ブラウザ内検索(Ctrl+F)── 軽い行(hidden=until-found)に一致したときの動きを、実ブラウザの配置で見る。
  //   ⚠ `window.find()` は hidden=until-found の中を探さず beforematch も飛ばさない(実測: Chromium で、単純な頁でも false)。
  //   Ctrl+F の検索そのものは自動化できないので、ブラウザがすることを写す:
  //   beforematch を飛ばす → hidden を外す(ブラウザは一致を見せるとき外す)→ 軽い行の中の字を選択。
  //   見るのは「塊が組まれ、選択が本物の行の中へ移り、行が見える所にあり、軽い行が残らず、配置が動かない」。
  await page.evaluate((host) => ((document.querySelector(host) as HTMLElement).scrollTop = 0), HOST);
  await expect(page.locator(ROW).first()).toBeVisible();
  await expect(page.locator(ROW).filter({ hasText: 'n2500' }), '前提: n2500 は組まれていない').toHaveCount(0);
  const heightBefore = await page.evaluate((host) => (document.querySelector(host) as HTMLElement).scrollHeight, HOST);
  const mimicked = await page.evaluate(() => {
    const blob = [...document.querySelectorAll('tr[data-pkc-chunk-find]')].find((b) => (b.textContent ?? '').includes('n2500'));
    if (blob === undefined) return null;
    // ブラウザの順: beforematch → hidden を外す → 一致した字を選択してスクロール
    blob.dispatchEvent(new Event('beforematch', { bubbles: true }));
    blob.removeAttribute('hidden');
    const text = blob.firstElementChild!.firstChild as Text;
    const at = text.data.indexOf('n2500');
    const r = document.createRange();
    r.setStart(text, at);
    r.setEnd(text, at + 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    return { onbeforematch: 'onbeforematch' in document.documentElement, blobConnected: blob.isConnected };
  });
  expect(mimicked, 'n2500 を含む軽い行が無い').not.toBeNull();
  expect(mimicked!.onbeforematch, 'until-found に対応していない').toBe(true);
  expect(mimicked!.blobConnected, '一致を移す前に軽い行を外した').toBe(true);
  await expect(page.locator(ROW).filter({ hasText: 'n2500' }), '一致した塊が組まれない').toHaveCount(1);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const sel = window.getSelection();
        const n = sel?.anchorNode ?? null;
        const el = n === null ? null : n.nodeType === 1 ? (n as Element) : n.parentElement;
        return el?.closest('tr[data-pkc-entry]') && sel!.rangeCount > 0 ? sel!.getRangeAt(0).toString() : null;
      }),
    { message: '一致の後、選択が本物の行の中に無い' })
    .toBe('n2500');
  await expect(page.locator(ROW).filter({ hasText: 'n2500' })).toBeInViewport();
  expect(await page.locator('tr[data-pkc-chunk-find]').filter({ hasText: 'n2500' }).count(), '軽い行が残っている').toBe(0);
  // 軽い行(hidden を外されても)が場所を取らない: 組んだ分だけ高さが増えない
  const heightAfter = await page.evaluate((host) => (document.querySelector(host) as HTMLElement).scrollHeight, HOST);
  expect(Math.abs(heightAfter - heightBefore), 'スクロールの長さが動いた').toBeLessThanOrEqual(1);

  // ⑥ 掴んだまま遠くへ送る(下端の自動スクロール相当)── 掴んだ行は外れず、dragend が届く
  //   (掴んだ行が DOM から外れると dragend が来ず、ドラッグが終わらない)
  await page.evaluate((host) => ((document.querySelector(host) as HTMLElement).scrollTop = 0), HOST);
  await expect(page.locator(ROW).first()).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __dragend: number };
    w.__dragend = 0;
    document.addEventListener('dragend', () => (w.__dragend += 1));
  });
  const src = page.locator(ROW).first();
  const srcLid = await src.getAttribute('data-pkc-entry');
  const sb = (await src.boundingBox())!;
  await page.mouse.move(sb.x + 30, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + 40, sb.y + sb.height / 2 + 30, { steps: 5 });
  await page.evaluate((host) => ((document.querySelector(host) as HTMLElement).scrollTop = 60000), HOST);
  await page.waitForTimeout(300);
  await expect(page.locator(`${ROW}[data-pkc-entry="${srcLid}"]`), '掴んだ行が、遠くへ送ると外れた').toHaveCount(1);
  expect(await page.locator(ROW).count(), '全件を組んでいる').toBeLessThanOrEqual(450);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __dragend: number }).__dragend), {
      message: 'dragend が届かない(掴んだ行が外れた)',
    })
    .toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('🔴 PC のフォルダと同期する: 書き出し → フォルダ側の直しを取り込む → やめる(OPFS の本物のフォルダ)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle('pkc-sync-out', { create: true });
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('pkc-sync-out', { recursive: true }).catch(() => {});
  });
  await page.setInputFiles('[data-pkc-field="import-input"]', [
    { name: 'alpha.md', mimeType: 'text/markdown', buffer: Buffer.from('# alpha\n\nalphaの本文') },
    { name: 'beta.md', mimeType: 'text/markdown', buffer: Buffer.from('# beta\n\nbetaの本文') },
  ]);
  await expect(page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]')).toHaveCount(2);

  const list = (): Promise<Record<string, string>> =>
    page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('pkc-sync-out', { create: true });
      const out: Record<string, string> = {};
      for await (const e of dir.values()) if (e.kind === 'file') out[e.name] = await (await e.getFile()).text();
      return out;
    });

  await clickReal(page, '[data-pkc-browse="pc"]');
  await expect(page.locator('[data-pkc-field="pc-sync"]')).toBeVisible();
  await clickReal(page, '[data-pkc-action="pc-sync-pick"]');
  await expect(page.locator('[data-pkc-field="pc-sync-last"]')).toContainText('2 件をフォルダへ書きました');
  const first = await list();
  expect(first['alpha.md']).toContain('alphaの本文');
  expect(first['beta.md']).toContain('betaの本文');
  expect(Object.keys(first)).toContain('.pkc3-sync.json');

  // フォルダ側で直す → 今すぐ同期 → ノートの本文が置き換わる(履歴に前の本文が残る)
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('pkc-sync-out');
    const w = await (await dir.getFileHandle('alpha.md')).createWritable();
    await w.write('# alpha\n\n外で直した本文');
    await w.close();
  });
  await clickReal(page, '[data-pkc-action="pc-sync-now"]');
  await expect(page.locator('[data-pkc-field="pc-sync-last"]')).toContainText('1 件をフォルダから取り込みました');
  await clickReal(page, '[data-pkc-browse="filer"]');
  await clickReal(page, '[data-pkc-region="filer-table"] tr[data-pkc-entry]:has-text("alpha")');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('外で直した本文');
  // 取り込んだ直後の次の回で、ファイルを書き戻さない(内容が変わらない)
  await clickReal(page, '[data-pkc-browse="pc"]');
  await clickReal(page, '[data-pkc-action="pc-sync-now"]');
  await expect(page.locator('[data-pkc-field="pc-sync-last"]')).toContainText('変更はありませんでした');
  expect((await list())['alpha.md']).toContain('外で直した本文');

  // フォルダでファイルが消えたら、黙って書き戻さず画面に出す。「書き戻す」で戻る
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('pkc-sync-out');
    await dir.removeEntry('beta.md');
  });
  await clickReal(page, '[data-pkc-action="pc-sync-now"]');
  await expect(page.locator('[data-pkc-field="pc-sync-gone"]')).toContainText('beta');
  expect((await list())['beta.md'], '黙って書き戻した').toBeUndefined();
  await clickReal(page, '[data-pkc-action="pc-sync-restore"]');
  await expect(page.locator('[data-pkc-field="pc-sync-gone"]')).toHaveCount(0);
  expect((await list())['beta.md']).toContain('betaの本文');

  // フォルダでファイルが消えたら、黙って書き戻さず画面に出す。「書き戻す」で戻る
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('pkc-sync-out');
    await dir.removeEntry('beta.md');
  });
  await clickReal(page, '[data-pkc-action="pc-sync-now"]');
  await expect(page.locator('[data-pkc-field="pc-sync-gone"]')).toContainText('beta');
  expect((await list())['beta.md'], '黙って書き戻した').toBeUndefined();
  await clickReal(page, '[data-pkc-action="pc-sync-restore"]');
  await expect(page.locator('[data-pkc-field="pc-sync-gone"]')).toHaveCount(0);
  expect((await list())['beta.md']).toContain('betaの本文');

  // やめる(片道にしない): 欄が最初の形に戻り、選び直せる
  await clickReal(page, '[data-pkc-action="pc-sync-stop"]');
  await expect(page.locator('[data-pkc-action="pc-sync-pick"]')).toBeVisible();
  await expect(page.locator('[data-pkc-action="pc-sync-now"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
