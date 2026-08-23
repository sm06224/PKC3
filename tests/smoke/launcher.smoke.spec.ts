import { test, expect } from '@playwright/test';
import { gzipSync } from 'node:zlib';
import { answerAppDialog, gotoApp, clickReal, collectPageErrors, createEntry, useSplitEditor, useListBrowse } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useListBrowse(page);
  await useSplitEditor(page);
});

/**
 * 🔴 **取り込み・登録で生えたタイルだけを数える**（2026-08-19、#241 の組み込みタイル）。
 *
 * ⚠ 一覧には**組み込み**（`builtin:dual` / `builtin:office`）が常に居る ──
 *   `[data-pkc-tile]` をそのまま数えると、この file の主張
 *   （「登録した物が出る / 外すと消える」）が**別の population に満たされる**
 *   （CLAUDE.md §1「面へスコープする」の同型）。
 */
const USER_TILES =
  '[data-pkc-region="launcher-grid"] [data-pkc-tile]:not([data-pkc-tile^="builtin:"])';

/** 組み込みタイルを名指す（空振り防止 ── 一覧そのものが消えていないことを見る）。 */
const builtinTile = (id: string): string =>
  `[data-pkc-region="launcher-grid"] [data-pkc-tile="builtin:${id}"]`;

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
  const tiles = page.locator(USER_TILES);
  // ① 🔴 **素の添付は出ない**(4 件のうちタイルは 3 件)
  await expect(tiles).toHaveCount(3);
  // ⚠ 空振り防止：組み込みは同じ一覧に居る（除いたことを確かめる）
  await expect(page.locator(builtinTile('dual'))).toHaveCount(1);

  // ② 🔴 **PKC2 と同じ順** ── 既定群が先頭、グループ内は app_order 順
  await expect(tiles.nth(0)).toContainText('電卓');
  await expect(tiles.nth(1)).toContainText('先のリンク');
  await expect(tiles.nth(2)).toContainText('後のリンク');
  // 🔴 見出しが出るのは**名前の付いた群だけ**(P8 段⑭)。既定群に「よく使う」と
  //    名乗らせていたが、画面はその情報(頻度)を持っていない ── 名乗ったぶん嘘になる
  const groups = page.locator('[data-pkc-field="launcher-group"]');
  await expect(groups).toHaveCount(1);
  await expect(groups.nth(0)).toHaveText('ツール');

  // ③ 外部へ飛ぶタイルは**行き先が見えている**(押す前に分かる)
  await expect(tiles.nth(1).locator('[data-pkc-field="tile-url"]')).not.toHaveText('');

  // ④ 🔴 **押すと新しいタブで開く**(URL タイル)
  const [urlTab] = await Promise.all([
    context.waitForEvent('page'),
    clickReal(page, '[data-pkc-tile-kind="url"]'),
  ]);
  await urlTab.waitForLoadState('domcontentloaded');
  expect(urlTab.url()).toContain('tile=1');
  /**
   * 🔴 **opener も referrer も渡さない**(マニュアル §7-3 の約束)を**実物で**見る。
   *
   * ⚠ 直す前はこの約束が「`window.open` に渡す文字列」だけで pin されていた ──
   * 文字列は合っているのに引数の位置が違う、という形の間違いを 1 つも捕まえない
   * (`window.open(url, features)` は features を**窓の名前**として渡してしまう。
   * 実際に計測用の probe でその間違いを書いて、静かに noopener が効かなかった)。
   * ⚠ 行き先は同一オリジンなので `document.referrer` がそのまま観測できる。
   */
  const promise = await urlTab.evaluate(() => ({
    referrer: document.referrer,
    hasOpener: window.opener !== null,
  }));
  expect(promise, 'opener / referrer の約束が破れている').toEqual({
    referrer: '',
    hasOpener: false,
  });
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
    // 🔴 P8 段⑭ で `localStorage` は**開いた**(アプリに保存領域を貸すため)。
    //    だから観測点を変える ── 「使えるか」ではなく「**PKC3 の中身が見えるか**」。
    //    ⚠ ここを `ls: 'blocked'` のままにすると、shim が本物を素通しする実装に
    //    なっても「使えている」で緑になる(逆に、貸すのをやめても緑になる)
    try {
      localStorage.setItem('probe', '1');
      out.ls = localStorage.getItem('probe') === '1' ? 'OPEN' : 'broken';
    } catch {
      out.ls = 'blocked';
    }
    try {
      // 🔴 **PKC3 自身の鍵が 1 つも見えないこと**。`pkc3.theme` は PKC3 が
      //    実際に使っている鍵で、本物が漏れていれば必ずここに出る
      const keys = Object.keys(localStorage);
      out.lsKeys = keys.join(',');
      out.lsLeak = keys.some((k) => k.startsWith('pkc3.')) ? 'LEAK' : 'none';
      out.lsTheme = String(localStorage.getItem('pkc3.theme'));
    } catch {
      out.lsLeak = 'blocked';
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
    /**
     * 🔴 **なぜ blocked なのかを分ける**(2026-08-06。user 報告 2-15)。
     *
     * 手当ての後は、上の 3 つは「投げた」ではなく「**無い**」で失敗する
     * (prelude が `undefined` を返す getter に差し替えている)。⚠ 区別を
     * 持たないと、隔離が外れて**本物が生きている**ときとの差が
     * `blocked` / `OPEN` の 1 次元しか無くなり、手当てが効いているのか
     * 隔離が効いているのかが読めない。
     */
    out.idbType = typeof indexedDB;
    out.cachesType = typeof caches;
    return out;
  });
  // ⚠ **origin が opaque であること**を独立に見る ── 個々の storage API が
  // 将来別の理由で失敗しても、隔離が外れたことに気づけるようにする。
  // ⚠ 当初 `location.origin` を見ていたが、Chromium は `about:srcdoc` に対して
  // **隔離の有無に関わらず 'null'** を返すので**空振りだった**(実測)
  expect(reach.selfOrigin).toBe('null');
  expect(reach).toMatchObject({
    parentDom: 'blocked',
    idb: 'blocked',
    opfs: 'blocked',
    caches: 'blocked',
    // 🔴 失敗の**理由**まで見る(2026-08-06)── 手当ての後は「無い」で失敗する。
    //    ⚠ ここが `'object'` に戻ったら、prelude が届いていないか隔離が外れている
    idbType: 'undefined',
    cachesType: 'undefined',
  });
  // 🔴 P8 段⑭: 保存領域は**貸す**。ただし見えるのは**このアプリのぶんだけ**
  expect(reach.ls, 'アプリが状態を保存できない(貸せていない)').toBe('OPEN');
  expect(reach.lsLeak, 'PKC3 自身の鍵がアプリから見えている').toBe('none');
  expect(reach.lsTheme, 'PKC3 の設定がアプリから読めている').toBe('null');
  expect(reach.lsKeys, 'アプリの領域に他人のものが混ざっている').toBe('probe');

  // ⑤-2 ⚠ 隔離した先で**中身がちゃんと出ている**(隔離できても白紙では意味がない)
  // ⚠ 添付自身の `<p>` に絞る ── 手当ての帯(`app-capability`)も `<p>` なので、
  //    素の `locator('p')` は 2 件に当たる(実測で strict mode 違反になった)
  const inApp = appTab.frameLocator('[data-pkc-field="launcher-app"]');
  await expect(inApp.locator('p:not([data-pkc-field])')).toHaveText('1+1=2');

  /**
   * ⑤-3 🔴 **無い能力に触ったことが画面に出る**(2026-08-06。user 報告 2-15)。
   *
   * 上の probe が `indexedDB` / `navigator.storage` / `caches` を実際に触って
   * いるので、手当てが効いていれば**この時点で帯が出ている**。
   * ⚠ これは**実ブラウザでしか測れない** ── 不透明オリジンのプロパティ読みが
   * 同期に投げるのは実装の挙動で、unit の再現(投げる getter を仕込む)は
   * それを真似ているだけである。
   * ⚠ 「1 行目で死んでいない」も同時に見えている ── 死んでいたら上の
   *    `1+1=2` が出ない。
   */
  const capability = inApp.locator('[data-pkc-field="app-capability"]');
  await expect(capability, '無い能力に触ったのに何も出ない(黙って無いことにした)').toContainText(
    '囲いの中では使えません',
  );
  // ⚠ 触ったものの名前が出る(「何かが使えない」では直せない)
  await expect(capability).toContainText('IndexedDB');
  // 🔑 **押すと閉じる**(正常に動いているアプリを覆い続けない)
  await capability.click();
  await expect(capability).toHaveCount(0);
  await appTab.close();

  // ⑥ サイドバーの絞り込みがここでも効く(探し方を 2 通り覚えさせない)
  await page.locator('[data-pkc-field="entry-filter"]').fill('リンク');
  await expect(tiles).toHaveCount(2);
  await page.locator('[data-pkc-field="entry-filter"]').fill('存在しない');
  await expect(page.locator('[data-pkc-field="launcher-empty"]')).toBeVisible();

  expect(errors).toEqual([]);
});

