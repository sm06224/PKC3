import { test, expect, type Browser, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gotoApp, clickReal, collectPageErrors, createEntry } from './helpers';
import { fakeS3 } from '../helpers/fake-s3';

/**
 * 🔴 **S3 互換の保管先(#2000 段 4a-4。user 必須ガード)── COOP/COEP で分離した実ブラウザの 2 台から、作り物の S3 サーバを読み書きする**。
 *
 * - 作り物の S3 = この test が立てる Node の HTTP サーバ(`127.0.0.1` の別のポート = 別の origin)。中身は
 *   `tests/helpers/fake-s3.ts`(**SigV4 を node:crypto で独立に検算** ── 署名が合わなければ 403)。CORS の見出しを付ける / 付けないを切り替える。
 * - 見る物: ①分離(`crossOriginIsolated`)の下で読み書きでき、ファイルを運ばずに B へノートが届く ②認証情報の欄は接続したら空になり、
 *   localStorage・同期の記録(IndexedDB)・鍵の保管(暗号化)のどこにも平文が無い ③書く間に別の端末が書いた(412)ら上書きせずに止まる
 *   ④CORS を外すと、理由(CORS)を言って失敗する ⑤「接続を外す」で認証情報が消える(保管先のファイルは残る)。
 */
const SECRET = { accessKeyId: 'SMOKE-KEY-ID-4a4', secretAccessKey: 'smoke/SECRET+key=4a4' };

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
async function storageText(page: Page): Promise<{ local: string; folder: string; keys: string; keyCount: number }> {
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
    return { local, folder: (await dump('pkc3-sync-folder', 'folders')).map(flat).join('||'), keys: boxes.map(flat).join('||'), keyCount: boxes.length };
  });
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
    await A.locator('[data-pkc-field="editor-title"]').fill('S3 で運ぶメモ');
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
    await clickReal(A, '[data-pkc-action="connect-sync-s3"]');
    await expect(status(A), 'A が同期しない').toContainText('最終同期', { timeout: 20_000 });
    expect(await A.locator('[data-pkc-field="sync-s3-secret"]').inputValue(), '認証情報の欄は空にする').toBe('');
    expect(await A.locator('[data-pkc-field="sync-s3-access-key-id"]').inputValue()).toBe('');
    expect([...mock.s3.objects.keys()].map((k) => k.replace(/[0-9a-f]{16}/, 'ID')), '置き場の直下に A のファイル').toEqual(['pkc3/pkc3-ID.pkc3-diff.zip']);
    expect(mock.s3.seen.some((x) => x.method === 'PUT' && x.headers['if-none-match'] === '*'), '初めての書き込みは If-None-Match').toBe(true);

    // ── 🔴 保存領域に認証情報の平文が無い(鍵の保管には暗号文だけ)
    const st = await storageText(A);
    expect(st.keyCount, '鍵の保管に 1 件').toBe(1);
    expect(st.keys, '空振り防止: 接続先は平文で在る').toContain('127.0.0.1');
    for (const c of [SECRET.accessKeyId, SECRET.secretAccessKey, 'SMOKE-KEY', 'SECRET+key'])
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
    await expect(B.locator('[data-pkc-region="app-dialog"]'), '初めての相手の確認が出ない').toBeVisible({ timeout: 20_000 });
    await clickReal(B, '[data-pkc-field="dialog-ok"]');
    await expect(status(B)).toContainText('最終同期', { timeout: 20_000 });
    await expect(B.locator('[data-pkc-region="sidebar"]'), 'A のノートが B に届かない').toContainText('S3 で運ぶメモ', { timeout: 20_000 });
    expect(mock.s3.objects.size, '端末ごとに 1 つ').toBe(2);

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
