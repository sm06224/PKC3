import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gotoApp, clickReal, collectPageErrors, createEntry } from './helpers';

/**
 * 🔴 **同期フォルダ(#2000 段 3)── 実ブラウザの 2 台で、人がファイルを運ばずに同期する**。
 *
 * - 端末 = ブラウザのコンテキスト 2 つ(保存領域が別々)。
 * - 同期フォルダ = それぞれの OPFS の中のフォルダ。`showDirectoryPicker` をそこへ差し替える
 *   (OPFS の handle は本物の `FileSystemDirectoryHandle` ── 許可・IndexedDB への保存・書き込みが実物で通る)。
 * - クラウドドライブの役 = test が片方のフォルダのファイルをもう片方へ写す(ドライブが同期し終えた状態)。
 * 観測点: 相手の一覧に題名が出る(DB を通った後の画面)・読み直しても選んだフォルダを憶えている(IndexedDB の handle)。
 */
const PICKER = () => {
  (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('cloud', { create: true });
  };
};

async function device(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(PICKER);
  // 端末間の同期をオン(設定の保存先。`pkc3.sync`)
  await ctx.addInitScript(() => localStorage.setItem('pkc3.sync', '1'));
  const page = await ctx.newPage();
  await gotoApp(page);
  return page;
}

/** 同期フォルダのファイル(名前 → 中身の base64)。 */
async function folderFiles(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('cloud', { create: true });
    const out: Record<string, string> = {};
    for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (h.kind !== 'file') continue;
      const buf = new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer());
      let bin = '';
      for (const b of buf) bin += String.fromCharCode(b);
      out[name] = btoa(bin);
    }
    return out;
  });
}

/** クラウドドライブの役: from のフォルダのファイルを to のフォルダへ写す。 */
async function carry(from: Page, to: Page): Promise<number> {
  const files = await folderFiles(from);
  await to.evaluate(async (fs) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('cloud', { create: true });
    for (const [name, b64] of Object.entries(fs)) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const h = await dir.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(bytes);
      await w.close();
    }
  }, files);
  return Object.keys(files).length;
}

async function openSettings(page: Page): Promise<void> {
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(page.locator('[data-pkc-region="settings-sync-folder"]')).toBeVisible();
}

const status = (page: Page) => page.locator('[data-pkc-field="sync-folder-status"]');

test('🔴 同期フォルダを選ぶと、ファイルを運ばずに別の端末へノートが届き、確認は片方で 1 度、やめれば選ぶ前に戻る (#2000 段 3)', async ({ browser }) => {
  test.setTimeout(90_000);
  const A = await device(browser);
  const B = await device(browser);
  const errorsA = collectPageErrors(A);
  const errorsB = collectPageErrors(B);

  // ── A: ノートを書いて、同期フォルダを選ぶ
  await createEntry(A, 'text');
  await A.locator('[data-pkc-field="editor-title"]').fill('同期フォルダで運ぶメモ');
  await clickReal(A, '[data-pkc-action="commit-edit"]');
  await openSettings(A);
  await expect(status(A)).toContainText('まだ選んでいません');
  await clickReal(A, '[data-pkc-action="pick-sync-folder"]');
  await expect(status(A), 'A が同期しない').toContainText('最終同期', { timeout: 20_000 });
  const filesA = await folderFiles(A);
  expect(Object.keys(filesA), 'A の端末のファイルが 1 つ置かれる').toHaveLength(1);
  expect(Object.keys(filesA)[0]).toMatch(/^pkc3-[0-9a-f]{16}\.pkc3-diff\.zip$/);

  // ── クラウドドライブが A のファイルを B へ届けた
  expect(await carry(A, B)).toBe(1);
  await expect(B.locator('[data-pkc-region="sidebar"]'), '対照群: B にはまだ無い').not.toContainText('同期フォルダで運ぶメモ');

  // ── B: 同期フォルダを選ぶ(初めての相手なので確認が出る)
  await openSettings(B);
  await clickReal(B, '[data-pkc-action="pick-sync-folder"]');
  await expect(B.locator('[data-pkc-region="app-dialog"]'), '初めての相手の確認が出ない').toBeVisible({ timeout: 20_000 });
  await clickReal(B, '[data-pkc-field="dialog-ok"]');
  await expect(status(B)).toContainText('最終同期', { timeout: 20_000 });
  await expect(B.locator('[data-pkc-region="sidebar"]'), 'A のノートが B に届かない').toContainText('同期フォルダで運ぶメモ', { timeout: 20_000 });

  // ── B のファイルを A へ届け、A の「今すぐ同期」で取り込む(B の側で確認済みなので、A では確認を出さない)
  await carry(B, A);
  await clickReal(A, '[data-pkc-action="sync-folder-now"]');
  await expect(status(A)).toContainText('最終同期', { timeout: 20_000 });
  await expect(A.locator('[data-pkc-region="app-dialog"]'), 'A でも確認が出た(確認は 1 度で済むはず)').toHaveCount(0);

  // ── やめると、選ぶ前に戻る(片道にしない)。フォルダのファイルは残る
  await clickReal(A, '[data-pkc-action="stop-sync-folder"]');
  await expect(status(A)).toContainText('まだ選んでいません');
  expect(Object.keys(await folderFiles(A)).length, 'やめてもファイルは消さない').toBeGreaterThanOrEqual(1);

  expect(errorsA, `page error A: ${errorsA.join(' / ')}`).toEqual([]);
  expect(errorsB, `page error B: ${errorsB.join(' / ')}`).toEqual([]);
  await A.context().close();
  await B.context().close();
});