/**
 * P8 段⑭: 🔴 **PKC3 の中だけでタイルを作り、SPA が動いて、状態が残る**。
 *
 * > user 報告 2026-08-03
 * > 「**ランチャーから起動した単一 html の SPA アプリが動かない**」
 * > 「**ランチャーの設定導線が消えた**」
 *
 * 直す前の実測(実起動で回収):
 * ```
 * pageerror: SecurityError: Failed to read the 'sessionStorage' property from 'Window':
 *            The document is sandboxed and lacks the 'allow-same-origin' flag.
 * #app = 「読み込み中…」のまま / spaBoot 未設定
 * ```
 * `try/catch` の無いアプリは**保管庫を読む 1 行目で止まる**。加えて
 * `document.baseURI` が blob:(opaque path)なので `new URL(相対, base)` も
 * `TypeError` で落ちていた。そして PKC3 の中には**タイルを作る導線が無かった**。
 *
 * ⚠ 観測点を「タブが開いた」で止めない ── **アプリの中で JS が走り切ったか**
 * (`spaBoot`)と、**開き直して続きが出るか**まで見る。
 */
test('🔴 登録 → タイル → SPA が動き、開き直しても続きが出る', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // 保管庫と相対 URL と hash router を**全部**使う、try/catch の無い SPA
  const SPA = `<!doctype html><html lang="ja"><head><meta charset="utf-8"></head>
<body><div id="app">読み込み中…</div>
<script>
  var saved = JSON.parse(localStorage.getItem('notes') || '[]');
  sessionStorage.setItem('v', '1');
  var resolved = String(new URL('assets/app.js', document.baseURI));
  history.pushState({ p: 1 }, '', location.href.split('#')[0] + '#/list');
  saved.push('メモ' + (saved.length + 1));
  localStorage.setItem('notes', JSON.stringify(saved));
  document.getElementById('app').textContent = saved.join(',');
  document.body.dataset.spaBoot = 'ok';
  document.body.dataset.route = location.hash;
  document.body.dataset.resolved = resolved;
</scr` + `ipt></body></html>`;

  // ① 🔴 **PKC3 の中で**添付して、登録する(PKC2 のデータを一切使わない)
  await clickReal(page, '[data-pkc-action="attach-file"]');
  await page.locator('[data-pkc-field="attach-input"]').setInputFiles({
    name: 'memo.html',
    mimeType: 'text/html',
    buffer: Buffer.from(SPA, 'utf-8'),
  });
  const register = page.locator('[data-pkc-field="app-register"]');
  await expect(register, 'アプリとして登録する導線が無い').toBeVisible({ timeout: 15000 });

  // 🔴 **チェックボックスは小さな四角のまま**(P8 段⑱)。欄の高さ(`--row-h`)を
  //    入力欄と一緒に当てると、チェックボックスまで 28px の帯に化けて行が崩れる。
  //    ⚠ 空振り防止に**同じ行の入力欄**も測る ── 「入力欄には効いている」ことを
  //    示さないと、高さの指定を丸ごと消しても通ってしまう
  const boxSize = await register.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  expect(boxSize.h, `チェックボックスが縦に伸びている(${boxSize.h}px)`).toBeLessThan(24);
  expect(boxSize.w, `チェックボックスが横に伸びている(${boxSize.w}px)`).toBeLessThan(24);

  await register.check();
  // 登録すると設定欄が出る
  await expect(page.locator('[data-pkc-field="app-group"]')).toBeVisible();
  // 入力欄のほうは行の高さに揃っている(上の「小さいまま」が空振りでない証拠)
  const rowH = await page
    .locator('[data-pkc-field="app-group"]')
    .evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(rowH, `入力欄に行の高さが効いていない(${rowH}px)`).toBeGreaterThan(boxSize.h + 6);
  await page.locator('[data-pkc-field="app-group"]').fill('道具');
  await page.locator('[data-pkc-field="app-group"]').blur();
  await page.locator('[data-pkc-field="app-icon"]').fill('🧮');
  await page.locator('[data-pkc-field="app-icon"]').blur();

  // ② タイルが出る(グループ見出しと目印つき)
  await clickReal(page, '[data-pkc-browse="launcher"]');
  const tile = page.locator(USER_TILES);
  await expect(tile).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('[data-pkc-field="launcher-group"]')).toHaveText('道具');
  await expect(tile.locator('[data-pkc-field="tile-icon"]')).toHaveText('🧮');

  // ③ 🔴 押すと**アプリが動く**
  const open = async (): Promise<Record<string, string | null>> => {
    const [tab] = await Promise.all([context.waitForEvent('page'), tile.click()]);
    await tab.waitForLoadState('domcontentloaded');
    const inner = tab.frameLocator('[data-pkc-field="launcher-app"]');
    await expect(inner.locator('#app')).not.toHaveText('読み込み中…', { timeout: 20000 });
    const f = tab.frames().find((x) => x !== tab.mainFrame())!;
    const seen = await f.evaluate(() => ({
      boot: document.body.dataset.spaBoot ?? null,
      app: document.getElementById('app')?.textContent ?? null,
      route: document.body.dataset.route ?? null,
      resolved: document.body.dataset.resolved ?? null,
      origin: String(self.origin),
    }));
    await tab.close();
    return seen;
  };

  // 🔴 押した対象は**選択状態にもなる**(押しても本体側に何も残らない、を落とす)
  await expect(
    page.locator('[data-pkc-region="launcher-grid"] [data-pkc-tile][data-pkc-selected]'),
    'タイルを押しても、いま何を触ったのか画面に残らない',
  ).toHaveCount(1);
  // 中央にその添付が出る(空のままにしない)
  await expect(page.locator('[data-pkc-field="app-register"]')).toBeVisible();

  const first = await open();
  expect(first.boot, 'アプリが 1 行目で止まっている(保管庫が読めない)').toBe('ok');
  expect(first.app).toBe('メモ1');
  expect(first.route, 'hash router が効いていない').toBe('#/list');
  // 🔴 相対 URL が**解決できる**(base が opaque path だと TypeError で死ぬ)
  expect(first.resolved).toContain('/pkc3-app/assets/app.js');
  // ⚠ 隔離は保ったまま(直したら穴が開いた、を防ぐ)
  expect(first.origin, '隔離が外れている').toBe('null');

  // ④ 🔴 **開き直すと続きが出る**(状態が保存できている ── これが user の要求)
  const second = await open();
  expect(second.app, 'アプリの保存が残っていない').toBe('メモ1,メモ2');

  // ⑤ 🔴 **なりすましを受けない**。
  //    実測で 3 方向(アプリが `allow-popups` で開いた popup からの `opener.parent` /
  //    外殻に生えた別の sandboxed iframe / 外殻自身の `postMessage`)が**全部届き**、
  //    `event.origin` は正規も攻撃も一律 `"null"`、外殻自身の攻撃だけは
  //    **アプリ origin を名乗った** ── つまり origin は両方向に嘘をつく。
  //    ここでは「外殻自身から撃つ」を再現する(source が iframe ではない一通)
  const [attackTab] = await Promise.all([context.waitForEvent('page'), tile.click()]);
  await attackTab.waitForLoadState('domcontentloaded');
  await attackTab.frameLocator('[data-pkc-field="launcher-app"]').locator('#app').waitFor();
  await attackTab.evaluate(() => {
    window.postMessage({ tag: 'pkc3.app.storage', op: 'set', key: 'PWNED', value: '1' }, '*');
  });
  await attackTab.waitForTimeout(300);
  const leaked = await attackTab.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.includes('PWNED')),
  );
  expect(leaked, '外殻が自分宛の偽メッセージを受けて書き込んだ').toEqual([]);
  await attackTab.close();

  // ⑥ 登録を外すとタイルは消える(片道にしない)
  await clickReal(page, '[data-pkc-browse="list"]');
  await page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').first().click();
  await page.locator('[data-pkc-field="app-register"]').uncheck();
  await clickReal(page, '[data-pkc-browse="launcher"]');
  await expect(tile).toHaveCount(0, { timeout: 15000 });
  /**
   * ⚠ ここで「一覧が空」を見ない（2026-08-19）── 組み込みタイルが常に居る以上、
   *   `launcher-empty` は**絞り込みを掛けたときしか成り立たない**
   *   （CLAUDE.md §1「成り立ちえない条件を固定しない」）。
   * 🔑 代わりに**一覧が生きている**ことを見る ── 面ごと消えたのではなく、
   *   登録を外した 1 枚だけが消えたことの証拠である。
   */
  await expect(page.locator(builtinTile('dual'))).toHaveCount(1);

  expect(errors).toEqual([]);
});

