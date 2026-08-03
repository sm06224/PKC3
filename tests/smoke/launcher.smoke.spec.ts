import { test, expect } from '@playwright/test';
import { gzipSync } from 'node:zlib';
import { gotoApp, clickReal, clickMenuItem, collectPageErrors } from './helpers';

/**
 * P7b 段⑩: **取り込んだランチャーのタイルが見えて、押すと開く**。
 *
 * 🔴 これは「新機能」ではなく**到達不能の解消**である ── `attachment-flavor.ts` は
 * PKC2 の `registered_as_app` / `launcher_url` / `app_group` / `app_order` を
 * 取込時に欠損なく写しているのに、それを出す面が無かった。
 * だから観測点は「**PKC2 で見えていたものが、同じ順で見えて、押すと開くか**」。
 *
 * ⚠ unit(`tests/features/launcher-tiles.test.ts`)は並べ方の規則しか見ない ──
 * **取込 → frontmatter → 面 → 起動**がつながっているかは実物でしか確かめられない。
 */
const HTML_APP = Buffer.from('<!doctype html><title>電卓</title><p>1+1=2</p>', 'utf-8');

function pkc2WithTiles(target: string): string {
  const attachment = (
    lid: string,
    title: string,
    extra: Record<string, unknown>,
  ): Record<string, unknown> => ({
    lid,
    title,
    archetype: 'attachment',
    body: JSON.stringify({ name: title, mime: 'text/html', ...extra }),
  });
  const container = {
    meta: { container_id: 'c-l', title: 'ランチャー入り', entry_order: ['t1', 't2', 't3', 't4'] },
    entries: [
      // グループ無し = 既定群 → **先頭**に出る
      attachment('t1', '電卓', {
        registered_as_app: true,
        asset_key: 'app-key',
        size: HTML_APP.length,
      }),
      // 同じグループ内は app_order 順(2 → 1 の順で入れて、1 が先に出ることを見る)
      attachment('t2', '後のリンク', {
        registered_as_app: true,
        launcher_url: `${target}/index.html?tile=2`,
        app_group: 'ツール',
        app_order: 2,
      }),
      attachment('t3', '先のリンク', {
        registered_as_app: true,
        launcher_url: `${target}/index.html?tile=1`,
        app_group: 'ツール',
        app_order: 1,
      }),
      // 素の添付は**タイルにしない**(画像まで並んだら使い物にならない)
      attachment('t4', 'ただの添付', { asset_key: 'plain-key', mime: 'image/png' }),
    ],
    relations: [],
    assets: {
      'app-key': gzipSync(HTML_APP).toString('base64'),
      'plain-key': gzipSync(Buffer.from('x')).toString('base64'),
    },
  };
  const data = JSON.stringify({
    container,
    export_meta: { mode: 'full', mutability: 'editable', asset_encoding: 'gzip+base64' },
  }).replace(/<\/script>/gi, '<\\/script>');
  return `<!doctype html><html><head><meta charset="utf-8">
    <script id="pkc-meta" type="application/json">{"app":"pkc2","schema":1}</script>
  </head><body>
    <script id="pkc-data" type="application/json">${data}</script>
  </body></html>`;
}

test('🔴 取り込んだタイルが同じ順で見えて、押すと開く', async ({ page, context, baseURL }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  await clickMenuItem(page, '[data-pkc-action="import-file"]');
  await page.locator('[data-pkc-field="import-input"]').setInputFiles({
    name: 'container.html',
    mimeType: 'text/html',
    buffer: Buffer.from(pkc2WithTiles(baseURL ?? 'http://localhost'), 'utf-8'),
  });
  await expect(page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]')).toHaveCount(4);

  // ランチャーへ
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="launcher"]');
  const tiles = page.locator('[data-pkc-region="launcher-grid"] [data-pkc-tile]');
  // ① 🔴 **素の添付は出ない**(4 件のうちタイルは 3 件)
  await expect(tiles).toHaveCount(3);

  // ② 🔴 **PKC2 と同じ順** ── 既定群が先頭、グループ内は app_order 順
  await expect(tiles.nth(0)).toContainText('電卓');
  await expect(tiles.nth(1)).toContainText('先のリンク');
  await expect(tiles.nth(2)).toContainText('後のリンク');
  // グループ見出しも出る(既定群は「よく使う」)
  const groups = page.locator('[data-pkc-field="launcher-group"]');
  await expect(groups.nth(0)).toHaveText('よく使う');
  await expect(groups.nth(1)).toHaveText('ツール');

  // ③ 外部へ飛ぶタイルは**行き先が見えている**(押す前に分かる)
  await expect(tiles.nth(1).locator('[data-pkc-field="tile-url"]')).not.toHaveText('');

  // ④ 🔴 **押すと新しいタブで開く**(URL タイル)
  const [urlTab] = await Promise.all([
    context.waitForEvent('page'),
    clickReal(page, '[data-pkc-tile-kind="url"]'),
  ]);
  await urlTab.waitForLoadState('domcontentloaded');
  expect(urlTab.url()).toContain('tile=1');
  await urlTab.close();

  // ⑤ 🔴 **アプリのタイルは中身が開く**(blob。添付の bytes に届いている)
  const [appTab] = await Promise.all([
    context.waitForEvent('page'),
    clickReal(page, '[data-pkc-tile-kind="app"]'),
  ]);
  await appTab.waitForLoadState('domcontentloaded');
  // ⚠ 「タブが開いた」で止めない ── **中身**が届いているかを見る
  await expect(appTab.locator('p')).toHaveText('1+1=2');
  await appTab.close();

  // ⑥ サイドバーの絞り込みがここでも効く(探し方を 2 通り覚えさせない)
  await page.locator('[data-pkc-field="entry-filter"]').fill('リンク');
  await expect(tiles).toHaveCount(2);
  await page.locator('[data-pkc-field="entry-filter"]').fill('存在しない');
  await expect(page.locator('[data-pkc-field="launcher-empty"]')).toBeVisible();

  expect(errors).toEqual([]);
});
