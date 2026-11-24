import { test, expect, type Browser, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { gotoApp, clickReal, collectPageErrors, createEntry, openMessagePopover } from './helpers';
import { fakeS3 } from '../helpers/fake-s3';

/**
 * 🔴 **S3 互換の保管先(#2000 段 4a-4。user 必須ガード)── COOP/COEP で分離した実ブラウザの 2 台から、作り物の S3 サーバを読み書きする**。
 *
 * - 作り物の S3 = この test が立てる Node の HTTP サーバ(`127.0.0.1` の別のポート = 別の origin)。中身は
 *   `tests/helpers/fake-s3.ts`(**SigV4 を node:crypto で独立に検算** ── 署名が合わなければ 403)。CORS の見出しを付ける / 付けないを切り替える。
 * - 見る物: ①分離(`crossOriginIsolated`)の下で読み書きでき、ファイルを運ばずに B へノートが届く ②認証情報の欄は接続したら空になり、
 *   localStorage・同期の記録(IndexedDB)・鍵の保管(暗号化)のどこにも平文が無い ③書く間に別の端末が書いた(412)ら上書きせずに止まる
 *   ④CORS を外すと、理由(CORS)を言って失敗する ⑤「接続を外す」で認証情報が消える(保管先のファイルは残る)。
 * - 🔴 段 4b-B(暗号化は S3 の既定オン): ⑥接続しても、パスフレーズを決めて回復キーを打ち直すまで置き場に何も書かない
 *   ⑦置き場には `.enc` と `keyring.json` だけ(平文の zip も、ノートの字も、パスフレーズ・回復キーも無い)⑧ B は回復キーで開いて受け取る
 *   ⑨画面を開き直しても、端末に置いた暗号化キーで自動で再開する / 「開くたびにパスフレーズを入れる」は、入れるまで待ち、メッセージの「いまの状態」から入れに行ける。
 */
const SECRET = { accessKeyId: 'SMOKE-KEY-ID-4a4', secretAccessKey: 'smoke/SECRET+key=4a4' };
const PASS = 'smoke-パスフレーズ-4b-φ-2026';
const NOTE_TITLE = 'S3 で運ぶメモ';

interface MockS3 {
  url: string;
  s3: ReturnType<typeof fakeS3>;
  cors: boolean;
  race: boolean;
  server: Server;
}

async function startMockS3(): Promise<MockS3> {
  const m = { cors: true, race: false } as MockS3;
  m.s3 = fakeS3(SECRET, {
    beforePut: (key) => {
      if (!m.race) return;
      m.race = false;
      m.s3.objects.set(key, { body: new TextEncoder().encode('別の端末が書いた'), etag: '"racer"', mtime: new Date().toISOString() });
    },
  });
  m.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const origin = req.headers.origin ?? '';
        const corsHeaders: Record<string, string> = m.cors
          ? { 'access-control-allow-origin': origin, 'access-control-expose-headers': 'ETag', vary: 'Origin' }
          : {};
        if (req.method === 'OPTIONS') {
          res.writeHead(
            m.cors ? 204 : 403,
            m.cors
              ? {
                  ...corsHeaders,
                  'access-control-allow-methods': 'GET, PUT, DELETE, HEAD',
                  'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '',
                  'access-control-max-age': '0',
                }
              : {},
          );
          res.end();
          return;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
        const body = Buffer.concat(chunks);
        const r = await m.s3.fetch(`http://${req.headers.host ?? ''}${req.url ?? '/'}`, {
          method: req.method ?? 'GET',
          headers,
          ...(req.method === 'PUT' ? { body: new Uint8Array(body) } : {}),
        });
        const out: Record<string, string> = { ...corsHeaders };
        const etag = r.headers.get('etag');
        if (etag !== null) out.etag = etag;
        res.writeHead(r.status, out);
        res.end(Buffer.from(await r.arrayBuffer()));
      })();
    });
  });
  await new Promise<void>((resolve) => m.server.listen(0, '127.0.0.1', resolve));
  m.url = `http://127.0.0.1:${String((m.server.address() as AddressInfo).port)}`;
  return m;
}

async function device(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => localStorage.setItem('pkc3.sync', '1'));
  const page = await ctx.newPage();
  await gotoApp(page);
  return page;
}

async function openS3(page: Page): Promise<void> {
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(page.locator('[data-pkc-region="settings-sync-s3"]')).toBeAttached();
}