/**
 * P8 段⑯: 🔴 **行儀の悪いアプリが origin の保管庫を占有できない**。
 *
 * 🔴 直す前の実測(レビュー H-2)。shim を**一切使わず** `parent.postMessage` を
 * 直に投げるだけの HTML で:
 * ```
 * 外殻タブの localStorage 合計 5,239,731 文字 / 内訳 {"pkc3.app.<lid>": 5,239,154}
 * → origin の枠(≒5,242,000 文字)の 99.94% を 1 アプリが占有。
 *   以後 PKC3 本体は 3,015 文字で QuotaExceededError
 * ```
 * 上限が **shim(= untrusted 側)にしか無かった**のが原因。アプリは shim を
 * 使わずに投げられるので、あれは安全性の根拠にならない。
 *
 * 直した後: 2,000,056 文字で頭打ち / PKC3 本体はまだ 2,048,000 文字書けた。
 */
test('🔴 行儀の悪いアプリが保管庫を占有できない(上限は信頼側が持つ)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // shim を使わず外殻へ直に投げる(規約を守らないアプリ)
  const HOSTILE =
    `<!doctype html><html><head><meta charset="utf-8"></head><body><p>x</p>
<script>
  for (var i = 0; i < 20; i++) {
    parent.postMessage(
      { tag: 'pkc3.app.storage', op: 'set', key: 'k' + i, value: 'A'.repeat(500000) },
      '*',
    );
  }
  document.body.dataset.done = '1';
</scr` + `ipt></body></html>`;

  await clickReal(page, '[data-pkc-action="attach-file"]');
  await page.locator('[data-pkc-field="attach-input"]').setInputFiles({
    name: 'hostile.html',
    mimeType: 'text/html',
    buffer: Buffer.from(HOSTILE, 'utf-8'),
  });
  const register = page.locator('[data-pkc-field="app-register"]');
  await expect(register).toBeVisible({ timeout: 15000 });
  await register.check();

  await clickReal(page, '[data-pkc-browse="launcher"]');
  const tile = page.locator(USER_TILES);
  await expect(tile).toHaveCount(1, { timeout: 15000 });
  const [tab] = await Promise.all([context.waitForEvent('page'), tile.click()]);
  await tab.waitForLoadState('domcontentloaded');
  // ⚠ `evaluate` で待たない ── 外殻は `location.replace` で遷移するので
  //    「Execution context was destroyed」になる(実際に踏んだ)。locator は
  //    遷移をまたいで retry してくれる
  await expect(
    tab.locator('[data-pkc-field="app-note"]'),
    '上限に当たったことが外殻に出ていない',
  ).toBeVisible({ timeout: 20000 });

  const used = await tab.evaluate(() => {
    let per = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith('pkc3.app.')) per += k.length + (localStorage.getItem(k) ?? '').length;
    }
    return per;
  });
  // 🔴 上限(2MB)+ 1 件ぶんの余裕までで頭打ち(直す前は 5,239,154 文字だった)
  expect(used, '1 アプリが上限を超えて占有した').toBeLessThan(2 * 1024 * 1024 + 600_000);
  await tab.close();

  // 🔴 **PKC3 本体がまだ書ける**(占有されると設定すら保存できなくなる)
  const room = await page.evaluate(() => {
    let wrote = 0;
    try {
      for (let i = 0; i < 1000; i++) {
        localStorage.setItem('probe.' + i, 'x'.repeat(1024));
        wrote += 1024;
      }
    } catch {
      /* 上限 */
    } finally {
      for (let i = 0; i < 1000; i++) localStorage.removeItem('probe.' + i);
    }
    return wrote;
  });
  expect(room, 'アプリに占有されて PKC3 自身が書けない').toBeGreaterThan(512 * 1024);

  // 🔴 **開き直しても埋め直せない**(P8 段⑰)。外殻は起動のたびに前置きを走査して
  //    使用量を作り直す ── 覚えているだけだと、タブを開くたびに 0 から数え直して
  //    上限ぶんずつ積み増せる
  const [tab2] = await Promise.all([context.waitForEvent('page'), tile.click()]);
  await tab2.waitForLoadState('domcontentloaded');
  await expect(tab2.locator('[data-pkc-field="app-note"]')).toBeVisible({ timeout: 20000 });
  const after = await tab2.evaluate(() => {
    let per = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith('pkc3.app.')) per += k.length + (localStorage.getItem(k) ?? '').length;
    }
    return per;
  });
  expect(after, '開き直したら上限を超えて積み増せた').toBeLessThan(used + 600_000);
  await tab2.close();

  // 🔴 **削除は可逆なので、アプリのデータもまだ消えない**(P8 段⑳)。
  //    段⑰ はここで消していたが、削除の確認文は「ゴミ箱から戻せます」と
  //    言っている ── 戻したのにアプリの中身が 0 件では、**確認文が嘘**になる。
  //    家計簿アプリに貯めた入力が、警告 1 行も無く消えていた。
  const appKeys = (): Promise<number> =>
    page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pkc3.app.')).length);
  expect(await appKeys(), 'アプリのデータが入っていない(この次元を測れていない)').toBeGreaterThan(0);

  await clickReal(page, '[data-pkc-browse="list"]');
  await page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').first().click();
  await clickReal(page, '[data-pkc-action="delete-entry"]');
  // 確認は**アプリの中**の口を押す(#299 段② ── native は 1 度も開かない)
  await answerAppDialog(page, 'ok');
  await expect(page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]')).toHaveCount(0);
  expect(await appKeys(), '戻せる削除でアプリのデータまで消している').toBeGreaterThan(0);

  // 🔴 **戻すと使える状態で戻る**(確認文「ゴミ箱から戻せます」が嘘でない)
  await clickReal(page, '[data-pkc-browse="filer"]');
  await clickReal(page, '[data-pkc-action="show-trash"]');
  await clickReal(page, '[data-pkc-action="restore-trash"]');
  // ⚠ 一覧は「一覧」タブにしか無い ── フォルダのまま数えると常に 0 件になる
  await clickReal(page, '[data-pkc-browse="list"]');
  await expect(page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]')).toHaveCount(1);
  expect(await appKeys(), '戻したのにアプリのデータが無い').toBeGreaterThan(0);

  // 🔴 **ゴミ箱を空にすると消える**(唯一の不可逆点)。
  //    ここで消さないと、消したノートのデータが origin に永久に残る
  await page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]').first().click();
  await clickReal(page, '[data-pkc-action="delete-entry"]');
  await answerAppDialog(page, 'ok');
  await expect(page.locator('[data-pkc-region="entry-list"] [data-pkc-entry]')).toHaveCount(0);
  await clickReal(page, '[data-pkc-browse="filer"]');
  await clickReal(page, '[data-pkc-action="show-trash"]');
  await clickReal(page, '[data-pkc-action="purge-trash"]');
  // ⚠ 一括・不可逆なので、確認の文言も見る(#299 段②)
  expect(await answerAppDialog(page, 'ok'), '確認が不可逆だと言っていない').toContain(
    '元に戻せません',
  );
  await expect
    .poll(appKeys, {
      timeout: 15000,
      message: 'ゴミ箱を空にしてもアプリのデータが残っている',
    })
    .toBe(0);

  expect(errors).toEqual([]);
});

