import { expect, test } from '@playwright/test';
import { clickReal, collectPageErrors, dismissAnnounce, gotoApp } from './helpers';

/**
 * #532 段 B: **押すと、自分のパソコンで動かす一式が本当に落ちる**。
 *
 * 🔴 **ここでしか見えない層が 2 つある**:
 * ① **落ちること自体** ── unit は `download` を差した偽物で見ているので、
 *    `<a download>` の実配線(`platform/download.ts`)は 1 度も走らない。
 * ② 🔴 **配っている物を、配っている場所から本当に取れるか** ──
 *    一覧(`precache.json`)も中身も**相対**で取りに行くので、実際に配信されている
 *    dist の上でしか確かめられない。⚠ ここが崩れると、落ちた zip は
 *    **展開して起動して初めて**「白い画面」として症状が出る。
 *
 * ⚠ **サーバを立てるところまではやらない**(固定ポート 8787 を掴むと、
 *   同じ箱で走る他の spec とぶつかる)。そちらは手元の probe で 1 度通してある
 *   ── 実測(2026-09-09、フル Chromium):起動 ready / 書いたノートが読み直しでも残る /
 *   `crossOriginIsolated: true` / 404 は 0 件 / console.error は 0 件。
 */
test('🔴 「自分のパソコンで動かす」を押すと、一式の zip が落ちる (#532 段 B)', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);

  await clickReal(page, '[data-pkc-browse="launcher"]');
  const tile = '[data-pkc-region="launcher-grid"] [data-pkc-tile="builtin:selfhost"]';
  await expect(page.locator(tile), 'タイルが出ていない').toBeVisible();

  const wait = page.waitForEvent('download', { timeout: 30_000 });
  await clickReal(page, tile);
  const dl = await wait;

  /**
   * ⚠ 名前は**属性で見る**(`suggestedFilename()` ではない)── この headless は
   *   非 ASCII の `<a download>` 名を丸ごと捨てるが、ここは ASCII なので通る。
   *   それでも「アプリが決めた値」を見るほうが環境差に強い(CLAUDE.md §4)。
   */
  expect(dl.suggestedFilename(), '名前が違う').toMatch(/^pkc3-selfhost-\d{4}-\d{2}-\d{2}\.zip$/);

  // 🔑 **中身まで見る** ── 「落ちた」だけでは、空の zip でも通る
  const path = await dl.path();
  const { readFileSync } = await import('node:fs');
  const buf = readFileSync(path);
  const text = buf.toString('latin1');
  for (const name of [
    'pkc3-selfhost/site/index.html',
    // 🔴 これが無いと、落とした一式は**オフラインでも分離でも**動かない
    //    (実際に 1 度、precache の一覧だけで組んで抜けた)
    'pkc3-selfhost/site/sw.js',
    'pkc3-selfhost/start-windows.cmd',
    'pkc3-selfhost/start-mac-linux.sh',
  ]) {
    expect(text.includes(name), `${name} が一式に入っていない`).toBe(true);
  }
  // ⚠ 空振り防止 ── 「名前が在る」だけなら 0 バイトでも通る
  expect(buf.byteLength, '一式が小さすぎる(中身が入っていない)').toBeGreaterThan(1_000_000);

  // 画面にも結果を言う(無言で終えない)
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('localhost:8787');
  expect(errors, errors.join('\n')).toEqual([]);
});