async function fill(page: Page, endpoint: string): Promise<void> {
  const f = (k: string) => page.locator(`[data-pkc-field="sync-s3-${k}"]`);
  await f('endpoint').fill(endpoint);
  await f('bucket').fill('my notes');
  await f('region').fill('auto');
  await f('prefix').fill('pkc3/');
  await f('access-key-id').fill(SECRET.accessKeyId);
  await f('secret').fill(SECRET.secretAccessKey);
}

const status = (page: Page) => page.locator('[data-pkc-field="sync-s3-status"]');
const result = (page: Page) => page.locator('[data-pkc-field="sync-s3-result"]');

/** この端末の保存領域(localStorage・同期の記録・鍵の保管)を字にする(バイト列は latin1)。 */
async function storageText(page: Page): Promise<{ local: string; folder: string; keys: string; keyCount: number; keyNames: string[] }> {
  return page.evaluate(async () => {
    const flat = (v: unknown): string => {
      if (v instanceof ArrayBuffer) return String.fromCharCode(...new Uint8Array(v));
      if (ArrayBuffer.isView(v)) return String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      if (typeof v === 'object' && v !== null) return Object.values(v).map(flat).join('|');
      return String(v);
    };
    const dump = (db: string, store: string): Promise<unknown[]> =>
      new Promise((resolve) => {
        const req = indexedDB.open(db);
        // ⚠ 覗くだけ ── 無い DB を作らない(版 1 の空の DB を先に作ると、アプリの口が棚の無い DB を開く)
        req.onupgradeneeded = () => req.transaction?.abort();
        req.onsuccess = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(store)) {
            d.close();
            resolve([]);
            return;
          }
          const g = d.transaction(store, 'readonly').objectStore(store).getAll();
          g.onsuccess = () => {
            d.close();
            resolve(g.result as unknown[]);
          };
          g.onerror = () => resolve([]);
        };
        req.onerror = () => resolve([]);
      });
    const local = Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k) ?? ''}`).join('\n');
    const boxes = await dump('pkc3-sync-keys', 'boxes');
    // 🔴 暗号化キー(段 4b)は鍵の棚に `data:<cid>` で置く(取り出せない CryptoKey)── 名前だけ控える
    const keyNames = await new Promise<string[]>((resolve) => {
      const req = indexedDB.open('pkc3-sync-keys');
      req.onupgradeneeded = () => req.transaction?.abort();
      req.onsuccess = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('keys')) {
          d.close();
          resolve([]);
          return;
        }
        const g = d.transaction('keys', 'readonly').objectStore('keys').getAllKeys();
        g.onsuccess = () => {
          d.close();
          resolve((g.result as unknown[]).map(String));
        };
        g.onerror = () => resolve([]);
      };
      req.onerror = () => resolve([]);
    });
    return { local, folder: (await dump('pkc3-sync-folder', 'folders')).map(flat).join('||'), keys: boxes.map(flat).join('||'), keyCount: boxes.length, keyNames };
  });
}


/** 人が目で見るスクリーンショット(`PKC3_SHOT_DIR` があるときだけ)。 */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.PKC3_SHOT_DIR;
  if (dir !== undefined && dir !== '') await page.screenshot({ path: `${dir}/${name}.png` });
}

const e2eField = (page: Page, name: string) => page.locator(`[data-pkc-region="settings-sync-s3"] [data-pkc-field="${name}"]`);

/**
 * 設定 → 回復キーの窓 → 保存 → 打ち直し → 完了(実クリック)。回復キーを返す。
 * 🔴 打ち直しが合うまで「完了」が押せないこと・保存のファイルに回復キーが入ることもここで見る。
 */
async function setupEncryption(page: Page, opts: { ask?: boolean } = {}): Promise<string> {
  await expect(e2eField(page, 'sync-e2e-setup'), '設定の欄が出ない').toBeVisible({ timeout: 20_000 });
  await e2eField(page, 'sync-e2e-pass').fill(PASS);
  await e2eField(page, 'sync-e2e-pass2').fill(PASS);
  if (opts.ask === true) await e2eField(page, 'sync-e2e-ask-setup').check();
  await e2eField(page, 'sync-e2e-setup').scrollIntoViewIfNeeded();
  await shot(page, 'e2e-1-setup');
  await clickReal(page, '[data-pkc-region="settings-sync-s3"] [data-pkc-action="start-sync-e2e-setup"]');
  const keyEl = page.locator('[data-pkc-region="app-dialog"] [data-pkc-field="recovery-key"]');
  await expect(keyEl, '回復キーの窓が出ない').toBeVisible({ timeout: 20_000 });
  await shot(page, 'e2e-2-recovery-dialog');
  // 🔴 本物の Escape で閉じる = 設定をやめる(何も作らない)。入力は空に戻っているので入れ直す
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-pkc-region="app-dialog"]'), 'Esc で閉じない').toBeHidden();
  await expect(e2eField(page, 'sync-e2e-result')).toContainText('何も書いていません');
  await e2eField(page, 'sync-e2e-pass').fill(PASS);
  await e2eField(page, 'sync-e2e-pass2').fill(PASS);
  if (opts.ask === true) await e2eField(page, 'sync-e2e-ask-setup').check();
  await clickReal(page, '[data-pkc-region="settings-sync-s3"] [data-pkc-action="start-sync-e2e-setup"]');
  await expect(keyEl, '2 回目の回復キーの窓が出ない').toBeVisible({ timeout: 20_000 });
  const key = ((await keyEl.textContent()) ?? '').trim();
  expect(key).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  // 保存(テキストファイル)
  const download = page.waitForEvent('download');
  await clickReal(page, '[data-pkc-field="recovery-save"]');
  const dl = await download;
  expect(dl.suggestedFilename()).toBe('pkc3-recovery-key.txt');
  expect(await readFile(await dl.path(), 'utf8'), '保存したファイルに回復キーが入る').toContain(key);
  // 打ち直し: 合うまで「完了」は押せない
  const ok = page.locator('[data-pkc-region="app-dialog"] [data-pkc-field="dialog-ok"]');
  await expect(ok).toBeDisabled();
  const retype = page.locator('[data-pkc-field="recovery-retype"]');
  await retype.fill(key.slice(0, 10));
  await expect(ok, '途中では押せない').toBeDisabled();
  await retype.fill(key.replace(/.$/, (c) => (c === '0' ? '1' : '0')));
  await expect(ok, '1 字違いでは押せない').toBeDisabled();
  await retype.fill(key.toLowerCase().replace(/-/g, ' '));
  await expect(ok, '合えば押せる(小文字・空白でも)').toBeEnabled();
  await clickReal(page, ok);
  await expect(page.locator('[data-pkc-region="app-dialog"]')).toBeHidden();
  return key;
}

test('🔴 S3 互換の保管先: 分離した実ブラウザから読み書きし、412 は上書きせずに止まり、CORS が無ければ理由を言う (#2000 段 4a-4)', async ({ browser }) => {
  test.setTimeout(120_000);
  const mock = await startMockS3();
  const A = await device(browser);
  const B = await device(browser);
  const errorsA = collectPageErrors(A);
  const errorsB = collectPageErrors(B);
  try {
    expect(await A.evaluate(() => window.crossOriginIsolated), 'COOP/COEP の分離の下で確かめる').toBe(true);

    // ── A: ノートを書いて、保管先に接続する(先に「接続の確認」── 保存しない)
    await createEntry(A, 'text');
    await A.locator('[data-pkc-field="editor-title"]').fill(NOTE_TITLE);
    await clickReal(A, '[data-pkc-action="commit-edit"]');
    await openS3(A);
    await expect(status(A)).toHaveText('使っていません');
    // 🔴 CORS の設定の例に、本当の画面の場所が入っている(unit は場所を差し替えるので、本番の読み口はここで見る)
    const origin = await A.evaluate(() => location.origin);
    const tpl = JSON.parse((await A.locator('[data-pkc-field="sync-s3-cors"]').textContent()) ?? '') as { AllowedOrigins: string[] }[];
    expect(tpl[0]!.AllowedOrigins).toEqual([origin]);
    await fill(A, mock.url);
    await clickReal(A, '[data-pkc-action="test-sync-s3"]');
    await expect(result(A)).toContainText('接続できました', { timeout: 20_000 });
    expect((await storageText(A)).keyCount, '確認だけでは保存しない').toBe(0);
    await expect(e2eField(A, 'sync-e2e-on'), '暗号化は既定でオン').toBeChecked();
    await clickReal(A, '[data-pkc-action="connect-sync-s3"]');
    // 🔴 暗号化の設定が済むまで(平文を書かずに)止まる
    await expect(status(A)).toContainText('止まっています', { timeout: 20_000 });
    await expect(e2eField(A, 'sync-e2e-status')).toContainText('パスフレーズを決めてください');
    expect(await A.locator('[data-pkc-field="sync-s3-secret"]').inputValue(), '認証情報の欄は空にする').toBe('');
    expect(await A.locator('[data-pkc-field="sync-s3-access-key-id"]').inputValue()).toBe('');
    expect([...mock.s3.objects.keys()], '🔴 設定の前: 置き場には何も無い(平文も)').toEqual([]);
    const recovery = await setupEncryption(A);
    await expect(status(A), 'A が同期しない').toContainText('最終同期', { timeout: 20_000 });
    expect([...mock.s3.objects.keys()].map((k) => k.replace(/[0-9a-f]{16}/, 'ID')).sort(), '置き場には暗号化したファイルと keyring.json だけ').toEqual(['pkc3/keyring.json', 'pkc3/pkc3-ID.pkc3-diff.zip.enc']);
    expect(mock.s3.seen.some((x) => x.method === 'PUT' && x.headers['if-none-match'] === '*'), '初めての書き込みは If-None-Match').toBe(true);
    expect(mock.s3.seen.some((x) => x.method === 'PUT' && x.url.endsWith('/keyring.json') && x.headers['if-none-match'] === '*'), 'keyring.json の初回作成は If-None-Match: *').toBe(true);
    // 🔴 置き場の中身に、ノートの字・パスフレーズ・回復キー・zip の印(PK)が無い
    const enc = [...mock.s3.objects.entries()].find(([k]) => k.endsWith('.enc'))!;
    expect(Buffer.from(enc[1].body).subarray(0, 8).toString(), '暗号化したファイルの印').toBe('PKC3E2E1');
    for (const [k, o] of mock.s3.objects) {
      const raw = Buffer.from(o.body);
      for (const needle of [NOTE_TITLE, PASS, recovery, recovery.replace(/-/g, '')]) expect(raw.includes(Buffer.from(needle)), `置き場 ${k} に ${needle.slice(0, 6)}…`).toBe(false);
      expect(raw.subarray(0, 4).toString('latin1'), `置き場 ${k} が平文の zip`).not.toBe('PK\x03\x04');
    }

    // ── 🔴 保存領域に認証情報の平文が無い(鍵の保管には暗号文だけ)
    const st = await storageText(A);
    expect(st.keyCount, '鍵の保管に 1 件').toBe(1);
    expect(st.keys, '空振り防止: 接続先は平文で在る').toContain('127.0.0.1');
    expect(st.keyNames.some((n) => n.startsWith('data:')), '端末に暗号化キー(取り出せない形)を置いた').toBe(true);
    for (const c of [SECRET.accessKeyId, SECRET.secretAccessKey, 'SMOKE-KEY', 'SECRET+key', PASS, recovery, recovery.replace(/-/g, '')])
      for (const [where, text] of Object.entries({ localStorage: st.local, 同期の記録: st.folder, 鍵の保管: st.keys })) expect(text, `${where} に ${c}`).not.toContain(c);

    // ── B: 同じ保管先に接続する(初めての相手なので確認が出る)── ファイルを運ばずに届く
    await expect(B.locator('[data-pkc-region="sidebar"]'), '対照群: B にはまだ無い').not.toContainText('S3 で運ぶメモ');
    // 🔴 棚の無い同じ名前の DB が先に在っても、認証情報を保存できる(段 4a-4 の smoke で踏んだ ── 版を上げて棚を足す)
    await B.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const r = indexedDB.open('pkc3-sync-keys', 1);
          r.onsuccess = () => {
            r.result.close();
            resolve();
          };
        }),
    );
    await openS3(B);
    await fill(B, mock.url);
    await clickReal(B, '[data-pkc-action="connect-sync-s3"]');
    // 🔴 置き場に暗号化キーが在る ── 設定ではなく「開く」が出る。間違いは理由を言って開かない
    await expect(e2eField(B, 'sync-e2e-unlock'), 'B に「開く」が出ない').toBeVisible({ timeout: 20_000 });
    await expect(e2eField(B, 'sync-e2e-setup')).toBeHidden();
    await e2eField(B, 'sync-e2e-unlock-secret').fill(`${PASS}-ちがう`);
    await clickReal(B, '[data-pkc-region="settings-sync-s3"] [data-pkc-action="unlock-sync-e2e"]');
    await expect(e2eField(B, 'sync-e2e-result'), '違うパスフレーズの理由を言わない').toContainText('違います', { timeout: 20_000 });
    expect(await e2eField(B, 'sync-e2e-unlock-secret').inputValue(), '読んだら空').toBe('');
    // 回復キー(小文字・ハイフン無し)で開く
    await e2eField(B, 'sync-e2e-unlock-via').selectOption('recovery');
    await e2eField(B, 'sync-e2e-unlock-secret').fill(recovery.toLowerCase().replace(/-/g, ''));
    await clickReal(B, '[data-pkc-region="settings-sync-s3"] [data-pkc-action="unlock-sync-e2e"]');
    await expect(B.locator('[data-pkc-region="app-dialog"]'), '初めての相手の確認が出ない').toBeVisible({ timeout: 20_000 });
    await clickReal(B, '[data-pkc-field="dialog-ok"]');
    await expect(status(B)).toContainText('最終同期', { timeout: 20_000 });
    await expect(B.locator('[data-pkc-region="sidebar"]'), 'A のノートが B に届かない').toContainText(NOTE_TITLE, { timeout: 20_000 });
    expect([...mock.s3.objects.keys()].filter((k) => k.endsWith('.enc')).length, '端末ごとに 1 つ(暗号化したファイル)').toBe(2);
    expect(mock.s3.objects.size, '2 台ぶん + keyring.json').toBe(3);

    // ── 🔴 412: A が書く間に、別の端末が A のファイルを書き換えた ── 上書きせずに止まる
    await clickReal(A, '[data-pkc-region="settings-sync-s3"] [data-pkc-action="sync-folder-now"]');
    await expect(status(A)).toContainText('最終同期', { timeout: 20_000 });
    await createEntry(A, 'text');
    await A.locator('[data-pkc-field="editor-title"]').fill('412 の間に書いたメモ');
    await clickReal(A, '[data-pkc-action="commit-edit"]');
    await openS3(A);
    mock.race = true;
    await clickReal(A, '[data-pkc-region="settings-sync-s3"] [data-pkc-action="sync-folder-now"]');
    await expect(status(A), '412 で止まらない').toContainText('上書きしませんでした', { timeout: 20_000 });
    const aKey = [...mock.s3.objects.keys()].find((k) => mock.s3.objects.get(k)!.etag === '"racer"');
    expect(aKey, '別の端末が書いた物が残っている(上書きされた)').toBeDefined();
    expect(new TextDecoder().decode(mock.s3.objects.get(aKey!)!.body)).toBe('別の端末が書いた');

    // ── CORS を外す ── 理由(CORS)を言って失敗する
    mock.cors = false;
    await fill(A, mock.url);
    await clickReal(A, '[data-pkc-action="test-sync-s3"]');
    await expect(result(A), 'CORS の理由を言わない').toContainText('CORS', { timeout: 20_000 });
    mock.cors = true;

    // ── 接続を外す ── 認証情報が消え、保管先のファイルは残る(片道にしない)
    const before = mock.s3.objects.size;
    await clickReal(A, '[data-pkc-action="disconnect-sync-s3"]');
    await expect(status(A)).toHaveText('使っていません');
    expect((await storageText(A)).keyCount, '認証情報が残っている').toBe(0);
    expect((await storageText(A)).keyNames.some((n) => n.startsWith('data:')), '暗号化キーも消えている').toBe(false);
    expect(mock.s3.objects.size, '保管先のファイルは消さない').toBe(before);

    // ⚠ わざと起こした 412・CORS の拒否は、ブラウザが console に出す(作り物の S3 の URL への物だけ除く ── ほかの失敗は拾う)
    const mine = (e: string): boolean =>
      e.includes('/my%20notes') && /412 \(Precondition Failed\)|blocked by CORS policy|net::ERR_FAILED/.test(e);
    expect(errorsA.filter(mine).length, '対照群: わざと起こした失敗が console に出ている(除く物が実在する)').toBeGreaterThan(0);
    expect(errorsA.filter((e) => !mine(e)), `page error A: ${errorsA.join(' / ')}`).toEqual([]);
    expect(errorsB, `page error B: ${errorsB.join(' / ')}`).toEqual([]);
  } finally {
    await A.context().close();
    await B.context().close();
    await new Promise<void>((r) => mock.server.close(() => r()));
  }
});

test('🔴 暗号化キーの置き方: 端末に置けば開き直しても自動で再開 / 「開くたびにパスフレーズを入れる」は入れるまで待ち、メッセージの「いまの状態」から入れに行ける (#2000 段 4b-B)', async ({ browser }) => {
  test.setTimeout(150_000);
  const mock = await startMockS3();
  const A = await device(browser);
  const errorsA = collectPageErrors(A);
  const reopen = async (): Promise<void> => {
    await A.reload();
    await expect(A.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  };
  try {
    await createEntry(A, 'text');
    await A.locator('[data-pkc-field="editor-title"]').fill(NOTE_TITLE);
    await clickReal(A, '[data-pkc-action="commit-edit"]');
    await openS3(A);
    await fill(A, mock.url);
    await clickReal(A, '[data-pkc-action="connect-sync-s3"]');
    const recovery = await setupEncryption(A);
    await expect(status(A)).toContainText('最終同期', { timeout: 20_000 });
    expect((await storageText(A)).keyNames.some((n) => n.startsWith('data:')), '既定: 暗号化キーを端末に置く').toBe(true);

    // ── 開き直し(既定)── 入れ直さずに自動で再開する
    await reopen();
    await openS3(A);
    await expect(status(A), '開き直しても自動で再開しない').toContainText('最終同期', { timeout: 30_000 });
    await expect(e2eField(A, 'sync-e2e-status')).toContainText('暗号化しています');
    await e2eField(A, 'sync-e2e-open').scrollIntoViewIfNeeded();
    await shot(A, 'e2e-3-open');

    // ── 「開くたびにパスフレーズを入れる」をオン ── 端末の暗号化キーが消える
    await e2eField(A, 'sync-e2e-ask').check();
    await expect.poll(async () => (await storageText(A)).keyNames.some((n) => n.startsWith('data:')), { timeout: 20_000, message: '置いたキーが消えない' }).toBe(false);
    await expect(status(A), 'このセッションは開いたまま').not.toContainText('止まっています');

    // ── 開き直し ── 入れるまで待つ(平文では書かない)
    const before = new Set(mock.s3.objects.keys());
    await reopen();
    const pop = await openMessagePopover(A);
    await expect(pop.locator('[data-pkc-field="popover-state-list"]'), 'いまの状態に待っている理由が出ない').toContainText('パスフレーズを入れると同期を再開します', { timeout: 30_000 });
    const go = pop.locator('[data-pkc-field="status-sync-unlock"]');
    await expect(go, '「パスフレーズを入れる」のボタンが出ない').toBeVisible();
    await shot(A, 'e2e-5-popover');
    await expect(go).toHaveText('パスフレーズを入れる');
    expect([...mock.s3.objects.keys()].sort(), '待っている間、平文も書かず増えもしない').toEqual([...before].sort());
    await clickReal(A, go);
    if (await pop.isVisible()) await A.keyboard.press('Escape');
    await expect(e2eField(A, 'sync-e2e-unlock'), '設定の「開く」へ移らない').toBeVisible({ timeout: 20_000 });
    await shot(A, 'e2e-4-unlock');
    expect(await e2eField(A, 'sync-e2e-ask-unlock').isChecked(), '「開くたびに入れる」の選び方は開き直しても残る').toBe(true);
    await e2eField(A, 'sync-e2e-unlock-secret').fill(PASS);
    await clickReal(A, '[data-pkc-region="settings-sync-s3"] [data-pkc-action="unlock-sync-e2e"]');
    await expect(status(A), '入れても再開しない').toContainText('最終同期', { timeout: 30_000 });
    expect((await storageText(A)).keyNames.some((n) => n.startsWith('data:')), '開くたびに入れる設定のままなら、置かない').toBe(false);
    const st = await storageText(A);
    for (const c of [PASS, recovery, recovery.replace(/-/g, '')]) for (const [where, text] of Object.entries({ localStorage: st.local, 同期の記録: st.folder, 鍵の保管: st.keys })) expect(text, `${where} に秘密`).not.toContain(c);
    expect(await e2eField(A, 'sync-e2e-unlock-secret').inputValue(), '欄は空').toBe('');
    expect(errorsA, `page error A: ${errorsA.join(' / ')}`).toEqual([]);
  } finally {
    await A.context().close();
    await new Promise<void>((r) => mock.server.close(() => r()));
  }
});