/**
 * P8 段⑱: 🔴 **添付の参照を本文へ入れられる**(レビュー H)。
 *
 * 🔴 マニュアル §3 は `asset:<key>` を「本文に書ける形式」として説明していたのに、
 * **本文へ入れる経路も key を見る経路も無かった** ── 書ける形式なのに書けない、
 * という状態だった。
 *
 * ⚠ 観測点は「ボタンが在るか」ではなく **押した結果**(クリップボードの中身)。
 */
test('🔴 添付の「参照をコピー」で、本文に貼れる形が手に入る', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await gotoApp(page);

  await clickReal(page, '[data-pkc-action="attach-file"]');
  await page.locator('[data-pkc-field="attach-input"]').setInputFiles({
    name: 'p.png',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });
  const copy = page.locator('[data-pkc-field="copy-asset-ref"]');
  await expect(copy, '参照をコピーする導線が無い').toBeVisible({ timeout: 15000 });
  await copy.click();

  // 🔴 押した結果が**手に入る**(黙って終わらない)
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('コピーしました', {
    timeout: 10000,
  });
  const text = await page.evaluate(() => navigator.clipboard.readText());
  // ⚠ **貼れる形**であること ── 裸の `asset:<key>` は markdown としてはただの
  //    文字列で、貼っても何も出ない(直す前がそれだった)
  expect(text, 'コピーされた文字列が本文に貼れる形になっていない').toMatch(
    /^!\[[^\]]*\]\(asset:.+\)$/,
  );

  // ⚠ 貼ったら実際に添付として出る(形式が合っているか、の最終確認)
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(`見て: ${text}\n`);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await expect(
    page.locator('[data-pkc-field="detail-body"] img[data-pkc-asset-key]'),
    '貼った参照が添付として出ない',
  ).toHaveCount(1, { timeout: 15000 });

  expect(errors).toEqual([]);
});

