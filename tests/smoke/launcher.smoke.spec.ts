import { test, expect } from '@playwright/test';
import { gzipSync } from 'node:zlib';
import { gotoApp, clickReal, collectPageErrors } from './helpers';

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

  await clickReal(page, '[data-pkc-action="import-file"]');
  await page.locator('[data-pkc-field="import-input"]').setInputFiles({
    name: 'container.html',
    mimeType: 'text/html',
    buffer: Buffer.from(pkc2WithTiles(baseURL ?? 'http://localhost'), 'utf-8'),
  });
  await expect(page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]')).toHaveCount(4);

  // ランチャーへ
  await clickReal(page, '[data-pkc-browse="launcher"]');
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

  // ⑤-1 🔴 **アプリと同じ origin で走らせない**(review H-1)。
  // 修正前の実測: {"origin":"http://localhost:45732","ls":2,"idb":"pkc3-assets","opfs":".pkc3"}
  // ── 取り込んだ HTML から localStorage に書け、IndexedDB(添付の実体)と
  // OPFS(SQLite 本体)と Cache Storage(SW の precache)が見えていた。
  // Cache Storage が見えるのがとくに重く、偽の応答を書けば**再読込をまたいで
  // 生き残る改竄**になる。ここは「タブが開いた」ではなく**到達範囲**を測る。
  // ⚠ **順番が本体** ── 中身の確認を先に置くと、外殻を丸ごと外す変異が
  // 「中身が見えない」で落ちて、隔離の観測点に一度も到達しない(実際にそうなった)
  await expect
    .poll(() => appTab.frames().length, {
      message: '添付が最上位で開かれている(隔離した外殻を通っていない)',
    })
    .toBeGreaterThan(1);
  const sandboxed = appTab.frames().find((f) => f !== appTab.mainFrame())!;
  const reach = await sandboxed.evaluate(async () => {
    // ⚠ `location.origin` は**使えない** ── Chromium は `about:srcdoc` に対して
    // 隔離の有無に関わらず 'null' を返す(実測で空振りを踏んだ)。
    // 判別できるのは `self.origin` と **親 DOM に手が届くか**である
    const out: Record<string, string> = { selfOrigin: String(self.origin) };
    try {
      out.parentDom = String(parent.document.location.href).slice(0, 5);
    } catch {
      out.parentDom = 'blocked';
    }
    try {
      localStorage.setItem('pkc3-probe', '1');
      out.ls = 'OPEN';
    } catch {
      out.ls = 'blocked';
    }
    try {
      const req = indexedDB.open('pkc3-assets');
      await new Promise<void>((res, rej) => {
        req.onsuccess = () => res();
        req.onerror = () => rej(req.error);
      });
      out.idb = 'OPEN';
    } catch {
      out.idb = 'blocked';
    }
    try {
      await navigator.storage.getDirectory();
      out.opfs = 'OPEN';
    } catch {
      out.opfs = 'blocked';
    }
    try {
      await caches.keys();
      out.caches = 'OPEN';
    } catch {
      out.caches = 'blocked';
    }
    return out;
  });
  // ⚠ **origin が opaque であること**を独立に見る ── 個々の storage API が
  // 将来別の理由で失敗しても、隔離が外れたことに気づけるようにする。
  // ⚠ 当初 `location.origin` を見ていたが、Chromium は `about:srcdoc` に対して
  // **隔離の有無に関わらず 'null'** を返すので**空振りだった**(実測)
  expect(reach.selfOrigin).toBe('null');
  expect(reach).toMatchObject({
    parentDom: 'blocked',
    ls: 'blocked',
    idb: 'blocked',
    opfs: 'blocked',
    caches: 'blocked',
  });

  // ⑤-2 ⚠ 隔離した先で**中身がちゃんと出ている**(隔離できても白紙では意味がない)
  await expect(
    appTab.frameLocator('[data-pkc-field="launcher-app"]').locator('p'),
  ).toHaveText('1+1=2');
  await appTab.close();

  // ⑥ サイドバーの絞り込みがここでも効く(探し方を 2 通り覚えさせない)
  await page.locator('[data-pkc-field="entry-filter"]').fill('リンク');
  await expect(tiles).toHaveCount(2);
  await page.locator('[data-pkc-field="entry-filter"]').fill('存在しない');
  await expect(page.locator('[data-pkc-field="launcher-empty"]')).toBeVisible();

  expect(errors).toEqual([]);
});