/**
 * 🔴 **読み直しても選んだフォルダを使い続けられるか / 読み込みで画面が落ちてもアプリが開けなくならないか**(#2000 段 3)。
 *
 * ⚠ この箱の Chromium(Chrome for Testing 153)では、**使い捨てのプロファイル**(`browser.newContext()` = シークレットと同じ形)で
 *   IndexedDB からフォルダの handle を読むと**ブラウザごと落ちた**(2026-11-21 に実測。保存した同じ画面で読んでも落ちる)。
 *   ふつうのプロファイル(`launchPersistentContext`)では落ちない ── だからこの test はふつうのプロファイルで回し、
 *   見張りは「印が残っている」形を作って実物で通す。人が選んだフォルダ・本物の Chrome では実機で確かめる。
 * 🔑 だから読み直したあとは 2 通りのどちらかであればよい(どちらも user の作業は止まらない):
 *   ① 落ちない: そのまま同じフォルダを使っている
 *   ② 落ちた: 次に開いた画面は**ふつうに起動し**、「保存しないようにしました」と言い、以後は handle を読まない(もう落ちない)
 * ⚠ どちらにもならない(開けない・何も言わずフォルダを忘れる)ときだけ落ちる。
 */
test('🔴 読み直したあと: 同じフォルダを使い続けるか、読み込みで落ちても次は起動して理由を言う (#2000 段 3)', async ({ playwright }, testInfo) => {
  test.setTimeout(120_000);
  // ⚠ ブラウザごと落ちることがあるので、**同じ利用者のデータの置き場**(persistent context)を使い、落ちたら起動し直す
  const dataDir = mkdtempSync(join(tmpdir(), 'pkc3-sync-folder-'));
  const use = testInfo.project.use as { baseURL?: string; launchOptions?: { executablePath?: string } };
  const launch = async () => {
    const ctx = await playwright.chromium.launchPersistentContext(dataDir, {
      baseURL: use.baseURL,
      viewport: { width: 1440, height: 900 },
      ...(use.launchOptions?.executablePath ? { executablePath: use.launchOptions.executablePath } : {}),
    });
    await ctx.addInitScript(PICKER);
    await ctx.addInitScript(() => localStorage.setItem('pkc3.sync', '1'));
    return ctx;
  };
  try {
    let ctx = await launch();
    const A = await ctx.newPage();
    await gotoApp(A);
    await openSettings(A);
    await clickReal(A, '[data-pkc-action="pick-sync-folder"]');
    await expect(status(A)).toContainText('最終同期', { timeout: 20_000 });
    let closed = false;
    A.on('close', () => {
      closed = true;
    });
    await A.reload().catch(() => undefined);
    const booted = await A.locator('[data-pkc-boot="ready"]').waitFor({ state: 'attached', timeout: 15_000 }).then(
      () => true,
      () => false,
    );
    if (booted && !closed) {
      // ① 落ちなかった ── 同じフォルダを使っている
      await openSettings(A);
      await expect(status(A), '読み直したらフォルダを忘れた').toContainText('「cloud」', { timeout: 20_000 });
      console.log('[sync-folder] handle の読み直し: 落ちずに使えた');
      // 見張りも実物で通す: 前の読み込みが途中で落ちた形(印が残っている)を作って開き直す
      await A.evaluate(
        () =>
          new Promise<void>((resolve, reject) => {
            const req = indexedDB.open('pkc3-sync-folder', 1);
            req.onsuccess = () => {
              const t = req.result.transaction('marks', 'readwrite');
              t.objectStore('marks').put('1', 'pkc3.sync-folder-loading');
              t.oncomplete = () => {
                req.result.close();
                resolve();
              };
              t.onerror = () => reject(t.error);
            };
            req.onerror = () => reject(req.error);
          }),
      );
      await A.reload();
      await expect(A.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
      await openSettings(A);
      await expect(status(A), '印が残っていたのに理由を言わない').toContainText('保存しないようにしました', { timeout: 20_000 });
      await A.reload();
      await expect(A.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 15_000 });
      await openSettings(A);
      await expect(status(A), '以後は handle を読まない(選び直す前の状態)').toContainText('まだ選んでいません');
    } else {
      // ② 落ちた ── 起動し直した画面は開け、理由を言う。以後は読まない
      await ctx.close().catch(() => undefined);
      ctx = await launch();
      const next = await ctx.newPage();
      await gotoApp(next);
      await openSettings(next);
      await expect(status(next), '落ちた後に理由を言わない').toContainText('保存しないようにしました', { timeout: 20_000 });
      // もう 1 度開き直しても落ちない(handle を読まない)
      await next.reload();
      await expect(next.locator('[data-pkc-boot="ready"]'), '開き直すとまた落ちる').toBeAttached({ timeout: 15_000 });
      await openSettings(next);
      await expect(status(next), '開き直したら、選び直す前の状態').toContainText('まだ選んでいません');
      // 選び直せば同期はできる(handle は保存しない)
      await clickReal(next, '[data-pkc-action="pick-sync-folder"]');
      await expect(status(next)).toContainText('最終同期', { timeout: 20_000 });
      await next.reload();
      await expect(next.locator('[data-pkc-boot="ready"]'), '保存しないはずの handle を読んで落ちた').toBeAttached({ timeout: 15_000 });
      console.log('[sync-folder] handle の読み直し: ブラウザが落ちた → 見張りで復帰した');
    }
    await ctx.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