/**
 * P8 段⑱: 🔴 **タブを変えても中央の面は変わらない**(レビュー M)。
 * 直す前は「アプリ」タブに切り替えただけで `SET_VIEW_MODE 'launcher'` を撃って
 * おり、**中央下の追記欄が消えて**いた(他の 2 タブでは残る)。探し方(左の列)と
 * 見る場所(中央)は別の軸である。
 */
test('🔴 左のタブを変えても、中央の追記欄は消えない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('追記できるノート');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  const box = page.locator('[data-pkc-field="append-input"]');
  await expect(box).toBeVisible();
  for (const tab of ['filer', 'launcher', 'list']) {
    await clickReal(page, `[data-pkc-browse="${tab}"]`);
    await expect(box, `${tab} タブで追記欄が消えた`).toBeVisible();
  }

  expect(errors).toEqual([]);
});

/**
 * 🔴 **素のまま起動すると、囲いの中で死ぬアプリが動く**(P10、user 指示 2026-08-05
 * 「同一ドメインで動かしたい HTML アセットが javascript が動かなくて死ぬ」)。
 *
 * 診断は「JS は動いていた」── 死んでいたのは**不透明オリジン**のせいで、
 * `indexedDB.open()` が**同期に SecurityError** を投げ、`try/catch` の無い
 * 普通のアプリは 1 行目で止まって真っ白になっていた。
 *
 * ⚠ ここが観測点である ── **同じアプリ**を 2 通りで開き、
 * 「囲いの中では止まる / 素のままでは動く」の**両方**を見る。
 * 片方だけでは「たまたま動いた」と区別できない。
 */
test('🔴 IndexedDB を使うアプリは、素のままで動き、囲いの中では止まる', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  // ⚠ `try/catch` を**書かない** ── これが user の言う「普通のアプリ」である。
  //    1 行目で throw したら以後の行は動かない = 真っ白になる
  const IDB_APP =
    `<!doctype html><title>台帳</title><body><p id="app">読み込み中…</p><scr` +
    `ipt>
  var req = indexedDB.open('ledger', 1);
  req.onupgradeneeded = function () { req.result.createObjectStore('rows'); };
  req.onsuccess = function () {
    document.getElementById('app').textContent = 'ok';
    document.body.dataset.idb = 'ok';
  };
</scr` + `ipt></body></html>`;

  await clickReal(page, '[data-pkc-action="attach-file"]');
  await page.locator('[data-pkc-field="attach-input"]').setInputFiles({
    name: 'ledger.html',
    mimeType: 'text/html',
    buffer: Buffer.from(IDB_APP, 'utf-8'),
  });
  // 🔴 **登録していない状態で**起動できること(登録はランチャーに並べる設定であって、
  //    開けることとは別 ── そこを混ぜていたのが「詳細から起動できない」の一因)
  const run = page.locator('[data-pkc-action="launch-asset"]');
  await expect(run, '詳細画面に「起動」が無い').toBeVisible({ timeout: 15000 });

  const readApp = async (win: import('@playwright/test').Page): Promise<unknown> => {
    const frame = win.frameLocator('[data-pkc-field="launcher-app"]');
    // ⚠ 待つのは **frame の中の文字**(タブが開いた瞬間はまだ空)
    await expect(frame.locator('#app')).not.toHaveText('', { timeout: 15000 });
    return frame.locator('#app').textContent();
  };

  // ① 囲いの中 ── **止まる**(1 行目の SecurityError)
  const boxedTab = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="launch-asset"]');
  const boxed = await boxedTab;
  expect(await readApp(boxed), '囲いの中で IndexedDB が通ってしまった(隔離が外れている)').toBe(
    '読み込み中…',
  );
  /**
   * 🔴 **止まるのは変わらないが、理由が出る**(2026-08-06。user 報告 2-15)。
   *
   * 直す前は「真っ白 + 理由なし」だった。いまは 2 つ出る:
   *  ① 上の帯 ── **何が使えないのか**(IndexedDB)
   *  ② 下の行 ── 例外そのもの(`app-anchor-shim` の `say()`)
   * ⚠ ここは user 報告の本体である ── 「動かない」ことより
   *   「**理由がどこにも出ない**」ことが報告の中身だった。
   */
  const boxedFrame = boxed.frameLocator('[data-pkc-field="launcher-app"]');
  await expect(
    boxedFrame.locator('[data-pkc-field="app-capability"]'),
    '何が使えないのか画面に出ない',
  ).toContainText('IndexedDB');
  await expect(
    boxedFrame.locator('[data-pkc-field="app-error"]'),
    '止まった理由が画面に出ない(真っ白 + 理由なし)',
  ).toContainText('エラー');
  await boxed.close();

  // ② 素のまま ── **動く**。⚠ 確認が出るので受ける(fail closed の逆側)
  const rawTab = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="launch-asset-raw"]');
  // ⚠ 確認は**開く前**に出る(断ったら空のタブが残らない ── #299 段③)
  await answerAppDialog(page, 'ok');
  const raw = await rawTab;
  expect(await readApp(raw), '素のままなのに IndexedDB が動かない(直っていない)').toBe('ok');
  // 器の印も見る(どちらで開いたかが外から分かる)
  const mode = await raw
    .locator('[data-pkc-field="launcher-app"]')
    .getAttribute('data-pkc-launcher-mode');
  expect(mode).toBe('same-origin');
  await raw.close();

  expect(errors).toEqual([]);
});

/**
 * 🔴 **ページ内リンクでアプリが消えない**(2026-08-05、調査 doc 1-7)。
 *
 * 直す前は、`srcdoc` + `<base>` のせいで `<a href="#sec">` を押すと
 * `…/pkc3-app/#sec` へ**本当に遷移**し、そこは SPA fallback で **PKC3 自身の
 * index.html** ── 不透明オリジンでは起動できず真っ白になった。
 * **JS を 1 行も使わないアプリでも起きる。**
 *
 * ⚠ 観測点は **frame の document URL**。「見えているか」だけを見ると、
 * PKC3 の index.html が真っ白に描かれた状態と区別が付かない。
 */
test('🔴 囲いの中のアプリで、ページ内リンクを押してもアプリが消えない', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ⚠ **script を 1 行も使わない**アプリにする ── この事故は素の HTML で起きる
  const DOC_APP =
    '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>手引き</title>' +
    '<style>body{margin:0;font:16px system-ui}#pad{height:3000px}</style></head><body>' +
    '<h1 id="top">手引き</h1>' +
    '<p><a href="#tail" id="jump">末尾へ</a></p>' +
    '<div id="pad"></div>' +
    '<h2 id="tail">末尾の節</h2>' +
    '</body></html>';

  await clickReal(page, '[data-pkc-action="attach-file"]');
  await page.locator('[data-pkc-field="attach-input"]').setInputFiles({
    name: 'guide.html',
    mimeType: 'text/html',
    buffer: Buffer.from(DOC_APP, 'utf-8'),
  });
  await expect(page.locator('[data-pkc-action="launch-asset"]')).toBeVisible({
    timeout: 15000,
  });

  const appTab = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="launch-asset"]');
  const tab = await appTab;
  await tab.waitForLoadState('domcontentloaded');
  const inner = tab.frameLocator('[data-pkc-field="launcher-app"]');
  await expect(inner.locator('#jump')).toBeVisible({ timeout: 15000 });
  const frame = tab.frames().find((f) => f !== tab.mainFrame())!;

  // 前提: 囲いの中(不透明オリジン)で、文書は srcdoc である
  expect(await frame.evaluate(() => String(self.origin))).toBe('null');
  expect(await frame.evaluate(() => location.href)).toBe('about:srcdoc');

  // ── 実際に押す(リンクは frame の中なので、frame 座標で実クリックする)
  await inner.locator('#jump').click();

  // ① 🔴 **アプリが生きている**(遷移していない)
  expect(
    await frame.evaluate(() => location.href),
    'ページ内リンクで別の文書へ遷移した(アプリが消える経路)',
  ).toBe('about:srcdoc');
  await expect(inner.locator('h1#top'), 'アプリの中身が失われた').toHaveText('手引き');

  // ② 🔴 **リンクが効いている**(遷移を止めただけの「死んだリンク」にしない)
  const y = await frame.evaluate(() => window.scrollY);
  expect(y, `末尾へ移動していない(scrollY=${y})`).toBeGreaterThan(100);

  await tab.close();
  expect(errors).toEqual([]);
});

/**
 * #148: **組み込みの Office タイル**(user 裁定 2026-08-14「組み込みタイルの案を採用」)。
 *
 * ⚠ unit は「合流の規則」しか見ない ── **meta を入れた端末で boot → 面に出る →
 * 押すと Office の窓が開く**という 1 本の線は実物でしか確かめられない。
 * ⚠ 「タイルが在る」で止めない ── 押して窓が開くところまで見る
 * (「名前が在るかの検査は、中身が空でも通る」)。
 */
test('🔴 一式を入れた端末では Office タイルが出て、押すと窓が開く (#148)', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // Office 一式の meta を仕込む。⚠ 「入っているか」の判定は **meta の有無**
  // (install の tx で files と一緒に書かれる ── office-pack-store.ts の作法)
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('pkc3-office-pack', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('files')) req.result.createObjectStore('files');
        if (!req.result.objectStoreNames.contains('meta')) req.result.createObjectStore('meta');
      };
      req.onsuccess = () => {
        const db = req.result;
        const t = db.transaction('meta', 'readwrite');
        t.objectStore('meta').put(
          { version: 'smoke-pack', installedAt: Date.now(), source: 'url', totalBytes: 1, files: [] },
          'pack',
        );
        t.oncomplete = () => {
          db.close();
          resolve();
        };
        t.onerror = () => reject(t.error ?? new Error('idb write failed'));
      };
      req.onerror = () => reject(req.error ?? new Error('idb open failed'));
    });
  });
  // 控え(appOfficePack)は boot で読む ── 仕込んだ後に開き直す
  await gotoApp(page);

  await clickReal(page, '[data-pkc-browse="launcher"]');
  /**
   * ⚠ **Office だけを名指す**（2026-08-19）── 組み込みは 2 枚になった
   *   （2 ペイン + Office、#241）ので、`nth(0)` はもう Office ではない。
   */
  const office = page.locator(builtinTile('office'));
  await expect(page.locator(USER_TILES), '仕込んだ覚えの無いタイルが出ている').toHaveCount(0);
  await expect(office).toHaveCount(1);
  await expect(office).toContainText('Office');
  expect(await office.getAttribute('data-pkc-tile-kind')).toBe('office');

  // 🔴 押すと **Office の窓**が開く
  const popup = context.waitForEvent('page');
  await clickReal(page, builtinTile('office'));
  const win = await popup;
  expect(win.url()).toContain('office/host.html');
  await win.close();

  expect(errors).toEqual([]);
});

/**
 * 🔴 **素のまま起動の許可は、読み込み直しても憶えている**(#301。user 裁定 2026-08-21)。
 *
 * > 「**同じハッシュのアプリ登録済みの URL もしくは HTML に関しては永続化
 * > (文字通りの永続化、期間とかない)**」
 *
 * ⚠ **ここは unit では届かない**。`main.ts` の `openTile` が
 *   「憶えているか」を見て `sameOrigin` を渡す配線は、原文を読む test しか無い
 *   (CLAUDE.md §2)── ここが fail-open に壊れると、**登録しただけのアプリが
 *   確認なしで全ノートを読める**。だから実ブラウザで 1 本張る。
 * 🔑 見るのは 3 つ: ① 読み込み直しても聞かない ② タイルから素のまま開く
 *   ③ **許可していないアプリは囲いの中のまま**(対照群 ── これが無いと
 *   「全部素のまま開く」に壊しても緑になる)。
 */
test('🔴 一度許した素のまま起動は、読み込み直しても聞かない(#301)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  const APP = (name: string): string =>
    `<!doctype html><title>${name}</title><body><p id="app">${name}</p></body></html>`;

  const attach = async (name: string): Promise<void> => {
    // ⚠ 添付は**本文の面**から ── タイルの面に居ると導線が無い
    await clickReal(page, '[data-pkc-browse="list"]');
    await clickReal(page, '[data-pkc-action="attach-file"]');
    await page.locator('[data-pkc-field="attach-input"]').setInputFiles({
      name: `${name}.html`,
      mimeType: 'text/html',
      buffer: Buffer.from(APP(name), 'utf-8'),
    });
    await expect(
      page.locator('[data-pkc-action="launch-asset"]'),
      `${name} の添付が出ていない`,
    ).toBeVisible({ timeout: 15000 });
  };

  const modeOf = async (win: import('@playwright/test').Page): Promise<string | null> => {
    const el = win.locator('[data-pkc-field="launcher-app"]');
    await expect(el).toBeVisible({ timeout: 15000 });
    return el.getAttribute('data-pkc-launcher-mode');
  };

  /**
   * ⚠ **タイルが出るまで待つ。** 登録は `SET_APP_TILE` → 本文の frontmatter を
   *   保存 → 読み直し、と**保存を往復してから**反映される ── 押した直後は
   *   まだ「登録していない」ものとして見える(1 稿目はここで落ち、確認の文面が
   *   「この画面を開いている間は」になっていた)。
   */
  const registerApp = async (expected: number): Promise<void> => {
    await page.locator('[data-pkc-field="app-register"]').check();
    await clickReal(page, '[data-pkc-browse="launcher"]');
    await expect(page.locator(USER_TILES), '登録がタイルに反映されない').toHaveCount(expected, {
      timeout: 15000,
    });
  };

  // ① 添付して「アプリとして登録」する(タイルに並ぶ = 憶える対象になる)
  await attach('daichou');
  await registerApp(1);

  // ② 素のまま起動を **1 度だけ** 許す
  const first = context.waitForEvent('page');
  await clickReal(page, '[data-pkc-action="launch-asset-raw"]');
  const asked = await answerAppDialog(page, 'ok');
  expect(asked, '確認の文面が変わっている').toContain('渡して開き');
  // 🔑 **登録済みの枝を通ったこと**まで見る ── ここが「この画面を開いている間は」に
  //    なっていたら、以後の「読み込み直しても憶えている」は**別の理由で緑**になる
  expect(asked, '登録済みなのに、その場かぎりの確認になっている').toContain('次回から聞きません');
  const firstWin = await first;
  expect(await modeOf(firstWin), '1 度目が素のままで開いていない').toBe('same-origin');
  await firstWin.close();

  // ③ 🔴 **読み込み直す**(セッションの記憶は消える。憶えていれば保存の側に在る)
  await gotoApp(page);

  // ④ タイルを押す ── 確認は出ず、素のままで開く
  await clickReal(page, '[data-pkc-browse="launcher"]');
  const tile = page.locator(USER_TILES).first();
  await expect(tile, 'タイルが並んでいない').toBeVisible({ timeout: 15000 });
  const again = context.waitForEvent('page');
  await tile.click();
  const againWin = await again;
  expect(await modeOf(againWin), '読み込み直したら忘れている(永続化していない)').toBe(
    'same-origin',
  );
  // ⚠ **確認が出ていないこと**も見る ── 出ていたら「聞かれなくなった」は嘘である
  await expect(
    page.locator('[data-pkc-region="app-dialog"][open]'),
    '憶えているのに確認が出た',
  ).toHaveCount(0);
  await againWin.close();

  /**
   * ⑤ 🔑 **対照群 ── 取り消したら、また囲いの中に戻る。**
   *
   * ⚠ これが無いと「タイルは常に素のまま開く」に壊しても緑になる(fail open)。
   * ⚠ ついでに**マニュアルの約束**(「設定でいつでも取り消せます」)も、ここで守る
   *   ── 期限なしで憶える以上、出口が死んでいたら二度と外せない。
   */
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const revoke = page.locator('[data-pkc-action="revoke-same-origin"]');
  await expect(revoke, '設定に取り消しの導線が無い').toHaveCount(1, { timeout: 15000 });
  await revoke.click();
  await expect(revoke, '押しても一覧から消えない').toHaveCount(0, { timeout: 15000 });

  await gotoApp(page);
  await clickReal(page, '[data-pkc-browse="launcher"]');
  const after = page.locator(USER_TILES).first();
  await expect(after).toBeVisible({ timeout: 15000 });
  const boxedTab = context.waitForEvent('page');
  await after.click();
  const boxedWin = await boxedTab;
  expect(await modeOf(boxedWin), '取り消したのに素のままで開いた(fail open)').not.toBe(
    'same-origin',
  );
  await boxedWin.close();

  expect(errors).toEqual([]);
});

/**
 * 🔴 **組み込みアプリのタイルは、別窓を開く**(#300 段③、2026-08-22)。
 *
 * > 「**組み込みのアプリに関しては全て別窓で作業したい Office みたいに!**」
 * > 「**メインの PKC の機能を阻害する方向で PKC のセンターペインを占有するな**」
 *
 * 🔴 **unit では原理的に届かない層だけ**をここで見る:
 * ① **本当に窓が開くか** ── `window.open` は unit では差し替えている
 * ② 🔴 **中央の面が 1 ミリも動かないか** ── これが user の要望そのもの
 * ③ **窓が PKC のディープリンクで開くか** ── 開いた先がその面で立ち上がる
 * ④ 🔴 **読んでいたノートが連れて来られているか**(段③ の直し)── ここが
 *    user の目的である(「カレンダーで日付を付けたい」)。連れて行かないと
 *    別窓は「日を押す前に…ノートを選んでください」で立ち上がる
 * ⑤ 🔴 **窓の題名でどれがどれか分かるか** ── 直す前は 3 枚とも「PKC3」
 * ⑥ 🔴 **`× 閉じる` が窓ごと閉じるか** ── 直す前は窓が残って本文が出た
 *    (「アプリを閉じたら PKC がもう 1 つ増えた」)
 */
test('🔴 組み込みタイルを押すと別窓が開き、本文の面は残る (#300)', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  await clickReal(page, '[data-pkc-browse="launcher"]');
  /**
   * 🔴 **押す前に「別の窓で開く」と分かる**(動線レビュー §4/§8)。
   * ⚠ 押しても本体の画面は 1 ドットも動かないので、書いていないと
   *   「壊れている」に見える(そして user はもう一度押す)。
   */
  await expect(
    page.locator('[data-pkc-field="launcher-lead"]'),
    '別の窓で開くと書いていない',
  ).toHaveText('アプリは別の窓で開きます');

  const popup = context.waitForEvent('page');
  await clickReal(page, builtinTile('dual'));
  const win = await popup;

  // ③ 窓は PKC のディープリンクで開いている(面 + 連れて行くノート + 合図)
  expect(win.url(), '別窓がその面のディープリンクで開いていない').toContain('view=dual');
  expect(win.url(), '読んでいたノートを載せていない').toMatch(/[?&]container=[^&]+&entry=/);
  expect(win.url(), '合図を載せていない(開けたかを判定できない)').toMatch(/[&]w=/);
  await expect(win.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await expect(
    win.locator('[data-pkc-view-pane="dual"]'),
    '別窓が 2 ペインで立ち上がっていない',
  ).toBeVisible();

  /**
   * ④ 🔴 **読んでいたノートが連れて来られている。**
   * ⚠ 連れて行かないと、別窓は `selectedLid === null` で立ち上がる ──
   *   user はさっきまで読んでいたノートを**探し直す**ことになる。
   * 🔑 観測点は**アドレスに載っていること**ではなく(それは③で見た)、
   *   **その窓が実際にそのノートを選んでいること**である。
   */
  await expect
    .poll(() => win.locator('[data-pkc-entry][data-pkc-selected]').count(), { timeout: 10_000 })
    .toBeGreaterThan(0);

  /**
   * 🔑 **合図はアドレスから消えている**(段③ の直し)── ブックマークに
   * 焼き付くと、次に開いたときに誰も聞いていない放送を撒く。
   * ⚠ **面は残る**(段② の裁定「見ている間は残す」── `F5` で戻る / `Ctrl+D` が効く)。
   */
  await expect
    .poll(() => win.url(), { timeout: 10_000 })
    .not.toContain('&w=');
  expect(win.url(), '面まで落とした(F5 で本文へ落ちる)').toContain('view=dual');

  // ⑤ 🔴 窓の題名でどれがどれか分かる(タスクバーに何枚並んでも見分けられる)
  await expect
    .poll(() => win.title(), { timeout: 10_000 })
    .toContain('2 ペイン');

  /**
   * ② 🔴 **本体の中央の面は動いていない。**
   * ⚠ 直す前はここが入れ替わって**本文が消えていた** ── user の苦情の実体である。
   */
  await expect(
    page.locator('[data-pkc-view-pane="detail"]'),
    '別窓を開いたのに本体の本文が消えた(センターペインを占有している)',
  ).toBeVisible();
  await expect(page.locator('[data-pkc-view-pane="dual"]')).toBeHidden();

  /**
   * ⑥ 🔴 **`× 閉じる` は窓ごと閉じる**(動線レビュー §7)。
   * ⚠ 直す前は `SET_VIEW_MODE 'detail'` が飛ぶだけで、**窓は残りそこに本文が
   *   出た** ── user から見ると「アプリを閉じたら PKC がもう 1 つ増えた」。
   * 🔑 観測点は **窓が閉じたこと**である(面が畳まれたことではない)。
   */
  /**
   * ⚠ **押した結果その窓が閉じるので、click の ack が返らないことがある**
   *   (2026-08-22、CI で実際に落ちた:`mouse.click: Target page, context or
   *   browser has been closed`)。⚠ **手元は緑・CI は赤**だった ── 手元は
   *   フル chromium、PR gate は `chromium_headless_shell` である(CLAUDE.md §5)。
   * 🔑 **握り潰さない** ── 「閉じた」以外の失敗(ボタンが無い等)はそのまま投げる。
   *   そして**押せたことの証拠は次の行**である(閉じていなければ落ちる)。
   */
  await clickReal(win, '[data-pkc-action="close-pane"]').catch((e: unknown) => {
    if (!String(e).includes('closed')) throw e;
  });
  await expect.poll(() => win.isClosed(), { timeout: 10_000 }).toBe(true);

  /**
   * ⚠ **カレンダー / やることの板はここから外れた**(#292 段⑤、2026-08-23)──
   *   あの 2 つは「アプリ」ではなく**ノートの見方**だったので、左の列の
   *   「予定」タブへ引っ越した。**栞から開く道が生きているか**は
   *   `deep-link.smoke.spec.ts` の引っ越し test が見る。
   */
  expect(errors).toEqual([]);
});
